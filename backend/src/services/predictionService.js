'use strict';
/**
 * Prediction Service (FR-06, FR-07).
 *  - loads the live state of a queue and builds the Section 6.3 feature vector per token,
 *  - asks the AI service (/ai/predict-wait, 1.5 s timeout) and falls back to the
 *    Eq. 6.2 baseline when it is unavailable or has no active model. LAB/PHARMACY counters use the
 *    same feature vector (doctor_id = department_id = 0, counter-level averages), exactly like the
 *    rows the model is trained on,
 *  - bounds and stores every prediction in wait_predictions with its `features` object.
 */
const config = require('../config');
const time = require('../utils/time');
const { models, sess, byIds, insertManyWithIds } = require('../db');
const fb = require('./featureBuilder');
const ai = require('./aiClient');
const scheduleService = require('./scheduleService');

const { Token, Visit, QueueEvent, ServicePoint, Appointment, Doctor, WaitPrediction } = models;

const DEFAULT_SERVICE_MINUTES = { OPD: 10, LAB: 6, PHARMACY: 3 };
const ROLLING_WINDOW = 30;
const MIN_SAMPLES = 5;

/** Mean of (completed_at - called_at) in minutes for token documents. */
function meanDuration(rows) {
  const durations = rows
    .map((r) => time.minutesBetween(time.parseDateTime(r.called_at), time.parseDateTime(r.completed_at)))
    .filter((d) => Number.isFinite(d) && d >= 0);
  if (durations.length < MIN_SAMPLES) return null;
  return time.meanMinutes(durations);
}

const spAverageCache = new Map();
/**
 * Average service minutes of a LAB/PHARMACY counter: rolling mean of its last 30 completed
 * tokens before the start of `dateStr` (the "nightly" value, cached per day).
 */
async function servicePointAverage(db, servicePointId, type, dateStr) {
  const key = `${servicePointId}|${dateStr}`;
  if (spAverageCache.has(key)) return spAverageCache.get(key);
  const rows = await Token.find(
    {
      service_point_id: servicePointId,
      status: 'COMPLETED',
      called_at: { $ne: null },
      completed_at: { $lt: time.dayStart(dateStr) },
    },
    { called_at: 1, completed_at: 1 }
  )
    .sort({ completed_at: -1 })
    .limit(ROLLING_WINDOW)
    .session(sess(db))
    .lean();
  const value = meanDuration(rows) || DEFAULT_SERVICE_MINUTES[type] || 5;
  if (spAverageCache.size > 1000) spAverageCache.clear();
  spAverageCache.set(key, value);
  return value;
}

function clearCaches() {
  spAverageCache.clear();
}

function rowToQueueToken(r, patientId) {
  return {
    id: r._id,
    status: r.status,
    priorityLevel: Number(r.priority_level),
    issuedAt: time.parseDateTime(r.issued_at),
    calledAt: r.called_at ? time.parseDateTime(r.called_at) : null,
    completedAt: r.completed_at ? time.parseDateTime(r.completed_at) : null,
    patientId,
    tokenNumber: r.token_number,
    queueType: r.queue_type,
  };
}

/** Token filter of one queue: service point + day, doctor (or no doctor for LAB/PHARMACY). */
function queueFilter(key) {
  return { service_point_id: key.servicePointId, token_date: key.date, doctor_id: key.doctorId ? key.doctorId : null };
}

/** OPD WAITING tokens in a department on a date. */
async function departmentWaitingCount(db, departmentId, dateStr) {
  const doctorIds = await Doctor.distinct('_id', { department_id: departmentId }).session(sess(db));
  if (!doctorIds.length) return 0;
  return Token.countDocuments({ doctor_id: { $in: doctorIds }, token_date: dateStr, status: 'WAITING', queue_type: 'OPD' })
    .session(sess(db));
}

/** BOOKED appointment slot starts (Date) of a doctor on a date. */
async function bookedSlots(db, doctorId, dateStr) {
  const appts = await Appointment.find(
    { doctor_id: doctorId, status: 'BOOKED', slot_start: time.dayRange(dateStr) },
    { slot_start: 1 }
  )
    .session(sess(db))
    .lean();
  return appts.map((a) => time.parseDateTime(a.slot_start));
}

/**
 * Live context of one queue: service point + date (+ doctor for OPD).
 * @param {{servicePointId:number, date:string, doctorId:number|null}} key
 */
