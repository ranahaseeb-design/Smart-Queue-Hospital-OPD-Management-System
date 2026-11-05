"""Offline training, evaluation and registration of waiting-time models (Sections 6.4, 6.7, 6.8) — FR-22.

Training set: the FIRST ``wait_predictions`` row of every token (its ``features_json`` is
the feature vector known when the token was issued) joined with the token's actual wait
``called_at - issued_at`` in minutes (Section 6.1). ``called_at`` is the FIRST call: the backend
never overwrites it on a recall (a recall is only a RECALLED queue_event). All queue types are used.

Procedure:
1. Chronological 80/20 split by ``issued_at`` (Section 6.7.1 — a random split would leak the future).
2. RandomizedSearchCV with TimeSeriesSplit over the Section 6.4.2 ranges on the training part.
3. Test-period metrics (Eq. 6.6-6.8, within +/-10 min) and the Eq. 6.2 baseline MAE.
4. Acceptance (Section 6.7.3): MAE < baseline MAE and, when a model is active, MAE < the
   active model's MAE on the same test rows. Departments whose MAE is >20% worse than the
   baseline are reported (they do not by themselves reject the model).
5. The model file is saved as ``MODELS_DIR/<version>.joblib`` with its metadata and a
   ``model_versions`` row is written (ACTIVE or REJECTED).
"""

from __future__ import annotations

import json
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
from sqlalchemy import text

from . import db
from .config import local_now, settings
from .features import FEATURES, baseline_series, prepare_frame
from .predictor import active_version, load_bundle, model_path, predict_with_bundle, registry

log = logging.getLogger(__name__)

RANDOM_STATE = 42
TEST_FRACTION = 0.2
MAX_PLAUSIBLE_WAIT_MINUTES = 12 * 60  # data-quality filter: a token called >12 h after issue is not a real wait
DEPARTMENT_TOLERANCE = 1.20  # "not systematically worse for any major department" (Section 6.7.3)

# Section 6.4.2 candidate ranges, kept small so a retrain finishes in reasonable time.
PARAM_DISTRIBUTIONS: dict[str, list[Any]] = {
    "n_estimators": [100, 150, 200, 300],
    "max_depth": [8, 12, 16, 20, 30, None],
    "min_samples_leaf": [1, 2, 4, 6, 10],
    "max_features": ["sqrt", 0.5, 1.0],
}

TRAINING_SQL = """
SELECT wp.token_id AS token_id,
       wp.features_json AS features_json,
       t.issued_at AS issued_at,
       t.called_at AS called_at,
       t.is_synthetic AS is_synthetic,
       t.queue_type AS queue_type
FROM wait_predictions wp
JOIN (SELECT token_id, MIN(prediction_id) AS first_id
      FROM wait_predictions
      GROUP BY token_id) firsts ON firsts.first_id = wp.prediction_id
JOIN tokens t ON t.token_id = wp.token_id
WHERE t.called_at IS NOT NULL
"""

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


def load_training_data(engine=None) -> TrainingData:
    """Labelled rows sorted chronologically by issue time."""
    raw = db.fetch_df(TRAINING_SQL, engine=engine)
    if raw.empty:
        empty = pd.Series(dtype=float)
        return TrainingData(prepare_frame([]), empty, pd.Series(dtype="datetime64[ns]"), empty)

    features = raw["features_json"].map(_safe_features)
    issued = db.to_datetime_series(raw["issued_at"])
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
    frame = frame.sort_values(["issued_at", "token_id"], kind="mergesort").reset_index(drop=True)
    X = prepare_frame(frame["features"].tolist())
    return TrainingData(X=X, y=frame["wait"], issued_at=frame["issued_at"], is_synthetic=frame["is_synthetic"])


