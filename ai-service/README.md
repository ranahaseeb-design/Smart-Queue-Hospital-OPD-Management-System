# Smart OPD — AI Service

The internal Python service for the AI module in Chapter 6 of the FYP documentation. It covers
waiting-time prediction with a Random Forest, branch ranking, hourly arrival and congestion
forecasting, and model retraining and versioning.

Only the **backend** calls it, through `AI_SERVICE_URL` on port **8000**. Patients and dashboards never
reach it directly. Whenever this service is down or returns an error, the backend falls back
silently to its own logic: the Eq. 6.2 baseline, JS scoring or the JS seasonal forecast. For this
reason every endpoint fails fast and answers with a plain `{"detail": "..."}` error.

Stack: FastAPI + uvicorn, scikit-learn `RandomForestRegressor`, pandas, numpy, **pymongo 4**
(MongoDB, shared with the backend), joblib. Python 3.11+.

> **Training-data caveat (Sections 6.2, 6.9, 6.11).** The development database is seeded with
> **synthetic** history (`tokens.is_synthetic: true`). Models trained on it only show that the pipeline
> works end to end. Their metrics are **not** real-world accuracy and must not be reported as such.
> Each model version records its `data_source` over all labelled rows used (training + test period):
> `synthetic` when every token is synthetic, `pilot` when none is, `mixed` otherwise; the synthetic
> shares are stored in `model_versions.metrics` as `syntheticShareTrain` / `syntheticShareTest` (0-1). Real accuracy can only come from pilot or partner-hospital data, evaluated with
> the procedure below. This README makes no accuracy claim.

---

## Layout

```
ai-service/
├── app/
│   ├── main.py          FastAPI app, routes, error mapping
│   ├── config.py        environment settings, hospital local time
│   ├── db.py            pymongo client, counters ids, transactions, UTC <-> hospital time helpers
│   ├── features.py      FEATURES (Section 6.3, contract order) + Eq. 6.2 baseline
│   ├── predictor.py     active-model loading/caching and prediction (FR-06, FR-07)
│   ├── ranking.py       Eq. 6.3 branch scoring (FR-08, FR-09)
│   ├── training.py      retraining, evaluation, acceptance, registry (FR-22)
│   ├── forecasting.py   arrivals/congestion forecast job (FR-17, Eq. 6.5)
│   └── schemas.py       pydantic v2 request/response models (camelCase aliases)
├── scripts/train_cli.py retrain / list / activate / forecast from the command line
├── tests/               pytest suite (mongomock in-memory MongoDB, FastAPI TestClient)
├── models/              <version>.joblib files (git-ignored)
├── requirements.txt     runtime pins;  requirements-dev.txt adds pytest + httpx + mongomock
├── Dockerfile, .env.example, pytest.ini
```

## Setup and run

```bash
cd ai-service
python -m venv .venv
# Windows: .venv\Scripts\activate      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt        # or requirements-dev.txt to run the tests
cp .env.example .env                   # then set AI_SERVICE_TOKEN (and MONGODB_URI if needed)
python -c "import secrets; print(secrets.token_hex(32))"   # same value in backend/.env AI_SERVICE_TOKEN

uvicorn app.main:app --host 127.0.0.1 --port 8000
# interactive docs: http://localhost:8000/docs
```

Start MongoDB and the backend first, or at least create and seed the backend's database. The
service uses the same MongoDB database as the backend (`database/MONGODB_DESIGN.md`). On a fresh
database `/ai/predict-wait` returns 503 until a model has been trained. Train one with
`POST /ai/models/retrain` (from the Admin Dashboard through the backend) or with
`python scripts/train_cli.py`.

### MongoDB

