"""Shared fixtures: an in-memory MongoDB (mongomock) holding the collections the AI service reads/writes.

Collection and field names follow database/MONGODB_DESIGN.md: integer ``_id`` values, foreign keys
under their SQL column names, ``wait_predictions.features`` and ``settings.value`` as embedded
objects, ``model_versions._id`` = version, datetimes stored as naive **UTC** ``datetime`` values
(BSON Date). The generators below think in hospital-local time and convert with ``db.to_utc``, so
the tests also exercise the UTC <-> HOSPITAL_TZ handling.
"""

from __future__ import annotations

import random
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace

import mongomock
import pytest
from fastapi.testclient import TestClient

from app import db
from app.config import settings
from app.predictor import registry
from app.security import TOKEN_HEADER

TEST_SERVICE_TOKEN = "test-ai-service-token"
TEST_DB_NAME = "smart_opd_test"


def utc(local: datetime) -> datetime:
    """Hospital-local naive datetime -> the naive UTC value MongoDB stores."""
    return db.to_utc(local)


def new_database():
    """A fresh mongomock database registered as the service's database."""
    return db.set_client(mongomock.MongoClient(), TEST_DB_NAME)


@pytest.fixture
def mongo(tmp_path):
    """Fresh in-memory MongoDB + isolated settings for every test; yields the Database handle."""
    original = replace(settings)
    settings.models_dir = tmp_path / "models"
    settings.search_iter = 2  # keep the hyperparameter search quick in tests
    settings.n_jobs = 1  # single-threaded forests -> bit-for-bit reproducible predictions
    settings.min_training_rows = 200
    settings.ai_service_token = TEST_SERVICE_TOKEN
    settings.allow_unauthenticated = False
    database = new_database()
    registry.invalidate()
    yield database
    registry.invalidate()
    for name in ("mongodb_uri", "mongodb_db", "models_dir", "search_iter", "n_jobs", "min_training_rows",
                 "forecast_lookback_days", "ai_service_token", "allow_unauthenticated",
                 "department_min_rows", "department_tolerance"):
        setattr(settings, name, getattr(original, name))
    db.reset_client()


@pytest.fixture
def client(mongo):
    from app.main import app

    with TestClient(app, headers={TOKEN_HEADER: TEST_SERVICE_TOKEN}) as test_client:
        yield test_client


@pytest.fixture
def anon_client(mongo):
    """Client WITHOUT the X-AI-Service-Token header."""
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


# --------------------------------------------------------------------------- waiting-time history

TRUE_CONSULT = {1: 6.0, 2: 9.0, 3: 12.0, 4: 15.0}  # actual minutes per patient (registered avg is 10)
DEPARTMENT_OF = {1: 1, 2: 1, 3: 2, 4: 2}


def _seed_wait_history(database, days: int = 40, per_session: int = 8, start: datetime = datetime(2026, 8, 3)) -> dict:
    """Synthetic tokens whose real wait depends on the doctor's *actual* consult time.

    The Eq. 6.2 baseline uses the registered average (10 min) and is therefore biased per
    doctor, while ``doctor_recent_consult`` lets the forest learn the true speed.
    A second, later prediction per token (patients_ahead = 0, higher ``_id``) checks that
    training uses the FIRST prediction of each token.
    """
    rng = random.Random(7)
    tokens, first_predictions, later_predictions = [], [], []
    token_id = 0
    summary = {"called": 0, "patients_ahead_sum": 0.0}
    for d in range(days):
        day = start + timedelta(days=d)
        for doctor_id, consult in TRUE_CONSULT.items():
            for i in range(per_session):
                token_id += 1
                issued = day.replace(hour=8) + timedelta(minutes=9 * i + rng.randint(0, 5))
                started = rng.random() < 0.6
                patients_ahead = rng.randint(0, 12)
                features = {
                    "patients_ahead": patients_ahead,
                    # priority tokens ahead are a subset of the patients ahead (as in the backend)
                    "priority_ahead": min(patients_ahead, rng.randint(0, 2)),
                    "doctor_avg_consult": 10.0,
                    "doctor_recent_consult": round(consult + rng.uniform(-1.0, 1.0), 1),
                    "interruptions_last_hour": rng.randint(0, 3),
                    "session_started": started,
                    "minutes_to_start": 0 if started else rng.randint(5, 60),
                    "hour_of_day": issued.hour,
                    "day_of_week": issued.isoweekday(),
                    "appointments_ahead": rng.randint(0, 2),
                    "department_load": round(rng.uniform(1.0, 8.0), 1),
                    "doctor_id": doctor_id,
                    "department_id": DEPARTMENT_OF[doctor_id],
                    "branch_id": 1,
                }
                wait = features["patients_ahead"] * consult
                wait = max(0.0, wait + features["minutes_to_start"] + rng.gauss(0.0, 2.0))
                called = None if rng.random() < 0.05 else issued + timedelta(minutes=wait)
                if called is not None:
                    summary["called"] += 1
                    summary["patients_ahead_sum"] += features["patients_ahead"]
                tokens.append(
                    {
                        "_id": token_id,
                        "visit_id": token_id,
                        "service_point_id": doctor_id,
                        "doctor_id": doctor_id,
                        "appointment_id": None,
                        "token_number": i + 1,
                        "token_date": day.strftime("%Y-%m-%d"),
                        "queue_type": "OPD",
                        "priority_level": 0,
                        "status": "COMPLETED" if called else "CANCELLED",
                        "issued_at": utc(issued),
                        "called_at": utc(called) if called else None,
                        "completed_at": None,
                        "is_synthetic": True,
                    }
                )
                first_predictions.append(
                    {"token_id": token_id, "predicted_minutes": 30.0, "model_version": "baseline",
                     "features": features, "created_at": utc(issued)}
                )
                later = dict(features, patients_ahead=0, priority_ahead=0)
                later_predictions.append(
                    {"token_id": token_id, "predicted_minutes": 5.0, "model_version": "baseline",
                     "features": later, "created_at": utc(issued + timedelta(minutes=1))}
                )

    database["tokens"].insert_many(tokens)
    # Integer ids in insertion order (as allocated from counters): every first prediction has a
    # lower _id than the later prediction of the same token.
    predictions = first_predictions + later_predictions
    for new_id, doc in enumerate(predictions, start=1):
        doc["_id"] = new_id
    database["wait_predictions"].insert_many(predictions)
    database["counters"].insert_many(
        [{"_id": "tokens", "seq": len(tokens)}, {"_id": "wait_predictions", "seq": len(predictions)}]
    )
    summary["tokens"] = len(tokens)
    return summary


