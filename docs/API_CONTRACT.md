# Smart OPD — Shared API Contract

This is the single source of truth that the backend, the AI service, both dashboards and the
mobile app are built against. Requirement IDs (FR-xx) refer to the FYP documentation.

## Ports and conventions

| Component | Path | Port |
|---|---|---|
| Backend API (Node.js/Express + Socket.IO) | `backend/` | 4000, REST under `/api` |
| AI service (Python/FastAPI, internal only) | `ai-service/` | 8000 |
| Staff Dashboard (React + Vite) | `staff-dashboard/` | 5173 |
| Admin Dashboard (React + Vite) | `admin-dashboard/` | 5174 |
| Patient app (Flutter, Android) | `mobile_app/` | — (emulator reaches backend at `http://10.0.2.2:4000`) |

- JSON bodies, **camelCase** keys in the REST API. DB columns are snake_case.
- Auth: backend-issued JWT, header `Authorization: Bearer <token>`. All endpoints except register/login and `GET /api/health` require auth.
- Errors: HTTP status + `{ "error": { "code": "SOME_CODE", "message": "Human readable" } }`.
  Codes used: `VALIDATION_ERROR` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `AI_UNAVAILABLE` (503).
- Datetimes: hospital local time (server `TZ=Asia/Karachi`), serialized as `"YYYY-MM-DDTHH:mm:ss"` **without** a zone suffix. Dates are `"YYYY-MM-DD"`, times `"HH:mm"`. Clients parse them as local time.
- Roles: `PATIENT`, `STAFF` (doctors, OPD/lab/pharmacy staff), `BRANCH_ADMIN`, `HOSPITAL_ADMIN`.
- Priority levels: `0` normal, `1` elderly / differently-abled, `2` emergency. Queue order = `priorityLevel DESC, issuedAt ASC` among `WAITING` tokens (FR-13).
- Display numbers: `"OPD-007"`, `"LAB-003"`, `"PHARMACY-012"` → `queueType + "-" + zero-padded tokenNumber (3)`.

### Seed / demo accounts (development only; defined in `backend/src/db/seed.js`)

| Role | Login | Password |
|---|---|---|
| Hospital Admin | `admin@opd.test` | `Admin@123` |
| Branch Admin (branch 1) | `branchadmin@opd.test` | `Admin@123` |
| Doctor (staff, OPD room) | `doctor1@opd.test` … `doctorN@opd.test` | `Staff@123` |
| Lab staff (branch 1) | `lab1@opd.test` | `Staff@123` |
| Pharmacy staff (branch 1) | `pharmacy1@opd.test` | `Staff@123` |
| Patient | `patient@opd.test` (phone `03001234567`) | `Patient@123` |

Seed: 3 branches in Lahore, 4–5 departments each (standardised specialties: General Medicine, Cardiology, Pediatrics, ENT, Orthopedics, Dermatology), 2 doctors per department, one OPD room per doctor, one LAB and one PHARMACY counter per branch, schedules Mon–Sun, ~60 days of **synthetic** history (tokens, queue events, wait predictions with `features_json`, feedback) flagged `is_synthetic = 1`.

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
  "estimate": { "minutes": 30, "low": 24, "high": 36, "modelVersion": "baseline" }, // null if not WAITING
  "congestion": { "level": "NORMAL|HIGH|CRITICAL", "suggestAlternatives": false },
  "linkedTokens": [ /* TokenDetail without linkedTokens, same visit, other queues */ ] }