- **Connection:** `MONGODB_URI`, default `mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0`. The
  database is `MONGODB_DB` when set, otherwise the name in the URI path, otherwise `smart_opd`.
  Locally, run MongoDB as a **single-node replica set** `rs0` (as for the backend): the service's
  delete+insert of forecasts and its model switch run in a multi-document transaction. On a
  standalone server it logs a warning and writes without a transaction. `MONGODB_TIMEOUT_MS`
  (default 3000) bounds server selection, so `/health` and requests fail fast when MongoDB is down;
  any driver error answers **503** `{"detail": "Database unavailable: ..."}` and the backend falls back.
- **Data shape** follows the design document: one collection per former table with the same
  snake_case field names, integer `_id`, `model_versions._id` = version string, `settings._id` = key
  with a `value` object, `wait_predictions.features` an embedded object with the 14 contract keys,
  schedule times `"HH:mm:ss"` strings, datetimes BSON Date in **UTC**.
- **Time zones:** pymongo returns UTC dates as naive `datetime` values. The service converts them to
  `HOSPITAL_TZ` before deriving hours and weekdays (forecast arrivals), and converts hospital-local
  times back to UTC for query bounds and writes (`forecast_hour`, `generated_at`, `trained_at`).
  `trainedAt` in `/ai/models` is hospital-local `YYYY-MM-DDTHH:mm:ss`, as before.

| Collection | Read | Written |
|---|---|---|
| `wait_predictions` | first document per token (lowest `_id`): `features` | – |
| `tokens` | `issued_at`, `called_at`, `is_synthetic` (training label); `queue_type`, `doctor_id`, `issued_at` (OPD arrivals) | – |
| `doctors` | `department_id`, `avg_consult_minutes`, `user_id`, `is_active` | – |
| `departments` / `branches` | `branch_id`, `is_active` / `status = 'ACTIVE'` | – |
| `users` / `service_points` | `is_active` (only doctors who can take patients add capacity) | – |
| `doctor_schedules` | `doctor_id`, `service_point_id`, `day_of_week`, `start_time`, `end_time` | – |
| `settings` | `{_id: 'congestionThresholds', value: {high, critical}}` | – |
| `forecasts` | – | all documents with `forecast_hour` ≥ today 00:00 are replaced on every forecast run |
| `model_versions` | registry, active version (`is_active: true`) | one document per retrain; `status` / `is_active` on activation |
| `counters` | – | `{_id: 'forecasts'}`: one atomic `$inc` reserves the block of `_id` values for a forecast run |

The aggregation for the training set is `$sort {token_id, _id}` → `$group {$first: features}` →
`$lookup tokens` → `$match called_at != null` (`allowDiskUse`). The arrival and schedule joins are
done in Python over the small lookup collections (`doctors`, `departments`, `branches`, `users`,
`service_points`). Before reserving forecast ids the counter is lifted with `$max` to the highest
existing `forecasts._id`, so ids written without the counter (e.g. by a seed) are never reused.

**Authentication.** Every `/ai/*` endpoint requires the header `X-AI-Service-Token` to equal
`AI_SERVICE_TOKEN` (401 otherwise); the backend sends it from its own `AI_SERVICE_TOKEN`. If the
service has no token configured it fails closed with 503, unless `AI_ALLOW_UNAUTHENTICATED=true`
(local development only). `GET /health` is open. The Docker image listens on `0.0.0.0` inside the
container; publish port 8000 only on the internal network that the backend uses.

