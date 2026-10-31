'use strict';
/**
 * Prediction Service (FR-06, FR-07).
 *  - loads the live state of a queue and builds the Section 6.3 feature vector per token,
 *  - asks the AI service (/ai/predict-wait, 1.5 s timeout) and falls back to the
 *    Eq. 6.2 baseline when it is unavailable or has no active model. LAB/PHARMACY counters use the
 *    same feature vector (doctor_id = department_id = 0, counter-level averages), exactly like the
 *    rows the model is trained on,
 *  - bounds and stores every prediction in wait_predictions with features_json.
 */
const config = require('../config');
const time = require('../utils/time');
const { insertMany, placeholders, parseJson } = require('../db');
const fb = require('./featureBuilder');
const ai = require('./aiClient');
const scheduleService = require('./scheduleService');

const DEFAULT_SERVICE_MINUTES = { OPD: 10, LAB: 6, PHARMACY: 3 };
const ROLLING_WINDOW = 30;
const MIN_SAMPLES = 5;

/** Mean of (completed_at - called_at) in minutes for DB rows. */
function meanDuration(rows) {
  const durations = rows
    .map((r) => time.minutesBetween(time.parseDateTime(r.called_at), time.parseDateTime(r.completed_at)))
    .filter((d) => Number.isFinite(d) && d >= 0);
  if (durations.length < MIN_SAMPLES) return null;
  return time.round(durations.reduce((s, d) => s + d, 0) / durations.length, 2);
}

const spAverageCache = new Map();
/**
 * Average service minutes of a LAB/PHARMACY counter: rolling mean of its last 30 completed
 * tokens before the start of `dateStr` (the "nightly" value, cached per day).
 */
async function servicePointAverage(db, servicePointId, type, dateStr) {
  const key = `${servicePointId}|${dateStr}`;
  if (spAverageCache.has(key)) return spAverageCache.get(key);
  const rows = await db.query(
    `SELECT called_at, completed_at FROM tokens
      WHERE service_point_id = ? AND status = 'COMPLETED' AND called_at IS NOT NULL AND completed_at < ?
      ORDER BY completed_at DESC LIMIT ${ROLLING_WINDOW}`,
    [servicePointId, `${dateStr} 00:00:00`]
  );
  const value = meanDuration(rows) || DEFAULT_SERVICE_MINUTES[type] || 5;
  if (spAverageCache.size > 1000) spAverageCache.clear();
  spAverageCache.set(key, value);
  return value;
}

function clearCaches() {
  spAverageCache.clear();
}

function rowToQueueToken(r) {
  return {
    id: r.token_id,
    status: r.status,
    priorityLevel: Number(r.priority_level),
    issuedAt: time.parseDateTime(r.issued_at),
    calledAt: r.called_at ? time.parseDateTime(r.called_at) : null,
    completedAt: r.completed_at ? time.parseDateTime(r.completed_at) : null,
    patientId: r.patient_id,
    tokenNumber: r.token_number,
    queueType: r.queue_type,
  };
}

/**
 * Live context of one queue: service point + date (+ doctor for OPD).
 * @param {{servicePointId:number, date:string, doctorId:number|null}} key
 */
