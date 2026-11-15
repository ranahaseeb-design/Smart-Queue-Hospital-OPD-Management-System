# Upgrade 2026 — build plan (Phases 1–3)

Scope stays the documented FYP domain: OPD queues across a multi-branch hospital network with
linked `LAB` / `PHARMACY` tokens, roles `PATIENT`, `STAFF`, `BRANCH_ADMIN`, `HOSPITAL_ADMIN`, and
non-clinical queue data only (FR-01…FR-22, UC-01…UC-19, Data Dictionary 4.9, Chapter 6).
**`docs/API_CONTRACT.md` is binding**; every new endpoint/field used below is defined there.

## Decisions (read first)

1. **Eq. 6.2 notation.** Document: `W = (n_ahead + n_priority) · c̄_doctor + d_start`. In code
   `patients_ahead` already includes priority tokens, so `n_ahead` = **normal** (non-priority)
   tokens ahead and `n_priority` = priority tokens ahead. Numbers do not change; comments, docs
   and `estimate.explain` use this mapping.
2. **Queue order** (FR-13, data dictionary "higher = earlier"): `priority_level DESC`, then
   checked-in appointment tokens (`from_appointment`), then `issued_at ASC` → EMERGENCY (2) >
   ELDERLY / DIFFERENTLY_ABLED (1) > APPOINTMENT (0 + appointment) > NORMAL (0). Priority levels
   keep their values (mobile app and AI features unchanged). Badge mapping in every UI:
   level 2 → `EMERGENCY` (pulsing crimson), level 1 → `ELDERLY` or `DIFFERENTLY_ABLED` from
   `priorityCategory` (amber), level 0 + `fromAppointment` → `APPOINTMENT` (blue), else `NORMAL`
   (slate).
3. **Display board** — the document puts physical display hardware out of scope "although the
   staff and admin web dashboards can be shown on any screen". So `/display` is a page of the
   Staff Dashboard behind staff/admin login (`GET /api/display`), shows token numbers only (no
   names), and is meant to be opened full-screen on a TV.
4. **Patient Web Portal** — a new React client (`patient-portal/`, port 5175) of the same PATIENT
   API the Flutter app uses. The Flutter app stays the documented patient deliverable; the portal
   adds a web channel. No new patient capabilities except FR-09 "switch my token" (contract:
   `POST /tokens/:id/switch`, only on the patient's own click — the system never moves a token
   without consent, Section 6.5.3).
5. **Theme** — "Clinical Night": dark slate is the default (`#0F172A` page, `#1E293B` cards,
   emerald `#10B981` / teal `#14B8A6` accents); light is opt-in. Canonical tokens:
   `docs/design-system/tokens.css`, copied **verbatim** to each app's `src/styles/tokens.css`.
   Theme toggle: two states, **Dark ↔ Light**, stored in `localStorage["smartopd.theme"]`
   (`"dark" | "light"`; anything else / missing / storage blocked → dark), applied as
   `<html data-theme="…">` by an inline script in `index.html` before first paint (wrap storage
   access in try/catch). The OS colour scheme is no longer followed.
6. **Honesty rules** — no fake data, no static placeholders: every number on screen comes from the
   API. Loading → skeletons; empty → a real empty state saying why; errors → a message + retry.
   When the AI service is down, Model Management says so (it can't show metrics it doesn't have).
   The retraining stepper animates the pipeline stages while the request runs, but the outcome
   (accepted / activated / rejected, metrics) is the real response; stage timing is approximate
   and labelled so. The "+1 doctor session" simulator is a client-side what-if, labelled
   "estimate", never written anywhere.
7. **Accessibility (NFR-03, elderly users)** — body text ≥ 7:1, muted ≥ 4.5:1 (the tokens are
   tuned for this), touch targets ≥ 44 px (≥ 56 px for the staff action bar), visible focus
   rings, every icon-only button has an `aria-label`, status is never colour-only (badge text +
   colour), live regions (`aria-live="polite"`) for queue changes, and all animation respects
   `prefers-reduced-motion` (the tokens zero the durations; JS count-ups must check it too).
8. **Real time (NFR-01, ≤ 3 s)** — Socket.IO events trigger a re-fetch; keep a polling fallback
   (≤ 3 s on `/display`, ≤ 15 s elsewhere) while the socket is disconnected.
