# app/routers/ops_workbench.py
"""
Workbench — the human-in-the-loop review queue backed by the real
`exceptions` table. Decisions write back to `exceptions` and insert a row
into `human_feedback` so the resolution is auditable and can inform future
Supervity runs.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..core.supabase_client import SupabaseError, count, insert, select, select_one, update
from ..security import get_current_user

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ops/exceptions", tags=["Ops Workbench"])


class ExceptionDecisionRequest(BaseModel):
    # "archive" is for old technical/debug exceptions that aren't a real
    # business decision (e.g. a stale safety-check artifact) — it clears them
    # from the Pending queue without pretending a human approved/rejected them.
    decision: str = Field(..., pattern="^(approve|modify|reject|archive)$")
    comment: str | None = None


def _handle(e: SupabaseError):
    raise HTTPException(status_code=502 if e.status_code >= 500 else e.status_code, detail=e.detail)


def _extract_triggered_policies(evidence: dict | None) -> list[dict]:
    """
    Evidence payloads vary by exception type but consistently nest a list of
    per-policy results under either `policy_decisions` or `policy_results`.
    Normalize both shapes into [{policy_id, result, reason}].
    """
    if not evidence:
        return []
    raw = evidence.get("policy_decisions") or evidence.get("policy_results") or []
    normalized = []
    for item in raw:
        normalized.append(
            {
                "policy_id": item.get("policy_id"),
                "policy_name": item.get("policy_name"),
                "result": (item.get("result") or "").lower(),
                "reason": item.get("reason"),
            }
        )
    return normalized


def _serialize_exception(row: dict) -> dict:
    return {
        **row,
        "triggered_policies": _extract_triggered_policies(row.get("evidence")),
    }


@router.get("")
async def list_exceptions(
    status: str = "all",
    limit: int = 100,
    user: dict = Depends(get_current_user),
):
    """
    List exceptions from the live `exceptions` table.
    status: "pending" | "resolved" (includes archived) | "all"
    """
    params = {"select": "*", "order": "created_at.desc", "limit": str(min(limit, 500))}
    if status == "pending":
        params["status"] = "eq.pending"
    elif status == "resolved":
        params["status"] = "in.(resolved,archived)"
    try:
        rows = await select("exceptions", params)
        pending_count = await count("exceptions", {"status": "eq.pending"})
        resolved_count = await count("exceptions", {"status": "in.(resolved,archived)"})
    except SupabaseError as e:
        _handle(e)
    serialized = [_serialize_exception(r) for r in rows]
    return {
        "exceptions": serialized,
        "count": len(serialized),
        "pending_count": pending_count,
        "resolved_count": resolved_count,
    }


@router.get("/{exception_id}")
async def get_exception(exception_id: int, user: dict = Depends(get_current_user)):
    try:
        row = await select_one("exceptions", {"select": "*", "id": f"eq.{exception_id}"})
    except SupabaseError as e:
        _handle(e)
    if not row:
        raise HTTPException(status_code=404, detail=f"Exception {exception_id} not found")
    return _serialize_exception(row)


@router.post("/{exception_id}/decision")
async def decide_exception(
    exception_id: int,
    body: ExceptionDecisionRequest,
    user: dict = Depends(get_current_user),
):
    """
    Record a human decision on an exception: approve / modify / reject.
    Updates `exceptions` (status, human_decision, human_comment, resolved_at)
    and inserts a row into `human_feedback` for the audit trail.
    """
    try:
        current = await select_one("exceptions", {"select": "*", "id": f"eq.{exception_id}"})
        if not current:
            raise HTTPException(status_code=404, detail=f"Exception {exception_id} not found")

        now = datetime.now(timezone.utc).isoformat()
        patch = {
            "status": "archived" if body.decision == "archive" else "resolved",
            "human_decision": body.decision,
            "human_comment": body.comment,
            "resolved_at": now,
        }
        rows = await update("exceptions", {"id": f"eq.{exception_id}"}, patch)

        await insert(
            "human_feedback",
            {
                "run_id": current.get("run_id"),
                "exception_id": exception_id,
                "decision": body.decision,
                "comment": body.comment,
                "created_at": now,
            },
        )
    except SupabaseError as e:
        _handle(e)

    actor = user.get("email", "unknown") if user else "unknown"
    log.info(f"[OPS] Exception {exception_id} resolved as '{body.decision}' by {actor}")
    if not rows:
        raise HTTPException(status_code=404, detail=f"Exception {exception_id} not found")
    return _serialize_exception(rows[0])