@pytest.fixture
def seed_wait_history(mongo):
    return lambda **kwargs: _seed_wait_history(mongo, **kwargs)


# --------------------------------------------------------------------------- forecasting history

# (branch_id, department_id) -> hourly capacity used in assertions (Eq. 6.5).
DEPT1_CAPACITY = 60 / 10 + 60 / 12  # doctors 1 and 2, 09:00-13:00, Mon-Sat
DEPT2_FULL_HOUR = 60 / 15  # doctor 3, 14:00-16:30, Mon-Fri
DEPT2_HALF_HOUR = 30 / 15


def _seed_forecast_history(database, today: datetime, weeks: int = 9) -> None:
    rng = random.Random(11)
    database["branches"].insert_many(
        [
            {"_id": 1, "name": "Model Town", "address": None, "latitude": 31.48, "longitude": 74.32, "status": "ACTIVE"},
            {"_id": 2, "name": "Closed Branch", "address": None, "latitude": 31.50, "longitude": 74.30, "status": "INACTIVE"},
        ]
    )
    database["departments"].insert_many(
        [
            {"_id": 1, "branch_id": 1, "specialty": "Cardiology", "name": "Cardiology", "is_active": True},
            {"_id": 2, "branch_id": 1, "specialty": "ENT", "name": "ENT", "is_active": True},
            {"_id": 3, "branch_id": 2, "specialty": "ENT", "name": "ENT", "is_active": True},
        ]
    )
    # Doctor 5's user account and doctor 6's room are deactivated: like the backend's live Eq. 6.5,
    # they must not add forecast capacity although they still have schedules.
    database["users"].insert_many(
        [
            {"_id": uid, "full_name": name, "role": "STAFF", "is_active": active}
            for uid, name, active in (
                (101, "Dr A", True), (102, "Dr B", True), (103, "Dr C", True),
                (104, "Dr D", True), (105, "Dr E", False), (106, "Dr F", True),
            )
        ]
    )
    database["service_points"].insert_many(
        [
            {"_id": sp, "branch_id": branch, "type": "OPD", "name": f"Room {sp}", "is_active": active}
            for sp, branch, active in ((1, 1, True), (2, 1, True), (3, 1, True), (4, 2, True), (5, 1, True), (6, 1, False))
        ]
    )
    database["doctors"].insert_many(
        [
            {"_id": did, "user_id": uid, "department_id": dep, "avg_consult_minutes": c, "is_active": True}
            for did, uid, dep, c in ((1, 101, 1, 10.0), (2, 102, 1, 12.0), (3, 103, 2, 15.0), (4, 104, 3, 10.0),
                                     (5, 105, 1, 10.0), (6, 106, 2, 10.0))
        ]
    )
    schedules = []

    def schedule(doctor_id: int, sp: int, dow: int, start: str, end: str) -> None:
        schedules.append(
            {"_id": len(schedules) + 1, "doctor_id": doctor_id, "service_point_id": sp, "day_of_week": dow,
             "start_time": start, "end_time": end, "max_patients": None}
        )

    for dow in range(1, 8):
        if dow <= 6:
            schedule(1, 1, dow, "09:00:00", "13:00:00")
            schedule(2, 2, dow, "09:00:00", "13:00:00")
            schedule(5, 5, dow, "09:00:00", "13:00:00")  # inactive user
        if dow <= 5:
            schedule(3, 3, dow, "14:00:00", "16:30:00")
            schedule(6, 6, dow, "14:00", "17:00")  # inactive room (also: 'HH:mm' is tolerated)
        schedule(4, 4, dow, "09:00:00", "17:00:00")  # inactive branch
    database["doctor_schedules"].insert_many(schedules)
    database["settings"].insert_one(
        {"_id": "congestionThresholds", "value": {"high": 0.5, "critical": 0.9}, "updated_at": utc(today)}
    )

    tokens = []

    def add(issued: datetime, doctor_id, queue_type: str = "OPD") -> None:
        number = len(tokens) + 1
        tokens.append(
            {
                "_id": number,
                "visit_id": number,
                "service_point_id": doctor_id or 99,
                "doctor_id": doctor_id,
                "token_number": number,
                "token_date": issued.strftime("%Y-%m-%d"),
                "queue_type": queue_type,
                "priority_level": 0,
                "status": "COMPLETED",
                "issued_at": utc(issued),
                "called_at": None,
                "is_synthetic": True,
            }
        )

    for d in range(weeks * 7, 0, -1):
        day = today - timedelta(days=d)
        dow = day.isoweekday()
        if dow <= 6:  # Cardiology: Monday surge (FR-17 peak hours)
            for hour in range(9, 13):
                count = (14 if dow == 1 else 8) + rng.randint(-1, 1)
                for i in range(count):
                    add(day.replace(hour=hour, minute=rng.randint(0, 59)), 1 + i % 2)
        if dow <= 5:  # ENT afternoon session
            for hour, count in ((14, 5), (15, 5), (16, 2)):
                for _ in range(count):
                    add(day.replace(hour=hour, minute=rng.randint(0, 29)), 3)
        for _ in range(10):  # LAB tokens are not OPD arrivals
            add(day.replace(hour=10, minute=rng.randint(0, 59)), None, "LAB")
    # Today's tokens are not part of the (complete-day) history. 00:30 local is still the previous
    # day in UTC, so this also checks that the history bounds are converted to UTC.
    for _ in range(30):
        add(today.replace(hour=0, minute=30), 1)
    database["tokens"].insert_many(tokens)

    # Stale documents: one inside the horizon and one after it (both must be replaced, e.g. what the
    # backend's JS fallback writes up to now + 7 days) and one in the past (must be kept). No
    # counters document exists yet: the job must not reuse these _id values.
    generated = utc(today - timedelta(days=2))
    database["forecasts"].insert_many(
        [
            {"_id": 1, "branch_id": 1, "department_id": 1, "forecast_hour": utc(today.replace(hour=3)),
             "expected_arrivals": 99.0, "capacity": 1.0, "congestion_level": "CRITICAL", "is_peak": True,
             "source": "stale", "generated_at": generated},
            {"_id": 2, "branch_id": 1, "department_id": 1, "forecast_hour": utc(today + timedelta(days=31, hours=10)),
             "expected_arrivals": 7.0, "capacity": 11.0, "congestion_level": "NORMAL", "is_peak": False,
             "source": "baseline", "generated_at": generated},
            {"_id": 3, "branch_id": 1, "department_id": 1, "forecast_hour": utc(today - timedelta(days=1, hours=-10)),
             "expected_arrivals": 5.0, "capacity": 11.0, "congestion_level": "NORMAL", "is_peak": False,
             "source": "stale", "generated_at": generated},
        ]
    )


@pytest.fixture
def seed_forecast_history(mongo):
    return lambda today, **kwargs: _seed_forecast_history(mongo, today, **kwargs)


def expected_forecast_rows(today: datetime, days: int) -> int:
    """Scheduled hours in the horizon: Cardiology 09-12 Mon-Sat (4/day), ENT 14-16 Mon-Fri (3/day)."""
    total = 0
    for d in range(days):
        dow = (today + timedelta(days=d)).isoweekday()
        total += 4 if dow <= 6 else 0
        total += 3 if dow <= 5 else 0
    return total


@pytest.fixture
def forecast_expectations():
    return SimpleNamespace(
        rows=expected_forecast_rows,
        dept1_capacity=DEPT1_CAPACITY,
        dept2_full_hour=DEPT2_FULL_HOUR,
        dept2_half_hour=DEPT2_HALF_HOUR,
    )
