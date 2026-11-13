"""Offline training, evaluation and registration of waiting-time models (Sections 6.4, 6.7, 6.8) — FR-22.

Training set: the FIRST ``wait_predictions`` document of every token (lowest integer ``_id``; its
embedded ``features`` object is the feature vector known when the token was issued) joined with
the token's actual wait ``called_at - issued_at`` in minutes (Section 6.1). ``called_at`` is the
FIRST call: the backend never overwrites it on a recall (a recall is only a RECALLED queue_event).
All queue types are used.

Procedure:
1. Chronological 80/20 split by ``issued_at`` (Section 6.7.1 — a random split would leak the future).
2. RandomizedSearchCV with TimeSeriesSplit over the Section 6.4.2 ranges on the training part.
3. Test-period metrics (Eq. 6.6-6.8, within +/-10 min) and the Eq. 6.2 baseline MAE.
4. Acceptance (Section 6.7.3): MAE < baseline MAE, when a model is active MAE < the active
   model's MAE on the same test rows, AND the model is "not systematically worse for any major
   department": every department with >= AI_DEPARTMENT_MIN_ROWS (default 30) test rows must have
   MAE <= AI_DEPARTMENT_TOLERANCE (default 1.2) x its own baseline MAE. Smaller departments are
   reported but cannot reject the model on their own (too few rows to be meaningful).
   A REJECTED version can never be activated manually (409).
5. The model file is saved as ``MODELS_DIR/<version>.joblib`` with its metadata and a
   ``model_versions`` document is written (``_id`` = version; ACTIVE or REJECTED).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import RandomizedSearchCV, TimeSeriesSplit
from sklearn.pipeline import Pipeline

from . import db
from .config import local_now, settings
from .features import FEATURE_ENCODING, FEATURES, baseline_series, build_preprocessor, prepare_frame, source_feature
from .predictor import active_version, load_bundle, model_path, predict_with_bundle, registry

log = logging.getLogger(__name__)

RANDOM_STATE = 42
TEST_FRACTION = 0.2
MAX_PLAUSIBLE_WAIT_MINUTES = 12 * 60  # data-quality filter: a token called >12 h after issue is not a real wait
# "Not systematically worse for any major department" (Section 6.7.3): thresholds are
# settings.department_min_rows / settings.department_tolerance (env-overridable).

# Section 6.4.2 candidate ranges, kept small so a retrain finishes in reasonable time.
PARAM_DISTRIBUTIONS: dict[str, list[Any]] = {
    "n_estimators": [100, 150, 200, 300],
    "max_depth": [8, 12, 16, 20, 30, None],
    "min_samples_leaf": [1, 2, 4, 6, 10],
    "max_features": ["sqrt", 0.5, 1.0],
}

# First wait_predictions document per token (lowest _id, ids come from the counters collection in
# insertion order) joined with its token; only tokens that were called carry a label.
TRAINING_PIPELINE: list[dict] = [
    {"$sort": {"token_id": 1, "_id": 1}},
    {"$group": {"_id": "$token_id", "features": {"$first": "$features"}}},
    {"$lookup": {"from": "tokens", "localField": "_id", "foreignField": "_id", "as": "token"}},
    {"$unwind": "$token"},
    {"$match": {"token.called_at": {"$ne": None}}},
    {
        "$project": {
            "_id": 0,
            "token_id": "$_id",
            "features": 1,
            "issued_at": "$token.issued_at",
            "called_at": "$token.called_at",
            "is_synthetic": "$token.is_synthetic",
            "queue_type": "$token.queue_type",
        }
    },
]
TRAINING_COLUMNS = ["token_id", "features", "issued_at", "called_at", "is_synthetic", "queue_type"]

_train_lock = threading.Lock()


class TrainingError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class TrainingBusyError(TrainingError):
    def __init__(self) -> None:
        super().__init__("A retraining job is already running.", status_code=409)


@dataclass
class TrainingData:
    X: pd.DataFrame
    y: pd.Series
    issued_at: pd.Series
    is_synthetic: pd.Series

    def __len__(self) -> int:
        return len(self.y)


def _safe_features(value: Any) -> dict | None:
    try:
        parsed = db.parse_json(value)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def load_training_data() -> TrainingData:
    """Labelled rows sorted chronologically by issue time (``issued_at`` in hospital local time)."""
    cursor = db.get_db()["wait_predictions"].aggregate(TRAINING_PIPELINE, allowDiskUse=True)
    raw = pd.DataFrame(list(cursor)).reindex(columns=TRAINING_COLUMNS)
    if raw.empty:
        empty = pd.Series(dtype=float)
        return TrainingData(prepare_frame([]), empty, pd.Series(dtype="datetime64[ns]"), empty)

    features = raw["features"].map(_safe_features)
    issued = db.to_datetime_series(raw["issued_at"])  # UTC: the wait is zone-independent
    called = db.to_datetime_series(raw["called_at"])
    wait = (called - issued).dt.total_seconds() / 60.0

    valid = features.notna() & issued.notna() & called.notna() & wait.notna()
    valid &= (wait >= 0) & (wait <= MAX_PLAUSIBLE_WAIT_MINUTES)

    frame = pd.DataFrame(
        {
            "features": features[valid],
            "issued_at": issued[valid],
            "wait": wait[valid].astype(float),
            "is_synthetic": raw.loc[valid, "is_synthetic"].map(db.to_bool),
            "token_id": raw.loc[valid, "token_id"],
        }
    )
    # Sorted on UTC (monotonic even across a DST change), then shown in hospital local time.
    frame = frame.sort_values(["issued_at", "token_id"], kind="mergesort").reset_index(drop=True)
    frame["issued_at"] = db.utc_series_to_local(frame["issued_at"])
    X = prepare_frame(frame["features"].tolist())
    return TrainingData(X=X, y=frame["wait"], issued_at=frame["issued_at"], is_synthetic=frame["is_synthetic"])


def build_pipeline() -> Pipeline:
    """One-hot id encoding (features.build_preprocessor) followed by the random forest."""
    return Pipeline(
        steps=[
            ("encode", build_preprocessor()),
            ("forest", RandomForestRegressor(random_state=RANDOM_STATE, n_jobs=settings.n_jobs)),
        ]
    )


def _search_model(X: pd.DataFrame, y: pd.Series) -> tuple[Pipeline, dict, float]:
    """Section 6.4.2: hyperparameter search with time-series cross-validation on the training period.

    The encoder is refitted inside every CV fold (part of the pipeline), so no id seen only in a
    validation fold leaks into training. Returned hyperparameters use the plain forest names.
    """
    search = RandomizedSearchCV(
        estimator=build_pipeline(),
        param_distributions={f"forest__{name}": values for name, values in PARAM_DISTRIBUTIONS.items()},
        n_iter=settings.search_iter,
        scoring="neg_mean_absolute_error",
        cv=TimeSeriesSplit(n_splits=3),
        random_state=RANDOM_STATE,
        refit=True,
        n_jobs=1,
        error_score="raise",
    )
    search.fit(X, y)
    params = {name.removeprefix("forest__"): value for name, value in search.best_params_.items()}
    return search.best_estimator_, params, float(-search.best_score_)


def _feature_importances(pipeline: Pipeline) -> dict[str, float]:
    """Forest importances summed back onto the 14 contract feature keys (one-hot columns per id)."""
    names = pipeline.named_steps["encode"].get_feature_names_out()
    totals = {name: 0.0 for name in FEATURES}
    for encoded, value in zip(names, pipeline.named_steps["forest"].feature_importances_):
        totals[source_feature(str(encoded))] += float(value)
    return {name: round(value, 5) for name, value in sorted(totals.items(), key=lambda p: -p[1])}


def _metrics(y_true: np.ndarray, y_pred: np.ndarray, baseline_mae: float) -> dict:
    """Eq. 6.6-6.8 plus % within +/-10 minutes (Section 6.7.2)."""
    errors = np.abs(y_true - y_pred)
    r2 = float(r2_score(y_true, y_pred)) if len(y_true) > 1 else 0.0
    return {
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 2),
        "rmse": round(float(np.sqrt(mean_squared_error(y_true, y_pred))), 2),
        "r2": round(r2 if np.isfinite(r2) else 0.0, 3),
        "within10": round(float(np.mean(errors <= 10.0) * 100.0), 1),
        "baselineMae": round(float(baseline_mae), 2),
        "testRows": int(len(y_true)),
    }


def _department_check(test_X: pd.DataFrame, y_true: np.ndarray, y_pred: np.ndarray, y_base: np.ndarray) -> list[dict]:
    """Per-department MAE vs the Eq. 6.2 baseline (Section 6.7.3).

    ``major``: at least ``settings.department_min_rows`` test rows. ``rejects``: a major department
    whose MAE exceeds ``settings.department_tolerance`` x its baseline MAE -> the model is rejected.
    """
    rows = []
    min_rows = settings.department_min_rows
    tolerance = settings.department_tolerance
    departments = test_X["department_id"].to_numpy()
    for dept in sorted(set(departments.tolist())):
        mask = departments == dept
        mae_model = float(np.mean(np.abs(y_true[mask] - y_pred[mask])))
        mae_base = float(np.mean(np.abs(y_true[mask] - y_base[mask])))
        test_rows = int(mask.sum())
        worse = bool(mae_model > mae_base * tolerance)
        major = test_rows >= min_rows
        rows.append(
            {
                "departmentId": int(dept) if dept > 0 else None,  # 0 = LAB/PHARMACY tokens without a department
                "testRows": test_rows,
                "mae": round(mae_model, 2),
                "baselineMae": round(mae_base, 2),
                "worseThanBaseline": worse,
                "major": major,
                "rejects": bool(major and worse),
            }
        )
    return rows


def _plain(value: Any) -> Any:
    """numpy scalars -> Python numbers, recursively (BSON cannot encode numpy types)."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, np.generic):
        return value.item()
    return value


