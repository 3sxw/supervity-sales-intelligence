# app/services/ops_runs.py
"""
Shared helpers for turning raw `run_events` / `policy_evaluations` rows into
run-level and account-level (business execution) summaries, and mapping real
Supervity operator_name values onto the 6 named Operators.

These are pure functions over already-fetched Supabase rows — no I/O here.
"""

from collections import defaultdict
from datetime import datetime

# The 6 real Operators this Command Center renders. `operator_names` lists the
# exact `run_events.operator_name` values observed in Supabase for that role.
# "Lead Enricher" has no dedicated run_events entries in the current telemetry
# (enrichment happens ahead of scoring); its activity is sourced from the
# `enrichment_data` table instead — never fabricated.
OPERATOR_TAXONOMY = [
    {
        "key": "lead_enricher",
        "label": "Lead Enricher",
        "operator_names": [],
        "fallback_source": "enrichment_data",
    },
    {
        "key": "lead_scorer",
        "label": "Lead / ICP Scorer",
        "operator_names": ["Sales Lead Scorer & Intelligence Brief Generator"],
        "fallback_source": None,
    },
    {
        "key": "buying_group_resolver",
        "label": "Buying Group Resolver",
        "operator_names": ["Buying Group Resolver"],
        "fallback_source": None,
    },
    {
        "key": "consent_dedupe_gate",
        "label": "Consent & Dedupe Gate",
        "operator_names": ["Consent & Dedupe Gate"],
        "fallback_source": None,
    },
    {
        "key": "territory_router",
        "label": "Territory & Capacity Router",
        "operator_names": ["Territory & Capacity Router"],
        "fallback_source": None,
    },
    {
        "key": "deal_intake_crm_updater",
        "label": "Deal Intake & CRM Updater",
        "operator_names": ["Deal Intake & CRM Updater"],
        "fallback_source": None,
    },
]

ORCHESTRATOR_NAME = "Inbound Revenue Orchestrator"

# Consecutive events for the same account further apart than this are treated
# as separate business executions rather than merged into one timeline.
# Chosen from observed real data: operator handoffs within one execution are
# consistently under ~4 minutes apart; distinct executions are 7+ minutes apart.
SESSION_GAP_MINUTES = 5

_NAME_TO_KEY = {}
for _op in OPERATOR_TAXONOMY:
    for _name in _op["operator_names"]:
        _NAME_TO_KEY[_name] = _op["key"]


def operator_key_for(operator_name: str) -> str:
    if operator_name == ORCHESTRATOR_NAME:
        return "orchestrator"
    return _NAME_TO_KEY.get(operator_name, "unknown")


def _parse_ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def group_by_run_id(events: list[dict]) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        groups[e["run_id"]].append(e)
    for run_id in groups:
        groups[run_id].sort(key=lambda e: e["created_at"])
    return groups


def _first(events: list[dict], predicate) -> dict | None:
    for e in events:
        if predicate(e):
            return e
    return None


def build_score_by_account(events: list[dict]) -> dict[str, dict]:
    """Latest LEAD_SCORED payload per account_id, across all runs."""
    latest: dict[str, dict] = {}
    for e in sorted(events, key=lambda e: e["created_at"]):
        if e.get("action") != "LEAD_SCORED":
            continue
        p = e.get("payload") or {}
        account_id = p.get("account_id")
        if not account_id:
            continue
        latest[account_id] = {
            "score": p.get("score"),
            "tier": p.get("tier"),
            "threshold": p.get("threshold"),
            "scored_at": e["created_at"],
            "run_id": e["run_id"],
        }
    return latest


def build_p03_eval_by_run(policy_evaluations: list[dict]) -> dict[str, dict]:
    """Latest P03 evaluation per run_id, preferring entries that carry an explicit score."""
    latest: dict[str, dict] = {}
    for ev in sorted(policy_evaluations, key=lambda e: e["created_at"]):
        if ev.get("policy_id") != "P03":
            continue
        evidence = ev.get("evidence") or {}
        score = evidence.get("score", evidence.get("icp_score"))
        minimum_score = evidence.get("minimum_score")
        run_id = ev.get("run_id")
        if not run_id:
            continue
        existing = latest.get(run_id)
        # Prefer the most recent evaluation that actually carries score data.
        if score is not None or existing is None or existing.get("score") is None:
            latest[run_id] = {
                "score": score,
                "minimum_score": minimum_score,
                "result": (ev.get("result") or "").lower(),
                "reason": ev.get("reason"),
                "evaluated_at": ev["created_at"],
            }
    return latest


