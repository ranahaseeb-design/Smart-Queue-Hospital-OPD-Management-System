'use strict';
/**
 * Pure (DB-free) queue maths shared by the live Prediction Service and the seed's
 * synthetic-history generator, so stored features_json values are computed
 * identically in both places (Section 6.3, FR-06).
 *
 * A queue context describes one queue (service point + day [+ doctor for OPD]) at time `now`:
 *   queue:              [{ id, status, priorityLevel, issuedAt: Date, calledAt: Date|null, completedAt: Date|null }]
 *                       tokens of this queue issued so far today, with their state as of `now`
 *   recentEvents:       [{ eventType, eventTime: Date }] queue_events of this queue's tokens
 *   doctor:             { id, departmentId, branchId, avgConsultMinutes }  (ids 0 for LAB/PHARMACY)
 *   session:            { start: Date, end: Date } | null    today's session of the doctor
 *   bookedAppointments: [Date]  slot starts of BOOKED (not yet checked-in) appointments today
 *   departmentWaiting:  WAITING tokens in the department today (queue size for LAB/PHARMACY)
 *   departmentActiveDoctors: doctors on duty in the department (1 for LAB/PHARMACY)
 */
const { round, isoDow, MINUTE } = require('../utils/time');

const FEATURE_KEYS = Object.freeze([
  'patients_ahead',
  'priority_ahead',
  'doctor_avg_consult',
  'doctor_recent_consult',
  'interruptions_last_hour',
  'session_started',
  'minutes_to_start',
  'hour_of_day',
  'day_of_week',
  'appointments_ahead',
  'department_load',
  'doctor_id',
  'department_id',
  'branch_id',
]);

const OPEN_STATUSES = new Set(['CALLED', 'IN_SERVICE']);
const INTERRUPTION_EVENTS = new Set(['SKIPPED', 'RECALLED', 'PRIORITY_SET']);