9. **Dependencies** — prefer what each app already has (React, react-router, Recharts in the
   admin app, socket.io-client, Vitest). No new UI kits. Animations in CSS (keyframes,
   transitions) or tiny hooks; no animation libraries.

10. **One dashboard (added after the plan started)** — the user wants a single web dashboard for
    all logins. `admin-dashboard/` is now the **Smart OPD Dashboard** (port 5174): `/login` is the
    shared four-card sign-in (`UnifiedLoginPage`), `RootApp` loads the admin screens for
    BRANCH_ADMIN / HOSPITAL_ADMIN or the doctor/staff screens for STAFF (imported from
    `staff-dashboard/src` as `@staff`), each with its own stylesheet; sign-in/out reload the page.
    Staff-screen work (console, `/display`) still lives in `staff-dashboard/src`; when merged,
    give administrators a way to open `/display` from the admin section (it needs staff routes).

11. **Patient Portal inside the one dashboard (replaces the separate `patient-portal/` app)** —
    a PATIENT section of the Smart OPD Dashboard (`admin-dashboard/src/patient/`) with a featured
    "Patient Portal / Get Token" login card, 1-click walk-in check-in (`POST /auth/guest`), booking
    with area presets + haversine distances + the Random Forest estimate (`estimateModelVersion`),
    the busy-queue recommendation (> 25 min or > 4 waiting) with one-click switch, the live token
    pass (socket + 4 s polling, "NOW SERVING — Proceed to Room N", chime, journey) and the demo
    load simulator (`POST /demo/load-queue`). `DEMO_TOOLS` gates the guest and demo endpoints.
    The paused `upgrade/patient` agent is superseded; reuse its appointments / history / feedback
    screens here if they are worth keeping.

## Phase 1 — backend, database, AI (branch `upgrade/backend`)

- Health: `.env` / `MONGODB_URI` checks, async error handling on every route, all tests green.
- Seed — SUPERSEDED (decision 12): keep the current Model Town / Gulberg data, rename DHA → Johar Town. Original plan: Gulberg / Johar Town / DHA; Cardiology,
  Gynaecology, General Medicine, Orthopedics in each; 24 doctors with distinct rolling
  `avg_consult_minutes`; LAB + PHARMACY counters; 60 days of history; live queues today incl.
  priority, appointment and linked tokens; at least one HIGH/CRITICAL department now. Branch
  admin = Gulberg. Update README / contract / tests that mention old branches, departments or
  `doctor28`.
- Queue order with `from_appointment` everywhere the order is computed (queue reads, feature
  builder, seed simulation — the seed-replay test must still match).
- Prediction: `estimate.explain`; cold-start baseline (`COLD_START_MIN_CONSULTS`, default 30);
  baseline tagging `model_version: "baseline"` in `wait_predictions`.
- Recommendations (FR-08/09, Eq. 6.3–6.4) — already implemented; verify candidate selection
  (active branch, same standardised specialty, doctor scheduled + accepting today), haversine,
  congestion ratio, ascending score, reasons like `"About 34 min shorter wait, 3.2 km away"`.
- New/extended endpoints: `GET /branches` load, departments load fields, `POST /tokens/:id/switch`,
  `GET /display` + socket room `branch:<id>`, admin dashboard `trend` + `departments[].doctors`,
  forecasts `avgConsultMinutes` + `shortfallDoctorHours`, models `featureImportances` +
  `baseline*` metrics (AI service: store them in `model_versions.metrics`, expose in
  `ModelMetrics`), CORS default adds `http://localhost:5175` and `http://127.0.0.1:5175`.
- Tests for every new behaviour; `npm test` 100 % green on MongoDB (`rs0`); AI tests green.

## Phase 2 — interfaces

