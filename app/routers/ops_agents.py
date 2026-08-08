# app/routers/ops_agents.py
"""
Live Agent Activity — the 6 real Supervity Operators, backed by `run_events`.
Business execution timelines are correlated by account_id (the authoritative
link across run_ids) with real P03 policy_evaluations merged in — not a raw,
fragmented run_id grouping.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException

from ..core.supabase_client import SupabaseError, select
from ..security import get_current_user
from ..services.ops_runs import OPERATOR_TAXONOMY, ORCHESTRATOR_NAME, correlate_business_timelines

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/agents", tags=["Ops Agent Activity"])


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


@router.get("")
async def get_agent_activity(
    session_limit: int = 25,
    user: dict = Depends(get_current_user),
):
    try:
        run_events = await select(
            "run_events", {"select": "*", "order": "created_at.desc", "limit": "1000"}
        )
        enrichment_rows = await select(
            "enrichment_data", {"select": "enrichment_id,company_domain,industry,source,confidence,last_verified"}
        )
        p03_evaluations = await select(
            "policy_evaluations", {"select": "*", "policy_id": "eq.P03", "order": "created_at.desc", "limit": "300"}
        )
    except SupabaseError as e:
        _handle(e)

    account_ids = {(e.get("payload") or {}).get("account_id") for e in run_events}
    lookup = await _account_lookup(account_ids)

    business_timelines = correlate_business_timelines(run_events, p03_evaluations, lookup)

    operator_cards = []
    for op in OPERATOR_TAXONOMY:
        if op["key"] == "lead_enricher":
            # Source records, not a run_events stream — labeled and shaped
            # distinctly so the UI never implies this is live event activity.
            operator_cards.append(
                {
                    "key": op["key"],
                    "label": op["label"],
                    "kind": "source_records",
                    "unit_label": "records in enrichment_data",
                    "record_count": len(enrichment_rows),
                    "status": "source_data_available" if enrichment_rows else "no_source_data",
                    "data_source": "enrichment_data (no dedicated run_events entries observed for this operator)",
                    "sample_records": enrichment_rows[:5],
                    "last_event": None,
                }
            )
            continue

        matching = [e for e in run_events if e["operator_name"] in op["operator_names"]]
        matching.sort(key=lambda e: e["created_at"], reverse=True)
        operator_cards.append(
            {
                "key": op["key"],
                "label": op["label"],
                "kind": "event_stream",
                "unit_label": "events observed",
                "event_count": len(matching),
                "last_event": matching[0] if matching else None,
                "status": "active" if matching else "no_activity_observed",
            }
        )

    orchestrator_events = [e for e in run_events if e["operator_name"] == ORCHESTRATOR_NAME]
    orchestrator_events.sort(key=lambda e: e["created_at"], reverse=True)
    orchestrator_card = {
        "key": "orchestrator",
        "label": ORCHESTRATOR_NAME,
        "kind": "event_stream",
        "unit_label": "events observed",
        "event_count": len(orchestrator_events),
        "last_event": orchestrator_events[0] if orchestrator_events else None,
        "status": "active" if orchestrator_events else "no_activity_observed",
    }

    return {
        "operators": operator_cards,
        "orchestrator": orchestrator_card,
        "business_timelines": business_timelines[: min(session_limit, 100)],
        "total_business_executions_observed": len(business_timelines),
        "data_source": "supabase.run_events, supabase.enrichment_data, supabase.policy_evaluations",
    }
