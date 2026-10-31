# Smart OPD — Admin Dashboard

React web application for **Branch Administrators**, **Hospital Administrators** and **Hospital
Management** of the *Smart Digital Queue Management System for Hospital OPD with AI-Based Waiting
Time Prediction and Branch Recommendation* (FYP documentation, Section 4.2.3). It is a separate app
from the Staff Dashboard, so day-to-day queue operations and administration stay apart (least
privilege, Section 3.2).

It talks only to the backend REST API and Socket.IO channel described in
[`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md); it never calls the AI service directly.

| | |
|---|---|
| Stack | Vite 6.4, React 18.3 (JavaScript), react-router-dom 6.30, socket.io-client 4.8, Recharts 2.15, plain CSS (CSS variables); exact versions pinned in `package.json` |
| Dev server | <http://localhost:5174> (`strictPort`) |
| Backend | `VITE_API_URL` (default `http://localhost:4000`), REST under `/api`, Socket.IO on the same origin |
| Tests | Vitest unit tests for the pure helpers (`npm test`) |

## Setup and running

Prerequisites: Node.js 18+ (developed with Node 24 / npm 11) and the backend running on port 4000.

```bash
cd admin-dashboard
npm install
cp .env.example .env        # optional: only needed if the backend is not on http://localhost:4000
npm run dev                 # http://localhost:5174
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serves the production build on port 5174 |
| `npm test` | Runs the Vitest unit tests (`src/**/*.test.js`) |

`dist/` is a static single-page app. When hosting it behind a web server, route unknown paths to
`index.html` (history API fallback) so deep links such as `/forecasts` work.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | Backend origin. REST calls go to `${VITE_API_URL}/api/...`, the socket connects to `${VITE_API_URL}`. |
| `VITE_HOSPITAL_TZ` | `Asia/Karachi` | Hospital time zone (the backend `TZ`). API datetimes are hospital wall-clock times without a zone, so "today" (report / forecast defaults) and relative times ("5 min ago", "in 3 h") use this zone even when the browser runs in another one. |

Vite inlines `VITE_*` variables at build time, so set it before `npm run build` for other environments.

### Signing in (development)

Use the seed accounts from the API contract (created by `backend/src/db/seed.js`):

| Role | Login | Password |
|---|---|---|
| Hospital Admin | `admin@opd.test` | `Admin@123` |
| Branch Admin (branch 1) | `branchadmin@opd.test` | `Admin@123` |

In `npm run dev` the login page shows two buttons that fill in these seed accounts. They are guarded by
`import.meta.env.DEV` and are not included in production builds. Staff and patient accounts are rejected
with a message pointing to the Staff Dashboard / mobile app. Hospital Management users use
`HOSPITAL_ADMIN` accounts (the contract defines no separate management role).

## How it works

- **Authentication** (`src/context/AuthContext.jsx`, `src/api/client.js`): `POST /api/auth/login`; only
  `BRANCH_ADMIN` and `HOSPITAL_ADMIN` are accepted. The JWT and user are kept in `localStorage`, sent as
  `Authorization: Bearer …`, and the profile is refreshed from `GET /api/auth/me` on load. Any `401` from
  the API logs the user out and returns to the login page with a "session ended" note. After signing in,
  the user returns to the page they came from; only in-app paths are accepted (`src/utils/navigation.js`),
  so a crafted link cannot turn the login page into an open redirect.
- **Branch scope** (`src/context/ScopeContext.jsx`): hospital admins get an *All branches / branch*
  filter in the top bar (remembered per browser); branch admins are locked to `user.adminBranchId`.
  Every scoped request adds `?branchId=`.
- **Real time** (`src/context/RealtimeContext.jsx`, `src/hooks/useLiveRefresh.js`): one Socket.IO
  connection with `auth: { token }`, which subscribes to the `admin` room. On `queue:updated` and `alert`
  the monitoring screens re-fetch their REST resources (debounced 1.2 s). While the socket is down they
  poll every 20 s, and the top bar shows *Live* or *Polling*. Congestion alerts also show as a toast. The
  backend re-uses an alert id per department (`live-<departmentId>`) and emits again when the level rises,
  so toasts are de-duplicated on id + level + time: a HIGH → CRITICAL escalation is always shown.
- **Errors**: `{ error: { code, message } }` bodies become readable toasts and banners. `AI_UNAVAILABLE`
  (503) gets its own banner that explains the fallback.
- **CSV export** (FR-16): `GET /api/admin/reports?...&format=csv` is fetched with the Bearer header
  (`Accept: text/csv`), turned into a blob and saved through a temporary `<a download>`. The file name comes
  from `Content-Disposition` when the backend exposes it to the browser
  (`Access-Control-Expose-Headers: Content-Disposition`); otherwise `<type>_<from>_<to>.csv` is used.
- **Report charts**: the report's numeric columns are the selectable metrics and its text columns the
  categories. When the first text column repeats (several departments per branch), further text columns
  are joined until every bar is unique ("Model Town · Cardiology"). Date series are drawn as a line chart,
  everything else as ranked horizontal bars (top 31; the table always lists every row).
- **Roles** (`src/utils/roles.js`): navigation entries, buttons and form fields the role cannot use are
  hidden or disabled (Table 3.2). The backend still enforces every rule.
- **Reusable CRUD** (`src/components/CrudPage.jsx`, `DataTable.jsx`, `FormFields.jsx`, `Modal.jsx`):
  each master-data page declares its columns, form fields and payload mapping. The generic component
  provides search, sorting, paging, the create/edit modal, validation, toasts and the
  *Deactivate* / *Delete* confirmation.

## Screens and requirement mapping

| Screen (Table 4.19) | Route | Requirements | Notes |
|---|---|---|---|
| Login | `/login` | FR-01 | Admin roles only; 401 → logout |
| Live Overview & Alerts | `/overview` | FR-15, FR-17, NFR-01 | KPI tiles; department filter; departments table with load bar and congestion badge (Eq. 6.5); waiting-by-department chart; branches table (all-branch view); service points with *now serving*; alert list (LIVE / FORECAST) |
| Branches | `/branches` | FR-14 | Hospital admin: create / edit / deactivate. Branch admin: read-only |
| Departments | `/departments` | FR-14 | Standard specialty suggestions from `GET /specialties` |
| Doctors | `/doctors` | FR-14 | Creating a doctor creates the doctor's STAFF login account. Link to the doctor's schedule |
| Schedules | `/schedules?doctorId=` | FR-14 (feeds FR-10, FR-17) | Per-doctor week view; days Mon…Sun = 1…7, times `HH:mm`; one create can add the same session to several days; hard delete |
| Service Points | `/service-points` | FR-14 | OPD rooms, LAB and PHARMACY counters |
| Staff & Users | `/users` | FR-14 | User accounts (branch admins: STAFF of own branch only) and staff→service point assignments; a new staff account can be assigned to a service point straight away. Administrators cannot change their own role or deactivate themselves; patient accounts (self-registered in the mobile app) are not managed here |
| Reports | `/reports` | FR-16 | 5 report types, date range with presets, chart picked from the report's numeric columns (line chart for date series), table, CSV export (fetched with the auth header, saved as a blob) |
| Forecasts | `/forecasts` | FR-17 | Date and department filters; expected arrivals bars coloured by congestion level, capacity step line, shaded peak hours; hourly detail table; *Run forecast now* reports whether the AI model or the seasonal baseline produced the rows |
| Workload & Recommendations | `/workload` | FR-18 | Workload table and utilisation chart; recommendation cards (decision support only) |
| Feedback | `/feedback` | FR-20 | Average rating, response share, distribution chart, filterable comment list |
| Model Management | `/models` | FR-22 | Hospital admin only. Versions with MAE / RMSE / R² / within ±10 min / baseline MAE / improvement, status and active badge, MAE vs. baseline chart, *Retrain* with spinner and result (accepted / activated), *Activate* with a warning when a version is not better. Notes that metrics on synthetic data are not real-world accuracy |
| Settings | `/settings` | FR-08, FR-09, FR-10, FR-11, FR-17 | Hospital admin edits, branch admins see a read-only view. Recommendation weights must sum to 1 (with *Normalise to 1*), congestion thresholds (HIGH < CRITICAL), alternative-suggestion wait, notify positions ahead, slot length |

Soft-deleted master data (branches, departments, doctors, service points, users) is labelled
**Deactivate** and stays visible, greyed out, with a *Show inactive* toggle. Deactivated rows can be
re-activated with *Edit*. Schedules and assignments are hard-deleted (**Delete** / **Remove**), as the
contract specifies.

## Project layout

```
src/
  api/client.js            fetch wrapper, token storage, 401 handling, CSV download
  context/                 Auth, Scope (branch filter), Realtime (Socket.IO), Toasts
  hooks/                   useResource (GET + reload), useLiveRefresh, useLookups
  components/              Layout, CrudPage, DataTable, FormFields, Modal, ui (badges, KPI tiles, banners), ChartTooltip, Icon
  pages/                   one file per screen
  utils/                   formatting, roles, settings validation, forecast aggregation, report helpers, model metrics,
                           chart colours, safe post-login redirect; utils.test.js holds the unit tests
  styles/index.css         design tokens and all styles (responsive: drawer navigation below 960 px)
```

## How the client reads the contract

These points are not fixed by the contract, so the client handles them as follows:

- `utilization` (workload) and `congestionRatio` are ratios (1.0 = 100 %).
- `metrics.within10` is reported by the AI service as a percentage (76.4). The client also accepts a fraction (0.764): values ≤ 1 are treated as fractions.
- `servicePoints[].nowServing` in `/admin/dashboard` may be a display-number string or a
  `{ tokenId, displayNumber }` object. Both are rendered.
- Forecast rows carry no `branchName`, so the client looks it up from the branch list.
- `PUT /admin/doctors/:id` sends `{ fullName, email, phone, departmentId, avgConsultMinutes, isActive }`
  plus `password` only when a new one is typed. `PUT /admin/users/:id` likewise omits an empty password.
- If a `VALIDATION_ERROR` includes `error.details` (as `{ field: message }` or `[{ field, message }]`),
  the messages are shown on the matching form fields. Otherwise the message appears above the form.

## Verification status

- `npm install`, `npm run build` and `npm test` (25 Vitest unit tests for the pure helpers) pass.
- The UI was exercised in a browser (desktop and 375 px mobile width) against a throw-away local mock of
  the contract endpoints **with a Socket.IO server**: login (wrong password, seed accounts, 401 → logout),
  branch filter, live refresh on `queue:updated`, *Live* → *Polling* → *Live* when the socket drops and
  reconnects, HIGH and CRITICAL alert toasts, branch create / validation / deactivate, doctor create with a
  409 duplicate e-mail, multi-day schedule create with room/branch validation, staff account plus
  assignment, report chart and CSV export, forecast run, model retrain (503, then success) and activate,
  settings validation and save, and the branch-admin restrictions (locked branch, read-only branches and
  settings, no Model Management, STAFF-only accounts).
- It has **not** been tested against the real backend, which was being finished at the same time; an
  integration pass against `backend/` is still needed.

### Dependency audit

`npm audit` still lists advisories that have no fix within the pinned major versions:
`react-router-dom` 6.30.6 (moderate; the fix is in v7 — the post-login redirect is sanitised independently),
`vite` 6.4.4 (moderate, dev server only; fixed in 6.4.5, which was too new to adopt) and `vitest` 3.2.7 /
`tinypool` (test runner only; fixed in vitest 5). Only react-router-dom ships in the production bundle.
