'use strict';
/**
 * Branch, Doctor & Schedule helpers: doctor lookups, today's sessions and availability
 * ("acceptingNow", FR-02 / FR-03).
 */
const config = require('../config');
const time = require('../utils/time');

/** Doctor with user, department and branch data (null if missing). */
async function getDoctor(db, doctorId) {
  const row = await db.get(
    `SELECT d.doctor_id, d.user_id, d.department_id, d.avg_consult_minutes, d.is_active,
            u.full_name, u.email, u.phone, u.is_active AS user_active,
            dp.specialty, dp.name AS department_name, dp.branch_id, dp.is_active AS department_active,
            b.name AS branch_name, b.status AS branch_status, b.address AS branch_address,
            b.latitude, b.longitude
       FROM doctors d
       JOIN users u ON u.user_id = d.user_id
       JOIN departments dp ON dp.department_id = d.department_id
       JOIN branches b ON b.branch_id = dp.branch_id
      WHERE d.doctor_id = ?`,
    [doctorId]
  );
  return row || null;
}

function isDoctorBookable(doc) {
  return Boolean(
    doc && doc.is_active && doc.user_active && doc.department_active && doc.branch_status === 'ACTIVE'
  );
}

/** Convert a doctor_schedules row into a session on a given date. */
function toSession(row, dateStr) {
  return {
    scheduleId: row.schedule_id,
    doctorId: row.doctor_id,
    servicePointId: row.service_point_id,
    servicePointName: row.service_point_name || null,
    startTime: time.shortTime(row.start_time),
    endTime: time.shortTime(row.end_time),
    start: time.combine(dateStr, row.start_time),
    end: time.combine(dateStr, row.end_time),
    maxPatients: row.max_patients === null || row.max_patients === undefined ? null : Number(row.max_patients),
    avgConsultMinutes: row.avg_consult_minutes !== undefined ? Number(row.avg_consult_minutes) : undefined,
  };
}

/** All sessions of a doctor on a date (sorted by start). */
async function doctorSessions(db, doctorId, dateStr) {
  const dow = time.isoDow(time.parseDate(dateStr));
  const rows = await db.query(
    `SELECT ds.*, sp.name AS service_point_name FROM doctor_schedules ds
       JOIN service_points sp ON sp.service_point_id = ds.service_point_id
      WHERE ds.doctor_id = ? AND ds.day_of_week = ? AND sp.is_active = 1
      ORDER BY ds.start_time`,
    [doctorId, dow]
  );
  return rows.map((r) => toSession(r, dateStr));
}

/**
 * The relevant session for "now": today -> the first session that has not ended, otherwise
 * the last one; other dates -> the first session.
 */
function pickSession(sessions, dateStr, now) {
  if (!sessions.length) return null;
  if (dateStr === time.formatDate(now)) {
    return sessions.find((s) => s.end > now) || sessions[sessions.length - 1];
  }
  return sessions[0];
}

/** Sessions on a date of all active doctors in a department (with avg consult minutes). */
async function departmentSessions(db, departmentId, dateStr) {
  const dow = time.isoDow(time.parseDate(dateStr));
  const rows = await db.query(
    `SELECT ds.*, d.avg_consult_minutes FROM doctor_schedules ds
       JOIN doctors d ON d.doctor_id = ds.doctor_id
       JOIN users u ON u.user_id = d.user_id
       JOIN service_points sp ON sp.service_point_id = ds.service_point_id
      WHERE d.department_id = ? AND ds.day_of_week = ? AND d.is_active = 1 AND u.is_active = 1 AND sp.is_active = 1`,
    [departmentId, dow]
  );
  return rows.map((r) => toSession(r, dateStr));
}

/** Tokens issued for a doctor today that count towards max_patients. */
async function issuedCount(db, doctorId, dateStr) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM tokens
      WHERE doctor_id = ? AND token_date = ? AND status <> 'CANCELLED' AND status <> 'TRANSFERRED'`,
    [doctorId, dateStr]
  );
  return Number(row.n) || 0;
}

async function waitingCount(db, doctorId, dateStr) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM tokens WHERE doctor_id = ? AND token_date = ? AND status = 'WAITING'`,
    [doctorId, dateStr]
  );
  return Number(row.n) || 0;
}

/**
 * Availability of a doctor (FR-02): acceptingNow = scheduled today, session not ended
 * (ignored when DEMO_ALWAYS_OPEN=true) and below max_patients.
 */
async function availability(db, doctor, dateStr, now) {
  const sessions = await doctorSessions(db, doctor.doctor_id, dateStr);
  const session = pickSession(sessions, dateStr, now);
  const isToday = dateStr === time.formatDate(now);
  let acceptingNow = false;
  let queueLength = 0;
  if (isToday && session && isDoctorBookable(doctor)) {
    const open = config.demoAlwaysOpen || now < session.end;
    const issued = await issuedCount(db, doctor.doctor_id, dateStr);
    const belowMax = !session.maxPatients || issued < session.maxPatients;
    acceptingNow = open && belowMax;
  }
  if (isToday) queueLength = await waitingCount(db, doctor.doctor_id, dateStr);
  return { sessions, session, availableToday: Boolean(session), acceptingNow, queueLength };
}

module.exports = {
  getDoctor,
  isDoctorBookable,
  toSession,
  doctorSessions,
  pickSession,
  departmentSessions,
  issuedCount,
  waitingCount,
  availability,
};