Run **one** uvicorn worker. The retrain and forecast "already running" guards and the model cache
live in each process.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0` | The backend's MongoDB database (Atlas: `mongodb+srv://…`) |
| `MONGODB_DB` | empty | Database name; empty = the name in the URI path, else `smart_opd` |
| `MONGODB_TIMEOUT_MS` | `3000` | Server selection / connect timeout (min 500) |
| `MODELS_DIR` | `./models` | Where `<version>.joblib` files are written and loaded |
| `HOSPITAL_TZ` | `Asia/Karachi` | Hospital local time. MongoDB stores UTC; hours and weekdays are derived in this zone |
| `AI_N_JOBS` | `-1` | CPU cores used to train forests |
| `AI_SEARCH_ITER` | `8` | RandomizedSearchCV iterations during retraining |
| `AI_MIN_TRAINING_ROWS` | `200` | Retraining is refused (400) below this many labelled tokens |
| `AI_FORECAST_LOOKBACK_DAYS` | `182` | History window of the forecast job |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `AI_DEPARTMENT_MIN_ROWS` | `30` | Test rows that make a department "major" for the Section 6.7.3 department rule |
| `AI_DEPARTMENT_TOLERANCE` | `1.2` | A major department with MAE > tolerance × its baseline MAE rejects the model (min 1.0) |
| `AI_SERVICE_TOKEN` | empty | **Required** shared secret expected in `X-AI-Service-Token` on `/ai/*` (empty → 503) |
| `AI_ALLOW_UNAUTHENTICATED` | `false` | Dev only: accept `/ai/*` without a token when `AI_SERVICE_TOKEN` is empty |

### Docker

```bash
docker build -t smart-opd-ai ./ai-service
docker run -p 8000:8000 -v opd-models:/app/models \
  -e AI_SERVICE_TOKEN=... \
  -e MONGODB_URI="mongodb://host.docker.internal:27017/smart_opd?replicaSet=rs0&directConnection=true" smart-opd-ai
```
With a replica-set URI the driver connects to the member host names stored in the replica-set
configuration. If `rs0` was initiated as `127.0.0.1:27017` on the host, that name is wrong inside
the container: add `directConnection=true` (single node) or initiate `rs0` with a reachable host name.

### Command line (Section 6.8: scheduled or manual retraining)

```bash
python scripts/train_cli.py                      # retrain (same as POST /ai/models/retrain)
python scripts/train_cli.py retrain --search-iter 4
python scripts/train_cli.py list
python scripts/train_cli.py activate rf-20261030-0915
python scripts/train_cli.py forecast --days 7    # same as POST /ai/jobs/forecast
python scripts/train_cli.py --mongodb-uri "mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0" --models-dir ./models list
python scripts/train_cli.py --mongodb-db smart_opd_copy list   # another database on the same server
```

The CLI prints JSON. It exits with 1 when a job is refused (for example, fewer than 200 rows). That makes
it suitable for a monthly cron job or Windows Task Scheduler entry (retraining) and a nightly
one (forecast).

### Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The suite needs no MongoDB server: each test gets a fresh **mongomock** database (pure-Python,
in-memory) injected with `db.set_client`. Its collections follow `database/MONGODB_DESIGN.md`
(integer `_id`, embedded `features` / `metrics` / `value` objects, UTC dates; the generators work in
hospital time and convert to UTC, so the time-zone handling is exercised too). pymongo is imported
only when a real client is created, so the suite also runs where pymongo cannot be installed.
mongomock does not implement transactions; on it the writes run without one (the code path used on
a standalone server). It covers:
- feature order and the Eq. 6.2 baseline formula;
- Eq. 6.3 normalisation (all-equal → 0), redistribution of the distance weight, and ordering;
- `/ai/rank-branches`;
- the training set: the first prediction per token, only called tokens, and chronological order;
- refusal below 200 rows;
- the full train → accept → predict → reject-equal → activate/retire → 404 flow;
- the forecast job: scheduled hours only, Eq. 6.5 capacity including partial hours, congestion levels
  from the `settings` thresholds, Monday peaks, replacement of stale horizon rows, idempotency, horizons
  longer than 7 days, and an empty database;
- the department rule, the REJECTED-cannot-be-activated rule, mixed/pilot data sources, old bundles,
  and the start-delay cap from `feature_max`;
- authentication (401 / 503 without a configured token, open `/health`);
- MongoDB specifics: `counters` id blocks (never reusing existing ids), forecast and model-version
  document shapes, UTC ↔ `HOSPITAL_TZ` conversion, database name selection, and 503 + `db: false` on
  database errors.

