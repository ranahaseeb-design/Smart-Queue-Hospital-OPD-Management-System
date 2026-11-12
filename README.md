# Smart Digital Queue Management System for Hospital OPD

AI-based waiting-time prediction and branch recommendation for multi-branch hospital
Out-Patient Departments (Final Year Project, Faculty of IT, University of Lahore).

Patients join a doctor's OPD queue from their phone, get a digital token, follow their position
live and see a predicted wait. Staff run their queues from a web dashboard, and administrators
manage branches, monitor live load and read reports, forecasts and resource recommendations.

## Components

A **MERN** stack (MongoDB, Express, React, Node.js), plus a Python AI service and a Flutter app.

| Folder | What it is | Stack | Port |
|---|---|---|---|
| [backend/](backend/README.md) | REST API + real-time channel | Node.js, Express, Socket.IO, MongoDB (Mongoose) | 4000 |
| [ai-service/](ai-service/README.md) | Internal AI service: wait prediction, branch ranking, forecasting, retraining | Python, FastAPI, scikit-learn (Random Forest), pandas | 8000 |
| [staff-dashboard/](staff-dashboard/README.md) | Doctors, OPD, lab and pharmacy staff | React, Vite | 5173 |
| [admin-dashboard/](admin-dashboard/README.md) | Branch admins, hospital admins, management | React, Vite, Recharts | 5174 |
| [mobile_app/](mobile_app/README.md) | Patient app (Android) | Flutter (Dart) | — |
| [database/MONGODB_DESIGN.md](database/MONGODB_DESIGN.md) | MongoDB collections, fields, indexes and concurrency rules | | |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | Every REST endpoint, JSON shape and socket event all components follow | | |

```
Patient app ──┐                         ┌── AI service (FastAPI, :8000, internal only)
Staff dash  ──┼── HTTPS/JSON + Socket.IO ┤
Admin dash  ──┘     Backend (:4000)      └── MongoDB (replica set)
```

If the AI service is down or has no trained model, the backend falls back to the queueing
baseline (Eq. 6.2), a JavaScript branch ranking and a seasonal-baseline forecast, so queue
operations never depend on the AI layer.

## Quick start (local demo)

Requirements: Node.js 22.13+ (24 recommended). Python 3.11+ for the AI service and the Flutter
SDK for the patient app are optional for a dashboard-only demo.

### 1. Backend

