"""MongoDB access helpers (pymongo) and value conversions.

The AI service shares the backend's MongoDB database (database/MONGODB_DESIGN.md): one collection
per former table, field names identical to the old SQL columns, integer ``_id`` values allocated
from the ``counters`` collection, datetimes stored as BSON Date in UTC.

pymongo is imported only when a real client is created, so the test-suite can run on
``mongomock`` alone (pure Python; injected with :func:`set_client`).

Time zones: pymongo returns BSON dates as timezone-naive UTC ``datetime`` values, and naive
datetimes passed to it are stored as UTC. The service works in naive hospital-local time
(``HOSPITAL_TZ``) internally, so every value crossing the database boundary goes through
:func:`to_utc` (writing / query bounds) or :func:`to_local` (reading).
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Iterable

import pandas as pd

from .config import settings

log = logging.getLogger(__name__)

DEFAULT_DB_NAME = "smart_opd"

try:  # the real driver; absent in the Pyodide test harness, where mongomock stands in
    from pymongo.errors import PyMongoError as DatabaseError
except ImportError:  # pragma: no cover - exercised only without pymongo

    class DatabaseError(Exception):  # type: ignore[no-redef]
        """Placeholder so ``except DatabaseError`` works when pymongo is not installed."""


_client: Any = None
_database: Any = None
_lock = threading.Lock()


def _make_client(uri: str) -> Any:
    from pymongo import MongoClient  # imported lazily (see module docstring)

    return MongoClient(
        uri,
        tz_aware=False,  # BSON dates come back as naive UTC datetimes
        serverSelectionTimeoutMS=settings.mongodb_timeout_ms,
        connectTimeoutMS=settings.mongodb_timeout_ms,
        appname="smart-opd-ai",
    )


def _select_database(client: Any) -> Any:
    """``MONGODB_DB`` when set, otherwise the database named in the URI path, else ``smart_opd``."""
    if settings.mongodb_db:
        return client[settings.mongodb_db]
    return client.get_default_database(default=DEFAULT_DB_NAME)


def get_db() -> Any:
    """The shared ``Database`` handle (pymongo's MongoClient is thread-safe and pools connections)."""
    global _client, _database
    with _lock:
        if _database is None:
            _client = _make_client(settings.mongodb_uri)
            _database = _select_database(_client)
        return _database


def set_client(client: Any, db_name: str | None = None) -> Any:
    """Use an existing client (tests inject ``mongomock.MongoClient()``); returns the Database."""
    global _client, _database
    with _lock:
        _client = client
        _database = client[db_name] if db_name else _select_database(client)
        return _database


def reset_client(uri: str | None = None) -> None:
    """Close the current client and (optionally) point the service at another MongoDB URI.

    The next :func:`get_db` call connects lazily.
    """
    global _client, _database
    with _lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:  # pragma: no cover - closing a mock / already closed client
                pass
        _client = None
        _database = None
        if uri is not None:
            settings.mongodb_uri = uri


def ping() -> bool:
    """True when the database answers (used by /health)."""
    try:
        get_db().command("ping")
        return True
    except Exception as exc:
        log.warning("MongoDB ping failed: %s", exc)
        return False


def next_ids(collection: str, count: int = 1) -> list[int]:
    """Reserve ``count`` consecutive integer ``_id`` values from ``counters`` (MONGODB_DESIGN.md).

    One atomic ``$inc`` by ``count`` (upsert, return the document after the update) reserves the
    whole block, so concurrent writers (the backend increments the same counter by 1) never
    receive overlapping ids. A ``$max`` first lifts the counter to the largest existing ``_id`` in
    case documents were inserted without it (e.g. a seed script that wrote explicit ids).
    """
    if count <= 0:
        return []
    database = get_db()
    newest = database[collection].find_one({}, projection={"_id": 1}, sort=[("_id", -1)])
    if newest is not None and isinstance(newest.get("_id"), int):
        database["counters"].update_one({"_id": collection}, {"$max": {"seq": int(newest["_id"])}}, upsert=True)
    counter = database["counters"].find_one_and_update(
        {"_id": collection},
        {"$inc": {"seq": int(count)}},
        upsert=True,
        return_document=True,  # pymongo ReturnDocument.AFTER
    )
    last = int(counter["seq"])
    return list(range(last - count + 1, last + 1))


def run_transaction(work: Callable[[Any], None]) -> None:
    """Run ``work(session)`` in a multi-document transaction when the deployment supports it.

    The design requires a replica set (``rs0``), where ``with_transaction`` makes a delete+insert
    or a deactivate+insert atomic and retries transient errors. On a standalone server or with
    mongomock (no sessions) the same writes run without a transaction (``session=None``).
    """
    database = get_db()
    client = getattr(database, "client", None)
    session = None
    try:
        session = client.start_session() if client is not None else None
    except Exception as exc:  # mongomock: NotImplementedError
        log.debug("Sessions not available (%s); writing without a transaction", exc)
    if session is None:
        work(None)
        return
    try:
        with session:
            session.with_transaction(lambda s: work(s))
    except DatabaseError as exc:
        # Code 20 IllegalOperation: "Transaction numbers are only allowed on a replica set member
        # or mongos". The aborted transaction wrote nothing, so the plain writes are safe to run.
        if getattr(exc, "code", None) == 20 or "replica set" in str(exc).lower():
            log.warning("MongoDB is not a replica set; writing without a transaction")
            work(None)
        else:
            raise


# --------------------------------------------------------------------------- time zones


def _zone():
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(settings.hospital_tz)
    except Exception:  # unknown zone / no tz database
        return None


def to_utc(value: datetime | None) -> datetime | None:
    """Naive hospital-local datetime -> naive UTC datetime (what pymongo stores as a BSON Date)."""
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        value = value.to_pydatetime()
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    zone = _zone()
    if zone is None:
        return value
    return value.replace(tzinfo=zone).astimezone(timezone.utc).replace(tzinfo=None)


def to_local(value: datetime | None) -> datetime | None:
    """Naive UTC datetime from MongoDB -> naive hospital-local datetime."""
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        value = value.to_pydatetime()
    zone = _zone()
    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if zone is None:
        return aware.replace(tzinfo=None)
    return aware.astimezone(zone).replace(tzinfo=None)


def utc_series_to_local(series: pd.Series) -> pd.Series:
    """Column of naive UTC timestamps -> naive hospital-local timestamps (NaT stays NaT)."""
    parsed = to_datetime_series(series)
    if parsed.empty:
        return parsed
    zone = settings.hospital_tz if _zone() is not None else None
    if zone is None:
        return parsed
    return parsed.dt.tz_localize("UTC").dt.tz_convert(zone).dt.tz_localize(None)


# --------------------------------------------------------------------------- value helpers


def parse_json(value: Any) -> Any:
    """Embedded objects come back as dicts; tolerate a JSON string (data migrated from SQL text)."""
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
    if hasattr(value, "to_decimal"):  # bson.Decimal128
        value = value.to_decimal()
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
    """'YYYY-MM-DD HH:MM:SS' (hospital local time), used in model-file metadata."""
    return value.strftime("%Y-%m-%d %H:%M:%S")


def iso_dt(value: Any) -> str | None:
    """Serialise a hospital-local datetime for the API: 'YYYY-MM-DDTHH:mm:ss' without a zone suffix."""
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
        return value.strftime("%Y-%m-%d %H:%M:%S.%f")
    return str(value).strip() or None


def to_datetime_series(series: pd.Series) -> pd.Series:
    """Parse a column of datetimes into naive pandas timestamps (unparseable values -> NaT).

    BSON dates arrive as ``datetime`` objects; strings (data migrated as text) are accepted too.
    """
    if pd.api.types.is_datetime64_any_dtype(series):
        return series.dt.tz_localize(None) if getattr(series.dt, "tz", None) is not None else series
    if series.empty:
        return pd.Series(pd.NaT, index=series.index, dtype="datetime64[ns]")
    as_text = series.map(_datetime_text)
    return pd.to_datetime(as_text, errors="coerce", format="mixed")


def time_to_minutes(value: Any) -> float | None:
    """Schedule times: 'HH:mm:ss' strings (MONGODB_DESIGN.md); 'HH:mm', time and timedelta accepted."""
    if value is None:
        return None
    if isinstance(value, timedelta):
        return value.total_seconds() / 60.0
    if isinstance(value, (time, datetime)):
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