---

## Endpoints (docs/API_CONTRACT.md → "Internal AI service")

### `GET /health`
`{"status": "ok", "activeModel": "rf-20261030-0915" | null, "db": true}`. `db` is an addition that
reports whether the database answered.

### `POST /ai/predict-wait` — FR-06, FR-07
```jsonc
// request
{ "items": [ { "tokenId": 42, "features": {
    "patients_ahead": 3, "priority_ahead": 1, "doctor_avg_consult": 9.5, "doctor_recent_consult": 11.0,
    "interruptions_last_hour": 0, "session_started": 1, "minutes_to_start": 0, "hour_of_day": 10,
    "day_of_week": 3, "appointments_ahead": 0, "department_load": 4.5,
    "doctor_id": 2, "department_id": 1, "branch_id": 1 } } ] }
// response
{ "modelVersion": "rf-20261030-0915", "predictions": [ { "tokenId": 42, "predictedMinutes": 31.4 } ] }
```
- Loads the model whose `model_versions` document has `is_active: true` (its `_id` is the version) from `MODELS_DIR/<version>.joblib`. The
  model is cached in memory and reloaded automatically when another version becomes active (for
  example through the CLI). A model accepted by retraining or activated through the API is put into
  the cache straight away, so the first prediction after a model change does not reload the file and
  stays within the backend's 1.5 s timeout.
- Builds the DataFrame with the features in the exact contract order. Predictions are bounded to be
  non-negative and rounded to 0.1 (Section 6.4.3, step 4).
- Missing or null features are filled with the same rules used in training:
  `doctor_recent_consult` falls back to `doctor_avg_consult`, which falls back to 10, and everything
  else to 0. Only `patients_ahead` is required.
- Returns **503** `{"detail": ...}` when there is no active model or its file is missing. The backend
  then uses the Eq. 6.2 baseline.

### `POST /ai/rank-branches` — FR-08, FR-09 (Eq. 6.3)
```jsonc
{ "weights": { "wait": 0.6, "distance": 0.25, "congestion": 0.15 },
  "candidates": [ { "branchId": 1, "doctorId": 2, "predictedWaitMinutes": 55, "distanceKm": 3.2, "congestionRatio": 0.9 } ] }
→ { "ranked": [ { "branchId": 1, "doctorId": 2, "score": 0.0 } ] }      // ascending, lower = better
```
Wait, distance and congestion are each min-max normalised across the candidates. When all
candidates share the same value, the normalised value is 0. The score is
`w1·W + w2·D + w3·ρ`. If `distanceKm` is null (the patient shared no location), the distance
weight is given to wait and congestion in proportion to their own weights. Ties are broken by the
shorter predicted wait.

### `POST /ai/jobs/forecast` — FR-17 (Section 6.6), input to FR-18
Body `{"days": 7}` (optional, 1–31) → `{"generated": 39, "modelVersion": "rf-forecast"}`, plus
additions `horizonStart`, `horizonEnd` and `evaluation {rfMae, baselineMae, trainRows, testRows, selected}`.

1. Hourly OPD arrivals are counted from `tokens.issued_at` (`queue_type = 'OPD'`) per branch and
   department over complete days before today, on a zero-filled hourly grid.
2. A **RandomForestRegressor** is back-tested against the **seasonal baseline** on the last 2 weeks
   of history using MAE. The forest uses day of week, hour, arrivals in the same hour 1–4 weeks earlier,
   and their mean. The baseline is the mean of the same weekday and hour over the previous 4 weeks.
   Whichever is lower is used, giving `source` / `modelVersion` = `rf-forecast` or `seasonal-baseline`.
   The forest needs at least 50 fully lagged training rows; otherwise the baseline is used.