async function loadQueueContext(db, key, now) {
  const sp = await db.get(
    'SELECT service_point_id, branch_id, type, name FROM service_points WHERE service_point_id = ?',
    [key.servicePointId]
  );
  if (!sp) return null;
  const doctorFilter = key.doctorId ? 'AND t.doctor_id = ?' : 'AND t.doctor_id IS NULL';
  const params = key.doctorId ? [key.servicePointId, key.date, key.doctorId] : [key.servicePointId, key.date];
  const rows = await db.query(
    `SELECT t.token_id, t.status, t.priority_level, t.issued_at, t.called_at, t.completed_at,
            t.token_number, t.queue_type, v.patient_id
       FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
      WHERE t.service_point_id = ? AND t.token_date = ? ${doctorFilter}`,
    params
  );
  const queue = rows.map(rowToQueueToken);
  const hourAgo = time.formatDateTime(new Date(now.getTime() - time.HOUR));
  const events = await db.query(
    `SELECT e.event_type, e.event_time FROM queue_events e JOIN tokens t ON t.token_id = e.token_id
      WHERE t.service_point_id = ? AND t.token_date = ? ${doctorFilter} AND e.event_time > ?`,
    [...params, hourAgo]
  );
  const recentEvents = events.map((e) => ({ eventType: e.event_type, eventTime: time.parseDateTime(e.event_time) }));

  const ctx = {
    key,
    servicePoint: { id: sp.service_point_id, branchId: sp.branch_id, type: sp.type, name: sp.name },
    queueType: sp.type,
    queue,
    recentEvents,
    session: null,
    bookedAppointments: [],
    departmentWaiting: 0,
    departmentActiveDoctors: 1,
    doctor: null,
  };

  const doctor = key.doctorId ? await scheduleService.getDoctor(db, key.doctorId) : null;
  if (doctor) {
    ctx.doctor = {
      id: doctor.doctor_id,
      departmentId: doctor.department_id,
      branchId: doctor.branch_id,
      avgConsultMinutes: Number(doctor.avg_consult_minutes),
    };
    const sessions = await scheduleService.doctorSessions(db, doctor.doctor_id, key.date);
    ctx.session = scheduleService.pickSession(sessions, key.date, now);
    const appts = await db.query(
      `SELECT slot_start FROM appointments
        WHERE doctor_id = ? AND status = 'BOOKED' AND slot_start >= ? AND slot_start < ?`,
      [doctor.doctor_id, `${key.date} 00:00:00`, `${time.addDaysStr(key.date, 1)} 00:00:00`]
    );
    ctx.bookedAppointments = appts.map((a) => time.parseDateTime(a.slot_start));
    const dw = await db.get(
      `SELECT COUNT(*) AS n FROM tokens t JOIN doctors d ON d.doctor_id = t.doctor_id
        WHERE d.department_id = ? AND t.token_date = ? AND t.status = 'WAITING' AND t.queue_type = 'OPD'`,
      [doctor.department_id, key.date]
    );
    ctx.departmentWaiting = Number(dw.n) || 0;
    const deptSessions = await scheduleService.departmentSessions(db, doctor.department_id, key.date);
    ctx.departmentActiveDoctors = fb.activeDoctorCount(deptSessions, now);
  } else {
    // LAB / PHARMACY counter (or an OPD point without doctor): counter-level statistics.
    ctx.doctor = {
      id: 0,
      departmentId: 0,
      branchId: sp.branch_id,
      avgConsultMinutes: await servicePointAverage(db, sp.service_point_id, sp.type, key.date),
    };
    ctx.departmentWaiting = queue.filter((q) => q.status === 'WAITING').length;
    ctx.departmentActiveDoctors = 1;
  }
  return ctx;
}

/** Latest stored prediction per token: Map tokenId -> row. */
async function latestPredictions(db, tokenIds) {
  const map = new Map();
  if (!tokenIds.length) return map;
  const rows = await db.query(
    `SELECT token_id, predicted_minutes, model_version, features_json, created_at FROM wait_predictions
      WHERE prediction_id IN (SELECT MAX(prediction_id) FROM wait_predictions
                               WHERE token_id IN (${placeholders(tokenIds.length)}) GROUP BY token_id)`,
    tokenIds
  );
  for (const r of rows) map.set(r.token_id, r);
  return map;
}

/** Remaining minutes of a stored prediction at `now` (predicted minus time elapsed since it was made). */
function remainingMinutes(predRow, now) {
  if (!predRow) return null;
  const elapsed = time.minutesBetween(time.parseDateTime(predRow.created_at), now);
  return Math.max(0, Number(predRow.predicted_minutes) - Math.max(0, elapsed));
}

/** Contract estimate object for a stored prediction. */
function estimateFromPrediction(predRow, now) {
  if (!predRow) return null;
  return fb.estimateRange(remainingMinutes(predRow, now), predRow.model_version);
}

/**
 * Re-predict all WAITING tokens of a queue (FR-07) and store the predictions.
 * Returns [{ tokenId, patientId, position, minutes, modelVersion, features, previousRemaining,
 *            previousPatientsAhead, changed }] in queue order.
 */
