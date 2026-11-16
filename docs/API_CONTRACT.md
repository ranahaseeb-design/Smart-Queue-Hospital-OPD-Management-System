# Smart OPD — Shared API Contract

This is the single source of truth that the backend, the AI service, both dashboards and the
mobile app are built against. Requirement IDs (FR-xx) refer to the FYP documentation.

## Ports and conventions

| Component | Path | Port |
|---|---|---|
| Backend API (Node.js/Express + Socket.IO) | `backend/` | 4000, REST under `/api` |
| AI service (Python/FastAPI, internal only) | `ai-service/` | 8000 |
| **Smart OPD Dashboard** — one web app for all four login types (React + Vite): shared four-card login, admin screens for BRANCH_ADMIN / HOSPITAL_ADMIN, doctor/staff screens for STAFF | `admin-dashboard/` (+ `staff-dashboard/src` as module `@staff`) | 5174 |
| Staff screens standalone (development only), incl. the waiting-room board `/display` | `staff-dashboard/` | 5173 |
| Patient Web Portal (React + Vite; same PATIENT API as the mobile app) | `patient-portal/` | 5175 |
| Patient app (Flutter, Android) | `mobile_app/` | — (emulator reaches backend at `http://10.0.2.2:4000`) |

- JSON bodies, **camelCase** keys in the REST API. DB columns are snake_case.
- Auth: backend-issued JWT, header `Authorization: Bearer <token>`. All endpoints except register/login and `GET /api/health` require auth.
- Errors: HTTP status + `{ "error": { "code": "SOME_CODE", "message": "Human readable" } }`.
  Codes used: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `TOO_MANY_REQUESTS` (429), `AI_UNAVAILABLE` (503).
- Datetimes: hospital local time (server `TZ=Asia/Karachi`), serialized as `"YYYY-MM-DDTHH:mm:ss"` **without** a zone suffix. Dates are `"YYYY-MM-DD"`, times `"HH:mm"`. Clients parse them as local time.
- Roles: `PATIENT`, `STAFF` (doctors, OPD/lab/pharmacy staff), `BRANCH_ADMIN`, `HOSPITAL_ADMIN`.
- Priority levels: `0` normal, `1` elderly / differently-abled, `2` emergency ("0 = normal; higher = earlier", data dictionary). Queue order among `WAITING` tokens (FR-13) = `priorityLevel DESC`, then `issuedAt ASC`, then id, i.e. EMERGENCY > ELDERLY / DIFFERENTLY_ABLED > NORMAL. A checked-in appointment joins the queue at its check-in time like a walk-in; `fromAppointment` (= the token has an `appointment_id`) is informational only.
- Display numbers: `"OPD-007"`, `"LAB-003"`, `"PHARMACY-012"` → `queueType + "-" + zero-padded tokenNumber (3)`.

### Seed / demo accounts (development only; defined in `backend/src/db/seed.js`)

| Role | Login | Password |
|---|---|---|
| Hospital Admin | `admin@opd.test` | `Admin@123` |
| Branch Admin (Model Town) | `branchadmin@opd.test` | `Admin@123` |
| Doctor (staff, OPD room) | `doctor1@opd.test` … `doctorN@opd.test` | `Staff@123` |
| Lab staff (branch 1) | `lab1@opd.test` | `Staff@123` |
| Pharmacy staff (branch 1) | `pharmacy1@opd.test` | `Staff@123` |
| Patient | `patient@opd.test` (phone `03001234567`) | `Patient@123` |

Seed: 3 Lahore branches — **Model Town** (branch 1, 31.4834, 74.3255), **Gulberg** (31.5204, 74.3587) and **Johar Town** (31.4697, 74.2728) — with 4–5 departments each from the standardised specialties (General Medicine, Cardiology, Pediatrics, ENT, Orthopedics, Dermatology), 2 doctors per department (28 doctors, `doctor1@opd.test` … `doctor28@opd.test`; Model Town: 10 doctors and 12 service points, e.g. Room 1 — Dr. Ahmed Raza), one OPD room per doctor, one LAB and one PHARMACY counter per branch (Model Town: Nasir Mehmood `lab1`, Sobia Anjum `pharmacy1`), schedules Mon–Sun, ~60 days of **synthetic** history flagged `is_synthetic`. Branch admin Kamran Butt (Model Town), hospital admin Ayesha Siddiqui. Live demo activity on top of the seed: `POST /demo/seed` (see Demo tools).

---

## Shared object shapes

