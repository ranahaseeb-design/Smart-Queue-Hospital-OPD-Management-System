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
| [admin-dashboard/](admin-dashboard/README.md) | **Smart OPD Dashboard** — the one web app for all four login types: admin screens (branch and hospital admins) plus the doctor/staff screens | React, Vite, Recharts | 5174 |
| [staff-dashboard/](staff-dashboard/README.md) | Doctor/staff screens (queue console) — a module of the Smart OPD Dashboard (imported as `@staff`); still runs standalone for development | React, Vite | (5173) |
| [mobile_app/](mobile_app/README.md) | Patient app (Android) | Flutter (Dart) | — |
| [database/MONGODB_DESIGN.md](database/MONGODB_DESIGN.md) | MongoDB collections, fields, indexes and concurrency rules | | |
| [docs/API_CONTRACT.md](docs/API_CONTRACT.md) | Every REST endpoint, JSON shape and socket event all components follow | | |

```
Patient app ──────┐                         ┌── AI service (FastAPI, :8000, internal only)
                  ├── HTTPS/JSON + Socket.IO ┤
Smart OPD         │     Backend (:4000)      └── MongoDB (replica set)
Dashboard (:5174)─┘  (doctors, staff, branch and hospital admins)
```

If the AI service is down or has no trained model, the backend falls back to the queueing
baseline (Eq. 6.2), a JavaScript branch ranking and a seasonal-baseline forecast, so queue
operations never depend on the AI layer.

## One command: `npm run dev`

Open **Git Bash** (or any terminal) in the project root — or inside `admin-dashboard`,
`staff-dashboard` or `backend`, where `npm run dev` runs the same launcher — and run:

```bash
npm run dev
```

`start-all.js` starts and connects everything, with colour-coded logs:

| Tag | What happens |
|---|---|
| `[MONGO]` | Reuses MongoDB on `127.0.0.1:27017`; otherwise starts the Windows `MongoDB` service or `mongod` itself (portable install in `%USERPROFILE%\mongodb-portable`, `C:\Program Files\MongoDB`, or `PATH`; detached, so it keeps running), then initialises replica set `rs0` if needed |
| `[AI]` | AI service (Random Forest) on `:8000` with `ai-service/.venv` / `venv` if present, else the system Python; skipped with a message if Python or its packages are missing (the backend then uses the Eq. 6.2 baseline) |
| `[BACKEND]` | Backend on `:4000`, waits for `/api/health` |
| `[FRONTEND]` | Smart OPD Dashboard (Vite) on <http://localhost:5174> |

It creates `backend/.env` (`npm run setup`) and `ai-service/.env` (same `AI_SERVICE_TOKEN`) when
they are missing, reuses services that are already running, and `Ctrl+C` stops the AI service,
backend and dashboard (MongoDB keeps running). Overrides: `MONGOD_PATH`, `MONGO_DBPATH`, `PYTHON`,
`SKIP_AI=1`. Single pieces for development: `npm run dev:vite` (admin-dashboard / staff-dashboard)
and `npm run dev:server` (backend, watch mode).

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

### 2. Smart OPD Dashboard (one web app for every role)

The dashboard imports the doctor/staff screens from `staff-dashboard/src`, so install both
folders once, then run the dashboard:

```bash
cd staff-dashboard && npm install
```

```bash
cd admin-dashboard && npm install && npm run dev
```

Open <http://localhost:5174>. The login page shows every login type; doctors and staff get the
queue console, branch and hospital administrators get the admin screens, and patients get the
**Patient Portal & token kiosk** — same address.

**Patient Portal / Get Token** (featured card): sign in with phone/email, **create an account**
("New patient? Create an account"), or **1-click walk-in check-in** (no account). The portal's
menu: **Get token**, **Appointments** (book, reschedule, cancel, check in), **My visits** (history
and one rating per visit), **Notifications** (unread badge; token updates and appointment
reminders) and your name → **Profile**. Choose an area (preset Lahore coordinates or your browser location),
department, branch and doctor/OPD room; the AI estimated wait comes from the Random Forest (or the
Eq. 6.2 fallback, labelled). When the chosen queue is busy (> 25 min or > 4 waiting) the portal
shows the best option from the haversine + load-balancing scorer with minutes saved and a
one-click switch. The **live token pass** updates over the socket (with polling fallback): "NOW
SERVING — Proceed to Room 1" with a pulse and optional chime when the doctor calls next, then the
OPD → Lab/Pharmacy → Completed journey. The header's **Demo load simulator** injects 5 simulated
patients into a doctor's queue for presentations. Walk-in check-in and the simulator need
`DEMO_TOOLS=true` (default outside production).

**Several roles at once.** Each role keeps its own browser session (`smartopd.doctor.*`,
`smartopd.staff.*`, `smartopd.admin.*`, `smartopd.patient.*`) and each tab remembers its role, so a
doctor, an admin and a walk-in patient can be signed in side by side in three tabs; signing in or
out in one tab never signs another role out. For committee demos (`DEMO_TOOLS`), the doctor
header has **Switch doctor / room (demo)** and Admin > Doctors has a **Live queue** button that
opens that doctor's queue in a new tab.

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

Development only, created by `npm run seed`. The Smart OPD Dashboard (<http://localhost:5174>)
opens on one role-card login (Patient Portal / Get Token, Doctor, Staff, Branch Administrator,
Hospital Administrator); pick the card that matches the account — the backend refuses a token when
the account type and the card differ. In development each form has a "Fill" button for its seed
account; patients can also use the 1-click walk-in check-in.

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

**Demo tools for presentations** (load committee demo data, peak congestion, reset demo data, the
doctor / room switcher, "Live queue" and the patient load simulator) are hidden by default. Turn
them on with the switch under the role cards on the login page, or in the admin user menu
("Demo tools: On"). The switch is saved per browser. In the admin header the tools sit in one
**Demo** menu; **Reset demo data** removes every demo, peak and walk-in patient again.

## Tests

| Component | Command | Suite |
|---|---|---|
| Backend | `cd backend && npm test` | 131 tests (node:test; integration tests use temporary MongoDB databases) |
| AI service | `cd ai-service && pytest` | 45 tests (mongomock) |
| Staff screens (module) | `cd staff-dashboard && npx vitest run` | 96 tests |
| Smart OPD Dashboard | `cd admin-dashboard && npx vitest run` | 131 tests |
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
  a device. The backend (131 tests), the AI service (native Python 3.12, training and forecasts
  against the live database) and the Smart OPD Dashboard have been run against MongoDB 9.0.8 (`rs0`).
- **Differences from the FYP document** are listed in [docs/IMPLEMENTATION_NOTES.md](docs/IMPLEMENTATION_NOTES.md).
- **Database choice:** the FYP documentation (Section 3.8) specifies MySQL. This MERN version
  uses MongoDB instead, so the documentation's database design and deployment sections need
  updating to match.
- **Push notifications:** in-app notifications work; Firebase Cloud Messaging is documented in
  the mobile README but not wired in, and SMS is optional and not implemented.
- **Production hardening:** see the "Security notes for production" sections in each client
  README (token storage, HTTPS, cleartext traffic).
