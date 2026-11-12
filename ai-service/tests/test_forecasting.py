"""Integration tests for the forecasting job (FR-17, Section 6.6, Eq. 6.5)."""

from __future__ import annotations

from datetime import datetime, timedelta

import pandas as pd
import pytest

from app import db
from app.config import local_now
from app.forecasting import SOURCE_BASELINE, SOURCE_RF, congestion_level, run_forecast

THRESHOLDS = {"high": 0.5, "critical": 0.9}  # seeded in the settings table


def _forecast_rows() -> pd.DataFrame:
    """All forecasts documents, ``forecast_hour`` converted from stored UTC to hospital local time."""
    docs = list(db.get_db()["forecasts"].find({}, sort=[("forecast_hour", 1), ("department_id", 1)]))
    frame = pd.DataFrame(docs)
    frame["forecast_hour"] = db.utc_series_to_local(frame["forecast_hour"])
    return frame


def test_congestion_level_boundaries():
    assert congestion_level(0.84, {"high": 0.85, "critical": 1.0}) == "NORMAL"
    assert congestion_level(0.85, {"high": 0.85, "critical": 1.0}) == "HIGH"
    assert congestion_level(1.0, {"high": 0.85, "critical": 1.0}) == "CRITICAL"


def test_forecast_job_writes_scheduled_hours(mongo, seed_forecast_history, forecast_expectations):
    now = datetime(2026, 10, 28, 10, 30)  # a Wednesday
    today = now.replace(hour=0, minute=0)
    seed_forecast_history(today)

    result = run_forecast(days=7, now=now)

    assert result["generated"] == forecast_expectations.rows(today, 7)
    assert result["modelVersion"] in (SOURCE_RF, SOURCE_BASELINE)
    evaluation = result["evaluation"]
    assert evaluation["testRows"] > 0 and evaluation["trainRows"] >= 50
    assert evaluation["baselineMae"] is not None and evaluation["rfMae"] is not None
    assert evaluation["selected"] == result["modelVersion"]

    rows = _forecast_rows()
    horizon = rows[rows["forecast_hour"] >= pd.Timestamp(today)]
    past = rows[rows["forecast_hour"] < pd.Timestamp(today)]
    # Stale rows inside AND after the horizon are gone: every future row now comes from this run.
    assert len(horizon) == result["generated"]
    assert (horizon["source"] == result["modelVersion"]).all()
    assert len(past) == 1 and past.iloc[0]["source"] == "stale"  # rows before the horizon kept
    assert horizon["forecast_hour"].max() < pd.Timestamp(today + timedelta(days=7))

    # Only scheduled hours of active branches/departments (branch 2 is INACTIVE, no Sunday sessions).
    assert set(horizon["branch_id"].astype(int)) == {1}
    assert set(horizon["department_id"].astype(int)) == {1, 2}
    assert not (horizon["forecast_hour"].dt.dayofweek == 6).any()
    cardiology = horizon[horizon["department_id"] == 1]
    ent = horizon[horizon["department_id"] == 2]
    assert set(cardiology["forecast_hour"].dt.hour) == {9, 10, 11, 12}
    assert set(ent["forecast_hour"].dt.hour) == {14, 15, 16}

    # Eq. 6.5 capacity: sum of 60 / c_j, pro-rated for the half hour 16:00-16:30. Doctors whose user
    # account or room is deactivated (doctors 5 and 6 in the fixture) add nothing.
    assert cardiology["capacity"].astype(float).to_numpy() == pytest.approx(forecast_expectations.dept1_capacity, abs=0.05)
    ent_16 = ent[ent["forecast_hour"].dt.hour == 16]["capacity"].astype(float)
    ent_14 = ent[ent["forecast_hour"].dt.hour == 14]["capacity"].astype(float)
    assert ent_16.to_numpy() == pytest.approx(forecast_expectations.dept2_half_hour, abs=0.05)
    assert ent_14.to_numpy() == pytest.approx(forecast_expectations.dept2_full_hour, abs=0.05)

    # Congestion level follows rho = expected / capacity with the thresholds from the settings table.
    for row in horizon.itertuples(index=False):
        ratio = float(row.expected_arrivals) / float(row.capacity)
        assert row.congestion_level == congestion_level(ratio, THRESHOLDS)
        assert float(row.expected_arrivals) >= 0

    # Monday surge (about 14/hour vs 8 on other days) is flagged as peak (80th percentile rule).
    monday = cardiology[cardiology["forecast_hour"].dt.dayofweek == 0]
    other_days = cardiology[cardiology["forecast_hour"].dt.dayofweek != 0]
    assert len(monday) == 4
    assert monday["is_peak"].astype(int).eq(1).all()
    assert monday["expected_arrivals"].astype(float).min() > other_days["expected_arrivals"].astype(float).max()
    assert other_days["is_peak"].astype(int).mean() <= 0.25