```jsonc
// User
{ "id": 1, "fullName": "Ali Khan", "email": "a@x.com", "phone": "0300...", "role": "PATIENT",
  "dateOfBirth": "1950-01-01", "priorityCategory": "NONE|ELDERLY|DIFFERENTLY_ABLED",
  "adminBranchId": null, "isActive": true,
  "doctorId": null,                       // set when the user is a doctor
  "assignments": [ { "servicePointId": 3, "servicePointName": "Room 1", "type": "OPD", "branchId": 1, "branchName": "Model Town" } ] }

// TokenDetail (patient-facing)
{ "id": 42, "visitId": 17, "tokenNumber": 7, "displayNumber": "OPD-007", "queueType": "OPD",
  "status": "WAITING|CALLED|IN_SERVICE|SKIPPED|TRANSFERRED|COMPLETED|CANCELLED|NO_SHOW",
  "priorityLevel": 0, "issuedAt": "2026-10-29T09:12:00", "calledAt": null, "completedAt": null,
  "branch": { "id": 1, "name": "Model Town" },
  "servicePoint": { "id": 3, "name": "Room 1", "type": "OPD" },
  "doctor": { "id": 2, "fullName": "Dr. Sara Ahmed", "specialty": "Cardiology" },   // null for LAB/PHARMACY
  "position": 4,                 // 1-based position among WAITING tokens; null if not WAITING
  "patientsAhead": 3,
  "nowServing": { "tokenId": 39, "displayNumber": "OPD-004" },                      // null if none
  "estimate": { "minutes": 30, "low": 24, "high": 36, "modelVersion": "baseline",   // null if not WAITING
    "explain": {                       // FR-06 transparency ("Explain AI estimate"); aggregate counts only
      "method": "MODEL|BASELINE",
      "reason": null,                  // BASELINE only: "AI_UNAVAILABLE" (no model answer: service down or no active model) | "COLD_START" (doctor has fewer than COLD_START_MIN_CONSULTS = 30 completed consultations)
      "patientsAhead": 3, "priorityAhead": 1, "normalAhead": 2,   // normalAhead = patientsAhead - priorityAhead
      "doctorAvgConsultMinutes": 6.8, "minutesToStart": 0,
      "baselineMinutes": 20,           // Eq. 6.2 (n_ahead + n_priority) * c_doctor + d_start, n_ahead = normalAhead
      "modelAdjustmentMinutes": 6,     // minutes - baselineMinutes when method = MODEL, else null
      "hourOfDay": 10,
      "departmentLoad": 4.5, "interruptionsLastHour": 1, "appointmentsAhead": 0 } },
  "congestion": { "level": "NORMAL|HIGH|CRITICAL", "suggestAlternatives": false },
  "linkedTokens": [ /* TokenDetail without linkedTokens, same visit, other queues */ ] }

// QueueToken (staff-facing)
{ "id": 42, "tokenNumber": 7, "displayNumber": "OPD-007", "status": "WAITING", "priorityLevel": 1,
  "priorityCategory": "ELDERLY", "patientName": "Ali Khan", "issuedAt": "...", "calledAt": null,
  "visitId": 17, "doctorId": 2, "estimateMinutes": 30, "fromAppointment": false,
  "priorityDeclared": false }  // true while priority 1 rests only on a self-declared DIFFERENTLY_ABLED category (no PRIORITY_SET in the visit yet)

// Appointment
{ "id": 5, "doctor": { "id": 2, "fullName": "Dr. Sara Ahmed", "specialty": "Cardiology" },
  "branch": { "id": 1, "name": "Model Town" }, "slotStart": "2026-10-30T10:15:00",
  "status": "BOOKED|CHECKED_IN|CANCELLED|COMPLETED|NO_SHOW", "updatedAt": "...", "tokenId": null }
```

Estimate range: `low = max(0, round(minutes*0.8))`, `high = round(minutes*1.2)`, at least ±5 min.

---

## REST endpoints (all under `/api`)