async function loadQueueContext(db, key, now) {
  const sp = await ServicePoint.findById(key.servicePointId, { branch_id: 1, type: 1, name: 1 }).session(sess(db)).lean();
  if (!sp) return null;
  const tokens = await Token.find(queueFilter(key)).session(sess(db)).lean();
  const visits = await byIds(db, Visit, tokens.map((t) => t.visit_id), { patient_id: 1 });
  const present = tokens.filter((t) => visits.has(t.visit_id));
  const queue = present.map((t) => rowToQueueToken(t, visits.get(t.visit_id).patient_id));
  const hourAgo = new Date(now.getTime() - time.HOUR);
  const events = present.length
    ? await QueueEvent.find(
        { token_id: { $in: present.map((t) => t._id) }, event_time: { $gt: hourAgo } },
        { event_type: 1, event_time: 1 }
      )
        .session(sess(db))
        .lean()
    : [];
  const recentEvents = events.map((e) => ({ eventType: e.event_type, eventTime: time.parseDateTime(e.event_time) }));

  const ctx = {
    key,
    servicePoint: { id: sp._id, branchId: sp.branch_id, type: sp.type, name: sp.name },
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
    ctx.bookedAppointments = await bookedSlots(db, doctor.doctor_id, key.date);
    ctx.departmentWaiting = await departmentWaitingCount(db, doctor.department_id, key.date);
    const deptSessions = await scheduleService.departmentSessions(db, doctor.department_id, key.date);
    ctx.departmentActiveDoctors = fb.activeDoctorCount(deptSessions, now);
  } else {
    // LAB / PHARMACY counter (or an OPD point without doctor): counter-level statistics.
    ctx.doctor = {
      id: 0,
      departmentId: 0,
      branchId: sp.branch_id,
      avgConsultMinutes: await servicePointAverage(db, sp._id, sp.type, key.date),
    };
    ctx.departmentWaiting = queue.filter((q) => q.status === 'WAITING').length;
    ctx.departmentActiveDoctors = 1;
  }
  return ctx;
}

/**
 * Latest stored prediction per token: Map tokenId -> { token_id, predicted_minutes, model_version,
 * features, created_at } (highest prediction _id per token, like MAX(prediction_id)).
 */
async function latestPredictions(db, tokenIds) {
  const map = new Map();
  if (!tokenIds.length) return map;
  const rows = await WaitPrediction.aggregate([
    { $match: { token_id: { $in: tokenIds } } },
    { $sort: { _id: -1 } },
    { $group: { _id: '$token_id', doc: { $first: '$$ROOT' } } },
  ]).session(sess(db));
  for (const r of rows) map.set(r._id, { ...r.doc, prediction_id: r.doc._id });
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

  const createdAt = time.dbDate(now);
  const docs = [];
  const results = waiting.map((t, i) => {
    const f = features[i];
    const useAi = aiResult && aiResult.byTokenId.has(t.id);
    const raw = useAi ? aiResult.byTokenId.get(t.id) : fb.baselineMinutes(f);
    const modelVersion = useAi ? aiResult.modelVersion : 'baseline';
    const minutes = fb.boundMinutes(raw, now, ctx.session);
    docs.push({ token_id: t.id, predicted_minutes: minutes, model_version: modelVersion, features: f, created_at: createdAt });

    const prev = previous.get(t.id);
    const prevRemaining = prev ? remainingMinutes(prev, now) : null;
    const prevFeatures = prev ? prev.features || {} : null;
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
  await insertManyWithIds(db, WaitPrediction, docs);
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
  const doctors = await Doctor.find({ is_active: true }, { avg_consult_minutes: 1 }).session(sess(db)).lean();
  let updated = 0;
  for (const d of doctors) {
    const rows = await Token.find(
      { doctor_id: d._id, queue_type: 'OPD', status: 'COMPLETED', called_at: { $ne: null } },
      { called_at: 1, completed_at: 1 }
    )
      .sort({ completed_at: -1, _id: -1 })
      .limit(ROLLING_WINDOW)
      .session(sess(db))
      .lean();
    const avg = meanDuration(rows);
    if (avg !== null && avg > 0 && Math.abs(avg - Number(d.avg_consult_minutes)) >= 0.01) {
      await Doctor.updateOne({ _id: d._id }, { $set: { avg_consult_minutes: Math.min(avg, 999) } }, { session: sess(db) });
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
  departmentWaitingCount,
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
