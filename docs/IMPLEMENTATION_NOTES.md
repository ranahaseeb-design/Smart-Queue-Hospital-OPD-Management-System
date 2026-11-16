# Implementation notes: where the system differs from the FYP document

This page lists every place where the built system deliberately differs from, or adds to, the FYP
documentation ("Smart Digital Queue Management System for Hospital OPD with AI-Based Waiting Time
Prediction and Branch Recommendation"). Use it to update the report and to answer committee
questions. The API details live in [API_CONTRACT.md](API_CONTRACT.md) and the build history in
[UPGRADE_2026.md](UPGRADE_2026.md).

## Architecture

| FYP document | Built system | Why |
|---|---|---|
| MySQL database (Section 3.8) | MongoDB (single-node replica set `rs0`), Mongoose models with the same tables / fields | The MERN stack was required; transactions need a replica set. The report's ER diagram still applies table-for-table. |
| Separate admin and staff web apps | One **Smart OPD Dashboard** (`admin-dashboard/`, port 5174) with one login page and five role cards | Users asked for one dashboard for every login. The doctor / staff screens are shared from `staff-dashboard/src`. |
| Patients use the Flutter mobile app (NFR-09: Android) | Patients use the **Patient Portal** in the dashboard: sign up, profile, get a token, live pass, appointments, visit history with feedback and notifications. The Flutter app is future work. | The project is delivered as a website; the portal works on any phone, laptop or kiosk browser without installing an app. |
| Start each service by hand | `npm run dev` (from the project folder or any sub-folder) starts MongoDB, the AI service, the backend and the dashboard | One command for demos. |

## AI and prediction (Chapter 6)

- **Model:** Random Forest regressor (scikit-learn) on the 14 features of Section 6.3, trained on a
  chronological 80 / 20 split. A new version is activated only if its MAE beats the Eq. 6.2
  baseline and the active model, and it is not worse than the baseline for any major department
  (Section 6.7.3). An exact tie with the active model counts as "not better", so the active model stays.
- **Scorecard (Model Management):** each version stores MAE, RMSE, R² and % within ±10 min for both
  the model and the Eq. 6.2 baseline on the same test rows, plus the feature importances and the
  accept / reject reason.
- **Cold start (Section 6.4.4):** a doctor with fewer than `COLD_START_MIN_CONSULTS` (default 30)
  completed consultations gets the Eq. 6.2 estimate even when a model is active.
- **Explain AI estimate (FR-06):** every token estimate carries its inputs (patients ahead, priority
  ahead, doctor's average consult time, start delay, baseline minutes, model adjustment) and why the
  baseline was used (`AI_UNAVAILABLE` or `COLD_START`). The patient pass shows this as "How was this
  estimate calculated?".
- **Estimates after a restart:** on start-up the backend re-predicts every queue that still has
  WAITING tokens, so stored estimates always come from the running model and rules.
- **Forecasts (FR-17):** the hourly forecast keeps the Random Forest unless the seasonal baseline's
  MAE is more than 2 % better in the back-test; every forecast row says which engine produced it.
- **Data:** the seeded history (about 60 days) is synthetic and flagged `is_synthetic`. Model metrics
  on it show that the pipeline works, not real-world accuracy (Section 6.11).

## Notifications and scheduled jobs

- **In-app notifications (FR-11)** for token issue, turn approaching, called / skipped / recalled,
  big estimate changes, appointment confirmation, cancellation and **reminders** (one reminder
  `APPOINTMENT_REMINDER_MINUTES`, default 60, before a booked slot). Patients see them under
  **Notifications** with an unread badge. E-mail is sent too when an SMTP server is configured.
- **Scheduled retraining (FR-22):** Model Management → "Automatic retraining" (off / every day /
  every week at a chosen hour). A scheduled run uses the same acceptance rules as a manual retrain.

## Queue rules

- **Queue order (FR-13):** priority level (emergency > elderly / differently-abled > normal), then
  issue time. A checked-in appointment joins at its check-in time like a walk-in; it is not placed
  ahead of walk-ins. (An earlier contract draft said appointments go first; that was not built.)
- **Token switch (FR-09, Section 6.5.3):** the system never moves a token on its own. The patient
  presses "Switch my token here" on the pass; the new token is issued first and the old one is then
  cancelled, so a refused switch leaves the original token untouched.
- **Doctor availability:** the doctor list says *why* a doctor cannot take a token now: session
  full (max patients reached), session ended, not scheduled today.
- **Hospital time:** all times are Asia/Karachi wall-clock time; the dashboard uses the hospital clock
  for "today" even when the laptop is set to another time zone.

## Demo-only features (not in the FYP scope)

These exist only for presentations and are off in production (`DEMO_TOOLS=false` or
`NODE_ENV=production`):

- `DEMO_ALWAYS_OPEN=true` treats every doctor's session as open at any hour, so the system can be
  shown in the evening. In this mode the estimate adds no "wait until the session starts" delay,
  and a session that has ended counts 60 minutes of remaining capacity in the congestion ratio.
- Walk-in kiosk check-in without an account (`POST /auth/guest`), the queue load simulator, one-click
  committee demo data, the peak-congestion switch, **Reset demo data**, the doctor / room switcher
  and the admin "Live queue" button.
- **Demo tools switch:** these controls are hidden unless "Demo tools for presentations" is turned
  on, either under the role cards on the login page or in the admin user menu. The setting is saved
  per browser, so a normal user's screens stay clean.

## Not implemented

- Phone push notifications (Firebase) and SMS: the website uses in-app notifications (and e-mail
  when configured) instead.
- The Flutter app (future work; not part of the website delivery).
- Production hardening (HTTPS, secure token storage) is described in each client README but not set up.
