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
from .features import FEATURES, prepare_frame


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
    if hasattr(bundle["model"], "n_jobs"):
        bundle["model"].n_jobs = 1
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


def predict_with_bundle(bundle: Mapping[str, Any], feature_rows: Sequence[Mapping[str, Any]]) -> np.ndarray:
    """Predict minutes for feature dicts; bounded to be non-negative and rounded to 0.1 (Section 6.4.3 step 4)."""
    if not feature_rows:
        return np.zeros(0)
    frame = prepare_frame(feature_rows, bundle.get("features") or FEATURES)
    raw = np.asarray(bundle["model"].predict(frame), dtype=float)
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
