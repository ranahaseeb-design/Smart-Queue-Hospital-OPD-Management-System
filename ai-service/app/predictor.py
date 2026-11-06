"""Online waiting-time prediction with the ACTIVE model (Section 6.4.3) — FR-06, FR-07.

The active version is the ``model_versions`` row with ``is_active = 1``; its file is
``MODELS_DIR/<version>.joblib``. The loaded bundle is cached in memory and reloaded
whenever a different version becomes active (activation endpoint, retraining or the CLI).
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Mapping, Sequence

import joblib
import numpy as np

from . import db
from .config import settings
from .features import FEATURES, RAW_FEATURE_ENCODING, prepare_frame


class NoActiveModelError(RuntimeError):
    """Raised when there is no usable active model (the API answers 503)."""


def model_path(version: str) -> Path:
    return Path(settings.models_dir) / f"{version}.joblib"


def prepare_for_serving(bundle: dict, version: str) -> dict:
    """Defaults for older bundles + single-threaded prediction.

    Online requests are small batches; single-threaded prediction avoids thread oversubscription
    when several requests arrive at once and keeps latency well inside the backend's 1.5 s timeout.
    """
    bundle.setdefault("features", list(FEATURES))
    bundle.setdefault("version", version)
    # Bundles saved before the one-hot id encoding hold a bare forest fed the raw 14 columns; they
    # are labelled "raw" and still predict through the same prepare_frame -> model.predict path.
    bundle.setdefault("feature_encoding", RAW_FEATURE_ENCODING)
    model = bundle["model"]
    estimator = model.steps[-1][1] if hasattr(model, "steps") else model  # Pipeline -> its forest
    if hasattr(estimator, "n_jobs"):
        estimator.n_jobs = 1
    return bundle


def load_bundle(version: str) -> dict:
    path = model_path(version)
    if not path.is_file():
        raise FileNotFoundError(f"Model file not found: {path}")
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or "model" not in bundle:
        raise ValueError(f"Unexpected model file format: {path}")
    return prepare_for_serving(bundle, version)


def active_version() -> str | None:
    return db.fetch_scalar(
        "SELECT version FROM model_versions WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1"
    )


START_DELAY_FEATURE = "minutes_to_start"


def _max_split_threshold(model: Any, feature: str) -> float | None:
    """Largest split threshold on ``feature`` in a forest (bare or last step of a Pipeline).

    Beyond it the forest's output no longer depends on the feature. Used for bundles saved
    before ``feature_max`` was recorded.
    """
    if hasattr(model, "steps"):
        forest = model.steps[-1][1]
        try:
            names = [str(n) for n in model[:-1].get_feature_names_out()]
        except Exception:
            return None
        matches = [i for i, n in enumerate(names) if n == feature or n.endswith(f"__{feature}")]
        if not matches:
            return None
        index = matches[0]
    else:
        forest = model
        names = list(getattr(forest, "feature_names_in_", FEATURES))
        if feature not in names:
            return None
        index = names.index(feature)
    best: float | None = None
    for tree in getattr(forest, "estimators_", []):
        thresholds = tree.tree_.threshold[tree.tree_.feature == index]
        if thresholds.size:
            value = float(thresholds.max())
            best = value if best is None else max(best, value)
    return best


def start_delay_cap(bundle: Mapping[str, Any]) -> float | None:
    """Largest ``minutes_to_start`` the model has learned from (the training maximum).

    A random forest cannot extrapolate: for a session starting later than anything seen in
    training it would predict as if the session started at the training maximum. Bundles
    saved by training record ``feature_max``; older bundles fall back to the largest split
    threshold of the forest.
    """
    recorded = (bundle.get("feature_max") or {}).get(START_DELAY_FEATURE)
    if recorded is not None:
        return float(recorded)
    return _max_split_threshold(bundle["model"], START_DELAY_FEATURE)


def predict_with_bundle(bundle: Mapping[str, Any], feature_rows: Sequence[Mapping[str, Any]]) -> np.ndarray:
    """Predict minutes for feature dicts; bounded to be non-negative and rounded to 0.1 (Section 6.4.3 step 4).

    A start delay beyond the training range (``minutes_to_start`` above :func:`start_delay_cap`,
    session not started) is fed to the forest at the edge of that range and the excess minutes
    are added, as in Eq. 6.2 where the start delay is additive. Inside the range the forest
    alone decides.
    """
    if not feature_rows:
        return np.zeros(0)
    frame = prepare_frame(feature_rows, bundle.get("features") or FEATURES)
    excess = np.zeros(len(frame))
    cap = start_delay_cap(bundle) if START_DELAY_FEATURE in frame else None
    if cap is not None and np.isfinite(cap):
        not_started = frame["session_started"] < 0.5 if "session_started" in frame else True
        beyond = (frame[START_DELAY_FEATURE] > cap) & not_started
        if bool(np.any(beyond)):
            excess = np.where(beyond, frame[START_DELAY_FEATURE] - cap, 0.0)
            # nextafter keeps the clipped value on the far side of every split threshold <= cap.
            frame.loc[beyond, START_DELAY_FEATURE] = float(np.nextafter(cap, np.inf))
    raw = np.asarray(bundle["model"].predict(frame), dtype=float) + excess
    raw = np.where(np.isfinite(raw), raw, 0.0)
    return np.round(np.clip(raw, 0.0, None), 1)


class ModelRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._version: str | None = None
        self._bundle: dict | None = None

    def invalidate(self) -> None:
        with self._lock:
            self._version = None
            self._bundle = None

    def put(self, version: str, bundle: dict) -> None:
        """Cache a bundle that was just trained or loaded (retraining / activation).

        Without this, the first prediction after a model change would reload the joblib file
        (several seconds for a large forest) and exceed the backend's 1.5 s timeout, so the
        backend would fall back to the baseline and open its circuit breaker for a while.
        """
        with self._lock:
            self._version = version
            self._bundle = prepare_for_serving(bundle, version)

    def get_active(self) -> tuple[str, dict]:
        """Return (version, bundle) of the active model, loading/reloading it if needed."""
        version = active_version()
        if not version:
            raise NoActiveModelError("No active waiting-time model; use the baseline estimate.")
        with self._lock:
            if self._version == version and self._bundle is not None:
                return version, self._bundle
            try:
                bundle = load_bundle(version)
            except (FileNotFoundError, ValueError) as exc:
                raise NoActiveModelError(f"Active model {version} could not be loaded: {exc}") from exc
            self._version, self._bundle = version, bundle
            return version, bundle

    def cached_version(self) -> str | None:
        return self._version

    def predict(self, feature_rows: Sequence[Mapping[str, Any]]) -> tuple[str, list[float]]:
        version, bundle = self.get_active()
        values = predict_with_bundle(bundle, feature_rows)
        return version, [float(v) for v in values]


registry = ModelRegistry()
