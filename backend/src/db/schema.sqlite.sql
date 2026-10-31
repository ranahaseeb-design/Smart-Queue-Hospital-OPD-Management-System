-- Smart Digital Queue Management System for Hospital OPD
-- SQLite mirror of database/schema.mysql.sql (used for local development and tests).
-- Same tables and columns; ENUM -> TEXT + CHECK, JSON -> TEXT, BOOLEAN -> INTEGER 0/1,
-- DATETIME -> TEXT "YYYY-MM-DD HH:mm:ss" (hospital local time), DATE -> TEXT "YYYY-MM-DD",
-- TIME -> TEXT "HH:mm:ss", DECIMAL -> REAL.
PRAGMA foreign_keys = ON;

CREATE TABLE branches (
  branch_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  address       TEXT,
  latitude      REAL NOT NULL,
  longitude     REAL NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE users (
  user_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name         TEXT NOT NULL,
  email             TEXT UNIQUE,
  phone             TEXT UNIQUE,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('PATIENT','STAFF','BRANCH_ADMIN','HOSPITAL_ADMIN')),
  date_of_birth     TEXT NULL,
  priority_category TEXT NOT NULL DEFAULT 'NONE' CHECK (priority_category IN ('NONE','ELDERLY','DIFFERENTLY_ABLED')),
  admin_branch_id   INTEGER NULL REFERENCES branches(branch_id),
  fcm_token         TEXT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at        TEXT NOT NULL
);

CREATE TABLE departments (
  department_id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id     INTEGER NOT NULL REFERENCES branches(branch_id),
  specialty     TEXT NOT NULL,
  name          TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE INDEX idx_dept_specialty ON departments (specialty);

CREATE TABLE service_points (
  service_point_id INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id        INTEGER NOT NULL REFERENCES branches(branch_id),
  type             TEXT NOT NULL CHECK (type IN ('OPD','LAB','PHARMACY')),
  name             TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE doctors (
  doctor_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL UNIQUE REFERENCES users(user_id),
  department_id       INTEGER NOT NULL REFERENCES departments(department_id),
  avg_consult_minutes REAL NOT NULL DEFAULT 10.00,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);

CREATE TABLE doctor_schedules (
  schedule_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id        INTEGER NOT NULL REFERENCES doctors(doctor_id),
  service_point_id INTEGER NOT NULL REFERENCES service_points(service_point_id),
  day_of_week      INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1 = Monday ... 7 = Sunday (ISO)
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  max_patients     INTEGER NULL
);

CREATE TABLE staff_assignments (
  assignment_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(user_id),
  service_point_id INTEGER NOT NULL REFERENCES service_points(service_point_id),
  CONSTRAINT uq_assignment UNIQUE (user_id, service_point_id)
);

CREATE TABLE visits (
  visit_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(user_id),
  branch_id  INTEGER NOT NULL REFERENCES branches(branch_id),
  visit_date TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

CREATE TABLE appointments (
  appointment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES users(user_id),
  doctor_id      INTEGER NOT NULL REFERENCES doctors(doctor_id),
  slot_start     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CHECKED_IN','CANCELLED','COMPLETED','NO_SHOW')),
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_appt_doctor_slot ON appointments (doctor_id, slot_start);

CREATE TABLE tokens (
  token_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id         INTEGER NOT NULL REFERENCES visits(visit_id),
  service_point_id INTEGER NOT NULL REFERENCES service_points(service_point_id),
  doctor_id        INTEGER NULL REFERENCES doctors(doctor_id),
  appointment_id   INTEGER NULL UNIQUE REFERENCES appointments(appointment_id),
  token_number     INTEGER NOT NULL,
  token_date       TEXT NOT NULL,
  queue_type       TEXT NOT NULL CHECK (queue_type IN ('OPD','LAB','PHARMACY')),
  priority_level   INTEGER NOT NULL DEFAULT 0,   -- 0 normal, 1 elderly/differently-abled, 2 emergency
  status           TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','CALLED','IN_SERVICE','SKIPPED','TRANSFERRED','COMPLETED','CANCELLED','NO_SHOW')),
  issued_at        TEXT NOT NULL,
  called_at        TEXT NULL,
  completed_at     TEXT NULL,
  is_synthetic     INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0,1)),
  CONSTRAINT uq_token_number UNIQUE (service_point_id, token_date, token_number)
);
CREATE INDEX idx_token_sp_status ON tokens (service_point_id, status);
CREATE INDEX idx_token_doctor_date ON tokens (doctor_id, token_date);

CREATE TABLE queue_events (
  event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id      INTEGER NOT NULL REFERENCES tokens(token_id),
  event_type    TEXT NOT NULL CHECK (event_type IN ('ISSUED','CALLED','STARTED','SKIPPED','RECALLED','TRANSFERRED','COMPLETED','CANCELLED','PRIORITY_SET','NO_SHOW')),
  performed_by  INTEGER NULL REFERENCES users(user_id),
  from_point_id INTEGER NULL,
  to_point_id   INTEGER NULL,
  note          TEXT NULL,
  event_time    TEXT NOT NULL
);
CREATE INDEX idx_event_time ON queue_events (event_time);

CREATE TABLE wait_predictions (
  prediction_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id          INTEGER NOT NULL REFERENCES tokens(token_id),
  predicted_minutes REAL NOT NULL,
  model_version     TEXT NOT NULL,
  features_json     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_pred_token ON wait_predictions (token_id);

CREATE TABLE notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(user_id),
  token_id        INTEGER NULL REFERENCES tokens(token_id),
  channel         TEXT NOT NULL CHECK (channel IN ('PUSH','IN_APP','EMAIL','SMS')),
  message         TEXT,
  sent_at         TEXT,
  status          TEXT NOT NULL CHECK (status IN ('SENT','FAILED')),
  is_read         INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1))
);

