# app/routers/ops_data_manager.py
"""
Data Manager — integration status panel.

Supabase gets a real backend health-check query. Supervity, HubSpot, and
Slack do not have direct health-check APIs wired up yet, so their status is
honestly labeled "last observed activity" derived from `run_events` — never
a fabricated green "connected" state.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..core.supabase_client import SupabaseError, health_check, select
from ..security import get_current_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/integrations", tags=["Ops Data Manager"])


def _handle(e: SupabaseError):
    raise HTTPException(status_code=502 if e.status_code >= 500 else e.status_code, detail=e.detail)


def _latest(events: list[dict], predicate) -> dict | None:
    matches = [e for e in events if predicate(e)]
    if not matches:
        return None
    matches.sort(key=lambda e: e["created_at"], reverse=True)
    return matches[0]


@router.get("")
async def get_integration_status(user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc).isoformat()

    supabase_health = await health_check()
    supabase_status = {
        "name": "Supabase",
        "check_type": "direct_health_check",
        "status": "operational" if supabase_health["connected"] else "error",
        "detail": supabase_health["detail"],
        "latency_ms": supabase_health["latency_ms"],
        "checked_at": now,
    }

    if not supabase_health["connected"]:
        # Without Supabase we can't derive anything else honestly.
        return {
            "integrations": [
                supabase_status,
                {
                    "name": "Supervity Auto",
                    "check_type": "last_observed_activity",
                    "status": "unknown",
                    "detail": "Cannot query run_events — Supabase is unreachable.",
                    "last_successful_action": None,
                },
                {
                    "name": "HubSpot",
                    "check_type": "last_observed_activity",
                    "status": "unknown",
                    "detail": "Cannot query run_events — Supabase is unreachable.",
                    "last_successful_action": None,
                },
                {
                    "name": "Slack",
                    "check_type": "last_observed_activity",
                    "status": "unknown",
                    "detail": "Cannot query run_events — Supabase is unreachable.",
                    "last_successful_action": None,
                },
            ]
        }

    try:
        run_events = await select(
            "run_events", {"select": "*", "order": "created_at.desc", "limit": "500"}
        )
    except SupabaseError as e:
        _handle(e)

    latest_run_event = _latest(run_events, lambda e: True)
    supervity_status = {
        "name": "Supervity Auto",
        "check_type": "last_observed_activity",
        "status": "activity_observed" if latest_run_event else "no_activity_observed",
        "detail": (
            "Status derived from the most recent Supervity workflow/operator telemetry written to "
            "run_events (no direct API health check configured for this panel)."
        ),
        "last_successful_action": (
            {
                "run_id": latest_run_event["run_id"],
                "operator_name": latest_run_event["operator_name"],
                "action": latest_run_event["action"],
                "status": latest_run_event["status"],
                "timestamp": latest_run_event["created_at"],
            }
            if latest_run_event
            else None
        ),
    }

    hubspot_event = _latest(
        run_events,
        lambda e: e["operator_name"] == "Deal Intake & CRM Updater"
        and (e.get("payload") or {}).get("write_success")
        and (e.get("payload") or {}).get("hubspot_deal_id"),
    )
    hubspot_status = {
        "name": "HubSpot",
        "check_type": "last_observed_activity",
        "status": "activity_observed" if hubspot_event else "no_activity_observed",
        "detail": "Derived from the most recent successful Deal Intake & CRM Updater write.",
        "last_successful_action": (
            {
                "run_id": hubspot_event["run_id"],
                "action": hubspot_event["action"],
                "hubspot_deal_id": (hubspot_event.get("payload") or {}).get("hubspot_deal_id"),
                "company_name": (hubspot_event.get("payload") or {}).get("company_name"),
                "timestamp": hubspot_event["created_at"],
            }
            if hubspot_event
            else None
        ),
    }

    def _has_slack_signal(e: dict) -> bool:
        payload = e.get("payload") or {}
        return any("slack" in str(k).lower() for k in payload.keys())

    # No run_events payload has ever carried a dedicated Slack field (verified
    # against the full telemetry set). Rather than reporting a flat "no
    # activity", we surface the most honest available evidence: per the
    # workflow design, a Slack notification fires immediately after each
    # successful CRM write, so we show that qualifying trigger explicitly
    # marked as unconfirmed — never claiming Slack delivery actually happened.
    slack_event = _latest(run_events, _has_slack_signal)
    slack_trigger = slack_event or hubspot_event
    slack_status = {
        "name": "Slack",
        "check_type": (
            "inferred_from_workflow_design" if not slack_event and slack_trigger else "last_observed_activity"
        ),
        "status": (
            "activity_observed"
            if slack_event
            else ("inferred_not_confirmed" if slack_trigger else "no_activity_observed")
        ),
        "confirmed": bool(slack_event),
        "detail": (
            "Derived from run_events payload fields containing Slack signals."
            if slack_event
            else (
                "run_events carries no dedicated Slack telemetry field. Per workflow design, a Slack "
                "notification is expected immediately after each successful CRM write — shown below is "
                "that most recent qualifying trigger, not a confirmed delivery."
                if slack_trigger
                else "No successful CRM write has occurred yet to trigger a Slack notification, and "
                "run_events carries no dedicated Slack telemetry field."
            )
        ),
        "last_successful_action": (
            {
                "run_id": slack_event["run_id"],
                "action": slack_event["action"],
                "timestamp": slack_event["created_at"],
            }
            if slack_event
            else None
        ),
        "last_qualifying_trigger": (
            {
                "run_id": slack_trigger["run_id"],
                "trigger": "Successful CRM write (Deal Intake & CRM Updater)",
                "hubspot_deal_id": (slack_trigger.get("payload") or {}).get("hubspot_deal_id"),
                "company_name": (slack_trigger.get("payload") or {}).get("company_name"),
                "timestamp": slack_trigger["created_at"],
            }
            if slack_trigger and not slack_event
            else None
        ),
    }

    return {"integrations": [supabase_status, supervity_status, hubspot_status, slack_status]}