// QueueToken (staff-facing)
{ "id": 42, "tokenNumber": 7, "displayNumber": "OPD-007", "status": "WAITING", "priorityLevel": 1,
  "priorityCategory": "ELDERLY", "patientName": "Ali Khan", "issuedAt": "...", "calledAt": null,
  "visitId": 17, "doctorId": 2, "estimateMinutes": 30, "fromAppointment": false }

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
| GET | `/health` | – | `{ status: "ok", db: "mysql|sqlite", ai: true|false }` |
| POST | `/auth/register` | `{ fullName, email?, phone?, password, dateOfBirth?, priorityCategory? }` (≥1 of email/phone, password ≥ 6) | 201 `{ token, user }` — role is always PATIENT |
| POST | `/auth/login` | `{ identifier, password }` (identifier = email or phone) | `{ token, user }` |
| GET | `/auth/me` | – | `{ user }` |
| PUT | `/auth/me` | `{ fullName?, email?, phone?, dateOfBirth?, priorityCategory?, password? }` | `{ user }` |

### Browse (FR-02) — any authenticated role
| GET | `/branches` | – | `[ { id, name, address, latitude, longitude, status } ]` (ACTIVE only for patients) |
| GET | `/specialties` | – | `[ "Cardiology", ... ]` |
| GET | `/branches/:id/departments` | – | `[ { id, branchId, specialty, name, doctorCount } ]` |
| GET | `/departments/:id/doctors` | `?date=YYYY-MM-DD` (default today) | `[ { id, fullName, departmentId, specialty, branchId, avgConsultMinutes, servicePointId, servicePointName, session: { startTime, endTime } | null, availableToday, acceptingNow, queueLength, estimatedWaitMinutes } ]` |

`acceptingNow` = scheduled today, session not ended (unless `DEMO_ALWAYS_OPEN=true`, which ignores clock time but still needs a schedule that weekday), and below `max_patients`.

### Tokens — patient (FR-03, FR-05, FR-06, FR-07, FR-09)
| POST | `/tokens` | `{ doctorId }` | 201 `TokenDetail`. 409 `CONFLICT` if patient already has an active (WAITING/CALLED/IN_SERVICE) token for that doctor today; 409 if doctor not accepting. Priority level pre-set from the patient's `priorityCategory` (ELDERLY/DIFFERENTLY_ABLED → 1). Creates/reuses today's OPEN visit at that branch, writes ISSUED event + prediction. |
| GET | `/tokens/active` | – | `[ TokenDetail ]` patient's WAITING/CALLED/IN_SERVICE tokens (all queues) |
| GET | `/tokens/:id` | – | `TokenDetail` (owner, staff, admins) |
| DELETE | `/tokens/:id` | – | `TokenDetail` with status CANCELLED (owner only, only from WAITING) |

### Recommendations (FR-08, FR-09)
| GET | `/recommendations` | `?specialty=Cardiology&lat=31.48&lng=74.32&excludeDoctorId=2` (lat/lng optional; location never stored) | `{ specialty, weights: { wait, distance, congestion }, items: [ { branchId, branchName, address, doctorId, doctorName, predictedWaitMinutes, distanceKm, congestionRatio, congestionLevel, score, reason } ] }` sorted by `score` ascending (lower = better). `distanceKm` null when no location. `reason` e.g. `"About 40 min shorter wait, 3.2 km away"`. |

Scoring (Eq. 6.3): min-max normalise wait, distance, congestion across candidates (all equal → 0), `score = w1*W + w2*D + w3*ρ`. Distance by haversine (R = 6371 km). Without location, the distance weight is redistributed proportionally to the other two.