def summarize_run(
    events: list[dict],
    account_lookup: dict[str, str] | None = None,
    score_by_account: dict[str, dict] | None = None,
    p03_eval_by_run: dict[str, dict] | None = None,
) -> dict:
    """Build a human-readable summary of a single run's event chain."""
    account_lookup = account_lookup or {}
    score_by_account = score_by_account or {}
    p03_eval_by_run = p03_eval_by_run or {}
    events_sorted = sorted(events, key=lambda e: e["created_at"])
    run_id = events_sorted[0]["run_id"]

    account_id = None
    account_name = None
    contact_id = None
    for e in events_sorted:
        p = e.get("payload") or {}
        account_id = account_id or p.get("account_id")
        account_name = account_name or p.get("account_name") or p.get("company_name")
        contact_id = contact_id or p.get("contact_id")
    if not account_name:
        account_name = account_lookup.get(account_id, account_id or "Unknown account")

    statuses = {e["status"] for e in events_sorted}
    if "SUPPRESSED" in statuses:
        final_status = "SUPPRESSED"
    elif "HUMAN_REVIEW" in statuses:
        final_status = "HUMAN_REVIEW"
    elif "PAUSED_OR_NO_WRITE" in statuses:
        final_status = "PAUSED_OR_NO_WRITE"
    elif statuses == {"COMPLETED"}:
        final_status = "COMPLETED"
    else:
        final_status = events_sorted[-1]["status"]

    consent_event = _first(events_sorted, lambda e: e["operator_name"] == "Consent & Dedupe Gate")
    orchestrator_event = _first(events_sorted, lambda e: e["operator_name"] == ORCHESTRATOR_NAME)
    policy_outcome = None
    if consent_event:
        policy_outcome = (consent_event.get("payload") or {}).get("decision")
    if not policy_outcome and orchestrator_event:
        policy_outcome = (orchestrator_event.get("payload") or {}).get("governance_decision")

    router_event = _first(events_sorted, lambda e: e["operator_name"] == "Territory & Capacity Router")
    route_outcome = None
    if router_event:
        rp = router_event.get("payload") or {}
        if rp.get("collision_detected") or rp.get("ownership_collision_detected"):
            route_outcome = "Routing collision detected"
        elif rp.get("selected_owner_id"):
            route_outcome = f"Routed to {rp.get('selected_owner_id')}"
        else:
            route_outcome = "Not routed"

    crm_event = _first(events_sorted, lambda e: e["operator_name"] == "Deal Intake & CRM Updater")
    crm_outcome = None
    if crm_event:
        cp = crm_event.get("payload") or {}
        owner_name = cp.get("routing_owner_name")
        if route_outcome and route_outcome.startswith("Routed to") and owner_name:
            route_outcome = f"Routed to {owner_name}"
        if cp.get("hubspot_deal_id"):
            mode = cp.get("crm_mode", "write")
            crm_outcome = f"HubSpot {mode} → deal {cp['hubspot_deal_id']}"
        elif cp.get("write_success") is False:
            crm_outcome = "CRM write blocked"
        elif crm_event["action"] == "NO_WRITE":
            crm_outcome = "No CRM write (paused for review)"
    elif final_status == "SUPPRESSED":
        crm_outcome = "Not reached — suppressed upstream"

    # Lead score: prefer a LEAD_SCORED event within this run, then a P03
    # evaluation recorded against this run_id, then the most recent
    # LEAD_SCORED event for the same account from any other run (clearly
    # tagged as correlated, never fabricated — every number is real).
    lead_score = None
    lead_scored_event = _first(events_sorted, lambda e: e["action"] == "LEAD_SCORED")
    if lead_scored_event:
        sp = lead_scored_event.get("payload") or {}
        lead_score = {
            "score": sp.get("score"),
            "tier": sp.get("tier"),
            "evaluated_threshold": sp.get("threshold"),
            "evaluated_result": "pass" if sp.get("meets_outreach_threshold") else "block",
            "source": "run_event",
        }
    elif run_id in p03_eval_by_run and p03_eval_by_run[run_id].get("score") is not None:
        pe = p03_eval_by_run[run_id]
        lead_score = {
            "score": pe["score"],
            "tier": None,
            "evaluated_threshold": pe.get("minimum_score"),
            "evaluated_result": pe.get("result"),
            "source": "policy_evaluation",
        }
    elif account_id in score_by_account:
        sc = score_by_account[account_id]
        lead_score = {
            "score": sc["score"],
            "tier": sc.get("tier"),
            "evaluated_threshold": sc.get("threshold"),
            "evaluated_result": None,
            "source": "correlated_other_run",
            "correlated_run_id": sc.get("run_id"),
            "correlated_scored_at": sc.get("scored_at"),
        }

    out_events = [
        {
            "id": e["id"],
            "run_id": e["run_id"],
            "operator_name": e["operator_name"],
            "operator_key": operator_key_for(e["operator_name"]),
            "action": e["action"],
            "status": e["status"],
            "duration_ms": e.get("duration_ms"),
            "created_at": e["created_at"],
            "payload": e.get("payload") or {},
        }
        for e in events_sorted
    ]

    return {
        "run_id": run_id,
        "account_id": account_id,
        "account_name": account_name,
        "contact_id": contact_id,
        "started_at": events_sorted[0]["created_at"],
        "last_event_at": events_sorted[-1]["created_at"],
        "final_status": final_status,
        "policy_outcome": policy_outcome,
        "route_outcome": route_outcome,
        "crm_outcome": crm_outcome,
        "lead_score": lead_score,
        "event_count": len(events_sorted),
        "events": out_events,
    }


