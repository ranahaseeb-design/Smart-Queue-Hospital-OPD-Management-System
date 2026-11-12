"""Runtime configuration, read from environment variables (and an optional .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

try:  # python-dotenv is optional at runtime; it is listed in requirements.txt
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


DEFAULT_MONGODB_URI = "mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0"


@dataclass
class Settings:
    mongodb_uri: str  # MONGODB_URI (database/MONGODB_DESIGN.md)
    mongodb_db: str  # MONGODB_DB; empty = the database named in the URI path (else smart_opd)
    mongodb_timeout_ms: int  # server selection / connect timeout, so /health and requests fail fast
    models_dir: Path
    n_jobs: int  # parallel jobs for scikit-learn forests (-1 = all cores)
    search_iter: int  # RandomizedSearchCV iterations during retraining
    min_training_rows: int  # retraining is refused below this many labelled tokens
    forecast_lookback_days: int  # history window used by the forecasting job
    hospital_tz: str  # hospital local time zone (DB datetimes are UTC; hours and weekdays use this zone)
    log_level: str
    ai_service_token: str = ""  # shared secret expected in the X-AI-Service-Token header
    allow_unauthenticated: bool = False  # dev only: accept /ai/* calls when no token is configured
    department_min_rows: int = 30  # Section 6.7.3: a "major" department has at least this many test rows
    department_tolerance: float = 1.2  # ... and is rejected if its MAE > tolerance x its baseline MAE


def load_settings() -> Settings:
    return Settings(
        mongodb_uri=os.getenv("MONGODB_URI", "").strip() or DEFAULT_MONGODB_URI,
        mongodb_db=os.getenv("MONGODB_DB", "").strip(),
        mongodb_timeout_ms=max(500, _int_env("MONGODB_TIMEOUT_MS", 3000)),
        models_dir=Path(os.getenv("MODELS_DIR", "./models")),
        n_jobs=_int_env("AI_N_JOBS", -1),
        search_iter=max(1, _int_env("AI_SEARCH_ITER", 8)),
        min_training_rows=max(1, _int_env("AI_MIN_TRAINING_ROWS", 200)),
        forecast_lookback_days=max(14, _int_env("AI_FORECAST_LOOKBACK_DAYS", 182)),
        hospital_tz=os.getenv("HOSPITAL_TZ", "Asia/Karachi"),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        ai_service_token=os.getenv("AI_SERVICE_TOKEN", "").strip(),
        allow_unauthenticated=_bool_env("AI_ALLOW_UNAUTHENTICATED", False),
        department_min_rows=max(1, _int_env("AI_DEPARTMENT_MIN_ROWS", 30)),
        department_tolerance=max(1.0, _float_env("AI_DEPARTMENT_TOLERANCE", 1.2)),
    )


# Mutable singleton so tests and the CLI can override values at runtime.
settings = load_settings()


def local_now() -> datetime:
    """Current hospital local time as a naive datetime (db.to_utc converts it before it is stored)."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(settings.hospital_tz)).replace(tzinfo=None, microsecond=0)
    except Exception:  # unknown zone / no tz database: fall back to the server clock
        return datetime.now().replace(microsecond=0)
