# app/routers/ops_insights.py
"""
AI Insights — deterministic, evidence-backed observations computed live from
run_events, policy_evaluations, exceptions, routing_rules, sdr_roster,
buying_group, and visitor_activity. No LLM invention, no generic filler:
every card cites the real rows that produced it.
"""

import logging
from collections import defaultdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..core.supabase_client import SupabaseError, select
from ..security import get_current_user
from ..services.ops_runs import summarize_all_runs

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/insights", tags=["Ops Insights"])


def _handle(e: SupabaseError):
    raise HTTPException(status_code=502 if e.status_code >= 500 else e.status_code, detail=e.detail)


async def _account_lookup(account_ids: set[str]) -> dict[str, str]:
    account_ids = {a for a in account_ids if a}
    if not account_ids:
        return {}
    try:
        ids_filter = "(" + ",".join(account_ids) + ")"
        rows = await select("account", {"select": "Id,Name", "Id": f"in.{ids_filter}"})
        return {r["Id"]: r["Name"] for r in rows}
    except SupabaseError:
        return {}


def _card(insight_type, severity, title, description, evidence, recommendation, confidence):
    return {
        "insight_type": insight_type,
        "severity": severity,
        "title": title,
        "description": description,
        "evidence": evidence,
        "recommendation": recommendation,
        "confidence": confidence,
    }


def _insight_buying_groups(buying_groups: list[dict], account_lookup: dict) -> list[dict]:
    by_group: dict[str, list[dict]] = defaultdict(list)
    for bg in buying_groups:
        if bg.get("group_id"):
            by_group[bg["group_id"]].append(bg)

    cards = []
    for group_id, members in by_group.items():
        if len(members) < 2:
            continue
        account_id = members[0].get("account_id")
        account_name = account_lookup.get(account_id, account_id or "Unknown account")
        roles = sorted({m.get("role") for m in members if m.get("role")})
        economic_buyer = next((m for m in members if m.get("role") == "economic_buyer"), None)
        cards.append(
            _card(
                "pattern",
                "info",
                f"High-intent buying group detected: {account_name}",
                f"{len(members)} stakeholders are linked to buying group {group_id} "
                f"spanning roles: {', '.join(roles)}.",
                {
                    "group_id": group_id,
                    "account_id": account_id,
                    "member_count": len(members),
                    "roles": roles,
                },
                (
                    f"Multi-thread outreach across all {len(members)} stakeholders"
                    + (
                        f"; loop in the economic buyer (contact {economic_buyer['contact_id']})."
                        if economic_buyer
                        else "."
                    )
                ),
                0.9,
            )
        )
    return cards


def _insight_consent_anomalies(exceptions: list[dict]) -> list[dict]:
    cards = []
    for exc in exceptions:
        if exc.get("exception_type") == "CONSENT_REGION_CONFLICT" and exc.get("status") == "pending":
            cards.append(
                _card(
                    "anomaly",
                    "critical",
                    "Consent region conflict blocking outreach",
                    exc.get("reason") or "A contact has conflicting regional consent records.",
                    {"exception_id": exc["id"], "run_id": exc.get("run_id"), "entity_id": exc.get("entity_id")},
                    exc.get("recommendation") or "Resolve the consent conflict in Workbench before any outreach.",
                    float(exc.get("confidence") or 0.9),
                )
            )
    return cards


def _insight_routing_collisions(routing_rules: list[dict]) -> list[dict]:
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for r in routing_rules:
        key = (r.get("region"), r.get("segment"), r.get("industry"), r.get("priority"))
        buckets[key].append(r)

    cards = []
    for (region, segment, industry, priority), rules in buckets.items():
        owners = {r["owner_id"] for r in rules if r.get("owner_id")}
        if len(owners) > 1:
            cards.append(
                _card(
                    "anomaly",
                    "warning",
                    f"Routing collision: {region}/{segment}/{industry or 'any industry'} at priority {priority}",
                    f"{len(rules)} routing_rules rows share the same region, segment, industry, and "
                    f"priority but point to {len(owners)} different owners: {', '.join(sorted(owners))}.",
                    {
                        "rule_ids": [r["rule_id"] for r in rules],
                        "region": region,
                        "segment": segment,
                        "industry": industry,
                        "priority": priority,
                        "owner_ids": sorted(owners),
                    },
                    "Assign a single owner per (region, segment, industry, priority) tuple, or split the "
                    "conflicting rule into a narrower priority band.",
                    0.95,
                )
            )
    return cards


def _insight_rep_capacity(sdr_roster: list[dict]) -> list[dict]:
    cards = []
    for rep in sdr_roster:
        current = rep.get("current_capacity")
        maximum = rep.get("max_capacity")
        if current is None or maximum is None or not rep.get("active", True):
            continue
        if current > maximum:
            cards.append(
                _card(
                    "anomaly",
                    "critical",
                    f"{rep['name']} is over capacity ({current}/{maximum})",
                    f"{rep['name']} ({rep.get('territory')}) is assigned {current} accounts against a max "
                    f"capacity of {maximum}.",
                    {
                        "owner_id": rep["owner_id"],
                        "current_capacity": current,
                        "max_capacity": maximum,
                        "territory": rep.get("territory"),
                    },
                    f"Rebalance new routing away from {rep['name']} or raise their capacity limit.",
                    0.95,
                )
            )
        elif maximum and current / maximum >= 0.9:
            cards.append(
                _card(
                    "recommendation",
                    "info",
                    f"{rep['name']} is approaching capacity ({current}/{maximum})",
                    f"{rep['name']} ({rep.get('territory')}) is at {round(current / maximum * 100)}% of max capacity.",
                    {
                        "owner_id": rep["owner_id"],
                        "current_capacity": current,
                        "max_capacity": maximum,
                        "territory": rep.get("territory"),
                    },
                    "Monitor before routing additional accounts to this rep.",
                    0.7,
                )
            )
    return cards


