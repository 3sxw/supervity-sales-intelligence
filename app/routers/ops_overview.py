# app/routers/ops_overview.py
"""
Overview Dashboard — live KPIs and recent run cards computed from the real
`run_events`, `exceptions`, `buying_group`, and `routing_rules` tables.
Nothing here is hardcoded; every number is derived from what Supervity has
actually written to Supabase.
"""

import logging
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException

from ..core.supabase_client import SupabaseError, select, select_one
from ..security import get_current_user
from ..services.ops_runs import build_p03_eval_by_run, build_score_by_account, summarize_all_runs

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/overview", tags=["Ops Overview"])


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


def _routing_rule_collisions(routing_rules: list[dict]) -> list[dict]:
    buckets: dict[tuple, set] = defaultdict(set)
    for r in routing_rules:
        key = (r.get("region"), r.get("segment"), r.get("industry"), r.get("priority"))
        if r.get("owner_id"):
            buckets[key].add(r["owner_id"])
    collisions = []
    for (region, segment, industry, priority), owners in buckets.items():
        if len(owners) > 1:
            collisions.append(
                {
                    "region": region,
                    "segment": segment,
                    "industry": industry,
                    "priority": priority,
                    "conflicting_owner_ids": sorted(owners),
                }
            )
    return collisions


@router.get("")
async def get_overview(user: dict = Depends(get_current_user)):
    try:
        run_events = await select(
            "run_events", {"select": "*", "order": "created_at.desc", "limit": "1000"}
        )
        exceptions = await select("exceptions", {"select": "id,status"})
        buying_groups = await select("buying_group", {"select": "group_id"})
        routing_rules = await select("routing_rules", {"select": "*"})
        policy_evaluations = await select(
            "policy_evaluations", {"select": "*", "policy_id": "eq.P03", "order": "created_at.desc", "limit": "300"}
        )
        p03_policy = await select_one("policies", {"select": "*", "id": "eq.P03"})
    except SupabaseError as e:
        _handle(e)

    account_ids = {
        (e.get("payload") or {}).get("account_id") for e in run_events
    }
    lookup = await _account_lookup(account_ids)
    score_by_account = build_score_by_account(run_events)
    p03_eval_by_run = build_p03_eval_by_run(policy_evaluations)

    run_summaries = summarize_all_runs(run_events, lookup, score_by_account, p03_eval_by_run)
    p03_current_minimum = (p03_policy.get("config") or {}).get("minimum_score") if p03_policy else None

    leads_processed = len(run_summaries)
    policy_blocks = sum(1 for s in run_summaries if s["final_status"] == "SUPPRESSED")
    pending_human_reviews = sum(1 for e in exceptions if e["status"] == "pending")
    buying_groups_detected = len({g["group_id"] for g in buying_groups if g.get("group_id")})
    crm_actions = sum(
        1
        for e in run_events
        if e["operator_name"] == "Deal Intake & CRM Updater" and (e.get("payload") or {}).get("write_success")
    )
    rule_collisions = _routing_rule_collisions(routing_rules)
    runtime_collisions = sum(
        1
        for s in run_summaries
        if s["route_outcome"] == "Routing collision detected"
    )
    routing_collisions = len(rule_collisions) + runtime_collisions

    recent_runs = [
        {
            "run_id": s["run_id"],
            "account_id": s["account_id"],
            "account_name": s["account_name"],
            "final_status": s["final_status"],
            "policy_outcome": s["policy_outcome"],
            "route_outcome": s["route_outcome"],
            "crm_outcome": s["crm_outcome"],
            "lead_score": s["lead_score"],
            "started_at": s["started_at"],
            "last_event_at": s["last_event_at"],
            "event_count": s["event_count"],
        }
        for s in run_summaries[:8]
    ]

    latest_operation = run_summaries[0] if run_summaries else None
    _ls = (latest_operation or {}).get("lead_score")
    if latest_operation and _ls and _ls.get("score") is not None:
        latest_operation = {
            **latest_operation,
            "lead_score": {
                **latest_operation["lead_score"],
                "would_pass_current_live_threshold": (
                    p03_current_minimum is not None and latest_operation["lead_score"]["score"] >= p03_current_minimum
                ),
            },
        }

    return {
        "kpis": {
            "leads_processed": leads_processed,
            "policy_blocks": policy_blocks,
            "pending_human_reviews": pending_human_reviews,
            "buying_groups_detected": buying_groups_detected,
            "crm_actions": crm_actions,
            "routing_collisions": routing_collisions,
        },
        "routing_collision_detail": {
            "config_level": rule_collisions,
            "runtime_level_count": runtime_collisions,
        },
        "recent_runs": recent_runs,
        "latest_operation": latest_operation,
        "p03": {
            "current_minimum_score": p03_current_minimum,
        },
        "data_source": (
            "supabase.run_events, supabase.exceptions, supabase.buying_group, "
            "supabase.routing_rules, supabase.policy_evaluations, supabase.policies"
        ),
    }
