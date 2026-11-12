"""MongoDB access helpers: counters, UTC <-> hospital time, database errors (database/MONGODB_DESIGN.md)."""

from __future__ import annotations

from datetime import datetime

import pandas as pd

from app import db
from app.config import settings


def test_next_ids_reserves_blocks_atomically(mongo):
    assert db.next_ids("forecasts", 0) == []
    assert db.next_ids("forecasts", 3) == [1, 2, 3]
    assert db.next_ids("forecasts") == [4]
    assert mongo["counters"].find_one({"_id": "forecasts"}) == {"_id": "forecasts", "seq": 4}


def test_next_ids_never_reuses_existing_ids(mongo):
    """A collection filled without the counter (e.g. explicit ids from a seed) lifts the counter first."""
    mongo["forecasts"].insert_many([{"_id": 10}, {"_id": 41}])
    assert db.next_ids("forecasts", 2) == [42, 43]
    mongo["counters"].update_one({"_id": "forecasts"}, {"$set": {"seq": 100}})  # counter ahead: kept
    assert db.next_ids("forecasts") == [101]


def test_hospital_time_conversion():
    assert settings.hospital_tz == "Asia/Karachi"
    local = datetime(2026, 10, 28, 9, 0)
    assert db.to_utc(local) == datetime(2026, 10, 28, 4, 0)
    assert db.to_local(datetime(2026, 10, 28, 4, 0)) == local
    assert db.to_utc(None) is None and db.to_local(None) is None
    series = pd.Series([datetime(2026, 10, 27, 19, 30), None])
    converted = db.utc_series_to_local(series)
    assert converted.iloc[0] == pd.Timestamp(2026, 10, 28, 0, 30)
    assert pd.isna(converted.iloc[1])


def test_database_name_comes_from_the_uri_or_mongodb_db(mongo):
    import mongomock

    original = settings.mongodb_db
    try:
        settings.mongodb_db = ""
        assert db._select_database(mongomock.MongoClient("mongodb://h:27017/opd_a?replicaSet=rs0")).name == "opd_a"
        assert db._select_database(mongomock.MongoClient("mongodb://h:27017/")).name == db.DEFAULT_DB_NAME
        settings.mongodb_db = "opd_b"
        assert db._select_database(mongomock.MongoClient("mongodb://h:27017/opd_a")).name == "opd_b"
    finally:
        settings.mongodb_db = original


def test_database_errors_answer_503_and_health_reports_db_false(client, monkeypatch):
    def unavailable():
        raise db.DatabaseError("server selection timed out")

    monkeypatch.setattr(db, "get_db", unavailable)
    response = client.get("/ai/models")
    assert response.status_code == 503
    assert response.json()["detail"].startswith("Database unavailable")
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["db"] is False and health.json()["activeModel"] is None
