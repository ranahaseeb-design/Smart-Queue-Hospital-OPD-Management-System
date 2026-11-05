"""Request/response models (pydantic v2). JSON keys follow docs/API_CONTRACT.md (camelCase),
except the feature object, whose keys are the snake_case names of Section 6.3."""

from __future__ import annotations

from typing import Optional, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    # protected_namespaces=() allows field names such as ``model_version``.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, protected_namespaces=())


# --------------------------------------------------------------------------- /health


class HealthResponse(CamelModel):
    status: str = "ok"
    active_model: Optional[str] = None
    db: bool = True  # addition: whether the DB could be queried


# --------------------------------------------------------------------------- /ai/predict-wait (FR-06, FR-07)


class WaitFeatures(BaseModel):
    """Feature vector of Section 6.3 (snake_case keys, exactly as stored in wait_predictions.features_json).

    Unknown keys are ignored. Only ``patients_ahead`` is mandatory; missing/null values are
    filled by ``features.prepare_frame`` with the same rules used at training time, so a
    partially built vector still gets a prediction instead of a validation error.
    """

    model_config = ConfigDict(extra="ignore")

    patients_ahead: float = Field(ge=0)
    priority_ahead: Optional[float] = None
    doctor_avg_consult: Optional[float] = None
    doctor_recent_consult: Optional[float] = None
    interruptions_last_hour: Optional[float] = None
    session_started: Optional[Union[bool, float]] = None  # 0/1 or true/false
    minutes_to_start: Optional[float] = None
    hour_of_day: Optional[float] = None
    day_of_week: Optional[float] = None  # 1 = Monday ... 7 = Sunday
    appointments_ahead: Optional[float] = None
    department_load: Optional[float] = None
    doctor_id: Optional[float] = None
    department_id: Optional[float] = None
    branch_id: Optional[float] = None


class PredictItem(CamelModel):
    token_id: Optional[int] = None
    features: WaitFeatures


class PredictRequest(CamelModel):
    items: list[PredictItem]


class Prediction(CamelModel):
    token_id: Optional[int] = None
    predicted_minutes: float


class PredictResponse(CamelModel):
    model_version: str
    predictions: list[Prediction]


# --------------------------------------------------------------------------- /ai/rank-branches (FR-08, Eq. 6.3)


class RankWeights(CamelModel):
    wait: float = Field(ge=0)
    distance: float = Field(ge=0)
    congestion: float = Field(ge=0)


class RankCandidate(CamelModel):
    branch_id: int
    doctor_id: Optional[int] = None
    predicted_wait_minutes: float
    distance_km: Optional[float] = None
    congestion_ratio: float = 0.0


class RankRequest(CamelModel):
    weights: RankWeights
    candidates: list[RankCandidate]


class RankedItem(CamelModel):
    branch_id: int
    doctor_id: Optional[int] = None
    score: float


class RankResponse(CamelModel):
    ranked: list[RankedItem]


# --------------------------------------------------------------------------- models (FR-22)


class ModelMetrics(CamelModel):
    mae: Optional[float] = None
    rmse: Optional[float] = None
    r2: Optional[float] = None
    within10: Optional[float] = None
    baseline_mae: Optional[float] = None
    test_rows: Optional[int] = None


class ModelVersionOut(CamelModel):
    version: str
    trained_at: Optional[str] = None
    training_rows: int
    data_source: str
    status: str
    is_active: bool
    metrics: ModelMetrics


class DepartmentCheck(CamelModel):
    department_id: Optional[int] = None
    test_rows: int
    mae: float
    baseline_mae: float
    worse_than_baseline: bool
    major: bool = False  # >= AI_DEPARTMENT_MIN_ROWS test rows
    rejects: bool = False  # major and worse than baseline -> the model is rejected (Section 6.7.3)


class RetrainResponse(CamelModel):
    version: str
    metrics: ModelMetrics
    accepted: bool
    activated: bool
    # Additions (informational, not required by the contract):
    reason: str
    active_model_mae: Optional[float] = None
    department_check: list[DepartmentCheck] = []


class ActivateResponse(CamelModel):
    version: str
    activated: bool = True


# --------------------------------------------------------------------------- /ai/jobs/forecast (FR-17)


class ForecastRequest(CamelModel):
    days: int = Field(default=7, ge=1, le=31)


class ForecastEvaluation(CamelModel):
    """Backtest of hourly arrivals on the last 2 weeks of history (Section 6.7.2, MAE)."""

    rf_mae: Optional[float] = None
    baseline_mae: Optional[float] = None
    train_rows: int = 0
    test_rows: int = 0
    selected: str = "seasonal-baseline"


class ForecastResponse(CamelModel):
    generated: int
    model_version: str
    # Additions (informational, not required by the contract):
    horizon_start: Optional[str] = None
    horizon_end: Optional[str] = None
    evaluation: Optional[ForecastEvaluation] = None