### Admin Dashboard (branch `upgrade/admin`, FR-14…FR-22, UC-12…UC-19)
- **Live Overview**: congestion alert strip that slides down when any department (live or
  forecast alert) is HIGH (ρ ≥ 0.85, amber) or CRITICAL (ρ ≥ 1.0, crimson, pulsing), dismissible
  per alert, with "Simulate staffing fix →" linking to `/workload?departmentId=…` (the Workload
  page scrolls to and highlights that department's recommendation). KPI tiles (the 7 KPIs) with
  count-up, a pulsing green "● Live" indicator tied to the socket state, and sparklines from
  `trend`. Department load matrix: utilisation bars from `congestionRatio` (emerald < 70 %, amber
  70–85 %, crimson > 85 %), expandable rows listing `departments[].doctors`, live filter by the
  Branch and Department dropdowns.
- **Forecasts**: dual-series chart — forecast arrivals (Âh) vs dashed scheduled capacity (Ch),
  crimson-shaded peak/shortfall hours, tooltip with exact `shortfallDoctorHours`.
- **Workload**: each recommendation card gets a "+1 extra doctor session" toggle that adds
  `60 / avgConsultMinutes` capacity across the recommendation's time range and re-animates the
  chart plus an estimated wait reduction (simple backlog model, labelled estimate).
- **Model Management** under an **INSIGHTS** sidebar group (with Forecasts, Workload, Reports,
  Feedback): benchmark scorecards Random Forest vs Queueing Baseline on MAE, RMSE, R², within
  ±10 min with green improvement badges; horizontal feature-importance chart; "Trigger model
  retraining" with the 4-stage stepper (Reading QUEUE_EVENT logs → Chronological split & CV →
  Comparing MAE vs active model → Activating improved version) and the real outcome. AI down →
  clear unavailable state (no fake numbers).

### Staff Dashboard (branch `upgrade/staff`, FR-04, FR-12, FR-13, UC-11)
- Split-screen, touch-first console. **Left**: live queue in the backend's order with the badge
  mapping above, tabs "Waiting queue" / "Skipped (recallable)", quick priority-escalation selector
  on each waiting token (still asks for the reason the API requires). **Right**: consultation
  stage — oversized token number with priority tag and stage (CALLED / IN_SERVICE), pace gauge
  (elapsed vs the doctor's rolling average from `summary.avgConsultMinutes` / the room's doctor;
  amber past average), action bar: Call next (emerald), Start service, Skip (absent), Recall,
  Transfer (modal), Issue linked token, Complete consultation — instant feedback, ≥ 56 px targets.
- Linked referral **drawer** (slide-over): LAB and PHARMACY toggles for the same visit, creates
  one token per selected type (`POST /visits/:id/linked-tokens`), shows the created token numbers.
- **`/display`** board (see decision 3): full-screen, high-contrast dark cards, oversized NOW
  SERVING per room/counter with a gentle pulse when it changes, NEXT UP strip (next 3), live
  estimated wait per department, clock, auto-refresh ≤ 3 s, branch picker for admins, no names.

### Patient Web Portal (branch `upgrade/patient`, FR-01…FR-11, FR-19, FR-20, UC-01…UC-10)
- Login / register (FR-01). 3-step finder: branch cards (live `load`: "Normal • ~12 min wait" /
  "Congested • ~48 min wait") → specialty pills / departments → doctor cards (avg consult speed,
  queue length, estimated wait) with a mode switch "Join live OPD queue now" / "Book future slot".
- Live boarding pass: perforated ticket, oversized token number, status banner (WAITING /
  "CALLED — PROCEED TO ROOM 4" / IN_SERVICE), queue progress bar from `patientsAhead`, wait range
  pill `low–high min`, "Explain AI estimate" accordion from `estimate.explain`.
- Visit journey tracker over the visit's tokens (OPD → LAB → PHARMACY) from `linkedTokens`.
- Branch comparison drawer: opens automatically when `congestion.suggestAlternatives` is true, or
  via "Compare faster branches"; ranked alternatives from `/recommendations` (time-saved pill,
  distance, score breakdown wait / distance / congestion), "Switch my token here" →
  `POST /tokens/:id/switch` after a confirmation. Location only with the browser's consent.
- Appointments (book / reschedule / cancel / check-in), visit history, one-time 1–5 star
  feedback, notifications.

## Phase 3 — verification
- Build + lint + tests for backend, AI service, all three web apps.
- Automated E2E smoke: patient joins a congested branch → sees wait range + recommendation →
  switches branch → staff sets priority, calls next, issues LAB + PHARMACY, completes → admin
  dashboard KPIs / alerts / forecasts reflect it.
- Commit per milestone; push.
