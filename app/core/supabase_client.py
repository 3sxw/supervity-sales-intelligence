# app/core/supabase_client.py
"""
Minimal async REST client for Supabase (PostgREST), used exclusively by the
backend. The service-role key never leaves this process — it is not exposed
to the frontend in any response.
"""

import logging
import os
import time

import httpx

log = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")

_TIMEOUT = httpx.Timeout(15.0)


class SupabaseError(Exception):
    """Raised when Supabase is not configured or a REST call fails."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def is_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def _headers(prefer: str | None = None) -> dict:
    headers = {
        "apikey": SUPABASE_SECRET_KEY,
        "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _require_configured():
    if not is_configured():
        raise SupabaseError(
            503,
            "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.",
        )


async def select(table: str, params: dict | None = None) -> list[dict]:
    """GET rows from a table. `params` are raw PostgREST query params."""
    _require_configured()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/{table}", headers=_headers(), params=params or {}
        )
    if r.status_code >= 400:
        log.error(f"Supabase select failed for {table}: {r.status_code} {r.text}")
        raise SupabaseError(r.status_code, r.text)
    return r.json()


async def select_one(table: str, params: dict | None = None) -> dict | None:
    rows = await select(table, params)
    return rows[0] if rows else None


async def count(table: str, params: dict | None = None) -> int:
    """Return the total row count matching a filter, via Content-Range."""
    _require_configured()
    p = dict(params or {})
    p.setdefault("select", "*")
    p["limit"] = "1"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers(prefer="count=exact"),
            params=p,
        )
    if r.status_code >= 400:
        log.error(f"Supabase count failed for {table}: {r.status_code} {r.text}")
        raise SupabaseError(r.status_code, r.text)
    cr = r.headers.get("content-range", "")
    if "/" in cr:
        total = cr.split("/")[-1]
        return int(total) if total.isdigit() else 0
    return len(r.json())


async def update(table: str, params: dict, data: dict) -> list[dict]:
    """PATCH rows matching `params` (e.g. {'id': 'eq.P03'}) with `data`."""
    _require_configured()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.patch(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers(prefer="return=representation"),
            params=params,
            json=data,
        )
    if r.status_code >= 400:
        log.error(f"Supabase update failed for {table}: {r.status_code} {r.text}")
        raise SupabaseError(r.status_code, r.text)
    return r.json()


async def insert(table: str, data: dict | list[dict]) -> list[dict]:
    """POST new row(s) into a table."""
    _require_configured()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers(prefer="return=representation"),
            json=data,
        )
    if r.status_code >= 400:
        log.error(f"Supabase insert failed for {table}: {r.status_code} {r.text}")
        raise SupabaseError(r.status_code, r.text)
    return r.json()


async def health_check() -> dict:
    """
    Real backend query against Supabase to confirm connectivity/latency.
    Never returns a fabricated "healthy" state — only what was observed.
    """
    if not is_configured():
        return {
            "connected": False,
            "detail": "SUPABASE_URL / SUPABASE_SECRET_KEY not set",
            "latency_ms": None,
        }
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                f"{SUPABASE_URL}/rest/v1/policies",
                headers=_headers(),
                params={"select": "id", "limit": "1"},
            )
        latency_ms = round((time.monotonic() - start) * 1000)
        if r.status_code < 400:
            return {"connected": True, "detail": "Query succeeded", "latency_ms": latency_ms}
        return {
            "connected": False,
            "detail": f"HTTP {r.status_code}",
            "latency_ms": latency_ms,
        }
    except Exception as e:
        return {"connected": False, "detail": str(e), "latency_ms": None}
