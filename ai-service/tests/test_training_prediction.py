"""Integration tests: retraining (FR-22, Sections 6.4/6.7), the model registry and prediction (FR-06/FR-07)."""

from __future__ import annotations

import joblib
import pytest
from sqlalchemy import text

from app import db, predictor
from app.config import settings
from app.features import FEATURES
from app.predictor import registry
from app.training import load_training_data

PREDICT_BODY = {
    "items": [
        {
            "tokenId": 101,
            "features": {
                "patients_ahead": 5, "priority_ahead": 1, "doctor_avg_consult": 10.0,
                "doctor_recent_consult": 6.2, "interruptions_last_hour": 0, "session_started": 1,
                "minutes_to_start": 0, "hour_of_day": 9, "day_of_week": 2, "appointments_ahead": 0,
                "department_load": 3.5, "doctor_id": 1, "department_id": 1, "branch_id": 1,
            },
        },
        {
            "tokenId": 102,
            "features": {
                "patients_ahead": 9, "priority_ahead": 0, "doctor_avg_consult": 10.0,
                "doctor_recent_consult": 14.8, "interruptions_last_hour": 2, "session_started": False,
                "minutes_to_start": 20, "hour_of_day": 8, "day_of_week": 5, "appointments_ahead": 1,
                "department_load": 6.0, "doctor_id": 4, "department_id": 2, "branch_id": 1,
            },
        },
    ]
}


def _model_rows(engine) -> dict[str, dict]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT version, status, is_active, data_source, training_rows FROM model_versions")).mappings().all()
    return {row["version"]: dict(row) for row in rows}


