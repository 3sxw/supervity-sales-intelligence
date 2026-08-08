# app/routers/ops_policies.py
"""
AI Policies — reads and writes the real `policies` table in Supabase.

The most important policy is P03 (ICP Outreach Threshold): editing
config.minimum_score here writes straight to Supabase and is picked up by
the next Supervity workflow run with no code change.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..core.supabase_client import SupabaseError, select, select_one, update
from ..security import get_current_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/policies", tags=["Ops Policies"])


class PolicyUpdateRequest(BaseModel):
    config: dict | None = None
    enabled: bool | None = None
    priority: int | None = None
    description: str | None = None


def _handle(e: SupabaseError):
    raise HTTPException(status_code=502 if e.status_code >= 500 else e.status_code, detail=e.detail)


@router.get("")
async def list_policies(user: dict = Depends(get_current_user)):
    """List all policies ordered by priority, from the live `policies` table."""
    try:
        rows = await select("policies", {"select": "*", "order": "priority.asc"})
    except SupabaseError as e:
        _handle(e)
    return {"policies": rows, "count": len(rows)}


@router.get("/{policy_id}")
async def get_policy(policy_id: str, user: dict = Depends(get_current_user)):
    try:
        row = await select_one("policies", {"select": "*", "id": f"eq.{policy_id}"})
    except SupabaseError as e:
        _handle(e)
    if not row:
        raise HTTPException(status_code=404, detail=f"Policy '{policy_id}' not found")
    return row


@router.patch("/{policy_id}")
async def update_policy(
    policy_id: str,
    body: PolicyUpdateRequest,
    user: dict = Depends(get_current_user),
):
    """
    Update a policy directly in Supabase. `config` is shallow-merged into the
    existing config JSON so callers can send only the field they're changing
    (e.g. {"minimum_score": 30} for P03) without clobbering the rest.
    """
    try:
        current = await select_one("policies", {"select": "*", "id": f"eq.{policy_id}"})
        if not current:
            raise HTTPException(status_code=404, detail=f"Policy '{policy_id}' not found")

        patch: dict = {"updated_at": datetime.now(timezone.utc).isoformat()}
        if body.config is not None:
            merged_config = {**(current.get("config") or {}), **body.config}
            patch["config"] = merged_config
        if body.enabled is not None:
            patch["enabled"] = body.enabled
        if body.priority is not None:
            patch["priority"] = body.priority
        if body.description is not None:
            patch["description"] = body.description

        rows = await update("policies", {"id": f"eq.{policy_id}"}, patch)
    except SupabaseError as e:
        _handle(e)
    if not rows:
        raise HTTPException(status_code=404, detail=f"Policy '{policy_id}' not found")
    log.info(f"[OPS] Policy {policy_id} updated by {user.get('email', 'unknown')}: {patch}")
    return rows[0]


@router.get("/{policy_id}/evaluations")
async def get_policy_evaluations(
    policy_id: str,
    limit: int = 20,
    user: dict = Depends(get_current_user),
):
    """Recent evaluations of this policy from `policy_evaluations`."""
    try:
        rows = await select(
            "policy_evaluations",
            {
                "select": "*",
                "policy_id": f"eq.{policy_id}",
                "order": "created_at.desc",
                "limit": str(min(limit, 200)),
            },
        )
    except SupabaseError as e:
        _handle(e)
    return {"evaluations": rows, "count": len(rows)}


@router.get("/{policy_id}/impact")
async def get_policy_impact(
    policy_id: str,
    minimum_score: float | None = None,
    user: dict = Depends(get_current_user),
):
    """
    Policy Impact preview for scoring-type policies (P03): shows, using the
    real distinct latest ICP score per lead observed in run_events, how many
    leads would pass at the current threshold vs. a candidate threshold.
    """
    try:
        policy = await select_one("policies", {"select": "*", "id": f"eq.{policy_id}"})
        if not policy:
            raise HTTPException(status_code=404, detail=f"Policy '{policy_id}' not found")
        if policy.get("policy_type") != "scoring":
            raise HTTPException(
                status_code=400,
                detail="Impact preview is only available for scoring-type policies (e.g. P03).",
            )

        current_min = float((policy.get("config") or {}).get("minimum_score", 0))
        candidate_min = float(minimum_score) if minimum_score is not None else current_min

        scored_events = await select(
            "run_events",
            {
                "select": "run_id,payload,created_at",
                "action": "eq.LEAD_SCORED",
                "order": "created_at.desc",
                "limit": "500",
            },
        )
    except SupabaseError as e:
        _handle(e)

    # Dedupe to the latest score per account_id (or contact_id if account missing).
    seen: dict[str, dict] = {}
    for e in scored_events:
        payload = e.get("payload") or {}
        entity_key = payload.get("account_id") or payload.get("contact_id")
        if not entity_key or entity_key in seen:
            continue
        seen[entity_key] = {
            "account_id": payload.get("account_id"),
            "contact_id": payload.get("contact_id"),
            "score": payload.get("score"),
            "tier": payload.get("tier"),
            "run_id": e.get("run_id"),
            "scored_at": e.get("created_at"),
        }

    account_ids = [v["account_id"] for v in seen.values() if v["account_id"]]
    account_names: dict[str, str] = {}
    if account_ids:
        try:
            ids_filter = "(" + ",".join(account_ids) + ")"
            accounts = await select("account", {"select": "Id,Name", "Id": f"in.{ids_filter}"})
            account_names = {a["Id"]: a["Name"] for a in accounts}
        except SupabaseError:
            account_names = {}

    leads = []
    eligible_now = 0
    eligible_candidate = 0
    for v in seen.values():
        score = v["score"]
        if score is None:
            continue
        is_eligible_now = score >= current_min
        is_eligible_candidate = score >= candidate_min
        eligible_now += int(is_eligible_now)
        eligible_candidate += int(is_eligible_candidate)
        leads.append(
            {
                **v,
                "account_name": account_names.get(v["account_id"], v["account_id"] or v["contact_id"]),
                "eligible_at_current_threshold": is_eligible_now,
                "eligible_at_candidate_threshold": is_eligible_candidate,
            }
        )

    leads.sort(key=lambda x: (x["score"] is None, -(x["score"] or 0)))

    return {
        "policy_id": policy_id,
        "current_minimum_score": current_min,
        "candidate_minimum_score": candidate_min,
        "total_leads_observed": len(leads),
        "eligible_at_current_threshold": eligible_now,
        "eligible_at_candidate_threshold": eligible_candidate,
        "newly_eligible": max(0, eligible_candidate - eligible_now),
        "newly_suppressed": max(0, eligible_now - eligible_candidate),
        "leads": leads,
    }