def synthetic_share(flags: pd.Series) -> float:
    """Fraction (0-1, 4 decimals) of rows flagged tokens.is_synthetic; 0.0 for no rows."""
    if len(flags) == 0:
        return 0.0
    return round(float(flags.astype(bool).mean()), 4)


def data_source_label(flags: pd.Series) -> str:
    """model_versions.data_source: 'synthetic' (all rows synthetic), 'pilot' (none), 'mixed'."""
    synthetic = flags.astype(bool)
    if len(synthetic) and bool(synthetic.all()):
        return "synthetic"
    if not bool(synthetic.any()):
        return "pilot"
    return "mixed"


def _new_version_name(now: datetime) -> str:
    base = now.strftime("rf-%Y%m%d-%H%M")  # 16 chars (hospital local time), kept <= 20 as before
    version, suffix = base, 2
    versions = db.get_db()["model_versions"]
    while versions.find_one({"_id": version}, projection={"_id": 1}) is not None or model_path(version).exists():
        version = f"{base}-{suffix}"
        suffix += 1
    return version


def retrain(now: datetime | None = None) -> dict:
    """Train, evaluate and register a new model version. Returns the /ai/models/retrain response body."""
    if not _train_lock.acquire(blocking=False):
        raise TrainingBusyError()
    try:
        return _retrain_locked(now or local_now())
    finally:
        _train_lock.release()


