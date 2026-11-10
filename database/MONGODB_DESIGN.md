# MongoDB data design (MERN migration)

MongoDB replaces MySQL/SQLite as the only database. The backend uses **Mongoose**, and the
AI service uses **pymongo** against the same database. This file is the shared contract between
the two, in the way that `database/schema.mysql.sql` was before.

**The REST API does not change** (`docs/API_CONTRACT.md`): same paths, same JSON, and ids stay
**integers**, so the dashboards and the Flutter app work unchanged.

## Conventions

- **Database name:** `smart_opd`. Connection string: `MONGODB_URI` (default
  `mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0`).
- **Replica set required.** Multi-document transactions (status change + `queue_events`
  together, FR-21; token numbering; appointment booking) need a replica set. For local
  development use a **single-node replica set** (`rs0`); MongoDB Atlas clusters already are one.
- **Collections:** one per former table, with the same snake_case name: `users`, `branches`,
  `departments`, `service_points`, `doctors`, `doctor_schedules`, `staff_assignments`, `visits`,
  `appointments`, `tokens`, `queue_events`, `wait_predictions`, `notifications`, `feedback`,
  `forecasts`, `model_versions`, `settings`, plus a `counters` collection for id sequences.
- **Field names are identical to the old SQL columns** (snake_case: `doctor_id`,
  `issued_at`, `avg_consult_minutes`, …), so the two codebases and the documentation's data
  dictionary still line up.
- **Integer ids.** Every document has `_id` = a positive integer from
  `counters` (`{ _id: '<collection>', seq: n }`, incremented atomically with
  `findOneAndUpdate({ $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' })`). The
  former PK column name is **not** duplicated: the API maps `_id` → `id`, and foreign keys keep
  their names (`tokens.doctor_id` holds a doctor's `_id`). Exceptions: `model_versions._id` is
  the version string (`rf-20261029-1210`), and `settings._id` is the setting key.
- **Types:**
  - Datetimes are BSON `Date` (stored in UTC, the driver default). Hospital-local formatting
    stays in the API layer (`TZ=Asia/Karachi`, the `"YYYY-MM-DDTHH:mm:ss"` strings from the
    contract).
  - `token_date` and `visit_date` stay `"YYYY-MM-DD"` strings (hospital-local calendar day,
    used for numbering and grouping).
  - Schedule `start_time` and `end_time` stay `"HH:mm:ss"` strings.
  - Booleans are real booleans; DECIMAL becomes Number.
  - Former JSON columns are embedded objects (`wait_predictions.features`,
    `model_versions.metrics`, `settings.value`).
- **Enums** keep the same string values as the SQL ENUMs, validated with Mongoose `enum`.

## Collections and indexes

| Collection | Fields (besides integer `_id`) | Indexes / constraints |
|---|---|---|
| `branches` | name, address, latitude, longitude, status (ACTIVE/INACTIVE) | |
| `users` | full_name, email?, phone?, password_hash, role, date_of_birth? (string `YYYY-MM-DD`), priority_category, admin_branch_id?, fcm_token?, is_active, created_at | unique sparse `email`, unique sparse `phone` |
| `departments` | branch_id, specialty, name, is_active | `{branch_id, specialty}`, `specialty` |
| `service_points` | branch_id, type (OPD/LAB/PHARMACY), name, is_active | `branch_id` |
| `doctors` | user_id, department_id, avg_consult_minutes, is_active | unique `user_id`, `department_id` |
| `doctor_schedules` | doctor_id, service_point_id, day_of_week (1–7), start_time, end_time, max_patients? | `{doctor_id, day_of_week}`, `{service_point_id, day_of_week}` |
| `staff_assignments` | user_id, service_point_id | unique `{user_id, service_point_id}` |
| `visits` | patient_id, branch_id, visit_date, status (OPEN/CLOSED) | `{patient_id, visit_date, branch_id}`; **partial unique** on `{patient_id, branch_id, visit_date}` where `status: 'OPEN'` (one open visit per patient, branch and day) |
| `appointments` | patient_id, doctor_id, slot_start (Date), status, updated_at | `{doctor_id, slot_start}`; **partial unique** `{doctor_id, slot_start}` where status ∈ {BOOKED, CHECKED_IN} (no double booking) |
| `tokens` | visit_id, service_point_id, doctor_id?, appointment_id?, token_number, token_date, queue_type, priority_level, status, issued_at, called_at?, completed_at?, is_synthetic | unique `{service_point_id, token_date, token_number}`; unique sparse `appointment_id`; `{service_point_id, token_date, status}`; `{doctor_id, token_date}`; `{visit_id}`; `{doctor_id, queue_type, status, completed_at}` |
| `queue_events` | token_id, event_type, performed_by?, from_point_id?, to_point_id?, note?, event_time | `{token_id, event_time}`, `event_time` |
| `wait_predictions` | token_id, predicted_minutes, model_version, features (object with the 14 contract keys), created_at | `{token_id, created_at}` |
| `notifications` | user_id, token_id?, channel, message, sent_at, status, is_read | `{user_id, sent_at}` |
| `feedback` | visit_id, rating, comment?, created_at | unique `visit_id` |
| `forecasts` | branch_id, department_id, forecast_hour (Date), expected_arrivals, capacity, congestion_level, is_peak, source, generated_at | `{branch_id, department_id, forecast_hour}`, `forecast_hour` |
| `model_versions` | `_id` = version string; trained_at, training_rows, data_source, metrics (object), status, is_active | `is_active` |
| `settings` | `_id` = key; value (object), updated_at | |
| `counters` | `_id` = collection name; seq | |

## Concurrency (replaces the SQL row locks)

- **Token numbers:** a per-queue-day counter, `counters` `_id: 'token:<service_point_id>:<YYYY-MM-DD>'`,
  incremented atomically inside the transaction. The unique index is the backstop.
- **Duplicate active token, double booking, one open visit:** checked inside the transaction and
  backed by the unique / partial unique indexes above. A duplicate-key error (11000) maps to
  409 CONFLICT.
- **Call next / open-token check:** run inside a transaction. A conditional
  `updateOne({ _id, status: <expected> })` that matches 0 documents means someone else got there
  first, which gives 409.
- **Transaction retries:** use `session.withTransaction()`, which retries transient errors and
  write conflicts. This replaces the old service-point → doctor → patient lock ordering.

## AI service

Reads `tokens`, `wait_predictions` (first per token: `features` + the token's `issued_at` /
`called_at` as the label), `doctor_schedules`, `doctors`, `departments`, `branches` and
`settings`. Writes `forecasts` (replacing its horizon) and `model_versions`. Connection:
`MONGODB_URI` (same database). Datetimes come back as timezone-naive UTC `datetime`; convert to
hospital-local time (`HOSPITAL_TZ`) before deriving hour of day or day of week.
