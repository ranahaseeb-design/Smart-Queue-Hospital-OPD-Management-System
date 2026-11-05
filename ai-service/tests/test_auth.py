"""Shared-secret authentication of the internal AI service (X-AI-Service-Token)."""

from __future__ import annotations

import pytest

from app.config import settings
from app.security import TOKEN_HEADER

AI_CALLS = [
    ("POST", "/ai/predict-wait", {"items": []}),
    ("POST", "/ai/rank-branches", {"candidates": [], "weights": {"wait": 0.6, "distance": 0.25, "congestion": 0.15}}),
    ("POST", "/ai/jobs/forecast", {"days": 1}),
    ("POST", "/ai/models/retrain", None),
    ("GET", "/ai/models", None),
    ("POST", "/ai/models/rf-unknown/activate", None),
]


def _call(client, method, path, body, headers=None):
    if method == "GET":
        return client.get(path, headers=headers) if headers else client.get(path)
    return client.post(path, json=body, headers=headers) if headers else client.post(path, json=body)


def test_every_ai_route_requires_the_token():
    from app.main import app

    ai_routes = [r for r in app.routes if getattr(r, "path", "").startswith("/ai")]
    assert len(ai_routes) >= 6
    for route in ai_routes:
        deps = [d.call.__name__ for d in route.dependant.dependencies]
        assert "require_service_token" in deps, route.path


@pytest.mark.parametrize("method,path,body", AI_CALLS)
def test_missing_or_wrong_token_is_401(anon_client, method, path, body):
    assert _call(anon_client, method, path, body).status_code == 401
    wrong = _call(anon_client, method, path, body, headers={TOKEN_HEADER: "wrong-token"})
    assert wrong.status_code == 401
    assert TOKEN_HEADER in wrong.json()["detail"]


def test_health_stays_open(anon_client):
    assert anon_client.get("/health").status_code == 200


def test_valid_token_is_accepted(client):
    assert client.get("/ai/models").status_code == 200


def test_unconfigured_token_fails_closed_unless_dev_flag(anon_client):
    settings.ai_service_token = ""
    settings.allow_unauthenticated = False
    response = anon_client.get("/ai/models")
    assert response.status_code == 503
    assert "AI_SERVICE_TOKEN" in response.json()["detail"]

    settings.allow_unauthenticated = True
    assert anon_client.get("/ai/models").status_code == 200