CREATE TABLE feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id    INTEGER NOT NULL UNIQUE REFERENCES visits(visit_id),
  rating      INTEGER NOT NULL,
  comment     TEXT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE forecasts (
  forecast_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id         INTEGER NOT NULL REFERENCES branches(branch_id),
  department_id     INTEGER NOT NULL REFERENCES departments(department_id),
  forecast_hour     TEXT NOT NULL,
  expected_arrivals REAL,
  capacity          REAL,
  congestion_level  TEXT NOT NULL CHECK (congestion_level IN ('NORMAL','HIGH','CRITICAL')),
  is_peak           INTEGER NOT NULL DEFAULT 0 CHECK (is_peak IN (0,1)),
  source            TEXT NOT NULL DEFAULT 'baseline',   -- 'baseline' or a model version
  generated_at      TEXT NOT NULL
);
CREATE INDEX idx_forecast_hour ON forecasts (branch_id, department_id, forecast_hour);

-- Registry of trained waiting-time model versions (FR-22).
CREATE TABLE model_versions (
  version       TEXT PRIMARY KEY,
  trained_at    TEXT NOT NULL,
  training_rows INTEGER NOT NULL,
  data_source   TEXT NOT NULL,
  metrics_json  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('CANDIDATE','ACTIVE','REJECTED','RETIRED')),
  is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1))
);

-- System settings managed by the Hospital Administrator (key -> JSON value)
CREATE TABLE settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- MySQL/InnoDB automatically creates an index for every foreign-key column that is not already
-- the leftmost column of another index; SQLite does not. The same indexes are created explicitly
-- here so both drivers have the same access paths (e.g. tokens by visit, events by token).
CREATE INDEX fk_users_admin_branch ON users (admin_branch_id);
CREATE INDEX fk_departments_branch ON departments (branch_id);
CREATE INDEX fk_service_points_branch ON service_points (branch_id);
CREATE INDEX fk_doctors_department ON doctors (department_id);
CREATE INDEX fk_schedules_doctor ON doctor_schedules (doctor_id);
CREATE INDEX fk_schedules_service_point ON doctor_schedules (service_point_id);
CREATE INDEX fk_assignments_service_point ON staff_assignments (service_point_id);
CREATE INDEX fk_visits_patient ON visits (patient_id);
CREATE INDEX fk_visits_branch ON visits (branch_id);
CREATE INDEX fk_appointments_patient ON appointments (patient_id);
CREATE INDEX fk_tokens_visit ON tokens (visit_id);
CREATE INDEX fk_queue_events_token ON queue_events (token_id);
CREATE INDEX fk_queue_events_performed_by ON queue_events (performed_by);
CREATE INDEX fk_notifications_user ON notifications (user_id);
CREATE INDEX fk_notifications_token ON notifications (token_id);
CREATE INDEX fk_forecasts_department ON forecasts (department_id);