def _retrain_locked(now: datetime) -> dict:
    data = load_training_data()
    if len(data) < settings.min_training_rows:
        raise TrainingError(
            f"Not enough labelled tokens to train: {len(data)} found, at least {settings.min_training_rows} required."
        )

    split = int(round(len(data) * (1.0 - TEST_FRACTION)))
    X_train, X_test = data.X.iloc[:split], data.X.iloc[split:]
    y_train, y_test = data.y.iloc[:split], data.y.iloc[split:]
    if len(X_test) < 1 or len(X_train) < 4:
        raise TrainingError("Not enough rows for a chronological train/test split.")

    log.info("Training on %d rows, testing on %d rows", len(X_train), len(X_test))
    model, best_params, cv_mae = _search_model(X_train, y_train)

    feature_importances = _feature_importances(model)
    version = _new_version_name(now)
    # Over every labelled row used (training + test period); the shares are stored in model_versions.metrics.
    data_source = data_source_label(data.is_synthetic)
    share_train = synthetic_share(data.is_synthetic.iloc[:split])
    share_test = synthetic_share(data.is_synthetic.iloc[split:])
    bundle = {
        "version": version,
        "model": model,
        "features": list(FEATURES),
        "feature_encoding": FEATURE_ENCODING,
        "trained_at": db.fmt_dt(now),
        "training_rows": int(len(X_train)),
        "data_source": data_source,
        "training_period": {
            "from": db.fmt_dt(data.issued_at.iloc[0].to_pydatetime()),
            "to": db.fmt_dt(data.issued_at.iloc[split - 1].to_pydatetime()),
        },
        "test_period": {
            "from": db.fmt_dt(data.issued_at.iloc[split].to_pydatetime()),
            "to": db.fmt_dt(data.issued_at.iloc[-1].to_pydatetime()),
        },
        # Training range of the start delay: predictions beyond it add the excess minutes
        # (predictor.predict_with_bundle), since the forest cannot extrapolate.
        "feature_max": {"minutes_to_start": float(X_train["minutes_to_start"].max())},
        "hyperparameters": best_params,
        "cv_mae": round(cv_mae, 3),
        "feature_importances": feature_importances,
        "sklearn_version": sklearn.__version__,
    }

    # Predictions are bounded/rounded exactly as when served online.
    test_rows = X_test.to_dict("records")
    y_true = y_test.to_numpy(dtype=float)
    y_pred = predict_with_bundle(bundle, test_rows)
    y_base = baseline_series(X_test).to_numpy(dtype=float)
    baseline_mae = float(np.mean(np.abs(y_true - y_base)))
    model_mae = float(np.mean(np.abs(y_true - y_pred)))
    metrics = _metrics(y_true, y_pred, baseline_mae)
    metrics["syntheticShareTrain"] = share_train
    metrics["syntheticShareTest"] = share_test
    department_check = _department_check(X_test, y_true, y_pred, y_base)

    # Compare with the currently active model on the same test rows (FR-22, Section 6.8).
    current = active_version()
    active_mae_raw: float | None = None
    if current:
        try:
            active_pred = predict_with_bundle(load_bundle(current), test_rows)
            active_mae_raw = float(np.mean(np.abs(y_true - active_pred)))
        except Exception as exc:  # missing/corrupt file: nothing comparable to beat
            log.warning("Active model %s could not be evaluated: %s", current, exc)
    active_mae = round(active_mae_raw, 2) if active_mae_raw is not None else None

    # Acceptance (Section 6.7.3) on unrounded values; strictly lower MAE is required.
    beats_baseline = model_mae < baseline_mae
    beats_active = active_mae_raw is None or model_mae < active_mae_raw
    failing_departments = [d for d in department_check if d["rejects"]]
    departments_ok = not failing_departments
    accepted = bool(beats_baseline and beats_active and departments_ok)
    pct = round((settings.department_tolerance - 1.0) * 100)
    if not beats_baseline:
        reason = f"Rejected: MAE {metrics['mae']} is not lower than the baseline MAE {metrics['baselineMae']}."
    elif not beats_active:
        reason = f"Rejected: MAE {metrics['mae']} is not lower than the active model {current} (MAE {active_mae})."
    elif not departments_ok:
        listed = ", ".join(
            f"department {d['departmentId'] if d['departmentId'] is not None else 'none (LAB/PHARMACY)'}"
            f" MAE {d['mae']} vs baseline {d['baselineMae']} ({d['testRows']} test rows)"
            for d in failing_departments
        )
        reason = (
            f"Rejected: systematically worse than the baseline for {len(failing_departments)} major department(s) "
            f"(>= {settings.department_min_rows} test rows, MAE more than {pct}% above baseline): {listed}."
        )
    else:
        reason = f"Accepted: MAE {metrics['mae']} vs baseline {metrics['baselineMae']}" + (
            f" and active model {current} ({active_mae})." if active_mae is not None else "."
        )
    minor_worse = [d for d in department_check if d["worseThanBaseline"] and not d["major"]]
    if minor_worse:
        reason += (
            f" Note: {len(minor_worse)} small department(s) (< {settings.department_min_rows} test rows) "
            f"more than {pct}% worse than baseline."
        )

    bundle["metrics"] = metrics
    bundle["department_check"] = department_check
    bundle["accepted"] = accepted

    # Save the file first so that an ACTIVE document always has a model file.
    models_dir = settings.models_dir
    models_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, model_path(version))

    document = {
        "_id": version,  # MONGODB_DESIGN.md: model_versions._id is the version string
        "trained_at": db.to_utc(now),
        "training_rows": int(len(X_train)),
        "data_source": data_source,
        "metrics": _plain(metrics),
        "status": "ACTIVE" if accepted else "REJECTED",
        "is_active": bool(accepted),
    }
    versions = db.get_db()["model_versions"]

    def register(session) -> None:
        if accepted:
            versions.update_many(
                {"is_active": True}, {"$set": {"is_active": False, "status": "RETIRED"}}, session=session
            )
        versions.insert_one(dict(document), session=session)

    db.run_transaction(register)
    if accepted:
        registry.put(version, bundle)  # serve the new model immediately, without reloading the file
    log.info("Model %s trained: %s", version, reason)

    return {
        "version": version,
        "metrics": metrics,
        "accepted": accepted,
        "activated": accepted,
        "reason": reason,
        "activeModelMae": active_mae,
        "departmentCheck": department_check,
    }