### Health / auth (FR-01)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/health` | – | `{ status: "ok", db: "mongodb", ai: true|false }` |
| POST | `/auth/register` | `{ fullName, email?, phone?, password, dateOfBirth?, priorityCategory? }` (≥1 of email/phone, password ≥ 6) | 201 `{ token, user }` — role is always PATIENT. `ELDERLY` is derived from `dateOfBirth` (age ≥ 60, set automatically); declaring it without a qualifying `dateOfBirth` → 400. `DIFFERENTLY_ABLED` may be declared (staff confirm per token) |
| POST | `/auth/login` | `{ identifier, password, portal? }` (identifier = email or phone; `portal` = `DOCTOR` \| `STAFF` \| `BRANCH_ADMIN` \| `HOSPITAL_ADMIN` \| `PATIENT`, case-insensitive) | `{ token, user }`. With `portal` (the dashboards' four-card sign-in), the account must match **after** the password check, else 403 `FORBIDDEN` naming the right card and no token: `DOCTOR` = STAFF with a doctor profile, `STAFF` = STAFF without one, admins and patients by role. Wrong password stays 401 without revealing the account type; unknown `portal` 400. Without `portal` (mobile app) any active account signs in |
| POST | `/auth/guest` | `{ fullName?, phone?, priority?: "NORMAL" \| "URGENT_SENIOR", birthYear? }` (URGENT_SENIOR needs a birth year giving age ≥ 60 → ELDERLY, DOB stored as 1 January of that year; otherwise 400 pointing urgent cases to the reception desk — emergency priority is set by staff; a phone that already has an account → 409) | 201 `{ token, user }` — kiosk **walk-in check-in** without credentials: a PATIENT account with a generated identity (`Walk-in Guest 1234` when no name, priority NONE, random password never returned). Only with `DEMO_TOOLS` (default on outside production; 404 when off); 30 per client address per hour (429 `TOO_MANY_REQUESTS`) |
| GET | `/auth/me` | – | `{ user }` |
| PUT | `/auth/me` | `{ fullName?, email?, phone?, dateOfBirth?, priorityCategory?, password? }` | `{ user }` (same `priorityCategory` rules as register) |

### Browse (FR-02) — any authenticated role
| GET | `/branches` | – | `[ { id, name, address, latitude, longitude, status, load: { waiting, congestionLevel, estimatedWaitMinutes } } ]` (ACTIVE only for patients). `load` is live: `waiting` = WAITING OPD tokens today, `congestionLevel` = worst department level, `estimatedWaitMinutes` = median over that branch's doctors accepting now of their `estimatedWaitMinutes` (null if none accepting) |
| GET | `/specialties` | – | `[ "Cardiology", ... ]` |
| GET | `/branches/:id/departments` | – | `[ { id, branchId, specialty, name, doctorCount, waiting, congestionLevel, congestionRatio, loadPercent } ]` (`loadPercent` = round(congestionRatio × 100)) |
| GET | `/departments/:id/doctors` | `?date=YYYY-MM-DD` (default today) | `[ { id, fullName, departmentId, specialty, branchId, avgConsultMinutes, servicePointId, servicePointName, session: { startTime, endTime } | null, availableToday, acceptingNow, unavailableReason, queueLength, estimatedWaitMinutes, estimateModelVersion } ]` (`unavailableReason` = null when accepting, else `NOT_SCHEDULED` | `SESSION_ENDED` | `SESSION_FULL` (max_patients reached) | `INACTIVE`) (`estimateModelVersion` = model version that produced the estimate, `"baseline"` for the Eq. 6.2 fallback) |

`acceptingNow` = scheduled today, session not ended (unless `DEMO_ALWAYS_OPEN=true`, which ignores clock time but still needs a schedule that weekday), and below `max_patients` of the current session (counting only the doctor's OPD tokens issued in that session's window: from the previous session's end, or 00:00, to this session's end; the last session runs to midnight).

### Tokens — patient (FR-03, FR-05, FR-06, FR-07, FR-09)
| POST | `/tokens` | `{ doctorId }` | 201 `TokenDetail`. 409 `CONFLICT` if patient already has an active (WAITING/CALLED/IN_SERVICE) token for that doctor today; 409 if doctor not accepting. Priority level pre-set from the patient's `priorityCategory` (ELDERLY/DIFFERENTLY_ABLED → 1). Creates/reuses today's OPEN visit at that branch, writes ISSUED event + prediction. |
| GET | `/tokens/active` | – | `[ TokenDetail ]` patient's WAITING/CALLED/IN_SERVICE tokens (all queues) |
| GET | `/tokens/:id` | – | `TokenDetail` (owner, staff, admins) |
| DELETE | `/tokens/:id` | – | `TokenDetail` with status CANCELLED (owner only, only from WAITING) |
| POST | `/tokens/:id/switch` | `{ doctorId }` | 201 `{ cancelled: TokenDetail, token: TokenDetail }` — FR-09 "Switch my token here", only with the patient's own action (owner only, OPD token in WAITING). The new token is issued first, then the old token → CANCELLED (if that cancel fails, the new token is cancelled again) (event CANCELLED, note `"Switched to <branch> · <doctor>"`) and a new OPD token is issued for `doctorId` exactly as `POST /tokens` (same 409 rules, priority from the patient's `priorityCategory`; staff-set priority does not carry over). If the issue fails nothing changes (old token stays WAITING). 400 if `doctorId` is the token's own doctor |

