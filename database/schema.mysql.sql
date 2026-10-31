-- Smart Digital Queue Management System for Hospital OPD
-- Canonical MySQL 8 schema (Section 4.9 of the FYP documentation).
-- All DATETIME values are stored in hospital local time (TZ=Asia/Karachi).

CREATE DATABASE IF NOT EXISTS smart_opd CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE smart_opd;

CREATE TABLE branches (
  branch_id     INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  address       VARCHAR(255),
  latitude      DECIMAL(9,6) NOT NULL,
  longitude     DECIMAL(9,6) NOT NULL,
  status        ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE users (
  user_id           INT AUTO_INCREMENT PRIMARY KEY,
  full_name         VARCHAR(100) NOT NULL,
  email             VARCHAR(120) UNIQUE,
  phone             VARCHAR(20) UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  role              ENUM('PATIENT','STAFF','BRANCH_ADMIN','HOSPITAL_ADMIN') NOT NULL,
  date_of_birth     DATE NULL,
  priority_category ENUM('NONE','ELDERLY','DIFFERENTLY_ABLED') NOT NULL DEFAULT 'NONE',
  admin_branch_id   INT NULL,
  fcm_token         VARCHAR(255) NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        DATETIME NOT NULL,
  FOREIGN KEY (admin_branch_id) REFERENCES branches(branch_id)
);

CREATE TABLE departments (
  department_id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id     INT NOT NULL,
  specialty     VARCHAR(80) NOT NULL,
  name          VARCHAR(100),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  INDEX idx_dept_specialty (specialty)
);

CREATE TABLE service_points (
  service_point_id INT AUTO_INCREMENT PRIMARY KEY,
  branch_id        INT NOT NULL,
  type             ENUM('OPD','LAB','PHARMACY') NOT NULL,
  name             VARCHAR(60),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id)
);

CREATE TABLE doctors (
  doctor_id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL UNIQUE,
  department_id       INT NOT NULL,
  avg_consult_minutes DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (department_id) REFERENCES departments(department_id)
);

CREATE TABLE doctor_schedules (
  schedule_id      INT AUTO_INCREMENT PRIMARY KEY,
  doctor_id        INT NOT NULL,
  service_point_id INT NOT NULL,
  day_of_week      TINYINT NOT NULL,          -- 1 = Monday ... 7 = Sunday (ISO)
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  max_patients     SMALLINT NULL,
  FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id),
  FOREIGN KEY (service_point_id) REFERENCES service_points(service_point_id)
);

CREATE TABLE staff_assignments (
  assignment_id    INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL,
  service_point_id INT NOT NULL,
  UNIQUE KEY uq_assignment (user_id, service_point_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (service_point_id) REFERENCES service_points(service_point_id)
);

CREATE TABLE visits (
  visit_id   INT AUTO_INCREMENT PRIMARY KEY,
  patient_id INT NOT NULL,
  branch_id  INT NOT NULL,
  visit_date DATE NOT NULL,
  status     ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
  FOREIGN KEY (patient_id) REFERENCES users(user_id),
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id)
);

CREATE TABLE appointments (
  appointment_id INT AUTO_INCREMENT PRIMARY KEY,
  patient_id     INT NOT NULL,
  doctor_id      INT NOT NULL,
  slot_start     DATETIME NOT NULL,
  status         ENUM('BOOKED','CHECKED_IN','CANCELLED','COMPLETED','NO_SHOW') NOT NULL DEFAULT 'BOOKED',
  updated_at     DATETIME NOT NULL,
  FOREIGN KEY (patient_id) REFERENCES users(user_id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id),
  INDEX idx_appt_doctor_slot (doctor_id, slot_start)
  -- Double-booking is prevented in the Appointment Service (only BOOKED/CHECKED_IN
  -- rows block a slot, so cancelled slots can be re-booked).
);