> **MongoDB.** The backend stores everything in MongoDB 6.0+ (Mongoose) and needs a **replica set**
> for its transactions. Locally: install MongoDB Community Server, add `replication: replSetName: rs0`
> to `mongod.cfg`, restart the MongoDB service and run `rs.initiate()` once in `mongosh`; or use a
> MongoDB Atlas cluster. Default connection string:
> `MONGODB_URI=mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0`. Step-by-step:
> [backend/README.md](backend/README.md#mongodb).

```bash
cd backend
npm install
npm run setup
```

`npm run setup` creates `backend/.env` from `.env.example` and fills in a random `JWT_SECRET` and
`AI_SERVICE_TOKEN` (it never overwrites real values). The server refuses to start with a missing,
short or placeholder `JWT_SECRET`.

Then seed the demo data (3 Lahore branches, 28 doctors, about 60 days of synthetic history; this
drops and recreates the `smart_opd` database) and start the API:

```bash
npm run seed
npm start
```

Check it at <http://localhost:4000/api/health>.

### 2. Dashboards

```bash
cd staff-dashboard && npm install && npm run dev
```

```bash
cd admin-dashboard && npm install && npm run dev
```

Staff Dashboard: <http://localhost:5173>. Admin Dashboard: <http://localhost:5174>.

### 3. AI service (optional)

```bash
cd ai-service
python -m venv .venv
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Set the same `AI_SERVICE_TOKEN` in `ai-service/.env` and `backend/.env`. Train the first model
with `python scripts/train_cli.py`, or from the Admin Dashboard's Model Management page.

### 4. Patient app (optional)

```bash
cd mobile_app
flutter create . --platforms android --project-name smart_opd
flutter pub get
flutter run --dart-define=API_URL=http://10.0.2.2:4000
```

See [mobile_app/README.md](mobile_app/README.md) for details.

## Demo accounts

Development only, created by `npm run seed`:

| Role | Login | Password |
|---|---|---|
| Hospital Admin | `admin@opd.test` | `Admin@123` |
| Branch Admin (Model Town) | `branchadmin@opd.test` | `Admin@123` |
| Doctor | `doctor1@opd.test` … `doctor28@opd.test` | `Staff@123` |
| Lab staff | `lab1@opd.test` | `Staff@123` |
| Pharmacy staff | `pharmacy1@opd.test` | `Staff@123` |
| Patient | `patient@opd.test` (phone `03001234567`) | `Patient@123` |

`DEMO_ALWAYS_OPEN=true` (the default in `.env.example`) lets doctors accept patients at any hour
of a scheduled weekday, so the demo works outside clinic hours.

## Tests

| Component | Command | Suite |
|---|---|---|
| Backend | `cd backend && npm test` | 109 tests (node:test; integration tests use temporary MongoDB databases) |
| AI service | `cd ai-service && pytest` | 45 tests (mongomock) |
| Staff Dashboard | `cd staff-dashboard && npx vitest run` | 57 tests |
| Admin Dashboard | `cd admin-dashboard && npx vitest run` | 38 tests |
| Patient app | `cd mobile_app && flutter test` | widget and model tests |

## Requirements coverage

| Requirement | Where |
|---|---|
| FR-01 registration and login | backend `routes/auth.js`; mobile login/register |
| FR-02 branch, department, doctor selection | backend `routes/browse.js`; mobile Find Doctor |
| FR-03, FR-05 remote token, real-time status | backend `queueService.js`, `realtime.js`; mobile My Token |
| FR-04 linked lab and pharmacy tokens | backend `issueLinkedToken`; Staff Dashboard; mobile Linked Tokens |
| FR-06, FR-07 AI wait prediction, live updates | backend `featureBuilder.js`, `predictionService.js`; ai-service `predictor.py` |
| FR-08, FR-09 branch recommendation | backend `recommendationService.js`; ai-service `ranking.py`; mobile Recommendations |
| FR-10 appointments | backend `appointmentService.js`; mobile Appointments |
| FR-11 notifications | backend `notificationService.js`; mobile Notifications (in-app; FCM optional) |
| FR-12, FR-13 staff operations, priority | backend `queueService.js`; Staff Dashboard |
| FR-14 to FR-18 administration, monitoring, reports, forecasts, workload | backend `adminService.js`, `analyticsService.js`, `forecastService.js`; Admin Dashboard |
| FR-19, FR-20 history and feedback | backend `routes/patient.js`; mobile History & Feedback |
| FR-21 queue event log | `queue_events`, written in the same transaction as every status change |
| FR-22 model retraining | ai-service `training.py`; Admin Dashboard Model Management |

## Status and limitations

- **Synthetic data.** The seed history is simulated and flagged `is_synthetic`. Model metrics on
  it only show that the pipeline works; they say nothing about real-world accuracy (Section 6.11).
- **Not yet run:** the Flutter app compiles (`flutter analyze`, `flutter test`) but has not run on
  a device; the MongoDB backend and AI service have not yet run against a real MongoDB server;
  and the AI service has only been tested in Pyodide, not native CPython.
- **Database choice:** the FYP documentation (Section 3.8) specifies MySQL. This MERN version
  uses MongoDB instead, so the documentation's database design and deployment sections need
  updating to match.
- **Push notifications:** in-app notifications work; Firebase Cloud Messaging is documented in
  the mobile README but not wired in, and SMS is optional and not implemented.
- **Production hardening:** see the "Security notes for production" sections in each client
  README (token storage, HTTPS, cleartext traffic).
