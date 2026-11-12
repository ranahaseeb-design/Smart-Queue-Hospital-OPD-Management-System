'use strict';
/**
 * Branch, Doctor & Schedule helpers: doctor lookups, today's sessions and availability
 * ("acceptingNow", FR-02 / FR-03).
 */
const config = require('../config');
const time = require('../utils/time');
const { models, sess, byIds } = require('../db');

const { Doctor, User, Department, Branch, DoctorSchedule, ServicePoint, Token } = models;

/** Doctor row built from doctors + users + departments + branches. */
function doctorRow(d, u, dp, b) {
  return {
    doctor_id: d._id,
    user_id: d.user_id,
    department_id: d.department_id,
    avg_consult_minutes: d.avg_consult_minutes,
    is_active: d.is_active,
    full_name: u.full_name,
    email: u.email,
    phone: u.phone,
    user_active: u.is_active,
    specialty: dp.specialty,
    department_name: dp.name,
    branch_id: dp.branch_id,
    department_active: dp.is_active,
    branch_name: b.name,
    branch_status: b.status,
    branch_address: b.address,
    latitude: b.latitude,
    longitude: b.longitude,
  };
}

/** Doctor rows for many doctor ids: Map doctorId -> row (inner-join semantics). */
async function getDoctors(db, doctorIds) {
  const docs = await byIds(db, Doctor, doctorIds);
  const users = await byIds(db, User, [...docs.values()].map((d) => d.user_id), { password_hash: 0 });
  const depts = await byIds(db, Department, [...docs.values()].map((d) => d.department_id));
  const branches = await byIds(db, Branch, [...depts.values()].map((d) => d.branch_id));
  const out = new Map();
  for (const d of docs.values()) {
    const u = users.get(d.user_id);
    const dp = depts.get(d.department_id);
    const b = dp ? branches.get(dp.branch_id) : null;
    if (u && dp && b) out.set(d._id, doctorRow(d, u, dp, b));
  }
  return out;
}

/** Doctor with user, department and branch data (null if missing). */
async function getDoctor(db, doctorId) {
  return (await getDoctors(db, [doctorId])).get(doctorId) || null;
}

function isDoctorBookable(doc) {
  return Boolean(
    doc && doc.is_active && doc.user_active && doc.department_active && doc.branch_status === 'ACTIVE'
  );
}

