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


@dataclass
class Settings:
    database_url: str
    models_dir: Path
    n_jobs: int  # parallel jobs for scikit-learn forests (-1 = all cores)
    search_iter: int  # RandomizedSearchCV iterations during retraining
    min_training_rows: int  # retraining is refused below this many labelled tokens
    forecast_lookback_days: int  # history window used by the forecasting job
    hospital_tz: str  # hospital local time zone (all DB datetimes are naive local time)
    log_level: str


def load_settings() -> Settings:
    return Settings(
        database_url=os.getenv("DATABASE_URL", "sqlite:///../backend/data/smart_opd.db"),
        models_dir=Path(os.getenv("MODELS_DIR", "./models")),
        n_jobs=_int_env("AI_N_JOBS", -1),
        search_iter=max(1, _int_env("AI_SEARCH_ITER", 8)),
        min_training_rows=max(1, _int_env("AI_MIN_TRAINING_ROWS", 200)),
        forecast_lookback_days=max(14, _int_env("AI_FORECAST_LOOKBACK_DAYS", 182)),
        hospital_tz=os.getenv("HOSPITAL_TZ", "Asia/Karachi"),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )


# Mutable singleton so tests and the CLI can override values at runtime.
settings = load_settings()


def local_now() -> datetime:
    """Current hospital local time as a naive datetime (matches how the DB stores datetimes)."""
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(settings.hospital_tz)).replace(tzinfo=None, microsecond=0)
    except Exception:  # unknown zone / no tz database: fall back to the server clock
        return datetime.now().replace(microsecond=0)