### Appointments (FR-10)
| GET | `/doctors/:id/slots` | `?date=YYYY-MM-DD` | `{ doctorId, date, slotMinutes, slots: [ { start: "2026-10-30T09:00:00", available: true } ] }` (slots from that weekday's schedule; past slots excluded) |
| GET | `/appointments` | – | `[ Appointment ]` own, newest first |
| POST | `/appointments` | `{ doctorId, slotStart }` | 201 `Appointment`; 409 if slot taken |
| PUT | `/appointments/:id` | `{ slotStart }` | `Appointment` (reschedule, only BOOKED) |
| DELETE | `/appointments/:id` | – | `Appointment` status CANCELLED (slot released) |
| POST | `/appointments/:id/check-in` | – | 201 `TokenDetail` (only on the appointment day; token gets `appointment_id`) |

### Visits, feedback, notifications (FR-19, FR-20, FR-11)
| GET | `/visits` | – | `[ { id, visitDate, status, branch: {id,name}, tokens: [ { id, displayNumber, queueType, status, issuedAt, calledAt, completedAt, doctorName, servicePointName } ], feedback: { rating, comment } | null, canGiveFeedback } ]` newest first |
| POST | `/visits/:id/feedback` | `{ rating: 1-5, comment? }` | 201 `{ id, rating, comment }`; 409 if already given; 400 unless the visit has a COMPLETED token |
| GET | `/notifications` | – | `[ { id, tokenId, channel, message, sentAt, isRead } ]` newest first (IN_APP rows) |
| POST | `/notifications/read-all` | – | `{ ok: true }` |
| POST | `/notifications/device-token` | `{ fcmToken }` | `{ ok: true }` |

### Staff (FR-04, FR-12, FR-13) — role STAFF, limited to assigned service points
| GET | `/staff/service-points` | – | `[ { id, name, type, branchId, branchName, doctorId, doctorName } ]` (doctorId = doctor scheduled in that room today, or the logged-in doctor) |
| GET | `/service-points/:id/queue` | – | `{ servicePoint: { id, name, type, branchId, branchName }, nowServing: QueueToken|null, waiting: [QueueToken] (ordered), skipped: [QueueToken], recentlyCompleted: [QueueToken] (last 5 COMPLETED today, newest first — lets staff issue linked tokens after consultation, FR-04), summary: { completedToday, skippedToday, waiting, avgWaitMinutes, avgConsultMinutes } }` (today only) |
| POST | `/service-points/:id/call-next` | – | `{ token: QueueToken|null }`; 409 if a CALLED/IN_SERVICE token is still open there |
| POST | `/tokens/:id/start` | – | `QueueToken` CALLED → IN_SERVICE |
| POST | `/tokens/:id/skip` | – | CALLED → SKIPPED |
| POST | `/tokens/:id/recall` | – | SKIPPED → CALLED (409 if another token is open) |
| POST | `/tokens/:id/complete` | – | CALLED/IN_SERVICE → COMPLETED |
| POST | `/tokens/:id/transfer` | `{ toServicePointId, toDoctorId? }` | `{ from: QueueToken, to: QueueToken }`; WAITING/CALLED → TRANSFERRED, new WAITING token in the target queue, same visit, priority kept |
| POST | `/tokens/:id/priority` | `{ level: 0-2, reason }` | `QueueToken`; logs PRIORITY_SET with note = reason |
| GET | `/staff/transfer-targets` | `?servicePointId=` | `[ { servicePointId, name, type, doctorId, doctorName, specialty, waiting } ]` active points in the same branch except this one |
| POST | `/visits/:id/linked-tokens` | `{ type: "LAB"|"PHARMACY", servicePointId? }` | 201 `TokenDetail`; default target = the branch's active point of that type with the shortest queue. Doctors only (roles matrix): 403 `FORBIDDEN` for staff without a doctor profile |

Every status change writes a `queue_events` row in the same DB transaction (FR-21), then re-predicts the affected queue (FR-07), sends notifications (called patient + those within `notifyPositionsAhead` positions, FR-11) and emits socket events.

### Admin (FR-14 … FR-18, FR-20, FR-22) — BRANCH_ADMIN (own branch only) and HOSPITAL_ADMIN (all; optional `?branchId=` filter)
| CRUD | `/admin/branches` | `{ name, address, latitude, longitude, status }` | GET for both; POST/PUT/DELETE hospital admin only |
| CRUD | `/admin/departments` | `{ branchId, specialty, name, isActive }` | `?branchId=` |
| CRUD | `/admin/doctors` | create: `{ fullName, email, phone?, password, departmentId, avgConsultMinutes? }` (creates STAFF user + doctor) | row: `{ id, userId, fullName, email, phone, departmentId, departmentName, specialty, branchId, branchName, avgConsultMinutes, isActive }` |
| CRUD | `/admin/schedules` | `{ doctorId, servicePointId, dayOfWeek (1=Mon..7=Sun), startTime "HH:mm", endTime, maxPatients? }` | `?doctorId=&branchId=`; row adds `doctorName`, `servicePointName` |
| CRUD | `/admin/service-points` | `{ branchId, type, name, isActive }` | |
| CRUD | `/admin/users` | `{ fullName, email, phone?, password?, role (STAFF|BRANCH_ADMIN|HOSPITAL_ADMIN), adminBranchId?, isActive }` | `?role=` (one role or a comma-separated list, e.g. `?role=STAFF,BRANCH_ADMIN,HOSPITAL_ADMIN`); branch admin may only manage STAFF of own branch |
| GET/POST/DELETE | `/admin/assignments` | `{ userId, servicePointId }` | row: `{ id, userId, userName, servicePointId, servicePointName, type, branchName }` |

`DELETE` on master data = soft deactivate (`is_active=false` / `status=INACTIVE`), except schedules and assignments which are hard-deleted. Each CRUD resource: `GET /x` list, `GET /x/:id`, `POST /x` → 201, `PUT /x/:id`, `DELETE /x/:id`.

| GET | `/admin/dashboard` | `?branchId=` | `{ kpis: { waiting, inService, completedToday, avgWaitMinutes, maxWaitMinutes, activeDoctors, activeServicePoints }, branches: [ { branchId, name, waiting, avgWaitMinutes, congestionLevel } ], departments: [ { departmentId, branchId, branchName, name, specialty, waiting, activeDoctors, avgWaitMinutes, maxWaitMinutes, congestionRatio, congestionLevel } ], servicePoints: [ { id, name, type, branchName, waiting, nowServing } ] }` |
| GET | `/admin/alerts` | `?branchId=` | `[ { id, level: "HIGH"|"CRITICAL", source: "LIVE"|"FORECAST", branchId, branchName, departmentId, departmentName, message, at } ]` |
| GET | `/admin/reports` | `?type=doctor-consult|department-traffic|branch-utilization|waiting-times|feedback&from=&to=&branchId=&format=json|csv` | json: `{ type, title, columns: [ { key, label } ], rows: [ {...} ] }`; csv: `text/csv` attachment |
| GET | `/admin/forecasts` | `?branchId=&departmentId=&date=` | `[ { branchId, departmentId, departmentName, forecastHour, expectedArrivals, capacity, congestionRatio, congestionLevel, isPeak, source } ]` |
| POST | `/admin/forecasts/run` | – | `{ generated, source: "ai"|"baseline" }` — calls AI `/ai/jobs/forecast`; falls back to the JS seasonal baseline (avg of same weekday+hour over last 4 weeks). HOSPITAL_ADMIN only (403 `FORBIDDEN` for branch admins) |
| GET | `/admin/recommendations` | `?branchId=` | `{ workload: [ { branchId, branchName, patientsPerDoctorHour, utilization, avgWaitMinutes } ], recommendations: [ { branchId, branchName, departmentId, departmentName, date, timeRange, shortfallSessions, message } ] }` (FR-18) |
| GET | `/admin/feedback` | `?branchId=` | `{ summary: { count, average, distribution: { "1": n, ..., "5": n } }, items: [ { id, rating, comment, createdAt, patientName, branchName, visitDate } ] }` |
| GET/PUT | `/admin/settings` | PUT hospital admin only | `{ recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 }, congestionThresholds: { high: 0.85, critical: 1.0 }, alternativeSuggestionWaitMinutes: 45, notifyPositionsAhead: 3, slotMinutes: 15 }` |
| GET | `/admin/models` | – | `[ { version, trainedAt, trainingRows, dataSource, status, isActive, metrics: { mae, rmse, r2, within10, baselineMae, testRows } } ]` |
| POST | `/admin/models/retrain` | – | hospital admin; proxies AI `/ai/models/retrain` → `{ version, metrics, accepted, activated }`; 503 `AI_UNAVAILABLE` |
| POST | `/admin/models/:version/activate` | – | hospital admin; proxies AI |

Congestion (Eq. 6.5): live ratio for a department = waiting tokens ÷ remaining capacity this session (Σ over active doctors of remaining session minutes ÷ avg consult minutes); `NORMAL` < high ≤ `HIGH` < critical ≤ `CRITICAL`. `suggestAlternatives` (FR-09) = estimate ≥ `alternativeSuggestionWaitMinutes` or level HIGH/CRITICAL.

---

## Real-time channel (Socket.IO on port 4000) — FR-05, NFR-01

Connect: `io("http://localhost:4000", { auth: { token: "<jwt>" } })`. The server auto-joins each socket to `user:<userId>`.
Client → server: `subscribe` with `{ room }` and `unsubscribe` with `{ room }`. Allowed rooms:
`token:<id>` (token owner, staff, admins), `sp:<servicePointId>` (assigned staff, admins), `admin` (admins).

Server → client events (clients just re-fetch the relevant REST resource):
| Event | Payload | Rooms |
|---|---|---|
| `queue:updated` | `{ servicePointId, branchId }` | `sp:<id>`, `admin` |
| `token:updated` | `{ tokenId, status }` | `token:<id>`, `user:<ownerId>` (sent for every token in an affected queue whose position/estimate changed) |
| `notification` | `{ id, message, tokenId }` | `user:<id>` |
| `alert` | alert object (as in `/admin/alerts`) | `admin` |

---

## Internal AI service (FastAPI, port 8000) — backend only (`AI_SERVICE_URL`)

Feature vector (Section 6.3), keys exactly:
`patients_ahead, priority_ahead, doctor_avg_consult, doctor_recent_consult, interruptions_last_hour, session_started (0/1), minutes_to_start, hour_of_day, day_of_week (1-7), appointments_ahead, department_load, doctor_id, department_id, branch_id`.
The backend stores this object as `wait_predictions.features_json` for every prediction; the first prediction of each token joined with its actual wait (`called_at − issued_at`) is the training set.

Baseline (Eq. 6.2): `W = (patients_ahead + priority_ahead) * doctor_avg_consult + minutes_to_start` (minutes_to_start = 0 once started). Used when the AI service is down/has no active model, and as the benchmark.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/health` | – | `{ status: "ok", activeModel: "rf-20261029-1" | null }` |
| POST | `/ai/predict-wait` | `{ items: [ { tokenId, features: {...} } ] }` | `{ modelVersion, predictions: [ { tokenId, predictedMinutes } ] }`; 503 if no active model |
| POST | `/ai/rank-branches` | `{ weights: { wait, distance, congestion }, candidates: [ { branchId, doctorId, predictedWaitMinutes, distanceKm|null, congestionRatio } ] }` | `{ ranked: [ { branchId, doctorId, score } ] }` ascending |
| POST | `/ai/jobs/forecast` | `{ days: 7 }` | reads history from DB, writes `forecasts` rows (`source` = model version) → `{ generated, modelVersion }` |
| POST | `/ai/models/retrain` | – | trains RF on chronological 80/20 split, compares with baseline MAE and the active model; writes `model_versions` → `{ version, metrics, accepted, activated }` |
| GET | `/ai/models` | – | same shape as `/admin/models` |
| POST | `/ai/models/{version}/activate` | – | `{ version, activated: true }` |

Backend → AI calls use a 1.5 s timeout; on failure the backend falls back silently (baseline prediction / JS scoring / baseline forecast).