CREATE TABLE tokens (
  token_id         INT AUTO_INCREMENT PRIMARY KEY,
  visit_id         INT NOT NULL,
  service_point_id INT NOT NULL,
  doctor_id        INT NULL,
  appointment_id   INT NULL UNIQUE,
  token_number     INT NOT NULL,
  token_date       DATE NOT NULL,
  queue_type       ENUM('OPD','LAB','PHARMACY') NOT NULL,
  priority_level   TINYINT NOT NULL DEFAULT 0,   -- 0 normal, 1 elderly/differently-abled, 2 emergency
  status           ENUM('WAITING','CALLED','IN_SERVICE','SKIPPED','TRANSFERRED','COMPLETED','CANCELLED','NO_SHOW') NOT NULL DEFAULT 'WAITING',
  issued_at        DATETIME NOT NULL,
  called_at        DATETIME NULL,
  completed_at     DATETIME NULL,
  is_synthetic     BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_token_number (service_point_id, token_date, token_number),
  FOREIGN KEY (visit_id) REFERENCES visits(visit_id),
  FOREIGN KEY (service_point_id) REFERENCES service_points(service_point_id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(doctor_id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id),
  INDEX idx_token_sp_status (service_point_id, status),
  INDEX idx_token_doctor_date (doctor_id, token_date)
);

CREATE TABLE queue_events (
  event_id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  token_id      INT NOT NULL,
  event_type    ENUM('ISSUED','CALLED','STARTED','SKIPPED','RECALLED','TRANSFERRED','COMPLETED','CANCELLED','PRIORITY_SET','NO_SHOW') NOT NULL,
  performed_by  INT NULL,
  from_point_id INT NULL,
  to_point_id   INT NULL,
  note          VARCHAR(255) NULL,
  event_time    DATETIME NOT NULL,
  FOREIGN KEY (token_id) REFERENCES tokens(token_id),
  FOREIGN KEY (performed_by) REFERENCES users(user_id),
  INDEX idx_event_time (event_time)
);

CREATE TABLE wait_predictions (
  prediction_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
  token_id          INT NOT NULL,
  predicted_minutes DECIMAL(6,1) NOT NULL,
  model_version     VARCHAR(20) NOT NULL,
  features_json     JSON,
  created_at        DATETIME NOT NULL,
  FOREIGN KEY (token_id) REFERENCES tokens(token_id),
  INDEX idx_pred_token (token_id)
);

CREATE TABLE notifications (
  notification_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  token_id        INT NULL,
  channel         ENUM('PUSH','IN_APP','EMAIL','SMS') NOT NULL,
  message         VARCHAR(255),
  sent_at         DATETIME,
  status          ENUM('SENT','FAILED') NOT NULL,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (token_id) REFERENCES tokens(token_id)
);

CREATE TABLE feedback (
  feedback_id INT AUTO_INCREMENT PRIMARY KEY,
  visit_id    INT NOT NULL UNIQUE,
  rating      TINYINT NOT NULL,
  comment     TEXT NULL,
  created_at  DATETIME NOT NULL,
  FOREIGN KEY (visit_id) REFERENCES visits(visit_id)
);

CREATE TABLE forecasts (
  forecast_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  branch_id         INT NOT NULL,
  department_id     INT NOT NULL,
  forecast_hour     DATETIME NOT NULL,
  expected_arrivals DECIMAL(6,1),
  capacity          DECIMAL(6,1),
  congestion_level  ENUM('NORMAL','HIGH','CRITICAL') NOT NULL,
  is_peak           BOOLEAN NOT NULL DEFAULT FALSE,
  source            VARCHAR(20) NOT NULL DEFAULT 'baseline',   -- 'baseline' or a model version
  generated_at      DATETIME NOT NULL,
  FOREIGN KEY (branch_id) REFERENCES branches(branch_id),
  FOREIGN KEY (department_id) REFERENCES departments(department_id),
  INDEX idx_forecast_hour (branch_id, department_id, forecast_hour)
);

-- Registry of trained waiting-time model versions (FR-22). Model files live in ai-service/models/<version>.joblib
CREATE TABLE model_versions (
  version       VARCHAR(20) PRIMARY KEY,
  trained_at    DATETIME NOT NULL,
  training_rows INT NOT NULL,
  data_source   VARCHAR(40) NOT NULL,       -- 'synthetic', 'pilot', 'partner-hospital'
  metrics_json  JSON NOT NULL,              -- {mae, rmse, r2, within10, baselineMae, testRows}
  status        ENUM('CANDIDATE','ACTIVE','REJECTED','RETIRED') NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT FALSE
);

-- System settings managed by the Hospital Administrator (key -> JSON value)
CREATE TABLE settings (
  setting_key   VARCHAR(60) PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_at    DATETIME NOT NULL
);