3. Capacity follows Eq. 6.5: `C_h = Σ 60 / c_j` over the department's doctors on duty in that
   hour, from `doctor_schedules` and `doctors.avg_consult_minutes`. A doctor on duty for only part of
   the hour counts pro rata, so 16:00–16:30 with c = 15 gives 2.0. As in the backend's live congestion
   ratio, only doctors who can take patients count: active doctor, active user account and active room
   (`service_points.is_active`).
4. `ρ = expected / capacity`, computed from the values as stored (both rounded to 0.1), so a reader who
   recomputes ρ from the document gets the same level. The level is NORMAL < `high` ≤ HIGH < `critical` ≤
   CRITICAL, with the thresholds read from the `settings` document `{_id: "congestionThresholds", value: {high, critical}}` (defaults 0.85 / 1.0).
5. `is_peak` is set when the forecast exceeds the 80th percentile of that branch-department's
   historical hourly arrivals, counting operating hours only.
6. Every `forecasts` document with `forecast_hour` from today 00:00 (hospital time, compared in UTC) onwards is deleted, so a run replaces all future forecasts,
   including rows past its own horizon (the backend's JS fallback writes now … now + 7 days, which
   would otherwise leave `baseline` rows beside the AI rows on the last day). New rows are inserted
   **only for hours with at least one scheduled doctor** in active departments of ACTIVE branches. The horizon covers whole
   days starting **today 00:00** (hospital time), so the dashboard can show a complete day. Today's own
   tokens are never used as input. Horizons longer than 7 days are forecast recursively, week by week.

### `POST /ai/models/retrain` — FR-22 (Sections 6.4, 6.7, 6.8)
`→ {"version", "metrics": {mae, rmse, r2, within10, baselineMae, testRows}, "accepted", "activated"}`,
plus additions `reason`, `activeModelMae` and `departmentCheck[]`.

- **Training set:** the **first** `wait_predictions` document of each token (lowest `_id`; its embedded `features` object is the
  state when the token was issued) joined with `tokens` where `called_at` is not null, for any queue
  type. The target is the number of minutes from `issued_at` to `called_at`. Rows with missing or malformed features,
  negative waits or waits above 12 h are dropped as data-quality filters.
- **Refused with 400** when fewer than 200 labelled rows exist, and **409** while another retrain runs.
- **Split:** chronological 80/20 by `issued_at`. A random split would leak future data (Section 6.7.1).
- **Tuning:** `RandomizedSearchCV` (`AI_SEARCH_ITER` iterations, default 8) with `TimeSeriesSplit(3)`
  over the ranges in Section 6.4.2: `n_estimators` 100–300, `max_depth` 8–30 or None,
  `min_samples_leaf` 1–10, and `max_features` of `sqrt`, 0.5 or all.
- **Metrics on the test period:** MAE, RMSE and R² (Eq. 6.6–6.8), plus the % of predictions with
  |error| ≤ 10 min. `baselineMae` is Eq. 6.2 computed from the same stored features.
- **Acceptance (Section 6.7.3):** the model's MAE must be below `baselineMae` **and**, when a model is
  already active, strictly below that model's MAE on the same test rows, **and** it must not be
  "systematically worse for any major department": a department with at least
  `AI_DEPARTMENT_MIN_ROWS` (default 30) test rows whose MAE exceeds `AI_DEPARTMENT_TOLERANCE`
  (default 1.2) × its own baseline MAE rejects the model (`departmentCheck[].major` / `.rejects`, and
  the `reason` names the departments). Smaller departments are listed and noted in the `reason` but
  cannot reject a model on their own.
- **Manual activation** (`POST /ai/models/{version}/activate`): only versions that passed acceptance
  (`ACTIVE`, or `RETIRED` for a rollback) can be activated. A `REJECTED` version answers **409**.
