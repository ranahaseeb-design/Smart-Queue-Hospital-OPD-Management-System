"""Waiting-time feature vector (Section 6.3) and the queueing baseline (Eq. 6.2).

The backend builds the feature object for every prediction and stores it in
``wait_predictions.features_json``; the same keys (in this order) are used for
training and for online prediction, so there is no train/serve skew.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

import numpy as np
import pandas as pd

# Exact keys and order from docs/API_CONTRACT.md ("Feature vector (Section 6.3)").
FEATURES: list[str] = [
    "patients_ahead",
    "priority_ahead",
    "doctor_avg_consult",
    "doctor_recent_consult",
    "interruptions_last_hour",
    "session_started",
    "minutes_to_start",
    "hour_of_day",
    "day_of_week",
    "appointments_ahead",
    "department_load",
    "doctor_id",
    "department_id",
    "branch_id",
]

# Used only when a stored/sent feature is missing or null.
DEFAULT_CONSULT_MINUTES = 10.0


def _coerce_value(value: Any) -> float:
    if value is None:
        return np.nan
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "false"):
            return 1.0 if lowered == "true" else 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return np.nan


def prepare_frame(rows: Iterable[Mapping[str, Any]], feature_order: list[str] | None = None) -> pd.DataFrame:
    """Build a numeric DataFrame with exactly ``feature_order`` columns from feature dicts.

    Missing values are filled with the same rules at training and prediction time:
    ``doctor_recent_consult`` falls back to ``doctor_avg_consult`` (no consultations yet
    in this session), ``doctor_avg_consult`` to 10 minutes, everything else to 0.
    """
    order = list(feature_order or FEATURES)
    data = [{key: _coerce_value(row.get(key)) for key in order} for row in rows]
    frame = pd.DataFrame(data, columns=order, dtype=float)
    if "doctor_avg_consult" in frame:
        frame["doctor_avg_consult"] = frame["doctor_avg_consult"].fillna(DEFAULT_CONSULT_MINUTES)
    if "doctor_recent_consult" in frame:
        fallback = frame["doctor_avg_consult"] if "doctor_avg_consult" in frame else DEFAULT_CONSULT_MINUTES
        frame["doctor_recent_consult"] = frame["doctor_recent_consult"].fillna(fallback)
    return frame.fillna(0.0)


def baseline_minutes(features: Mapping[str, Any]) -> float:
    """Eq. 6.2: W = (n_ahead + n_priority) * c_doctor + d_start (d_start = 0 once started)."""
    frame = prepare_frame([features])
    return float(baseline_series(frame).iloc[0])


def baseline_series(frame: pd.DataFrame) -> pd.Series:
    """Vectorised Eq. 6.2 over a frame produced by :func:`prepare_frame`."""
    ahead = frame["patients_ahead"].clip(lower=0) + frame["priority_ahead"].clip(lower=0)
    start_delay = frame["minutes_to_start"].clip(lower=0).where(frame["session_started"] < 0.5, 0.0)
    return (ahead * frame["doctor_avg_consult"] + start_delay).clip(lower=0)