async function repredictQueue(db, key, now = time.clock.now()) {
  const ctx = await loadQueueContext(db, key, now);
  if (!ctx) return { ctx: null, results: [] };
  const waiting = fb.orderedWaiting(ctx.queue);
  if (!waiting.length) return { ctx, results: [] };

  const features = waiting.map((t) => fb.computeFeatures(ctx, t, now));
  const aiResult = await ai.predictWait(waiting.map((t, i) => ({ tokenId: t.id, features: features[i] })));
  const previous = await latestPredictions(
    db,
    waiting.map((t) => t.id)
  );

  const createdAt = time.formatDateTime(now);
  const rows = [];
  const results = waiting.map((t, i) => {
    const f = features[i];
    const useAi = aiResult && aiResult.byTokenId.has(t.id);
    const raw = useAi ? aiResult.byTokenId.get(t.id) : fb.baselineMinutes(f);
    const modelVersion = useAi ? aiResult.modelVersion : 'baseline';
    const minutes = fb.boundMinutes(raw, now, ctx.session);
    rows.push([t.id, minutes, modelVersion, JSON.stringify(f), createdAt]);

    const prev = previous.get(t.id);
    const prevRemaining = prev ? remainingMinutes(prev, now) : null;
    const prevFeatures = prev ? parseJson(prev.features_json, {}) : null;
    const prevAhead = prevFeatures ? prevFeatures.patients_ahead : null;
    const changed =
      !prev || prevAhead !== f.patients_ahead || Math.round(prevRemaining) !== Math.round(minutes);
    return {
      tokenId: t.id,
      patientId: t.patientId,
      tokenNumber: t.tokenNumber,
      position: i + 1,
      minutes,
      modelVersion,
      features: f,
      previousRemaining: prevRemaining,
      previousPatientsAhead: prevAhead,
      changed,
    };
  });
  await insertMany(
    db,
    'wait_predictions',
    ['token_id', 'predicted_minutes', 'model_version', 'features_json', 'created_at'],
    rows
  );
  return { ctx, results };
}

/**
 * Predicted wait for a hypothetical new token joining a doctor's queue now (used by browse
 * and recommendations). Returns Map doctorId -> { minutes, modelVersion, features }.
 */
async function predictHypothetical(db, doctors, { priorityLevel = 0, now = time.clock.now() } = {}) {
  const date = time.formatDate(now);
  const prepared = [];
  for (const d of doctors) {
    if (!d.session) continue;
    const key = { servicePointId: d.session.servicePointId, date, doctorId: d.doctor_id };
    const ctx = await loadQueueContext(db, key, now);
    if (!ctx) continue;
    const hypothetical = {
      id: Number.MAX_SAFE_INTEGER,
      status: 'WAITING',
      priorityLevel,
      issuedAt: now,
      calledAt: null,
      completedAt: null,
    };
    ctx.queue = [...ctx.queue, hypothetical];
    ctx.departmentWaiting += 1;
    const features = fb.computeFeatures(ctx, hypothetical, now);
    prepared.push({ doctorId: d.doctor_id, features, session: ctx.session });
  }
  const aiResult = await ai.predictWait(prepared.map((p) => ({ tokenId: -p.doctorId, features: p.features })));
  const out = new Map();
  for (const p of prepared) {
    const useAi = aiResult && aiResult.byTokenId.has(-p.doctorId);
    const raw = useAi ? aiResult.byTokenId.get(-p.doctorId) : fb.baselineMinutes(p.features);
    out.set(p.doctorId, {
      minutes: fb.boundMinutes(raw, now, p.session),
      modelVersion: useAi ? aiResult.modelVersion : 'baseline',
      features: p.features,
    });
  }
  return out;
}

/** Nightly job: doctors' avg_consult_minutes = rolling mean of their last 30 completed consults. */
async function refreshDoctorAverages(db) {
  const doctors = await db.query('SELECT doctor_id, avg_consult_minutes FROM doctors WHERE is_active = 1', []);
  let updated = 0;
  for (const d of doctors) {
    const rows = await db.query(
      `SELECT called_at, completed_at FROM tokens
        WHERE doctor_id = ? AND queue_type = 'OPD' AND status = 'COMPLETED' AND called_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT ${ROLLING_WINDOW}`,
      [d.doctor_id]
    );
    const avg = meanDuration(rows);
    if (avg !== null && avg > 0 && Math.abs(avg - Number(d.avg_consult_minutes)) >= 0.01) {
      await db.run('UPDATE doctors SET avg_consult_minutes = ? WHERE doctor_id = ?', [Math.min(avg, 999), d.doctor_id]);
      updated += 1;
    }
  }
  clearCaches();
  return updated;
}

module.exports = {
  DEFAULT_SERVICE_MINUTES,
  ROLLING_WINDOW,
  MIN_SAMPLES,
  loadQueueContext,
  latestPredictions,
  remainingMinutes,
  estimateFromPrediction,
  repredictQueue,
  predictHypothetical,
  servicePointAverage,
  refreshDoctorAverages,
  clearCaches,
  meanDuration,
  config,
};