/** Convert a doctor_schedules row into a session on a given date. */
function toSession(row, dateStr) {
  return {
    scheduleId: row.schedule_id !== undefined ? row.schedule_id : row._id,
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

/** Sort by start_time ("HH:mm:ss" strings compare like times), then schedule id. */
const byStartTime = (a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a._id - b._id);

/** All sessions of a doctor on a date (sorted by start), only in active service points. */
async function doctorSessions(db, doctorId, dateStr) {
  const dow = time.isoDow(time.parseDate(dateStr));
  const rows = await DoctorSchedule.find({ doctor_id: doctorId, day_of_week: dow }).session(sess(db)).lean();
  const sps = await byIds(db, ServicePoint, rows.map((r) => r.service_point_id));
  return rows
    .filter((r) => sps.get(r.service_point_id) && sps.get(r.service_point_id).is_active)
    .sort(byStartTime)
    .map((r) => toSession({ ...r, schedule_id: r._id, service_point_name: sps.get(r.service_point_id).name }, dateStr));
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

/**
 * Schedules on a weekday of active doctors (active user account) in active service points,
 * with the doctor's avg_consult_minutes and department_id. `doctorFilter` narrows the doctors.
 */
async function activeSchedules(db, dow, doctorFilter = {}, { activeDepartmentsOnly = false } = {}) {
  const doctors = await Doctor.find({ ...doctorFilter, is_active: true }).session(sess(db)).lean();
  if (!doctors.length) return [];
  const users = await byIds(db, User, doctors.map((d) => d.user_id), { is_active: 1 });
  let active = doctors.filter((d) => users.get(d.user_id) && users.get(d.user_id).is_active);
  if (activeDepartmentsOnly) {
    const depts = await byIds(db, Department, active.map((d) => d.department_id), { is_active: 1, branch_id: 1 });
    active = active.filter((d) => depts.get(d.department_id) && depts.get(d.department_id).is_active);
  }
  const byDoctor = new Map(active.map((d) => [d._id, d]));
  const filter = { doctor_id: { $in: [...byDoctor.keys()] } };
  if (dow !== null && dow !== undefined) filter.day_of_week = dow;
  const rows = await DoctorSchedule.find(filter).session(sess(db)).lean();
  const sps = await byIds(db, ServicePoint, rows.map((r) => r.service_point_id), { is_active: 1, name: 1 });
  return rows
    .filter((r) => sps.get(r.service_point_id) && sps.get(r.service_point_id).is_active)
    .map((r) => {
      const d = byDoctor.get(r.doctor_id);
      return {
        ...r,
        schedule_id: r._id,
        department_id: d.department_id,
        avg_consult_minutes: d.avg_consult_minutes,
      };
    });
}

/** Sessions on a date of all active doctors in a department (with avg consult minutes). */
async function departmentSessions(db, departmentId, dateStr) {
  const dow = time.isoDow(time.parseDate(dateStr));
  const rows = await activeSchedules(db, dow, { department_id: departmentId });
  return rows.map((r) => toSession(r, dateStr));
}

/**
 * Issue-time window of a session, consistent with pickSession(): a token issued at time t
 * belongs to the first session that has not ended at t. So session i covers
 * [end of session i-1 (or 00:00), end of session i), and the last session also takes
 * everything until midnight (DEMO_ALWAYS_OPEN issues after the end).
 * Returns { from, to } as Dates (to is exclusive).
 */
function sessionWindow(sessions, session, dateStr) {
  const ordered = [...sessions].sort((a, b) => a.end - b.end);
  const idx = ordered.findIndex((s) => s === session || (s.scheduleId === session.scheduleId && s.end - session.end === 0));
  const dayStart = time.parseDate(dateStr);
  const from = idx > 0 ? ordered[idx - 1].end : dayStart;
  const to = idx >= 0 && idx < ordered.length - 1 ? session.end : time.addDays(dayStart, 1);
  return { from, to };
}

/**
 * OPD tokens issued for a doctor that count towards max_patients. With a session window only
 * the tokens issued within that session's window count (max_patients is per session, not per day).
 */
async function issuedCount(db, doctorId, dateStr, window = null) {
  const filter = {
    doctor_id: doctorId,
    token_date: dateStr,
    queue_type: 'OPD',
    status: { $nin: ['CANCELLED', 'TRANSFERRED'] },
  };
  if (window) filter.issued_at = { $gte: window.from, $lt: window.to };
  return Token.countDocuments(filter).session(sess(db));
}

/** Tokens already issued in `session` (of `sessions` on dateStr) for the doctor. */
async function sessionIssuedCount(db, doctorId, dateStr, sessions, session) {
  return issuedCount(db, doctorId, dateStr, sessionWindow(sessions, session, dateStr));
}

async function waitingCount(db, doctorId, dateStr) {
  return Token.countDocuments({ doctor_id: doctorId, token_date: dateStr, status: 'WAITING' }).session(sess(db));
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
    // Same per-session count as issueOpdToken enforces.
    const belowMax =
      !session.maxPatients ||
      (await sessionIssuedCount(db, doctor.doctor_id, dateStr, sessions, session)) < session.maxPatients;
    acceptingNow = open && belowMax;
  }
  if (isToday) queueLength = await waitingCount(db, doctor.doctor_id, dateStr);
  return { sessions, session, availableToday: Boolean(session), acceptingNow, queueLength };
}

module.exports = {
  getDoctor,
  getDoctors,
  isDoctorBookable,
  toSession,
  doctorSessions,
  pickSession,
  activeSchedules,
  departmentSessions,
  issuedCount,
  sessionWindow,
  sessionIssuedCount,
  waitingCount,
  availability,
};