# --------------------------------------------------------------------------- registry (FR-22)


def list_models() -> list[dict]:
    rows = db.get_db()["model_versions"].find({}, sort=[("trained_at", -1), ("_id", -1)])
    out = []
    for row in rows:
        try:
            metrics = db.parse_json(row.get("metrics")) or {}
        except (ValueError, TypeError):
            metrics = {}
        if not isinstance(metrics, dict):
            metrics = {}
        trained_at = row.get("trained_at")
        out.append(
            {
                "version": str(row["_id"]),
                "trainedAt": db.iso_dt(db.to_local(trained_at) if isinstance(trained_at, datetime) else trained_at),
                "trainingRows": int(row.get("training_rows") or 0),
                "dataSource": row.get("data_source"),
                "status": row.get("status"),
                "isActive": db.to_bool(row.get("is_active")),
                "metrics": {
                    "mae": metrics.get("mae"),
                    "rmse": metrics.get("rmse"),
                    "r2": metrics.get("r2"),
                    "within10": metrics.get("within10"),
                    "baselineMae": metrics.get("baselineMae"),
                    "testRows": metrics.get("testRows"),
                },
            }
        )
    return out


class ModelNotFoundError(Exception):
    pass


def activate(version: str) -> dict:
    """Make ``version`` the only active model; the previously active one becomes RETIRED.

    Only versions that passed the Section 6.7.3 acceptance rules (ACTIVE, or RETIRED for a
    rollback) can be activated; a REJECTED version answers 409 (FR-22).
    """
    versions = db.get_db()["model_versions"]
    row = versions.find_one({"_id": version}, projection={"status": 1})
    if row is None:
        raise ModelNotFoundError(f"Model version {version} not found.")
    if str(row.get("status")).upper() == "REJECTED":
        raise TrainingError(
            f"Model version {version} was REJECTED by the acceptance rules (Section 6.7.3: it did not beat the "
            "baseline / active model or was worse for a major department) and cannot be activated. "
            "Retrain to obtain an accepted version.",
            status_code=409,
        )
    try:
        bundle = load_bundle(version)  # refuse to activate a version whose file is missing or unreadable
    except (FileNotFoundError, ValueError) as exc:
        raise TrainingError(f"Model file for {version} is not usable: {exc}", status_code=409) from exc

    def switch(session) -> None:
        versions.update_many(
            {"is_active": True, "_id": {"$ne": version}},
            {"$set": {"is_active": False, "status": "RETIRED"}},
            session=session,
        )
        versions.update_one({"_id": version}, {"$set": {"is_active": True, "status": "ACTIVE"}}, session=session)

    db.run_transaction(switch)
    registry.put(version, bundle)
    return {"version": version, "activated": True}
