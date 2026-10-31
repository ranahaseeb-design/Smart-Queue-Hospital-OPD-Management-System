"""Peak-hour / arrival forecasting and congestion levels (Section 6.6) — FR-17 (inputs for FR-18).

Steps of the ``/ai/jobs/forecast`` job:

1. Hourly OPD token arrivals (``tokens.issued_at``, ``queue_type = 'OPD'``) are counted per
   branch and department over the history window (complete days before today), zero-filled
   on a regular hourly grid.
2. Two forecasters are back-tested on the last 2 weeks of history (Section 6.7.2, MAE on
   hourly arrivals):
     * seasonal baseline — the mean of the same weekday and hour over the previous 4 weeks;
     * a RandomForestRegressor on calendar features (day of week, hour) and the arrivals in
       the same hour 1..4 weeks earlier (plus their mean).
   The one with the lower MAE is used (``source`` = ``rf-forecast`` or ``seasonal-baseline``).
3. Hourly capacity per department comes from the current ``doctor_schedules`` and each
   doctor's ``avg_consult_minutes`` (Eq. 6.5: C_h = sum over doctors on duty of 60 / c_j,
   pro-rated when a doctor is on duty for only part of the hour).
4. Congestion ratio rho = expected / capacity; level NORMAL < high <= HIGH < critical <=
   CRITICAL with the thresholds from the ``settings`` row ``congestionThresholds``.
   ``is_peak`` = expected arrivals above the 80th percentile of that branch-department's
   historical hourly arrivals (operating hours only).
5. Every existing ``forecasts`` row from today 00:00 onwards is deleted and the new rows are
   inserted, so a run replaces all future forecasts, including rows beyond its horizon written by
   the backend's JS fallback (now .. now + 7 days) or by an earlier, longer run; sources never mix.
   Only hours in which at least one doctor of the department is scheduled are written. Capacity
   counts only doctors who can take patients (active doctor, user account and room), like the
   backend's live Eq. 6.5 congestion ratio.

The horizon covers whole days starting today 00:00 (hospital local time), so the admin
dashboard can show a complete day; it uses no data from today itself.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sqlalchemy import text

from . import db
from .config import local_now, settings

log = logging.getLogger(__name__)

HOURS_PER_WEEK = 7 * 24
LAG_WEEKS = 4
BACKTEST_DAYS = 14
PEAK_PERCENTILE = 80.0
MIN_RF_TRAIN_ROWS = 50
DEFAULT_THRESHOLDS = {"high": 0.85, "critical": 1.0}
DEFAULT_CONSULT_MINUTES = 10.0
SOURCE_RF = "rf-forecast"
SOURCE_BASELINE = "seasonal-baseline"
LAG_COLUMNS = [f"lag_{k}w" for k in range(1, LAG_WEEKS + 1)]
FORECAST_FEATURES = ["day_of_week", "hour", *LAG_COLUMNS, "lag_mean"]
RANDOM_STATE = 42

ARRIVALS_SQL = """
SELECT t.issued_at AS issued_at,
       dep.branch_id AS branch_id,
       dep.department_id AS department_id
FROM tokens t
JOIN doctors d ON d.doctor_id = t.doctor_id
JOIN departments dep ON dep.department_id = d.department_id
WHERE t.queue_type = 'OPD'
  AND t.issued_at >= :since
  AND t.issued_at < :until
"""

SCHEDULES_SQL = """
SELECT ds.doctor_id AS doctor_id,
       ds.day_of_week AS day_of_week,
       ds.start_time AS start_time,
       ds.end_time AS end_time,
       d.avg_consult_minutes AS avg_consult_minutes,
       dep.department_id AS department_id,
       dep.branch_id AS branch_id
FROM doctor_schedules ds
JOIN doctors d ON d.doctor_id = ds.doctor_id
JOIN users u ON u.user_id = d.user_id
JOIN service_points sp ON sp.service_point_id = ds.service_point_id
JOIN departments dep ON dep.department_id = d.department_id
JOIN branches b ON b.branch_id = dep.branch_id
WHERE d.is_active = 1
  AND u.is_active = 1
  AND sp.is_active = 1
  AND dep.is_active = 1
  AND b.status = 'ACTIVE'
