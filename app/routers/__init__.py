# app/routers/__init__.py
"""
API Routers - Modular endpoint organization.

Note: File endpoints are defined in main.py to maintain proper path ordering.
"""

from .admin import router as admin_router
from .audit import router as audit_router
from .auth import router as auth_router
from .examples import router as examples_router
from .health import router as health_router
from .items import router as items_router
from .ops_agents import router as ops_agents_router
from .ops_data_manager import router as ops_data_manager_router
from .ops_insights import router as ops_insights_router
from .ops_overview import router as ops_overview_router
from .ops_policies import router as ops_policies_router
from .ops_workbench import router as ops_workbench_router

__all__ = [
    "health_router",
    "auth_router",
    "admin_router",
    "audit_router",
    "items_router",
    "examples_router",
    "ops_overview_router",
    "ops_agents_router",
    "ops_policies_router",
    "ops_workbench_router",
    "ops_insights_router",
    "ops_data_manager_router",
]