def test_forecast_job_is_idempotent(mongo, seed_forecast_history, forecast_expectations):
    now = datetime(2026, 10, 28, 10, 30)
    today = now.replace(hour=0, minute=0)
    seed_forecast_history(today)
    first = run_forecast(days=7, now=now)
    second = run_forecast(days=7, now=now)
    assert first["generated"] == second["generated"]
    assert len(_forecast_rows()) == second["generated"] + 1  # + the kept past row


def test_forecast_endpoint_longer_horizon(client, seed_forecast_history, forecast_expectations):
    today = local_now().replace(hour=0, minute=0, second=0, microsecond=0)
    seed_forecast_history(today)

    response = client.post("/ai/jobs/forecast", json={"days": 10})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["generated"] == forecast_expectations.rows(today, 10)
    assert body["modelVersion"] in (SOURCE_RF, SOURCE_BASELINE)

    response = client.post("/ai/jobs/forecast")  # body is optional, default 7 days
    assert response.status_code == 200, response.text
    assert response.json()["generated"] == forecast_expectations.rows(today, 7)

    assert client.post("/ai/jobs/forecast", json={"days": 0}).status_code == 422


def test_forecast_without_history_or_schedules(client):
    response = client.post("/ai/jobs/forecast", json={"days": 3})
    assert response.status_code == 200, response.text
    assert response.json()["generated"] == 0
    assert response.json()["modelVersion"] == SOURCE_BASELINE


def test_forecast_documents_follow_the_mongodb_design(mongo, seed_forecast_history):
    """Integer _id values reserved from counters (never reusing existing ids), UTC dates, booleans."""
    now = datetime(2026, 10, 28, 10, 30)
    today = now.replace(hour=0, minute=0)
    seed_forecast_history(today)
    result = run_forecast(days=2, now=now)

    docs = list(mongo["forecasts"].find({"forecast_hour": {"$gte": db.to_utc(today)}}))
    assert len(docs) == result["generated"] > 0
    ids = sorted(doc["_id"] for doc in docs)
    assert all(isinstance(i, int) for i in ids)
    assert ids[0] > 3  # the seeded documents had _id 1..3 and no counters entry
    assert ids == list(range(ids[0], ids[0] + len(ids)))  # one reserved block
    assert mongo["counters"].find_one({"_id": "forecasts"})["seq"] == ids[-1]
    for doc in docs:
        assert isinstance(doc["forecast_hour"], datetime) and isinstance(doc["generated_at"], datetime)
        assert isinstance(doc["is_peak"], bool)
        assert set(doc) == {"_id", "branch_id", "department_id", "forecast_hour", "expected_arrivals", "capacity",
                            "congestion_level", "is_peak", "source", "generated_at"}
    # Asia/Karachi is UTC+5: the first Cardiology hour (09:00 local) is stored as 04:00 UTC.
    first = min(doc["forecast_hour"] for doc in docs if doc["department_id"] == 1)
    assert first == db.to_utc(today.replace(hour=9)) == datetime(2026, 10, 28, 4, 0)
    assert docs[0]["generated_at"] == datetime(2026, 10, 28, 5, 30)

    run_forecast(days=2, now=now)  # a second run continues the counter
    later = mongo["forecasts"].find({"forecast_hour": {"$gte": db.to_utc(today)}})
    assert min(doc["_id"] for doc in later) > ids[-1]