def summarize_all_runs(
    events: list[dict],
    account_lookup: dict[str, str] | None = None,
    score_by_account: dict[str, dict] | None = None,
    p03_eval_by_run: dict[str, dict] | None = None,
) -> list[dict]:
    grouped = group_by_run_id(events)
    summaries = [
        summarize_run(evs, account_lookup, score_by_account, p03_eval_by_run) for evs in grouped.values()
    ]
    summaries.sort(key=lambda s: s["last_event_at"], reverse=True)
    return summaries


def correlate_business_timelines(
    events: list[dict],
    p03_evaluations: list[dict],
    account_lookup: dict[str, str] | None = None,
    session_gap_minutes: float = SESSION_GAP_MINUTES,
) -> list[dict]:
    """
    Group run_events into business execution sessions using the authoritative
    account_id (falling back to run_id when an event carries no account_id),
    splitting into a new session whenever the gap since the previous event for
    that account exceeds `session_gap_minutes`. Real P03 policy_evaluations
    are merged in chronologically as annotation entries. This replaces a raw
    run_id grouping — which fragments one real sales-pipeline execution across
    multiple run_ids (score → buying group → consent → route → CRM often span
    2+ run_ids for the same lead) — with the actual business narrative.
    """
    account_lookup = account_lookup or {}

    by_account: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        p = e.get("payload") or {}
        key = p.get("account_id") or f"__run__{e['run_id']}"
        by_account[key].append({"type": "operator_event", "ts": e["created_at"], "data": e})

    for ev in p03_evaluations:
        if ev.get("policy_id") != "P03":
            continue
        # Attribute the evaluation to the account of its run, if we've seen that run.
        run_id = ev.get("run_id")
        matched_key = None
        for key, entries in by_account.items():
            if any(entry["data"]["run_id"] == run_id for entry in entries):
                matched_key = key
                break
        if matched_key:
            by_account[matched_key].append({"type": "policy_evaluation", "ts": ev["created_at"], "data": ev})

    sessions: list[dict] = []
    for key, entries in by_account.items():
        entries.sort(key=lambda x: x["ts"])
        current: list[dict] = []
        prev_ts: datetime | None = None
        for entry in entries:
            ts = _parse_ts(entry["ts"])
            if prev_ts is not None and (ts - prev_ts).total_seconds() / 60 > session_gap_minutes:
                sessions.append(_build_session(key, current, account_lookup))
                current = []
            current.append(entry)
            prev_ts = ts
        if current:
            sessions.append(_build_session(key, current, account_lookup))

    sessions.sort(key=lambda s: s["last_event_at"], reverse=True)
    return sessions


def _build_session(account_key: str, entries: list[dict], account_lookup: dict[str, str]) -> dict:
    operator_events = [e for e in entries if e["type"] == "operator_event"]
    account_id = None if account_key.startswith("__run__") else account_key
    account_name = None
    run_ids: list[str] = []
    for e in operator_events:
        p = e["data"].get("payload") or {}
        account_name = account_name or p.get("account_name") or p.get("company_name")
        if e["data"]["run_id"] not in run_ids:
            run_ids.append(e["data"]["run_id"])
    if not account_name:
        account_name = account_lookup.get(account_id, account_id or (run_ids[0] if run_ids else "Unknown"))

    statuses = {e["data"]["status"] for e in operator_events}
    if "SUPPRESSED" in statuses:
        final_status = "SUPPRESSED"
    elif "HUMAN_REVIEW" in statuses:
        final_status = "HUMAN_REVIEW"
    elif "PAUSED_OR_NO_WRITE" in statuses:
        final_status = "PAUSED_OR_NO_WRITE"
    elif operator_events and statuses == {"COMPLETED"}:
        final_status = "COMPLETED"
    else:
        final_status = operator_events[-1]["data"]["status"] if operator_events else "UNKNOWN"

    timeline = []
    for e in entries:
        if e["type"] == "operator_event":
            ev = e["data"]
            timeline.append(
                {
                    "type": "operator_event",
                    "created_at": ev["created_at"],
                    "run_id": ev["run_id"],
                    "operator_name": ev["operator_name"],
                    "operator_key": operator_key_for(ev["operator_name"]),
                    "action": ev["action"],
                    "status": ev["status"],
                    "payload": ev.get("payload") or {},
                }
            )
        else:
            pe = e["data"]
            evidence = pe.get("evidence") or {}
            timeline.append(
                {
                    "type": "policy_evaluation",
                    "created_at": pe["created_at"],
                    "run_id": pe.get("run_id"),
                    "policy_id": pe.get("policy_id"),
                    "result": pe.get("result"),
                    "reason": pe.get("reason"),
                    "score": evidence.get("score", evidence.get("icp_score")),
                    "minimum_score": evidence.get("minimum_score"),
                }
            )

    return {
        "business_id": f"BIZ-{account_id or run_ids[0]}-{entries[0]['ts']}",
        "account_id": account_id,
        "account_name": account_name,
        "run_ids": run_ids,
        "started_at": entries[0]["ts"],
        "last_event_at": entries[-1]["ts"],
        "final_status": final_status,
        "event_count": len(operator_events),
        "timeline": timeline,
    }
