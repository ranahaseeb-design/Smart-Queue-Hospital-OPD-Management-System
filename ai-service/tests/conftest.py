"""Shared fixtures: an in-memory SQLite database with the tables the AI service reads/writes.

Table and column names match database/schema.mysql.sql; datetimes are stored as
'YYYY-MM-DD HH:MM:SS' strings and JSON columns as text, like the backend's SQLite dev DB.
"""

from __future__ import annotations

import json
import random
from dataclasses import replace
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import db
from app.config import settings
from app.predictor import registry
from app.security import TOKEN_HEADER

TEST_SERVICE_TOKEN = "test-ai-service-token"

SQLITE_SCHEMA = [
    """CREATE TABLE users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, role TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE branches (
        branch_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT,
        latitude REAL NOT NULL, longitude REAL NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE')""",
    """CREATE TABLE departments (
        department_id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL,
        specialty TEXT NOT NULL, name TEXT, is_active INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE service_points (
        service_point_id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL,
        type TEXT NOT NULL, name TEXT, is_active INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE doctors (
        doctor_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
        department_id INTEGER NOT NULL, avg_consult_minutes REAL NOT NULL DEFAULT 10.0,
        is_active INTEGER NOT NULL DEFAULT 1)""",
    """CREATE TABLE doctor_schedules (
        schedule_id INTEGER PRIMARY KEY AUTOINCREMENT, doctor_id INTEGER NOT NULL,
        service_point_id INTEGER NOT NULL, day_of_week INTEGER NOT NULL,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, max_patients INTEGER)""",
    """CREATE TABLE tokens (
        token_id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id INTEGER NOT NULL,
        service_point_id INTEGER NOT NULL, doctor_id INTEGER, appointment_id INTEGER UNIQUE,
        token_number INTEGER NOT NULL, token_date TEXT NOT NULL, queue_type TEXT NOT NULL,
        priority_level INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'WAITING',
        issued_at TEXT NOT NULL, called_at TEXT, completed_at TEXT,
        is_synthetic INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE wait_predictions (
        prediction_id INTEGER PRIMARY KEY AUTOINCREMENT, token_id INTEGER NOT NULL,
        predicted_minutes REAL NOT NULL, model_version TEXT NOT NULL, features_json TEXT,
        created_at TEXT NOT NULL)""",
    """CREATE TABLE forecasts (
        forecast_id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL,
        department_id INTEGER NOT NULL, forecast_hour TEXT NOT NULL, expected_arrivals REAL,
        capacity REAL, congestion_level TEXT NOT NULL, is_peak INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'baseline', generated_at TEXT NOT NULL)""",
    """CREATE TABLE model_versions (
        version TEXT PRIMARY KEY, trained_at TEXT NOT NULL, training_rows INTEGER NOT NULL,
        data_source TEXT NOT NULL, metrics_json TEXT NOT NULL, status TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE settings (
        setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)""",
]