def _insight_duplicate_opportunity(exceptions: list[dict]) -> list[dict]:
    cards = []
    for exc in exceptions:
        evidence = exc.get("evidence") or {}
        open_opp_ids = evidence.get("open_opportunity_ids") or []
        if len(open_opp_ids) > 1 and exc.get("status") == "pending":
            cards.append(
                _card(
                    "anomaly",
                    "warning",
                    f"Duplicate open-opportunity risk: {evidence.get('company_name', exc.get('entity_id'))}",
                    f"{len(open_opp_ids)} open opportunities exist for this account, making the CRM write "
                    "target ambiguous.",
                    {"exception_id": exc["id"], "open_opportunity_ids": open_opp_ids, "run_id": exc.get("run_id")},
                    exc.get("recommendation")
                    or "Resolve which opportunity should receive the update before writing to HubSpot.",
                    float(exc.get("confidence") or 0.85),
                )
            )
    return cards


def _insight_suppression_trend(run_summaries: list[dict], p03_minimum: float | None) -> list[dict]:
    total = len(run_summaries)
    suppressed = sum(1 for s in run_summaries if s["final_status"] == "SUPPRESSED")
    if total == 0 or suppressed == 0:
        return []
    rate = suppressed / total
    severity = "warning" if rate >= 0.25 else "info"
    threshold_note = f" (P03 minimum_score is currently {p03_minimum})" if p03_minimum is not None else ""
    return [
        _card(
            "pattern",
            severity,
            f"{round(rate * 100)}% of processed runs suppressed by ICP threshold",
            f"{suppressed} of {total} observed runs were suppressed before reaching routing or CRM"
            f"{threshold_note}.",
            {"suppressed_runs": suppressed, "total_runs": total, "p03_minimum_score": p03_minimum},
            "Review whether P03's minimum_score is filtering out legitimate leads; adjust in AI Policies "
            "and use the Impact Preview before committing to a new threshold.",
            0.85,
        )
    ]


def _insight_pending_backlog(exceptions: list[dict]) -> list[dict]:
    pending = [e for e in exceptions if e.get("status") == "pending"]
    if not pending:
        return []
    severity = "critical" if len(pending) >= 3 else "warning"
    high_priority = sum(1 for e in pending if e.get("priority") == "high")
    return [
        _card(
            "recommendation",
            severity,
            f"{len(pending)} exception(s) awaiting human review",
            f"{high_priority} of {len(pending)} pending exceptions are marked high priority.",
            {"pending_ids": [e["id"] for e in pending], "high_priority_count": high_priority},
            "Work the Workbench queue, oldest and highest-priority first.",
            0.9,
        )
    ]


_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}


@router.get("")
async def get_insights(user: dict = Depends(get_current_user)):
    try:
        run_events = await select("run_events", {"select": "*", "order": "created_at.desc", "limit": "1000"})
        exceptions = await select("exceptions", {"select": "*"})
        routing_rules = await select("routing_rules", {"select": "*"})
        sdr_roster = await select("sdr_roster", {"select": "*"})
        buying_groups = await select("buying_group", {"select": "*"})
        policies = await select("policies", {"select": "id,config", "id": "eq.P03"})
    except SupabaseError as e:
        _handle(e)

    account_ids = {(e.get("payload") or {}).get("account_id") for e in run_events}
    lookup = await _account_lookup(account_ids)
    run_summaries = summarize_all_runs(run_events, lookup)
    p03_minimum = (policies[0].get("config") or {}).get("minimum_score") if policies else None

    cards: list[dict] = []
    cards += _insight_buying_groups(buying_groups, lookup)
    cards += _insight_consent_anomalies(exceptions)
    cards += _insight_routing_collisions(routing_rules)
    cards += _insight_rep_capacity(sdr_roster)
    cards += _insight_duplicate_opportunity(exceptions)
    cards += _insight_suppression_trend(run_summaries, p03_minimum)
    cards += _insight_pending_backlog(exceptions)

    cards.sort(key=lambda c: _SEVERITY_ORDER.get(c["severity"], 3))
    now = datetime.now(timezone.utc).isoformat()
    for i, c in enumerate(cards):
        c["id"] = f"derived-{i}"
        c["generated_at"] = now

    return {
        "insights": cards,
        "count": len(cards),
        "counts_by_severity": {
            sev: sum(1 for c in cards if c["severity"] == sev) for sev in ("critical", "warning", "info")
        },
        "data_source": "run_events, exceptions, routing_rules, sdr_roster, buying_group, policies(P03)",
    }
