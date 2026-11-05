"""Shared-secret authentication of the internal AI service.

Every ``/ai/*`` endpoint requires the header ``X-AI-Service-Token`` to equal the environment
variable ``AI_SERVICE_TOKEN`` (the backend sends it from its own ``AI_SERVICE_TOKEN``).
``/health`` stays open for container health checks.

If ``AI_SERVICE_TOKEN`` is not configured the endpoints answer 503 (fail closed), unless the
development flag ``AI_ALLOW_UNAUTHENTICATED=true`` is set.
"""

from __future__ import annotations

import hmac
from typing import Optional

from fastapi import Header, HTTPException

from .config import settings

TOKEN_HEADER = "X-AI-Service-Token"


async def require_service_token(
    x_ai_service_token: Optional[str] = Header(default=None, alias=TOKEN_HEADER),
) -> None:
    expected = (settings.ai_service_token or "").strip()
    if not expected:
        if settings.allow_unauthenticated:
            return
        raise HTTPException(
            status_code=503,
            detail="AI_SERVICE_TOKEN is not configured on the AI service "
            "(set it, or AI_ALLOW_UNAUTHENTICATED=true for local development only)",
        )
    supplied = (x_ai_service_token or "").strip()
    if not supplied or not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail=f"Missing or invalid {TOKEN_HEADER} header")