- **Versioning:** the version is named `rf-YYYYMMDD-HHMM`, with `-2`, `-3`… on a collision. The joblib
  bundle holds the model, the feature list, the training and test periods, the chosen hyperparameters,
  the CV MAE, feature importances, metrics, the per-department check and the sklearn version. The
  model is a scikit-learn `Pipeline`: a `ColumnTransformer` one-hot encodes `doctor_id`,
  `department_id` and `branch_id` (`OneHotEncoder(handle_unknown="ignore")`, so an id unseen in
  training adds nothing instead of being read as a number) and passes the 11 numeric features
  through to the forest; feature importances are summed back onto the 14 contract keys. The bundle
  records `feature_encoding = "onehot-ids-v1"`; bundles saved before this change have no such key,
  are reported as `"raw"` and still load and predict unchanged (same feature keys and predict API). A
  `model_versions` document (`_id` = version, `metrics` object, `trained_at` UTC) is written: `ACTIVE`/`is_active: true` when accepted (the previous active model
  becomes `RETIRED`), otherwise `REJECTED`.

### `GET /ai/models` — FR-22
Newest first: `[ {version, trainedAt, trainingRows, dataSource, status, isActive, metrics{…}} ]`,
the same shape as `/api/admin/models`.

### `POST /ai/models/{version}/activate` — FR-22
`→ {"version": "...", "activated": true}`. The previously active version becomes `RETIRED`. Returns 404
for an unknown version and 409 when the version's model file is missing.

---

## Requirement mapping

| Requirement | Where |
|---|---|
| FR-06 doctor-specific AI wait prediction | `predictor.py`, `/ai/predict-wait`. `doctor_id` and the doctor's consult statistics are features |
| FR-07 continuous update of estimates | The backend re-calls `/ai/predict-wait` on every queue change. Responses are fast because the model is cached and loaded at startup |
| FR-08 smart branch recommendation | `ranking.py`, `/ai/rank-branches` (Eq. 6.3) |
| FR-09 alternatives on congestion | Same scoring; congestion ratio is an input. The trigger logic lives in the backend |
| FR-17 congestion forecasting / peak hours | `forecasting.py`, `/ai/jobs/forecast` (Eq. 6.5, thresholds, 80th-percentile peaks) |
| FR-18 workload / resource allocation | Supplies the `forecasts` rows (expected arrivals vs capacity) that the backend turns into recommendations |
| FR-22 model retraining management | `training.py`, `/ai/models/*`, `scripts/train_cli.py` |
| NFR-07 accuracy measured against the baseline | Acceptance rule above. Every version stores `baselineMae` |
| Section 6.10 privacy | The service never receives patient identity or location. Ranking gets only distances computed by the backend |

## Notes and limitations
- Features must be computed identically at prediction time and training time. This service trusts
  `wait_predictions.features` as written by the backend.
- Doctor, department and branch ids are one-hot encoded (see Versioning above); target encoding can
  be evaluated once real data exist (Section 6.3).
- Public-holiday flags (Section 6.6.1) are not modelled because there is no holiday collection.
- Capacity uses the **current** weekly schedules for every forecast hour. Historical schedule
  changes are not reconstructed.
- The forecast replacement compares BSON dates (`forecast_hour >= today 00:00` converted to UTC), so it
  relies on the backend storing `forecast_hour` as a Date in UTC, as the design requires.
- The MongoDB code has been tested against mongomock only (no server was available while it was
  ported); transactions and the pymongo driver path are untested until it runs against a real `rs0`.
- Retraining time grows with the history. On the seeded development database (about 73,500 labelled
  tokens) a retrain fits `3 × AI_SEARCH_ITER + 1` forests (25 with the default 8). The backend's
  `/api/admin/models/retrain` proxy waits `AI_JOB_TIMEOUT_MS` (default 120 s). On a slow machine, lower
  `AI_SEARCH_ITER` or raise that timeout, or run `scripts/train_cli.py`. If the proxy gives up, the job
  still finishes here and registers the model; `GET /api/admin/models` shows it afterwards.