def test_health_without_model(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["activeModel"] is None


def test_predict_without_active_model_returns_503(client):
    response = client.post("/ai/predict-wait", json=PREDICT_BODY)
    assert response.status_code == 503
    assert "detail" in response.json()


def test_retrain_refused_below_200_rows(client, seed_wait_history):
    seed_wait_history(days=5, per_session=8)  # 160 tokens, fewer than 200 labelled rows
    response = client.post("/ai/models/retrain")
    assert response.status_code == 400
    assert "200" in response.json()["detail"]
    assert client.get("/ai/models").json() == []


def test_training_set_uses_first_prediction_per_called_token(engine, seed_wait_history):
    summary = seed_wait_history(days=10)
    data = load_training_data()
    assert len(data) == summary["called"]  # uncalled (cancelled) tokens are excluded
    assert list(data.X.columns) == FEATURES
    # Later predictions were stored with patients_ahead = 0; the first ones carry the real values.
    assert data.X["patients_ahead"].sum() == pytest.approx(summary["patients_ahead_sum"])
    assert data.issued_at.is_monotonic_increasing  # chronological order for the 80/20 split
    assert (data.y >= 0).all()


def _no_reload(version):
    raise AssertionError(f"model {version} was reloaded from disk instead of served from the cache")


def test_retrain_predict_and_activate_flow(client, engine, seed_wait_history, monkeypatch):
    seed_wait_history(days=40)

    # --- first model: must beat the Eq. 6.2 baseline and becomes ACTIVE
    response = client.post("/ai/models/retrain")
    assert response.status_code == 200, response.text
    first = response.json()
    version = first["version"]
    assert version.startswith("rf-") and len(version) <= 20
    metrics = first["metrics"]
    assert set(metrics) >= {"mae", "rmse", "r2", "within10", "baselineMae", "testRows"}
    assert metrics["testRows"] > 0
    assert metrics["mae"] < metrics["baselineMae"]
    assert first["accepted"] is True and first["activated"] is True

    rows = _model_rows(engine)
    assert rows[version]["status"] == "ACTIVE"
    assert db.to_bool(rows[version]["is_active"])
    assert rows[version]["data_source"] == "synthetic"
    # The accepted model is served from memory at once (no file reload on the first prediction,
    # which could exceed the backend's 1.5 s timeout for a large forest).
    assert registry.cached_version() == version

    bundle = joblib.load(settings.models_dir / f"{version}.joblib")
    assert bundle["features"] == FEATURES
    assert set(bundle["feature_importances"]) == set(FEATURES)
    assert bundle["training_period"]["from"] < bundle["training_period"]["to"]

    assert client.get("/health").json()["activeModel"] == version
    listed = client.get("/ai/models").json()
    assert listed[0]["version"] == version and listed[0]["isActive"] is True
    assert listed[0]["metrics"]["baselineMae"] == metrics["baselineMae"]

    # --- prediction with the active model (served from the cache: loading the file would fail here)
    monkeypatch.setattr(predictor, "load_bundle", _no_reload)
    response = client.post("/ai/predict-wait", json=PREDICT_BODY)
    monkeypatch.undo()
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["modelVersion"] == version
    assert [p["tokenId"] for p in body["predictions"]] == [101, 102]
    for prediction in body["predictions"]:
        value = prediction["predictedMinutes"]
        assert value >= 0
        assert round(value, 1) == pytest.approx(value)
    # Doctor 4 is slow and has more patients ahead plus a start delay: a longer wait is expected.
    assert body["predictions"][1]["predictedMinutes"] > body["predictions"][0]["predictedMinutes"]

    # --- second model on identical data: same MAE as the active model -> not strictly better -> REJECTED
    response = client.post("/ai/models/retrain")
    assert response.status_code == 200, response.text
    second = response.json()
    assert second["version"] != version
    assert second["activeModelMae"] is not None
    assert second["accepted"] is False and second["activated"] is False
    rows = _model_rows(engine)
    assert rows[second["version"]]["status"] == "REJECTED"
    assert db.to_bool(rows[version]["is_active"])

    # --- manual activation (FR-22): the previous active version is retired
    response = client.post(f"/ai/models/{second['version']}/activate")
    assert response.status_code == 200, response.text
    assert response.json() == {"version": second["version"], "activated": True}
    rows = _model_rows(engine)
    assert rows[second["version"]]["status"] == "ACTIVE" and db.to_bool(rows[second["version"]]["is_active"])
    assert rows[version]["status"] == "RETIRED" and not db.to_bool(rows[version]["is_active"])
    assert registry.cached_version() == second["version"]  # activation warms the cache
    monkeypatch.setattr(predictor, "load_bundle", _no_reload)
    assert client.post("/ai/predict-wait", json=PREDICT_BODY).json()["modelVersion"] == second["version"]
    monkeypatch.undo()

    assert client.post("/ai/models/rf-unknown/activate").status_code == 404


def test_data_source_label_and_synthetic_share():
    import pandas as pd

    from app.training import data_source_label, synthetic_share

    assert data_source_label(pd.Series([True, True])) == "synthetic"
    assert data_source_label(pd.Series([False, False])) == "pilot"
    assert data_source_label(pd.Series([True, False, False])) == "mixed"
    assert synthetic_share(pd.Series([True, False, False, False])) == 0.25
    assert synthetic_share(pd.Series([], dtype=bool)) == 0.0


def test_retrain_with_pilot_rows_is_mixed_and_stores_shares(client, engine, seed_wait_history):
    import json

    seed_wait_history(days=40)
    # The newest tokens (test period) come from the pilot deployment, not the synthetic history.
    with engine.begin() as conn:
        cutoff = conn.execute(text("SELECT MAX(issued_at) FROM tokens")).scalar()
        conn.execute(text("UPDATE tokens SET is_synthetic = 0 WHERE issued_at >= date(:c, '-3 day')"), {"c": cutoff})
    response = client.post("/ai/models/retrain")
    assert response.status_code == 200, response.text
    body = response.json()
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT data_source, metrics_json FROM model_versions WHERE version = :v"), {"v": body["version"]}
        ).mappings().one()
    assert row["data_source"] == "mixed"
    stored = json.loads(row["metrics_json"])
    assert stored["syntheticShareTrain"] == 1.0
    assert 0.0 <= stored["syntheticShareTest"] < 1.0