Prediction fallback (FR-06, Section 6.4.4): the backend uses the Eq. 6.2 baseline (`modelVersion: "baseline"`) when the AI service is unreachable or has no active model, and also for a **cold-start doctor** with fewer than `COLD_START_MIN_CONSULTS` (default 30) COMPLETED OPD consultations — even when a model is active. `estimate.explain.reason` says which.

### Recommendations (FR-08, FR-09)
| GET | `/recommendations` | `?specialty=Cardiology&lat=31.48&lng=74.32&excludeDoctorId=2` (lat/lng optional; location never stored) | `{ specialty, weights: { wait, distance, congestion }, items: [ { branchId, branchName, address, doctorId, doctorName, predictedWaitMinutes, distanceKm, congestionRatio, congestionLevel, score, reason } ] }` sorted by `score` ascending (lower = better). `distanceKm` null when no location. `reason` e.g. `"About 40 min shorter wait, 3.2 km away"`. |

Scoring (Eq. 6.3): min-max normalise wait, distance, congestion across candidates (all equal → 0), `score = w1*W + w2*D + w3*ρ`. Distance by haversine (R = 6371 km). Without location, the distance weight is redistributed proportionally to the other two.

### Appointments (FR-10)
| GET | `/doctors/:id/slots` | `?date=YYYY-MM-DD` | `{ doctorId, date, slotMinutes, slots: [ { start: "2026-10-30T09:00:00", available: true } ] }` (slots from that weekday's schedule; past slots excluded) |
| GET | `/appointments` | – | `[ Appointment ]` own, newest first |
| POST | `/appointments` | `{ doctorId, slotStart }` | 201 `Appointment`; 409 if slot taken |
| PUT | `/appointments/:id` | `{ slotStart }` | `Appointment` (reschedule, only BOOKED) |
| DELETE | `/appointments/:id` | – | `Appointment` status CANCELLED (slot released) |
| POST | `/appointments/:id/check-in` | – | 201 `TokenDetail` (only `BOOKED` appointments, from 60 min before `slot_start` until the end of the doctor's session containing the slot, else 409; the token is issued to that session's service point and gets `appointment_id`) |

### Visits, feedback, notifications (FR-19, FR-20, FR-11)
| GET | `/visits` | – | `[ { id, visitDate, status, branch: {id,name}, tokens: [ { id, displayNumber, queueType, status, issuedAt, calledAt, completedAt, doctorName, servicePointName } ], feedback: { rating, comment } | null, canGiveFeedback } ]` newest first |
| POST | `/visits/:id/feedback` | `{ rating: 1-5, comment? }` | 201 `{ id, rating, comment }`; 409 if already given; 400 unless the visit has a COMPLETED token |
| GET | `/notifications` | – | `[ { id, tokenId, channel, message, sentAt, isRead } ]` newest first (IN_APP rows) |
| POST | `/notifications/read-all` | – | `{ ok: true }` |
| POST | `/notifications/device-token` | `{ fcmToken }` | `{ ok: true }` |

### Demo tools (live presentations) — any authenticated role, only with `DEMO_TOOLS` (404 when off)
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/demo/load-queue` | `{ doctorId, count? }` (count 1–10, default 5) | 201 `{ doctorId, servicePoint: {id,name,type}, branch: {id,name}, issued: [ { id, displayNumber, patientsAhead } ], waitingNow }` — creates `count` "Demo Patient" accounts and issues their OPD tokens for that doctor through the normal issue path (events, predictions, notifications, sockets), flagged `is_synthetic`. A refusal (doctor not accepting) stops the batch with that error |
| POST | `/demo/seed` | – | 201 `{ date, completedVisits, linkedCompleted: { pharmacy, lab }, waiting: { doctor: { doctorName, servicePointName, branchName, tokens }, pharmacy: { servicePointName, branchName, tokens } }, forecast }` — committee demo data for today: ~48 completed visits (3 per Model Town doctor, 1 per peer doctor; ~40 % with a ~3 min pharmacy service, ~15 % with lab), 5 WAITING for the Model Town Room 1 doctor and 2 WAITING at the Model Town pharmacy (normal issue path), then a forecast run. Past visits are full records (visit, token, ISSUED/CALLED/STARTED/COMPLETED events), `is_synthetic` |
| POST | `/demo/reset` | – | STAFF and admins (patients 403): `{ removed: { patients, visits, tokens, events, predictions, notifications, feedback, appointments }, peakActive: false }` — deletes every demo, peak and walk-in kiosk patient (generated e-mail domains `demo.opd.local` / `walkin.opd.local`) with all their records; seeded accounts and history stay |
| GET | `/demo/peak` | – | `{ peakActive, branches: [ { branchId, name, loadPercent, waiting } ] }` |
| POST | `/demo/peak` | `{ enabled: true|false }` | `{ enabled, branch, added, cancelled, load: { waiting, capacity, ratio, percent }, peakActive }` — on: WAITING tokens for Model Town doctors until the branch load ≥ 85 % (max 300, each queue re-predicted once); off: cancels them |
| GET | `/demo/doctors` | – | STAFF and admins (patients 403; branch admins see their branch only): `[ { doctorId, fullName, specialty, branchId, branchName, servicePointName, acceptingNow, queueLength } ]` — active doctors with today's room, for the doctor / room switcher |
| POST | `/demo/switch-doctor` | `{ doctorId }` | STAFF and admins: `{ token, user }` — a session for that doctor's account, so committee demos can show several doctors' live queues without signing out (Doctor Portal header "Switch doctor / room (demo)", Admin > Doctors "Live queue"). Branch admins only for doctors of their branch (403); unknown/inactive doctor 404 |

### Staff (FR-04, FR-12, FR-13) — role STAFF, limited to assigned service points
| GET | `/staff/service-points` | – | `[ { id, name, type, branchId, branchName, doctorId, doctorName } ]` (doctorId = doctor scheduled in that room today, or the logged-in doctor) |
| GET | `/service-points/:id/queue` | – | `{ servicePoint: { id, name, type, branchId, branchName }, nowServing: QueueToken|null, waiting: [QueueToken] (ordered), skipped: [QueueToken], recentlyCompleted: [QueueToken] (last 5 COMPLETED today, newest first — lets staff issue linked tokens after consultation, FR-04), summary: { completedToday, skippedToday, waiting, avgWaitMinutes, avgConsultMinutes } }` (today only) |
| POST | `/service-points/:id/call-next` | – | `{ token: QueueToken|null }`; 409 if a CALLED/IN_SERVICE token is still open there |
| POST | `/tokens/:id/start` | – | `QueueToken` CALLED → IN_SERVICE |
| POST | `/tokens/:id/skip` | – | CALLED → SKIPPED |
| POST | `/tokens/:id/recall` | – | SKIPPED → CALLED (409 if another token is open) |
| POST | `/tokens/:id/complete` | – | CALLED/IN_SERVICE → COMPLETED |
| POST | `/tokens/:id/transfer` | `{ toServicePointId, toDoctorId? }` | `{ from: QueueToken, to: QueueToken }`; WAITING/CALLED → TRANSFERRED, new WAITING token in the target queue, same visit, priority kept; an appointment link (`appointment_id`) moves to the new token. A `toDoctorId` must be scheduled in the target room today (400 otherwise) |
| POST | `/tokens/:id/priority` | `{ level: 0-2, reason }` | `QueueToken`; logs PRIORITY_SET with note = `"Level <n>: <reason>"` (reason ≤ 200 chars) |
| GET | `/staff/transfer-targets` | `?servicePointId=` | `[ { servicePointId, name, type, doctorId, doctorName, specialty, waiting } ]` active points in the same branch except this one |
| POST | `/visits/:id/linked-tokens` | `{ type: "LAB"|"PHARMACY", servicePointId? }` | 201 `TokenDetail`; default target = the branch's active point of that type with the shortest queue. Doctors only (roles matrix): 403 `FORBIDDEN` for staff without a doctor profile, and for a doctor whose own OPD token is not part of that visit |

| GET | `/display` | `?branchId=` (default: first active branch) | **Public** waiting-room board data for the `/display` page (a TV opens it without signing in). `{ branch: { id, name }, branches: [ { id, name } ], generatedAt, servicePoints: [ { id, name, type, departmentName, doctorName, nowServing: { displayNumber, status: "CALLED"|"IN_SERVICE", calledAt } | null, next: [ { displayNumber, priorityLevel, fromAppointment } ] (first 3 WAITING in queue order), waiting } ], departments: [ { departmentId, name, waiting, estimatedWaitMinutes, congestionLevel } ] }` — **token numbers only, never patient names**; active service points only, OPD rooms first, then LAB, then PHARMACY |

Every status change writes a `queue_events` row in the same DB transaction (FR-21), then re-predicts the affected queue (FR-07), sends notifications (called patient + those within `notifyPositionsAhead` positions, FR-11) and emits socket events.

### Admin (FR-14 … FR-18, FR-20, FR-22) — BRANCH_ADMIN (own branch only) and HOSPITAL_ADMIN (all; optional `?branchId=` filter)
| CRUD | `/admin/branches` | `{ name, address, latitude, longitude, status }` | GET for both; POST/PUT/DELETE hospital admin only |
| CRUD | `/admin/departments` | `{ branchId, specialty, name, isActive }` | `?branchId=` |
| CRUD | `/admin/doctors` | create: `{ fullName, email, phone?, password, departmentId, avgConsultMinutes? }` (creates STAFF user + doctor) | row: `{ id, userId, fullName, email, phone, departmentId, departmentName, specialty, branchId, branchName, avgConsultMinutes, isActive }` |
| CRUD | `/admin/schedules` | `{ doctorId, servicePointId, dayOfWeek (1=Mon..7=Sun), startTime "HH:mm", endTime, maxPatients? }` | `?doctorId=&branchId=`; row adds `doctorName`, `servicePointName` |
| CRUD | `/admin/service-points` | `{ branchId, type, name, isActive }` | |
| CRUD | `/admin/users` | `{ fullName, email, phone?, password?, role (STAFF|BRANCH_ADMIN|HOSPITAL_ADMIN), adminBranchId?, isActive }` | `?role=` (one role or a comma-separated list, e.g. `?role=STAFF,BRANCH_ADMIN,HOSPITAL_ADMIN`); branch admin may only manage STAFF of own branch (home branch, assignment or doctor department there); staff with no branch at all are managed by the hospital admin only (403 for branch admins, also for `POST /admin/assignments`) |
| GET/POST/DELETE | `/admin/assignments` | `{ userId, servicePointId }` | row: `{ id, userId, userName, servicePointId, servicePointName, type, branchName }` |

`DELETE` on master data = soft deactivate (`is_active=false` / `status=INACTIVE`), except schedules and assignments which are hard-deleted. Each CRUD resource: `GET /x` list, `GET /x/:id`, `POST /x` → 201, `PUT /x/:id`, `DELETE /x/:id`.

| GET | `/admin/dashboard` | `?branchId=` | `{ kpis: { waiting, inService, completedToday, avgWaitMinutes, maxWaitMinutes, activeDoctors, activeServicePoints }, trend: [ { hour: "09:00", waiting, inService, completed, avgWaitMinutes, maxWaitMinutes } ], branches: [ { branchId, name, waiting, avgWaitMinutes, congestionLevel } ], departments: [ { departmentId, branchId, branchName, name, specialty, waiting, activeDoctors, avgWaitMinutes, maxWaitMinutes, congestionRatio, congestionLevel, doctors: [ { doctorId, fullName, servicePointId, servicePointName, waiting, nowServing: displayNumber|null, avgConsultMinutes, estimatedWaitMinutes, acceptingNow } ] } ], servicePoints: [ { id, name, type, branchName, waiting, nowServing } ] }`. `trend` = today's hours from the first token issued until the current hour (hospital time): `waiting` / `inService` = snapshot at the end of the hour (the current hour = now), `completed` = cumulative COMPLETED OPD tokens, `avgWaitMinutes` / `maxWaitMinutes` = waits (called − issued) of OPD tokens called in that hour (null when none) |
| GET | `/admin/alerts` | `?branchId=` | `[ { id, level: "HIGH"|"CRITICAL", source: "LIVE"|"FORECAST", branchId, branchName, departmentId, departmentName, message, at } ]` |
| GET | `/admin/reports` | `?type=doctor-consult|department-traffic|branch-utilization|waiting-times|feedback&from=&to=&branchId=&format=json|csv` | json: `{ type, title, columns: [ { key, label } ], rows: [ {...} ] }`; csv: `text/csv` attachment |
| GET | `/admin/load-balancer` | – | Haversine cross-branch load balancer: `{ generatedAt, redirectThresholdPercent: 75, scopeBranchId, branches: [ { branchId, name, latitude, longitude, waiting, capacity, loadPercent, level, activeDoctors, avgWaitMinutes, bestWaitMinutes, modelVersion } ], distances: [ { fromBranchId, toBranchId, km } ], recommendations: [ { fromBranchId, fromBranchName, toBranchId, toBranchName, distanceKm, waitSavedMinutes, fromLoadPercent, toLoadPercent, message, direction? } ] }`. Load = Eq. 6.5 summed over the branch's departments; waits from the Random Forest (Eq. 6.2 fallback). Branch admins see every branch's aggregates but only redirects involving their branch, with `direction` OUTGOING / INCOMING |
| GET | `/admin/forecast-status` | – | `{ aiAvailable, forecast: { source, engine, isRandomForest, rows, generatedAt, evaluation } | null, waitModel: { version, trainedAt, trainingRows, testRows, maeMinutes, baselineMaeMinutes, r2 } | null }` (Forecasts status banner) |
| GET | `/admin/forecasts` | `?branchId=&departmentId=&date=` | `[ { branchId, departmentId, departmentName, forecastHour, expectedArrivals, capacity, congestionRatio, congestionLevel, isPeak, source, avgConsultMinutes, shortfallDoctorHours } ]` — `avgConsultMinutes` = mean `avg_consult_minutes` of the department's active doctors (lets clients simulate one extra doctor session: +60 / avgConsultMinutes capacity per hour); `shortfallDoctorHours` = `max(0, expectedArrivals − capacity) × avgConsultMinutes / 60`, 1 decimal |
| POST | `/admin/forecasts/run` | `{ engine?: "AUTO" | "RF" | "BASELINE" }` | `{ generated, source: "ai"|"baseline", engine: "rf-forecast"|"seasonal-baseline"|"baseline", engineLabel, evaluation: { rfMae, baselineMae, trainRows, testRows } | null, generatedAt }` — AUTO (default): the AI service keeps the Random Forest unless the seasonal baseline's backtest MAE is more than 2 % lower; forecast rows store `source` = the engine — calls AI `/ai/jobs/forecast`; falls back to the JS seasonal baseline (avg of same weekday+hour over last 4 weeks) when the AI service is unavailable. Both replace forecasts from today 00:00. 409 `CONFLICT` while an AI forecast job is still running (busy, or longer than `AI_JOB_TIMEOUT_MS`), so the baseline never races it. HOSPITAL_ADMIN only (403 `FORBIDDEN` for branch admins) |
| GET | `/admin/recommendations` | `?branchId=` | `{ workload: [ { branchId, branchName, patientsPerDoctorHour, utilization, avgWaitMinutes } ], recommendations: [ { branchId, branchName, departmentId, departmentName, date, timeRange, shortfallSessions, message } ] }` (FR-18) |
| GET | `/admin/feedback` | `?branchId=` | `{ summary: { count, average, distribution: { "1": n, ..., "5": n } }, items: [ { id, rating, comment, createdAt, patientName, branchName, visitDate } ] }` |
| GET/PUT | `/admin/settings` | PUT hospital admin only | `{ recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 }, congestionThresholds: { high: 0.85, critical: 1.0 }, alternativeSuggestionWaitMinutes: 45, notifyPositionsAhead: 3, slotMinutes: 15, retrainSchedule: { frequency: "OFF", hour: 2, dayOfWeek: 7 } }` (`retrainSchedule`: FR-22 scheduled retraining, `frequency` OFF \| DAILY \| WEEKLY, `hour` 0–23 hospital time, `dayOfWeek` ISO 1 = Monday … 7 = Sunday, used for WEEKLY) |
| GET | `/admin/models` | – | `[ { version, trainedAt, trainingRows, dataSource, status, isActive, metrics: { mae, rmse, r2, within10, baselineMae, baselineRmse, baselineR2, baselineWithin10, testRows, featureImportances: { patients_ahead: 0.54, department_load: 0.26, … } }, reason } ]` — `featureImportances`: the forest's importances summed onto the 14 contract feature keys (one-hot id columns folded back), sum ≈ 1, keys in descending order (Section 6.4.1: "shown to administrators"). The three extra `baseline*` metrics score the Eq. 6.2 baseline on the same test rows (Table 7.3). `reason` = why the version was accepted or rejected. Versions trained before these fields existed return them as `null` |
| GET | `/admin/models/schedule` | – | hospital admin: `{ schedule: { frequency, hour, dayOfWeek }, nextRunAt: "…" \| null, lastRun: { slot, startedAt, status: "RUNNING"\|"ACCEPTED"\|"REJECTED"\|"FAILED", version?, activated?, reason?, mae?, error? } \| null }` — the backend runs the normal retrain job once in the scheduled hour; the acceptance rules decide activation |
| PUT | `/admin/models/schedule` | `{ frequency?, hour?, dayOfWeek? }` | hospital admin: same response; 400 on invalid values (same rules as `retrainSchedule` in settings) |
| POST | `/admin/models/retrain` | – | hospital admin; proxies AI `/ai/models/retrain` → `{ version, metrics, accepted, activated }`; 409 `CONFLICT` with the AI's message while a retraining job is already running; 503 `AI_UNAVAILABLE` when the AI is unreachable, times out (`AI_JOB_TIMEOUT_MS`, default 10 min) or rejects the backend's `AI_SERVICE_TOKEN` |
| POST | `/admin/models/:version/activate` | – | hospital admin; proxies AI |

Congestion (Eq. 6.5): live ratio for a department = waiting tokens ÷ remaining capacity this session (Σ over active doctors of remaining session minutes ÷ avg consult minutes); `NORMAL` < high ≤ `HIGH` < critical ≤ `CRITICAL`. `suggestAlternatives` (FR-09) = estimate ≥ `alternativeSuggestionWaitMinutes` or level HIGH/CRITICAL.

---

## Real-time channel (Socket.IO on port 4000) — FR-05, NFR-01

Connect: `io("http://localhost:4000", { auth: { token: "<jwt>" } })`. The server auto-joins each socket to `user:<userId>`.
Client → server: `subscribe` with `{ room }` and `unsubscribe` with `{ room }`. Allowed rooms:
`token:<id>` (token owner, staff, admins), `sp:<servicePointId>` (assigned staff, admins), `admin` (admins), `branch:<branchId>` (staff with an assignment in that branch, that branch's admin, hospital admins — used by `/display`).

Server → client events (clients just re-fetch the relevant REST resource):
| Event | Payload | Rooms |
|---|---|---|
| `queue:updated` | `{ servicePointId, branchId }` | `sp:<id>`, `admin`, `branch:<branchId>` |
| `token:updated` | `{ tokenId, status }` | `token:<id>`, `user:<ownerId>` (sent for every token in an affected queue whose position/estimate changed) |
| `notification` | `{ id, message, tokenId }` | `user:<id>` |
| `alert` | alert object (as in `/admin/alerts`) | `admin` |

---

## Internal AI service (FastAPI, port 8000) — backend only (`AI_SERVICE_URL`)

Authentication: every `/ai/*` request carries the header `X-AI-Service-Token: <AI_SERVICE_TOKEN>` (the same shared secret is configured on the backend and the AI service). Missing/wrong token → 401; if the AI service has no `AI_SERVICE_TOKEN` configured it answers 503 (unless `AI_ALLOW_UNAUTHENTICATED=true`, local development only). `GET /health` needs no token.

Feature vector (Section 6.3), keys exactly:
`patients_ahead, priority_ahead, doctor_avg_consult, doctor_recent_consult, interruptions_last_hour, session_started (0/1), minutes_to_start, hour_of_day, day_of_week (1-7), appointments_ahead, department_load, doctor_id, department_id, branch_id`.
The backend stores this object as `wait_predictions.features_json` for every prediction; the first prediction of each token joined with its actual wait (`called_at − issued_at`) is the training set.

Baseline (Eq. 6.2): `W = patients_ahead * doctor_avg_consult + minutes_to_start` (minutes_to_start = 0 once started). `patients_ahead` already counts the priority tokens ahead, so `priority_ahead` is not added again (it is a model feature only). Used when the AI service is down/has no active model, and as the benchmark.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | – | `{ status: "ok", activeModel: "rf-20261029-1" | null }` |
| POST | `/ai/predict-wait` | `{ items: [ { tokenId, features: {...} } ] }` | `{ modelVersion, predictions: [ { tokenId, predictedMinutes } ] }`; 503 if no active model |
| POST | `/ai/rank-branches` | `{ weights: { wait, distance, congestion }, candidates: [ { branchId, doctorId, predictedWaitMinutes, distanceKm|null, congestionRatio } ] }` | `{ ranked: [ { branchId, doctorId, score } ] }` ascending |
| POST | `/ai/jobs/forecast` | `{ days: 7 }` | reads history from DB, writes `forecasts` rows (`source` = model version) → `{ generated, modelVersion }` |
| POST | `/ai/models/retrain` | – | trains RF on chronological 80/20 split, compares with baseline MAE and the active model and rejects a model whose MAE exceeds 1.2 × baseline for any major department (≥ 30 test rows; Section 6.7.3); writes `model_versions` → `{ version, metrics, accepted, activated }` |
| GET | `/ai/models` | – | same shape as `/admin/models` |
| POST | `/ai/models/{version}/activate` | – | `{ version, activated: true }`; 404 unknown version; 409 when the version is `REJECTED` (only accepted versions — `ACTIVE`/`RETIRED` — can be activated) |

Backend → AI calls use a 1.5 s timeout; on failure the backend falls back silently (baseline prediction / JS scoring / baseline forecast).