def _search_model(X: pd.DataFrame, y: pd.Series) -> tuple[RandomForestRegressor, dict, float]:
    """Section 6.4.2: hyperparameter search with time-series cross-validation on the training period."""
    search = RandomizedSearchCV(
        estimator=RandomForestRegressor(random_state=RANDOM_STATE, n_jobs=settings.n_jobs),
        param_distributions=PARAM_DISTRIBUTIONS,
        n_iter=settings.search_iter,
        scoring="neg_mean_absolute_error",
        cv=TimeSeriesSplit(n_splits=3),
        random_state=RANDOM_STATE,
        refit=True,
        n_jobs=1,
        error_score="raise",
    )
    search.fit(X, y)
    return search.best_estimator_, dict(search.best_params_), float(-search.best_score_)


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
    rows = []
    departments = test_X["department_id"].to_numpy()
    for dept in sorted(set(departments.tolist())):
        mask = departments == dept
        mae_model = float(np.mean(np.abs(y_true[mask] - y_pred[mask])))
        mae_base = float(np.mean(np.abs(y_true[mask] - y_base[mask])))
        rows.append(
            {
                "departmentId": int(dept) if dept > 0 else None,  # 0 = LAB/PHARMACY tokens without a department
                "testRows": int(mask.sum()),
                "mae": round(mae_model, 2),
                "baselineMae": round(mae_base, 2),
                "worseThanBaseline": bool(mae_model > mae_base * DEPARTMENT_TOLERANCE),
            }
        )
    return rows


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
    base = now.strftime("rf-%Y%m%d-%H%M")  # 16 chars; model_versions.version is VARCHAR(20)
    version, suffix = base, 2
    while db.fetch_scalar("SELECT COUNT(*) FROM model_versions WHERE version = :v", {"v": version}) or model_path(version).exists():
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

    feature_importances = {
        name: round(float(value), 5) for name, value in sorted(zip(FEATURES, model.feature_importances_), key=lambda p: -p[1])
    }
    version = _new_version_name(now)
    # Over every labelled row used (training + test period); the shares are stored in metrics_json.
    data_source = data_source_label(data.is_synthetic)
    share_train = synthetic_share(data.is_synthetic.iloc[:split])
    share_test = synthetic_share(data.is_synthetic.iloc[split:])
    bundle = {
        "version": version,
        "model": model,
        "features": list(FEATURES),
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
    accepted = bool(beats_baseline and beats_active)
    if not beats_baseline:
        reason = f"Rejected: MAE {metrics['mae']} is not lower than the baseline MAE {metrics['baselineMae']}."
    elif not beats_active:
        reason = f"Rejected: MAE {metrics['mae']} is not lower than the active model {current} (MAE {active_mae})."
    else:
        reason = f"Accepted: MAE {metrics['mae']} vs baseline {metrics['baselineMae']}" + (
            f" and active model {current} ({active_mae})." if active_mae is not None else "."
        )
    worse = [d for d in department_check if d["worseThanBaseline"]]
    if worse:
        reason += f" Warning: {len(worse)} department(s) more than 20% worse than baseline."

    bundle["metrics"] = metrics
    bundle["department_check"] = department_check
    bundle["accepted"] = accepted

    # Save the file first so that an ACTIVE row always has a model file.
    models_dir = settings.models_dir
    models_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, model_path(version))

    with db.get_engine().begin() as conn:
        if accepted:
            conn.execute(text("UPDATE model_versions SET is_active = 0, status = 'RETIRED' WHERE is_active = 1"))
        conn.execute(
            text(
                "INSERT INTO model_versions (version, trained_at, training_rows, data_source, metrics_json, status, is_active) "
                "VALUES (:version, :trained_at, :training_rows, :data_source, :metrics_json, :status, :is_active)"
            ),
            {
                "version": version,
                "trained_at": db.fmt_dt(now),
                "training_rows": int(len(X_train)),
                "data_source": data_source,
                "metrics_json": json.dumps(metrics),
                "status": "ACTIVE" if accepted else "REJECTED",
                "is_active": 1 if accepted else 0,
            },
        )
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
    rows = db.fetch_all(
        "SELECT version, trained_at, training_rows, data_source, metrics_json, status, is_active "
        "FROM model_versions ORDER BY trained_at DESC, version DESC"
    )
    out = []
    for row in rows:
        try:
            metrics = db.parse_json(row["metrics_json"]) or {}
        except (ValueError, TypeError):
            metrics = {}
        out.append(
            {
                "version": row["version"],
                "trainedAt": db.iso_dt(row["trained_at"]),
                "trainingRows": int(row["training_rows"] or 0),
                "dataSource": row["data_source"],
                "status": row["status"],
                "isActive": db.to_bool(row["is_active"]),
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
    """Make ``version`` the only active model; the previously active one becomes RETIRED."""
    exists = db.fetch_scalar("SELECT COUNT(*) FROM model_versions WHERE version = :v", {"v": version})
    if not exists:
        raise ModelNotFoundError(f"Model version {version} not found.")
    try:
        bundle = load_bundle(version)  # refuse to activate a version whose file is missing or unreadable
    except (FileNotFoundError, ValueError) as exc:
        raise TrainingError(f"Model file for {version} is not usable: {exc}", status_code=409) from exc

    with db.get_engine().begin() as conn:
        conn.execute(
            text("UPDATE model_versions SET is_active = 0, status = 'RETIRED' WHERE is_active = 1 AND version <> :v"),
            {"v": version},
        )
        conn.execute(text("UPDATE model_versions SET is_active = 1, status = 'ACTIVE' WHERE version = :v"), {"v": version})
    registry.put(version, bundle)
    return {"version": version, "activated": True}
