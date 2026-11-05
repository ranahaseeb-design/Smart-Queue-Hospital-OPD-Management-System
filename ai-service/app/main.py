"""FastAPI entry point of the internal AI service (Chapter 6). Only the backend calls it.

Endpoints follow docs/API_CONTRACT.md ("Internal AI service"):

GET  /health                         service status and active model version
POST /ai/predict-wait                FR-06, FR-07: Random Forest waiting-time prediction (503 without an active model)
POST /ai/rank-branches               FR-08, FR-09: Eq. 6.3 branch scoring
POST /ai/jobs/forecast               FR-17: hourly arrival / congestion forecasts written to `forecasts`
POST /ai/models/retrain              FR-22: train, evaluate against the baseline and the active model, register
GET  /ai/models                      FR-22: model registry
POST /ai/models/{version}/activate   FR-22: make a version the active one

Run: ``uvicorn app.main:app --host 127.0.0.1 --port 8000`` from the ai-service folder.
Every /ai/* endpoint requires the X-AI-Service-Token header (see app/security.py).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import APIRouter, Body, Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from . import __version__
from .config import settings
from .forecasting import ForecastBusyError, run_forecast
from .predictor import NoActiveModelError, active_version, registry
from .ranking import Candidate, rank_candidates
from .schemas import (
    ActivateResponse,
    ForecastRequest,
    ForecastResponse,
    HealthResponse,
    ModelVersionOut,
    Prediction,
    PredictRequest,
    PredictResponse,
    RankedItem,
    RankRequest,
    RankResponse,
    RetrainResponse,
)
from .security import require_service_token
from .training import ModelNotFoundError, TrainingError, activate, list_models, retrain

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ai-service")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the model cache so the first prediction stays within the backend's 1.5 s timeout (NFR-01).
    try:
        version, _ = registry.get_active()
        log.info("Active waiting-time model: %s", version)
    except NoActiveModelError as exc:
        log.info("%s", exc)
    except Exception as exc:  # DB not reachable yet: the service still starts, /health reports it
        log.warning("Could not load the active model at startup: %s", exc)
    yield


app = FastAPI(
    title="Smart OPD AI Service",
    version=__version__,
    description="Waiting-time prediction, branch ranking, forecasting and model management (internal).",
    lifespan=lifespan,
)


# --------------------------------------------------------------------------- error mapping
# Errors are returned as {"detail": "..."}; the backend falls back to its baseline on any non-2xx.


@app.exception_handler(NoActiveModelError)
async def _no_active_model(_request: Request, exc: NoActiveModelError) -> JSONResponse:
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(TrainingError)
async def _training_error(_request: Request, exc: TrainingError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


@app.exception_handler(ModelNotFoundError)
async def _model_not_found(_request: Request, exc: ModelNotFoundError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(ForecastBusyError)
async def _forecast_busy(_request: Request, exc: ForecastBusyError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(SQLAlchemyError)
async def _database_error(_request: Request, exc: SQLAlchemyError) -> JSONResponse:
    log.error("Database error: %s", exc)
    return JSONResponse(status_code=503, content={"detail": f"Database unavailable: {exc.__class__.__name__}"})


# --------------------------------------------------------------------------- endpoints
# /health is open (container health checks); every /ai/* route requires X-AI-Service-Token.

ai = APIRouter(prefix="/ai", dependencies=[Depends(require_service_token)])


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        return HealthResponse(status="ok", active_model=active_version(), db=True)
    except Exception as exc:
        log.warning("Health check could not query the database: %s", exc)
        return HealthResponse(status="ok", active_model=None, db=False)


@ai.post("/predict-wait", response_model=PredictResponse)
def predict_wait(body: PredictRequest) -> PredictResponse:
    """FR-06/FR-07: predicted wait in minutes per token (non-negative, rounded to 0.1)."""
    features = [item.features.model_dump() for item in body.items]
    version, minutes = registry.predict(features)
    return PredictResponse(
        model_version=version,
        predictions=[
            Prediction(token_id=item.token_id, predicted_minutes=value) for item, value in zip(body.items, minutes)
        ],
    )


@ai.post("/rank-branches", response_model=RankResponse)
def rank_branches(body: RankRequest) -> RankResponse:
    """FR-08/FR-09: Eq. 6.3 score per candidate, sorted ascending (lower = better)."""
    candidates = [
        Candidate(
            branch_id=c.branch_id,
            doctor_id=c.doctor_id,
            predicted_wait_minutes=c.predicted_wait_minutes,
            distance_km=c.distance_km,
            congestion_ratio=c.congestion_ratio,
        )
        for c in body.candidates
    ]
    ranked = rank_candidates(candidates, body.weights.wait, body.weights.distance, body.weights.congestion)
    return RankResponse(ranked=[RankedItem(branch_id=r.branch_id, doctor_id=r.doctor_id, score=r.score) for r in ranked])


@ai.post("/jobs/forecast", response_model=ForecastResponse)
def forecast_job(body: Optional[ForecastRequest] = Body(default=None)) -> dict:
    """FR-17: regenerate hourly forecasts for the next ``days`` days (default 7)."""
    days = body.days if body is not None else 7
    return run_forecast(days)


@ai.post("/models/retrain", response_model=RetrainResponse)
def retrain_model() -> dict:
    """FR-22: 400 when fewer than 200 labelled tokens exist; 409 while another retrain runs."""
    return retrain()


@ai.get("/models", response_model=list[ModelVersionOut])
def get_models() -> list[dict]:
    return list_models()


@ai.post("/models/{version}/activate", response_model=ActivateResponse)
def activate_model(version: str) -> dict:
    return activate(version)


app.include_router(ai)