/** Queue order (FR-13): priority level DESC, issue time ASC, then id ASC. */
function compareQueueOrder(a, b) {
  if (b.priorityLevel !== a.priorityLevel) return b.priorityLevel - a.priorityLevel;
  const ta = a.issuedAt.getTime();
  const tb = b.issuedAt.getTime();
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

/** WAITING tokens of a queue in service order. */
function orderedWaiting(queue) {
  return queue.filter((t) => t.status === 'WAITING').sort(compareQueueOrder);
}

/** Number of doctors on duty at `now` among today's sessions (falls back to all sessions today, min 1). */
function activeDoctorCount(sessions, now) {
  if (!sessions || !sessions.length) return 1;
  const onDuty = new Set();
  for (const s of sessions) {
    if (s.start <= now && now < s.end) onDuty.add(s.doctorId);
  }
  if (onDuty.size) return onDuty.size;
  return Math.max(1, new Set(sessions.map((s) => s.doctorId)).size);
}

/**
 * Build the Section 6.3 feature vector for `token` (which must be part of ctx.queue).
 * Returns an object with exactly FEATURE_KEYS.
 */
function computeFeatures(ctx, token, now) {
  const ahead = ctx.queue.filter(
    (q) => q.id !== token.id && q.status === 'WAITING' && compareQueueOrder(q, token) < 0
  );
  const openServing = ctx.queue.filter((q) => OPEN_STATUSES.has(q.status)).length;
  const patientsAhead = ahead.length + openServing;
  const priorityAhead = ahead.filter((q) => q.priorityLevel > 0).length;

  const avg = Number(ctx.doctor.avgConsultMinutes) || 10;
  const durations = ctx.queue
    .filter((q) => q.status === 'COMPLETED' && q.calledAt && q.completedAt && q.completedAt <= now)
    .map((q) => (q.completedAt - q.calledAt) / MINUTE)
    .filter((d) => d >= 0);
  const recent = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : avg;

  const hourAgo = now.getTime() - 60 * MINUTE;
  const nowMs = now.getTime();
  const eventInterruptions = (ctx.recentEvents || []).filter(
    (e) => INTERRUPTION_EVENTS.has(e.eventType) && e.eventTime.getTime() > hourAgo && e.eventTime.getTime() <= nowMs
  ).length;
  const priorityInsertions = ctx.queue.filter(
    (q) => q.id !== token.id && q.priorityLevel > 0 && q.issuedAt.getTime() > hourAgo && q.issuedAt.getTime() <= nowMs
  ).length;

  const sessionStarted = ctx.queue.some((q) => q.calledAt && q.calledAt.getTime() <= nowMs) ? 1 : 0;
  const minutesToStart =
    sessionStarted || !ctx.session ? 0 : Math.max(0, round((ctx.session.start - now) / MINUTE, 1));

  // Appointments due before this token's expected turn (baseline estimate of the turn).
  const expectedTurn = nowMs + (patientsAhead * avg + minutesToStart) * MINUTE;
  const appointmentsAhead = (ctx.bookedAppointments || []).filter(
    (slot) => slot.getTime() >= nowMs && slot.getTime() < expectedTurn
  ).length;

  const departmentLoad = (ctx.departmentWaiting || 0) / Math.max(1, ctx.departmentActiveDoctors || 1);

  return {
    patients_ahead: patientsAhead,
    priority_ahead: priorityAhead,
    doctor_avg_consult: round(avg, 2),
    doctor_recent_consult: round(recent, 2),
    interruptions_last_hour: eventInterruptions + priorityInsertions,
    session_started: sessionStarted,
    minutes_to_start: minutesToStart,
    hour_of_day: now.getHours(),
    day_of_week: isoDow(now),
    appointments_ahead: appointmentsAhead,
    department_load: round(departmentLoad, 2),
    doctor_id: ctx.doctor.id || 0,
    department_id: ctx.doctor.departmentId || 0,
    branch_id: ctx.doctor.branchId || 0,
  };
}

/** Baseline estimate, Eq. 6.2: W = (n_ahead + n_priority) * c_doctor + d_start. */
function baselineMinutes(f) {
  return (f.patients_ahead + f.priority_ahead) * f.doctor_avg_consult + f.minutes_to_start;
}

/**
 * Bound a prediction (Section 6.4.3): non-negative and capped at the end of the doctor's
 * session plus a 60-minute margin (only while the session end is still ahead).
 */
function boundMinutes(minutes, now, session) {
  let m = Number(minutes);
  if (!Number.isFinite(m) || m < 0) m = 0;
  if (session && session.end > now) {
    const cap = (session.end - now) / MINUTE + 60;
    m = Math.min(m, cap);
  }
  return round(m, 1);
}

/** Contract estimate range: low = max(0, round(m*0.8)), high = round(m*1.2), at least +-5 min. */
function estimateRange(minutes, modelVersion) {
  const m = Math.max(0, Math.round(minutes));
  let low = Math.max(0, Math.round(m * 0.8));
  let high = Math.round(m * 1.2);
  low = Math.min(low, Math.max(0, m - 5));
  high = Math.max(high, m + 5);
  return { minutes: m, low, high, modelVersion };
}

/** Congestion level from ratio (Eq. 6.5 thresholds). */
function classifyCongestion(ratio, thresholds) {
  if (ratio === null || ratio === undefined) return 'NORMAL';
  if (ratio >= thresholds.critical) return 'CRITICAL';
  if (ratio >= thresholds.high) return 'HIGH';
  return 'NORMAL';
}

/**
 * Live congestion ratio for a department (Eq. 6.5): waiting tokens / remaining capacity this
 * session, capacity = sum over doctors of remaining session minutes / avg consult minutes.
 * sessions: [{ doctorId, start, end, avgConsultMinutes }] for today.
 * In demo mode a finished session counts with its full length (clock time is ignored).
 */
function liveCongestion({ waiting, sessions, now, demoAlwaysOpen, thresholds }) {
  let capacity = 0;
  for (const s of sessions) {
    let remaining;
    if (now >= s.end) remaining = demoAlwaysOpen ? (s.end - s.start) / MINUTE : 0;
    else remaining = (s.end - (now > s.start ? now : s.start)) / MINUTE;
    capacity += remaining / (Number(s.avgConsultMinutes) || 10);
  }
  let ratio;
  if (capacity > 0) ratio = waiting / capacity;
  else ratio = waiting > 0 ? 99 : 0;
  ratio = round(ratio, 2);
  return { waiting, capacity: round(capacity, 1), ratio, level: classifyCongestion(ratio, thresholds) };
}

/** Great-circle distance in km (Eq. 6.4, R = 6371 km). */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function displayNumber(queueType, tokenNumber) {
  return `${queueType}-${String(tokenNumber).padStart(3, '0')}`;
}

module.exports = {
  FEATURE_KEYS,
  compareQueueOrder,
  orderedWaiting,
  activeDoctorCount,
  computeFeatures,
  baselineMinutes,
  boundMinutes,
  estimateRange,
  classifyCongestion,
  liveCongestion,
  haversineKm,
  displayNumber,
};
