"""Database access helpers (SQLAlchemy 2 Core, portable between MySQL 8 and SQLite).

All SQL uses ``text()`` with named parameters and avoids dialect-specific functions;
datetimes are parsed in pandas rather than in SQL so the same queries work on the
canonical MySQL schema (database/schema.mysql.sql) and the backend's SQLite dev DB.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, time, timedelta
from decimal import Decimal
from typing import Any, Iterable, Mapping

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool

from .config import settings

_engine: Engine | None = None
_engine_lock = threading.Lock()


def _is_memory_sqlite(url: str) -> bool:
    return url.rstrip("/") in ("sqlite:", "sqlite://", "sqlite:///:memory:") or ":memory:" in url or "mode=memory" in url


def _make_engine(url: str) -> Engine:
    kwargs: dict[str, Any] = {}
    if url.startswith("sqlite"):
        # FastAPI runs sync endpoints in a thread pool, so connections cross threads.
        kwargs["connect_args"] = {"check_same_thread": False}
        if _is_memory_sqlite(url):
            # One shared connection, otherwise every thread would see its own empty database (tests).
            kwargs["poolclass"] = StaticPool
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_recycle"] = 1800
    return create_engine(url, **kwargs)


def get_engine() -> Engine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = _make_engine(settings.database_url)
        return _engine


def reset_engine(url: str | None = None) -> Engine:
    """Dispose the current engine and (optionally) point the service at a new database URL."""
    global _engine
    with _engine_lock:
        if _engine is not None:
            _engine.dispose()
        if url is not None:
            settings.database_url = url
        _engine = _make_engine(settings.database_url)
        return _engine


def dialect_name(engine: Engine | None = None) -> str:
    return (engine or get_engine()).dialect.name


# --------------------------------------------------------------------------- queries


def fetch_all(sql: str, params: Mapping[str, Any] | None = None, engine: Engine | None = None) -> list[dict]:
    with (engine or get_engine()).connect() as conn:
        result = conn.execute(text(sql), dict(params or {}))
        return [dict(row) for row in result.mappings().all()]


def fetch_df(sql: str, params: Mapping[str, Any] | None = None, engine: Engine | None = None) -> pd.DataFrame:
    with (engine or get_engine()).connect() as conn:
        result = conn.execute(text(sql), dict(params or {}))
        columns = list(result.keys())
        rows = result.fetchall()
    return pd.DataFrame([tuple(r) for r in rows], columns=columns)


def fetch_scalar(sql: str, params: Mapping[str, Any] | None = None, engine: Engine | None = None) -> Any:
    with (engine or get_engine()).connect() as conn:
        return conn.execute(text(sql), dict(params or {})).scalar()


# --------------------------------------------------------------------------- value helpers


def parse_json(value: Any) -> Any:
    """JSON columns come back as str from SQLite (and sometimes from MySQL drivers)."""
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        return json.loads(value)
    return value


def to_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def to_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "t", "yes")
    return bool(value)


def fmt_dt(value: datetime) -> str:
    """Format for DATETIME columns: 'YYYY-MM-DD HH:MM:SS' (hospital local time)."""
    return value.strftime("%Y-%m-%d %H:%M:%S")


def iso_dt(value: Any) -> str | None:
    """Serialise a DB datetime for the API: 'YYYY-MM-DDTHH:mm:ss' without a zone suffix."""
    if value is None:
        return None
    if isinstance(value, str):
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            return value
        value = parsed.to_pydatetime()
    if isinstance(value, pd.Timestamp):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        return value.replace(microsecond=0, tzinfo=None).strftime("%Y-%m-%dT%H:%M:%S")
    return str(value)


def _datetime_text(value: Any) -> str | None:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value).strip() or None


def to_datetime_series(series: pd.Series) -> pd.Series:
    """Parse a column of DB datetimes into naive pandas timestamps.

    MySQL/PyMySQL returns ``datetime`` objects; the SQLite dev DB returns
    'YYYY-MM-DD HH:MM:SS' strings (an ISO 'T' separator is accepted too). Unparseable
    values become NaT.
    """
    if pd.api.types.is_datetime64_any_dtype(series):
        return series.dt.tz_localize(None) if getattr(series.dt, "tz", None) is not None else series
    if series.empty:
        return pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")
    as_text = series.map(_datetime_text)
    return pd.to_datetime(as_text, errors="coerce", format="mixed")


def time_to_minutes(value: Any) -> float | None:
    """TIME columns: PyMySQL returns timedelta, SQLite returns 'HH:MM' or 'HH:MM:SS' strings."""
    if value is None:
        return None
    if isinstance(value, timedelta):
        return value.total_seconds() / 60.0
    if isinstance(value, time):
        return value.hour * 60 + value.minute + value.second / 60.0
    if isinstance(value, datetime):
        return value.hour * 60 + value.minute + value.second / 60.0
    text_value = str(value).strip()
    if "T" in text_value:
        text_value = text_value.split("T", 1)[1]
    elif " " in text_value:
        text_value = text_value.split(" ", 1)[1]
    parts = text_value.split(":")
    try:
        hours = int(parts[0])
        minutes = int(parts[1]) if len(parts) > 1 else 0
        seconds = float(parts[2]) if len(parts) > 2 else 0.0
    except (ValueError, IndexError):
        return None
    return hours * 60 + minutes + seconds / 60.0


def chunked(items: list, size: int) -> Iterable[list]:
    for start in range(0, len(items), size):
        yield items[start : start + size]