"""

INSERT_SQL = """
INSERT INTO forecasts (branch_id, department_id, forecast_hour, expected_arrivals, capacity,
                       congestion_level, is_peak, source, generated_at)
VALUES (:branch_id, :department_id, :forecast_hour, :expected_arrivals, :capacity,
        :congestion_level, :is_peak, :source, :generated_at)
"""

Key = tuple[int, int]  # (branch_id, department_id)

_forecast_lock = threading.Lock()


class ForecastBusyError(Exception):
    """Another forecasting job is running."""


@dataclass
class Backtest:
    rf_mae: float | None = None
    baseline_mae: float | None = None
    train_rows: int = 0
    test_rows: int = 0
    selected: str = SOURCE_BASELINE

    def as_dict(self) -> dict:
        return {
            "rfMae": None if self.rf_mae is None else round(self.rf_mae, 3),
            "baselineMae": None if self.baseline_mae is None else round(self.baseline_mae, 3),
            "trainRows": self.train_rows,
            "testRows": self.test_rows,
            "selected": self.selected,
        }


@dataclass
class ForecastGrid:
    """Regular hourly grid from the first history day to the end of the horizon."""

    index: pd.DatetimeIndex
    today_pos: int  # position of today 00:00 (= first horizon hour)
    values: dict[Key, np.ndarray] = field(default_factory=dict)  # arrivals (NaN in the horizon)

    def __post_init__(self) -> None:
        self.day_of_week = np.asarray(self.index.dayofweek, dtype=int) + 1  # 1 = Monday ... 7 = Sunday
        self.hour = np.asarray(self.index.hour, dtype=int)


# --------------------------------------------------------------------------- inputs


def load_congestion_thresholds() -> dict[str, float]:
    """``settings.congestionThresholds`` ({high, critical}); defaults 0.85 / 1.0 (Section 6.6.2)."""
    try:
        raw = db.fetch_scalar(
            "SELECT setting_value FROM settings WHERE setting_key = :k", {"k": "congestionThresholds"}
        )
        value = db.parse_json(raw) if raw is not None else None
    except Exception as exc:  # missing table / bad JSON: keep the documented defaults
        log.warning("Could not read congestionThresholds, using defaults: %s", exc)
        value = None
    thresholds = dict(DEFAULT_THRESHOLDS)
    if isinstance(value, dict):
        for name in ("high", "critical"):
            number = db.to_float(value.get(name))
            if number is not None and number > 0:
                thresholds[name] = number
    if thresholds["critical"] < thresholds["high"]:
        thresholds["high"], thresholds["critical"] = thresholds["critical"], thresholds["high"]
    return thresholds


def congestion_level(ratio: float, thresholds: dict[str, float]) -> str:
    """NORMAL when rho < theta1, HIGH when theta1 <= rho < theta2, CRITICAL when rho >= theta2."""
    if ratio >= thresholds["critical"]:
        return "CRITICAL"
    if ratio >= thresholds["high"]:
        return "HIGH"
    return "NORMAL"


def build_capacity(schedules: pd.DataFrame) -> dict[Key, np.ndarray]:
    """Eq. 6.5 per department: array [day_of_week 1..7, hour 0..23] of patients/hour.

    A doctor on duty for m minutes of an hour contributes m / c_j (= 60 / c_j for a full hour).
    """
    per_doctor: dict[tuple[Key, int], np.ndarray] = {}
    consult: dict[int, float] = {}
    for row in schedules.to_dict("records"):
        try:
            dow = int(row["day_of_week"])
            doctor_id = int(row["doctor_id"])
            key = (int(row["branch_id"]), int(row["department_id"]))
        except (TypeError, ValueError):
            continue
        start = db.time_to_minutes(row["start_time"])
        end = db.time_to_minutes(row["end_time"])
        if not 1 <= dow <= 7 or start is None or end is None or end <= start:
            continue
        c = db.to_float(row["avg_consult_minutes"], DEFAULT_CONSULT_MINUTES) or DEFAULT_CONSULT_MINUTES
        consult[doctor_id] = c if c > 0 else DEFAULT_CONSULT_MINUTES
        minutes = per_doctor.setdefault((key, doctor_id), np.zeros((8, 24)))
        for hour in range(24):
            overlap = min(end, (hour + 1) * 60.0) - max(start, hour * 60.0)
            if overlap > 0:
                minutes[dow, hour] += overlap

    capacity: dict[Key, np.ndarray] = {}
    for (key, doctor_id), minutes in per_doctor.items():
        on_duty = np.minimum(minutes, 60.0)  # overlapping sessions of one doctor count once
        capacity.setdefault(key, np.zeros((8, 24)))
        capacity[key] += on_duty / consult[doctor_id]
    return capacity


def load_arrivals(since: datetime, until: datetime) -> pd.DataFrame:
    """Hourly OPD arrivals per (branch, department) with columns hour, branch_id, department_id, arrivals."""
    raw = db.fetch_df(ARRIVALS_SQL, {"since": db.fmt_dt(since), "until": db.fmt_dt(until)})
    if raw.empty:
        return pd.DataFrame(columns=["hour", "branch_id", "department_id", "arrivals"])
    raw["issued_at"] = db.to_datetime_series(raw["issued_at"])
    raw = raw.dropna(subset=["issued_at", "branch_id", "department_id"])
    raw = raw[(raw["issued_at"] >= pd.Timestamp(since)) & (raw["issued_at"] < pd.Timestamp(until))].copy()
    if raw.empty:
        return pd.DataFrame(columns=["hour", "branch_id", "department_id", "arrivals"])
    raw["hour"] = raw["issued_at"].dt.floor("h")
    raw["branch_id"] = raw["branch_id"].astype(int)
    raw["department_id"] = raw["department_id"].astype(int)
    return raw.groupby(["hour", "branch_id", "department_id"]).size().reset_index(name="arrivals")


def build_grid(arrivals: pd.DataFrame, keys: list[Key], today: datetime, days: int) -> ForecastGrid:
    first_day = today
    if not arrivals.empty:
        first_day = min(today, pd.Timestamp(arrivals["hour"].min()).normalize().to_pydatetime())
    index = pd.date_range(start=first_day, end=today + timedelta(days=days), freq="h", inclusive="left")
    today_pos = int(index.get_loc(pd.Timestamp(today)))
    grid = ForecastGrid(index=index, today_pos=today_pos)

    positions = pd.Series(np.arange(len(index)), index=index)
    for key in keys:
        values = np.zeros(len(index), dtype=float)  # hours without tokens had 0 arrivals
        values[today_pos:] = np.nan  # the horizon is unknown
        grid.values[key] = values
    if not arrivals.empty:
        for row in arrivals.itertuples(index=False):
            key = (int(row.branch_id), int(row.department_id))
            pos = positions.get(pd.Timestamp(row.hour))
            if key in grid.values and pos is not None and pos < today_pos:
                grid.values[key][int(pos)] = float(row.arrivals)
    return grid


# --------------------------------------------------------------------------- features


def lag_features(values: np.ndarray, positions: np.ndarray) -> np.ndarray:
    """Arrivals in the same hour 1..4 weeks earlier, shape (len(positions), 4); NaN when unavailable."""
    lags = np.full((len(positions), LAG_WEEKS), np.nan)
    for k in range(1, LAG_WEEKS + 1):
        source = positions - k * HOURS_PER_WEEK
        ok = source >= 0
        lags[ok, k - 1] = values[source[ok]]
    return lags


def seasonal_baseline(lags: np.ndarray) -> np.ndarray:
    """Mean of the same weekday and hour over the previous 4 weeks (ignoring unavailable weeks; none -> 0)."""
    available = ~np.isnan(lags)
    counts = available.sum(axis=1)
    sums = np.where(available, lags, 0.0).sum(axis=1)
    return np.where(counts > 0, sums / np.maximum(counts, 1), 0.0)


def feature_frame(grid: ForecastGrid, values: np.ndarray, positions: np.ndarray) -> pd.DataFrame:
    lags = lag_features(values, positions)
    mean = seasonal_baseline(lags)
    filled = np.where(np.isnan(lags), mean[:, None], lags)  # short history: use the available mean
    frame = pd.DataFrame(filled, columns=LAG_COLUMNS)
    frame.insert(0, "hour", grid.hour[positions].astype(float))
    frame.insert(0, "day_of_week", grid.day_of_week[positions].astype(float))
    frame["lag_mean"] = mean
    return frame[FORECAST_FEATURES]


def _relevant_mask(grid: ForecastGrid, key: Key, capacity: dict[Key, np.ndarray]) -> np.ndarray:
    """Operating hours: a doctor is scheduled (current schedules) or tokens were issued."""
    values = grid.values[key]
    cap = capacity.get(key)
    scheduled = cap[grid.day_of_week, grid.hour] > 0 if cap is not None else np.zeros(len(values), dtype=bool)
    with np.errstate(invalid="ignore"):
        return scheduled | (np.nan_to_num(values, nan=0.0) > 0)


# --------------------------------------------------------------------------- model selection


def _history_rows(grid: ForecastGrid, capacity: dict[Key, np.ndarray]) -> pd.DataFrame:
    """Labelled history rows with all 4 lags observed, pooled over departments."""
    frames = []
    all_positions = np.arange(grid.today_pos)
    for key, values in grid.values.items():
        if grid.today_pos == 0:
            break
        mask = _relevant_mask(grid, key, capacity)[: grid.today_pos]
        positions = all_positions[mask & (all_positions >= LAG_WEEKS * HOURS_PER_WEEK)]
        if len(positions) == 0:
            continue
        frame = feature_frame(grid, values, positions)
        frame["target"] = values[positions]
        frame["position"] = positions
        frames.append(frame)
    if not frames:
        return pd.DataFrame(columns=[*FORECAST_FEATURES, "target", "position"])
    return pd.concat(frames, ignore_index=True)


def _new_forest() -> RandomForestRegressor:
    return RandomForestRegressor(
        n_estimators=200, min_samples_leaf=2, random_state=RANDOM_STATE, n_jobs=settings.n_jobs
    )


def select_model(grid: ForecastGrid, capacity: dict[Key, np.ndarray]) -> tuple[RandomForestRegressor | None, Backtest]:
    """Back-test RF vs the seasonal baseline on the last 2 weeks; refit the RF on all rows if it wins."""
    result = Backtest()
    rows = _history_rows(grid, capacity)
    if rows.empty:
        return None, result

    test_start = grid.today_pos - BACKTEST_DAYS * 24
    is_test = rows["position"].to_numpy() >= test_start
    train, test = rows[~is_test], rows[is_test]
    result.train_rows, result.test_rows = int(len(train)), int(len(test))
    if len(test) == 0:
        return None, result

    y_test = test["target"].to_numpy(dtype=float)
    result.baseline_mae = float(np.mean(np.abs(y_test - test["lag_mean"].to_numpy(dtype=float))))
    if len(train) < MIN_RF_TRAIN_ROWS:
        return None, result

    forest = _new_forest()
    forest.fit(train[FORECAST_FEATURES], train["target"].to_numpy(dtype=float))
    rf_pred = np.clip(forest.predict(test[FORECAST_FEATURES]), 0.0, None)
    result.rf_mae = float(np.mean(np.abs(y_test - rf_pred)))
    if result.rf_mae >= result.baseline_mae:
        return None, result

    result.selected = SOURCE_RF
    final = _new_forest()
    final.fit(rows[FORECAST_FEATURES], rows["target"].to_numpy(dtype=float))
    return final, result


def predict_horizon(grid: ForecastGrid, model: RandomForestRegressor | None) -> None:
    """Fill the horizon part of every series, one week at a time.

    Lags of the first horizon week are all observed; for horizons longer than 7 days the
    previous week's forecasts stand in for the unknown lags (recursive forecasting).
    """
    total = len(grid.index)
    for block_start in range(grid.today_pos, total, HOURS_PER_WEEK):
        positions = np.arange(block_start, min(block_start + HOURS_PER_WEEK, total))
        for values in grid.values.values():
            frame = feature_frame(grid, values, positions)
            if model is not None:
                predicted = model.predict(frame)
            else:
                predicted = frame["lag_mean"].to_numpy(dtype=float)
            values[positions] = np.clip(np.asarray(predicted, dtype=float), 0.0, None)


def peak_thresholds(grid: ForecastGrid, capacity: dict[Key, np.ndarray]) -> dict[Key, float | None]:
    """80th percentile of historical hourly arrivals per branch-department (operating hours)."""
    out: dict[Key, float | None] = {}
    for key, values in grid.values.items():
        mask = _relevant_mask(grid, key, capacity)[: grid.today_pos]
        history = values[: grid.today_pos][mask]
        out[key] = float(np.percentile(history, PEAK_PERCENTILE)) if len(history) else None
    return out


# --------------------------------------------------------------------------- job


def run_forecast(days: int = 7, now: datetime | None = None) -> dict:
    """FR-17: generate hourly forecasts for ``days`` days and write them to ``forecasts``."""
    if not _forecast_lock.acquire(blocking=False):
        raise ForecastBusyError("A forecasting job is already running.")
    try:
        return _run_forecast_locked(max(1, int(days)), now or local_now())
    finally:
        _forecast_lock.release()


def _run_forecast_locked(days: int, now: datetime) -> dict:
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    horizon_end = today + timedelta(days=days)
    history_from = today - timedelta(days=settings.forecast_lookback_days)

    capacity = build_capacity(db.fetch_df(SCHEDULES_SQL))
    thresholds = load_congestion_thresholds()
    arrivals = load_arrivals(history_from, today)

    # Only departments that currently have scheduled doctors can be forecast; departments
    # with history but no schedule are still useful training data for the pooled RF.
    keys = sorted(set(capacity) | {(int(b), int(d)) for b, d in arrivals[["branch_id", "department_id"]].itertuples(index=False)})
    grid = build_grid(arrivals, keys, today, days)

    model, backtest = select_model(grid, capacity)
    source = backtest.selected
    peaks = peak_thresholds(grid, capacity)
    predict_horizon(grid, model)

    generated_at = db.fmt_dt(now)
    rows: list[dict[str, Any]] = []
    dow = grid.day_of_week
    hours = grid.hour
    for key, cap in capacity.items():
        values = grid.values[key]
        peak_threshold = peaks.get(key)
        for pos in range(grid.today_pos, len(grid.index)):
            hourly_capacity = float(cap[dow[pos], hours[pos]])
            if hourly_capacity <= 0:
                continue  # no doctor scheduled in this hour
            # The level is derived from the values actually stored (DECIMAL(6,1)), so anyone who
            # recomputes rho = expected_arrivals / capacity from the row (the backend does, for
            # /api/admin/forecasts congestionRatio) gets the same level.
            expected = round(float(values[pos]), 1)
            stored_capacity = max(0.1, round(hourly_capacity, 1))
            ratio = expected / stored_capacity
            rows.append(
                {
                    "branch_id": key[0],
                    "department_id": key[1],
                    "forecast_hour": db.fmt_dt(grid.index[pos].to_pydatetime()),
                    "expected_arrivals": expected,
                    "capacity": stored_capacity,
                    "congestion_level": congestion_level(ratio, thresholds),
                    "is_peak": 1 if peak_threshold is not None and expected > peak_threshold else 0,
                    "source": source,
                    "generated_at": generated_at,
                }
            )

    with db.get_engine().begin() as conn:
        # Replace every future forecast, not only the horizon: the backend's JS fallback writes
        # now .. now + 7 days, so its rows past today + days would otherwise linger beside ours.
        conn.execute(text("DELETE FROM forecasts WHERE forecast_hour >= :start"), {"start": db.fmt_dt(today)})
        for chunk in db.chunked(rows, 1000):
            conn.execute(text(INSERT_SQL), chunk)

    log.info(
        "Forecast %s: %d rows for %s .. %s (rf MAE %s, baseline MAE %s)",
        source, len(rows), today, horizon_end, backtest.rf_mae, backtest.baseline_mae,
    )
    return {
        "generated": len(rows),
        "modelVersion": source,
        "horizonStart": db.iso_dt(today),
        "horizonEnd": db.iso_dt(horizon_end),
        "evaluation": backtest.as_dict(),
    }