def fmt(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S")


@pytest.fixture
def engine(tmp_path):
    """Fresh in-memory database + isolated settings for every test."""
    original = replace(settings)
    settings.models_dir = tmp_path / "models"
    settings.search_iter = 2  # keep the hyperparameter search quick in tests
    settings.n_jobs = 1  # single-threaded forests -> bit-for-bit reproducible predictions
    settings.min_training_rows = 200
    settings.ai_service_token = TEST_SERVICE_TOKEN
    settings.allow_unauthenticated = False
    eng = db.reset_engine("sqlite://")
    with eng.begin() as conn:
        for statement in SQLITE_SCHEMA:
            conn.execute(text(statement))
    registry.invalidate()
    yield eng
    registry.invalidate()
    for name in ("database_url", "models_dir", "search_iter", "n_jobs", "min_training_rows", "forecast_lookback_days",
                 "ai_service_token", "allow_unauthenticated",
                 "department_min_rows", "department_tolerance"):
        setattr(settings, name, getattr(original, name))
    db.reset_engine(original.database_url)


@pytest.fixture
def client(engine):
    from app.main import app

    with TestClient(app, headers={TOKEN_HEADER: TEST_SERVICE_TOKEN}) as test_client:
        yield test_client


@pytest.fixture
def anon_client(engine):
    """Client WITHOUT the X-AI-Service-Token header."""
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


# --------------------------------------------------------------------------- waiting-time history

TRUE_CONSULT = {1: 6.0, 2: 9.0, 3: 12.0, 4: 15.0}  # actual minutes per patient (registered avg is 10)
DEPARTMENT_OF = {1: 1, 2: 1, 3: 2, 4: 2}


def _seed_wait_history(eng, days: int = 40, per_session: int = 8, start: datetime = datetime(2026, 8, 3)) -> dict:
    """Synthetic tokens whose real wait depends on the doctor's *actual* consult time.

    The Eq. 6.2 baseline uses the registered average (10 min) and is therefore biased per
    doctor, while ``doctor_recent_consult`` lets the forest learn the true speed.
    A second, later prediction per token (patients_ahead = 0) checks that training uses
    the FIRST prediction of each token.
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
                        "token_id": token_id,
                        "visit_id": token_id,
                        "service_point_id": doctor_id,
                        "doctor_id": doctor_id,
                        "token_number": i + 1,
                        "token_date": day.strftime("%Y-%m-%d"),
                        "queue_type": "OPD",
                        "status": "COMPLETED" if called else "CANCELLED",
                        "issued_at": fmt(issued),
                        "called_at": fmt(called) if called else None,
                        "is_synthetic": 1,
                    }
                )
                first_predictions.append(
                    {"token_id": token_id, "minutes": 30.0, "features": json.dumps(features), "created_at": fmt(issued)}
                )
                later = dict(features, patients_ahead=0, priority_ahead=0)
                later_predictions.append(
                    {
                        "token_id": token_id,
                        "minutes": 5.0,
                        "features": json.dumps(later),
                        "created_at": fmt(issued + timedelta(minutes=1)),
                    }
                )

    with eng.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO tokens (token_id, visit_id, service_point_id, doctor_id, token_number, token_date, "
                "queue_type, status, issued_at, called_at, is_synthetic) VALUES (:token_id, :visit_id, "
                ":service_point_id, :doctor_id, :token_number, :token_date, :queue_type, :status, :issued_at, "
                ":called_at, :is_synthetic)"
            ),
            tokens,
        )
        insert_prediction = text(
            "INSERT INTO wait_predictions (token_id, predicted_minutes, model_version, features_json, created_at) "
            "VALUES (:token_id, :minutes, 'baseline', :features, :created_at)"
        )
        conn.execute(insert_prediction, first_predictions)
        conn.execute(insert_prediction, later_predictions)
    summary["tokens"] = len(tokens)
    return summary


@pytest.fixture
def seed_wait_history(engine):
    return lambda **kwargs: _seed_wait_history(engine, **kwargs)


# --------------------------------------------------------------------------- forecasting history

# (branch_id, department_id) -> hourly capacity used in assertions (Eq. 6.5).
DEPT1_CAPACITY = 60 / 10 + 60 / 12  # doctors 1 and 2, 09:00-13:00, Mon-Sat
DEPT2_FULL_HOUR = 60 / 15  # doctor 3, 14:00-16:30, Mon-Fri
DEPT2_HALF_HOUR = 30 / 15


def _seed_forecast_history(eng, today: datetime, weeks: int = 9) -> None:
    rng = random.Random(11)
    with eng.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO branches (branch_id, name, latitude, longitude, status) VALUES "
                "(1, 'Model Town', 31.48, 74.32, 'ACTIVE'), (2, 'Closed Branch', 31.50, 74.30, 'INACTIVE')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO departments (department_id, branch_id, specialty, name, is_active) VALUES "
                "(1, 1, 'Cardiology', 'Cardiology', 1), (2, 1, 'ENT', 'ENT', 1), (3, 2, 'ENT', 'ENT', 1)"
            )
        )
        # Doctor 5's user account and doctor 6's room are deactivated: like the backend's live Eq. 6.5,
        # they must not add forecast capacity although they still have schedules.
        conn.execute(
            text(
                "INSERT INTO users (user_id, full_name, role, is_active) VALUES "
                "(101, 'Dr A', 'STAFF', 1), (102, 'Dr B', 'STAFF', 1), (103, 'Dr C', 'STAFF', 1), "
                "(104, 'Dr D', 'STAFF', 1), (105, 'Dr E', 'STAFF', 0), (106, 'Dr F', 'STAFF', 1)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO service_points (service_point_id, branch_id, type, name, is_active) VALUES "
                "(1, 1, 'OPD', 'Room 1', 1), (2, 1, 'OPD', 'Room 2', 1), (3, 1, 'OPD', 'Room 3', 1), "
                "(4, 2, 'OPD', 'Room 4', 1), (5, 1, 'OPD', 'Room 5', 1), (6, 1, 'OPD', 'Room 6', 0)"
            )
        )
        conn.execute(
            text(
                "INSERT INTO doctors (doctor_id, user_id, department_id, avg_consult_minutes, is_active) VALUES "
                "(1, 101, 1, 10.0, 1), (2, 102, 1, 12.0, 1), (3, 103, 2, 15.0, 1), (4, 104, 3, 10.0, 1), "
                "(5, 105, 1, 10.0, 1), (6, 106, 2, 10.0, 1)"
            )
        )
        schedules = []
        for dow in range(1, 8):
            if dow <= 6:
                schedules.append({"doctor_id": 1, "sp": 1, "dow": dow, "start": "09:00", "end": "13:00"})
                schedules.append({"doctor_id": 2, "sp": 2, "dow": dow, "start": "09:00:00", "end": "13:00:00"})
                schedules.append({"doctor_id": 5, "sp": 5, "dow": dow, "start": "09:00", "end": "13:00"})  # inactive user
            if dow <= 5:
                schedules.append({"doctor_id": 3, "sp": 3, "dow": dow, "start": "14:00:00", "end": "16:30:00"})
                schedules.append({"doctor_id": 6, "sp": 6, "dow": dow, "start": "14:00", "end": "17:00"})  # inactive room
            schedules.append({"doctor_id": 4, "sp": 4, "dow": dow, "start": "09:00", "end": "17:00"})  # inactive branch
        conn.execute(
            text(
                "INSERT INTO doctor_schedules (doctor_id, service_point_id, day_of_week, start_time, end_time) "
                "VALUES (:doctor_id, :sp, :dow, :start, :end)"
            ),
            schedules,
        )
        conn.execute(
            text("INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (:k, :v, :u)"),
            {"k": "congestionThresholds", "v": json.dumps({"high": 0.5, "critical": 0.9}), "u": fmt(today)},
        )

        tokens = []
        number = 0

        def add(issued: datetime, doctor_id, queue_type: str = "OPD") -> None:
            nonlocal number
            number += 1
            tokens.append(
                {
                    "visit_id": number,
                    "sp": doctor_id or 99,
                    "doctor_id": doctor_id,
                    "number": number,
                    "date": issued.strftime("%Y-%m-%d"),
                    "queue_type": queue_type,
                    "issued_at": fmt(issued),
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
        for _ in range(30):  # today's tokens are not part of the (complete-day) history
            add(today.replace(hour=0, minute=30), 1)

        conn.execute(
            text(
                "INSERT INTO tokens (visit_id, service_point_id, doctor_id, token_number, token_date, queue_type, "
                "status, issued_at, is_synthetic) VALUES (:visit_id, :sp, :doctor_id, :number, :date, :queue_type, "
                "'COMPLETED', :issued_at, 1)"
            ),
            tokens,
        )

        # Stale rows: one inside the horizon and one after it (both must be replaced, e.g. what the
        # backend's JS fallback writes up to now + 7 days) and one in the past (must be kept).
        conn.execute(
            text(
                "INSERT INTO forecasts (branch_id, department_id, forecast_hour, expected_arrivals, capacity, "
                "congestion_level, is_peak, source, generated_at) VALUES "
                "(1, 1, :inside, 99.0, 1.0, 'CRITICAL', 1, 'stale', :gen), "
                "(1, 1, :after, 7.0, 11.0, 'NORMAL', 0, 'baseline', :gen), "
                "(1, 1, :past, 5.0, 11.0, 'NORMAL', 0, 'stale', :gen)"
            ),
            {
                "inside": fmt(today.replace(hour=3)),
                "after": fmt(today + timedelta(days=31, hours=10)),
                "past": fmt(today - timedelta(days=1, hours=-10)),
                "gen": fmt(today - timedelta(days=2)),
            },
        )


@pytest.fixture
def seed_forecast_history(engine):
    return lambda today, **kwargs: _seed_forecast_history(engine, today, **kwargs)


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
