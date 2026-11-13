'use strict';
/**
 * Queue & Token Service (FR-03, FR-04, FR-05, FR-07, FR-12, FR-13, FR-21).
 *
 * - Token numbering per service point per day, queue order = priority DESC, issued_at ASC.
 * - Every status change writes a queue_events document in the same MongoDB transaction (FR-21).
 * - After each change the affected queue is re-predicted (FR-07), patients are notified
 *   (FR-11) and socket events are emitted (FR-05).
 *
 * Concurrency (replaces the SQL "SELECT ... FOR UPDATE" locks, see db/counters.js):
 *   - every transaction that numbers tokens or changes a queue first writes the service point
 *     lock document(s) (lockServicePoints, ascending id) and numbers tokens with the per-queue-day
 *     counter, so two such transactions on one service point cannot both commit from the same
 *     snapshot: session.withTransaction() retries the loser, which then sees the winner's data;
 *   - status changes are conditional (updateOne({ _id, status: <expected> })); 0 matches -> 409;
 *   - unique / partial unique indexes back every rule (token numbers, one OPEN visit per patient
 *     and day, one token per appointment).
 *
 * A queue is identified by { servicePointId, date, doctorId } (doctorId null for LAB/PHARMACY).
 */
const config = require('../config');
const time = require('../utils/time');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { models, sess, byIds, insertOne, nextTokenNumber: counterNextTokenNumber, lockServicePoints: counterLock } = require('../db');
const fb = require('./featureBuilder');
const access = require('./accessService');
const scheduleService = require('./scheduleService');
const userService = require('./userService');
const predictionService = require('./predictionService');
const notificationService = require('./notificationService');
const settingsService = require('./settingsService');
const realtime = require('./realtime');

const { Token, Visit, Branch, ServicePoint, User, QueueEvent, Appointment, Department, DoctorSchedule } = models;

const ACTIVE_STATUSES = ['WAITING', 'CALLED', 'IN_SERVICE'];
const OPEN_STATUSES = ['CALLED', 'IN_SERVICE'];
const RECENTLY_COMPLETED_LIMIT = 5;
const LEVEL_RANK = { NORMAL: 0, HIGH: 1, CRITICAL: 2 };
const lastDepartmentLevel = new Map(); // departmentId -> last live congestion level (for alert escalation)
// tokenId -> last published queue position, so token:updated is sent whenever a position changes
// even when the estimate stays the same (contract: position/estimate changed).
const lastPosition = new Map();
const LAST_POSITION_LIMIT = 50000;
const QUEUE_ORDER = { priority_level: -1, issued_at: 1, _id: 1 };

/** Milliseconds of a stored datetime (null -> 0) for in-memory sorting. */
const ms = (d) => (d ? new Date(d).getTime() : 0);

/**
 * Pre-set priority of a new token (FR-13): 1 for ELDERLY / DIFFERENTLY_ABLED, and for a patient who
 * has reached userService.ELDERLY_MIN_AGE by dateStr even if the stored category predates that.
 */
function priorityFromCategory(category, dateOfBirth = null, dateStr = time.today()) {
  if (category === 'ELDERLY' || category === 'DIFFERENTLY_ABLED') return 1;
  return userService.isElderly(dateOfBirth, dateStr) ? 1 : 0;
}

/**
 * True while a token's priority 1 rests only on the patient's self-declared DIFFERENTLY_ABLED
 * category (not on age) and no staff member has confirmed/overridden priority in this visit.
 */
function isPriorityDeclared(row) {
  return (
    Number(row.priority_level) === 1 &&
    row.priority_category === 'DIFFERENTLY_ABLED' &&
    !userService.isElderly(row.patient_dob, time.toApiDate(row.token_date)) &&
    !Number(row.priority_confirmed)
  );
}

function queueKeyOf(row) {
  return {
    servicePointId: row.service_point_id,
    date: time.toApiDate(row.token_date),
    doctorId: row.doctor_id || null,
  };
}

function queueFilter(key) {
  return { service_point_id: key.servicePointId, token_date: key.date, doctor_id: key.doctorId ? key.doctorId : null };
}

/**
 * Token rows joined with visit, branch, service point, patient, doctor and department data (the
 * row shape of the former SQL join), in the order of `tokens`. Tokens whose visit, branch,
 * service point or patient is missing are dropped (inner-join semantics).
 */
async function tokenRows(db, tokens) {
  if (!tokens.length) return [];
  const visits = await byIds(db, Visit, tokens.map((t) => t.visit_id));
  const branches = await byIds(db, Branch, [...visits.values()].map((v) => v.branch_id), { name: 1 });
  const sps = await byIds(db, ServicePoint, tokens.map((t) => t.service_point_id), { name: 1, type: 1 });
  const patients = await byIds(db, User, [...visits.values()].map((v) => v.patient_id), {
    full_name: 1,
    priority_category: 1,
    date_of_birth: 1,
  });
  const doctors = await scheduleService.getDoctors(db, tokens.map((t) => t.doctor_id).filter(Boolean));
  // A PRIORITY_SET event on any token of the visit confirms (or overrides) the declared priority.
  const visitIds = [...visits.keys()];
  const visitTokens = await Token.find({ visit_id: { $in: visitIds } }, { visit_id: 1 }).session(sess(db)).lean();
  const visitOfToken = new Map(visitTokens.map((t) => [t._id, t.visit_id]));
  const confirmedTokenIds = visitTokens.length
    ? await QueueEvent.distinct('token_id', { token_id: { $in: visitTokens.map((t) => t._id) }, event_type: 'PRIORITY_SET' })
        .session(sess(db))
    : [];
  const confirmedVisits = new Set(confirmedTokenIds.map((id) => visitOfToken.get(id)));

  const out = [];
  for (const t of tokens) {
    const v = visits.get(t.visit_id);
    const b = v ? branches.get(v.branch_id) : null;
    const sp = sps.get(t.service_point_id);
    const pu = v ? patients.get(v.patient_id) : null;
    if (!v || !b || !sp || !pu) continue;
    const d = t.doctor_id ? doctors.get(t.doctor_id) : null;
    out.push({
      ...t,
      token_id: t._id,
      patient_id: v.patient_id,
      branch_id: v.branch_id,
      visit_status: v.status,
      branch_name: b.name,
      sp_name: sp.name,
      sp_type: sp.type,
      doctor_name: d ? d.full_name : null,
      specialty: d ? d.specialty : null,
      department_id: d ? d.department_id : null,
      department_name: d ? d.department_name : null,
      patient_name: pu.full_name,
      priority_category: pu.priority_category,
      patient_dob: pu.date_of_birth,
      priority_confirmed: confirmedVisits.has(v._id) ? 1 : 0,
    });
  }
  return out;
}

/** Token row with visit, branch, service point, doctor and department data. */
async function loadTokenRow(db, tokenId) {
  const t = await Token.findById(tokenId).session(sess(db)).lean();
  if (!t) return undefined;
  return (await tokenRows(db, [t]))[0];
}

async function requireTokenRow(db, tokenId) {
  const row = await loadTokenRow(db, tokenId);
  if (!row) throw notFound('Token not found');
  return row;
}

/** Ordered WAITING token ids of a queue. */
async function waitingIds(db, key) {
  const rows = await Token.find({ ...queueFilter(key), status: 'WAITING' }, { _id: 1 })
    .sort(QUEUE_ORDER)
    .session(sess(db))
    .lean();
  return rows.map((r) => r._id);
}

async function nowServingOf(db, key) {
  const row = await Token.findOne({ ...queueFilter(key), status: { $in: OPEN_STATUSES } }, { token_number: 1, queue_type: 1 })
    .sort({ called_at: -1, _id: -1 })
    .session(sess(db))
    .lean();
  return row ? { tokenId: row._id, displayNumber: fb.displayNumber(row.queue_type, row.token_number) } : null;
}

/** Live department congestion (Eq. 6.5) for today. */
async function departmentCongestion(db, departmentId, now = time.clock.now()) {
  const date = time.formatDate(now);
  const settings = await settingsService.getSettings(db);
  const waiting = await predictionService.departmentWaitingCount(db, departmentId, date);
  const sessions = await scheduleService.departmentSessions(db, departmentId, date);
  return fb.liveCongestion({
    waiting,
    sessions,
    now,
    demoAlwaysOpen: config.demoAlwaysOpen,
    thresholds: settings.congestionThresholds,
  });
}

/**
 * TokenDetail (patient-facing shape from the contract).
 */
async function buildTokenDetail(db, row, { includeLinked = true, now = time.clock.now() } = {}) {
  const key = queueKeyOf(row);
  let position = null;
  let patientsAhead = null;
  let estimate = null;
  if (row.status === 'WAITING') {
    const ids = await waitingIds(db, key);
    const idx = ids.indexOf(row.token_id);
    position = idx >= 0 ? idx + 1 : null;
    patientsAhead = idx >= 0 ? idx : null;
    const preds = await predictionService.latestPredictions(db, [row.token_id]);
    estimate = predictionService.estimateFromPrediction(preds.get(row.token_id), now);
  }
  const nowServing = await nowServingOf(db, key);

  let congestion = { level: 'NORMAL', suggestAlternatives: false };
  if (row.queue_type === 'OPD' && row.department_id) {
    const settings = await settingsService.getSettings(db);
    const c = await departmentCongestion(db, row.department_id, now);
    const longWait = Boolean(estimate && estimate.minutes >= settings.alternativeSuggestionWaitMinutes);
    congestion = {
      level: c.level,
      suggestAlternatives: row.status === 'WAITING' && (longWait || c.level !== 'NORMAL'),
    };
  }

  const detail = {
    id: row.token_id,
    visitId: row.visit_id,
    tokenNumber: row.token_number,
    displayNumber: fb.displayNumber(row.queue_type, row.token_number),
    queueType: row.queue_type,
    status: row.status,
    priorityLevel: Number(row.priority_level),
    issuedAt: time.toApi(row.issued_at),
    calledAt: time.toApi(row.called_at),
    completedAt: time.toApi(row.completed_at),
    branch: { id: row.branch_id, name: row.branch_name },
    servicePoint: { id: row.service_point_id, name: row.sp_name, type: row.sp_type },
    doctor: row.doctor_id ? { id: row.doctor_id, fullName: row.doctor_name, specialty: row.specialty } : null,
    position,
    patientsAhead,
    nowServing,
    estimate,
    congestion,
    appointmentId: row.appointment_id || null,
  };

  if (includeLinked) {
    const others = await Token.find({ visit_id: row.visit_id, _id: { $ne: row.token_id } }).sort({ _id: 1 }).session(sess(db)).lean();
    detail.linkedTokens = [];
    for (const r of await tokenRows(db, others)) {
      detail.linkedTokens.push(await buildTokenDetail(db, r, { includeLinked: false, now }));
    }
  }
  return detail;
}

async function getTokenDetail(db, tokenId, opts) {
  const row = await requireTokenRow(db, tokenId);
  return buildTokenDetail(db, row, opts);
}

/** QueueToken (staff-facing shape). */
function toQueueToken(row, estimateMinutes = null) {
  return {
    id: row.token_id,
    tokenNumber: row.token_number,
    displayNumber: fb.displayNumber(row.queue_type, row.token_number),
    status: row.status,
    priorityLevel: Number(row.priority_level),
    priorityCategory: row.priority_category || 'NONE',
    priorityDeclared: isPriorityDeclared(row),
    patientName: row.patient_name,
    issuedAt: time.toApi(row.issued_at),
    calledAt: time.toApi(row.called_at),
    visitId: row.visit_id,
    doctorId: row.doctor_id || null,
    estimateMinutes,
    fromAppointment: Boolean(row.appointment_id),
  };
}

async function getQueueToken(db, tokenId, now = time.clock.now()) {
  const row = await requireTokenRow(db, tokenId);
  let estimateMinutes = null;
  if (row.status === 'WAITING') {
    const preds = await predictionService.latestPredictions(db, [row.token_id]);
    const est = predictionService.estimateFromPrediction(preds.get(row.token_id), now);
    estimateMinutes = est ? est.minutes : null;
  }
  return toQueueToken(row, estimateMinutes);
}

async function insertEvent(tx, { tokenId, type, by = null, from = null, to = null, note = null, at }) {
  await insertOne(tx, QueueEvent, {
    token_id: tokenId,
    event_type: type,
    performed_by: by,
    from_point_id: from,
    to_point_id: to,
    note: note ? String(note).slice(0, 255) : null,
    event_time: at,
  });
}

/**
 * Lock service points (ascending id) as the FIRST operation of a transaction that numbers tokens
 * or changes a queue (see db/counters.js lockServicePoints).
 */
async function lockServicePoints(tx, ids) {
  await counterLock(ids, sess(tx));
}

/** Next token number at a service point (inside the transaction). */
async function nextTokenNumber(tx, servicePointId, date) {
  return counterNextTokenNumber(servicePointId, date, sess(tx));
}

/**
 * Today's OPEN visit of the patient at the branch, or a new one. The partial unique index
 * uq_open_visit backs the "one OPEN visit" rule: a concurrent insert makes this transaction
 * retry (withTransaction), and the retry reuses the visit the other request created.
 */
async function getOrCreateVisit(tx, patientId, branchId, date) {
  const existing = await Visit.findOne({ patient_id: patientId, branch_id: branchId, visit_date: date, status: 'OPEN' }, { _id: 1 })
    .sort({ _id: -1 })
    .session(sess(tx))
    .lean();
  if (existing) return existing._id;
  return insertOne(tx, Visit, { patient_id: patientId, branch_id: branchId, visit_date: date, status: 'OPEN' });
}

async function insertToken(tx, t) {
  return insertOne(tx, Token, {
    visit_id: t.visitId,
    service_point_id: t.servicePointId,
    doctor_id: t.doctorId || null,
    appointment_id: t.appointmentId || null,
    token_number: t.tokenNumber,
    token_date: t.date,
    queue_type: t.queueType,
    priority_level: t.priorityLevel,
    status: 'WAITING',
    issued_at: t.issuedAt,
    called_at: null,
    completed_at: null,
    is_synthetic: false,
  });
}

/**
 * After a queue change: re-predict (FR-07), notify (FR-11), emit socket events (FR-05) and
 * raise live congestion alerts (FR-17). Failures here never fail the originating request.
 */
async function propagate(db, keys, { now = time.clock.now(), skipApproaching = [] } = {}) {
  const seen = new Set();
  for (const key of keys) {
    const id = `${key.servicePointId}|${key.date}|${key.doctorId || 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const settings = await settingsService.getSettings(db);
      const { ctx, results } = await predictionService.repredictQueue(db, key, now);
      if (!ctx) continue;
      const spName = ctx.servicePoint.name;
      for (const r of results) {
        const moved = lastPosition.get(r.tokenId) !== r.position;
        if (lastPosition.size > LAST_POSITION_LIMIT) lastPosition.clear();
        lastPosition.set(r.tokenId, r.position);
        if (r.changed || moved) realtime.emitTokenUpdated(r.tokenId, 'WAITING', r.patientId);
        const display = fb.displayNumber(ctx.queueType, r.tokenNumber);
        // FR-11: turn approaching (once per token) for patients within N positions.
        if (
          settings.notifyPositionsAhead > 0 &&
          r.position <= settings.notifyPositionsAhead &&
          !skipApproaching.includes(r.tokenId) &&
          !(await notificationService.alreadySent(db, r.tokenId, 'Your turn is approaching'))
        ) {
          await notificationService.notify(db, r.patientId, {
            tokenId: r.tokenId,
            message: `Your turn is approaching: ${display} is number ${r.position} in the queue at ${spName}. Please be ready.`,
          });
        }
        // FR-11: big estimate change.
        if (r.previousRemaining !== null && !skipApproaching.includes(r.tokenId)) {
          const diff = Math.abs(r.minutes - r.previousRemaining);
          if (diff >= Math.max(10, 0.25 * r.previousRemaining)) {
            await notificationService.notify(db, r.patientId, {
              tokenId: r.tokenId,
              message: `Updated estimate for ${display}: ${time.waitText(r.minutes)} (previously ${time.waitText(r.previousRemaining)}).`,
            });
          }
        }
      }
      realtime.emitQueueUpdated(ctx.servicePoint.id, ctx.servicePoint.branchId);

      if (ctx.queueType === 'OPD' && ctx.doctor && ctx.doctor.departmentId) {
        await checkCongestionAlert(db, ctx.doctor.departmentId, now);
      }
    } catch (err) {
      console.error(`[queue] post-change processing failed for ${id}: ${err.stack || err.message}`);
    }
  }
}

async function checkCongestionAlert(db, departmentId, now) {
  const c = await departmentCongestion(db, departmentId, now);
  const previous = lastDepartmentLevel.get(departmentId) || 'NORMAL';
  lastDepartmentLevel.set(departmentId, c.level);
  if (LEVEL_RANK[c.level] > LEVEL_RANK[previous] && c.level !== 'NORMAL') {
    const dp = await Department.findById(departmentId).session(sess(db)).lean();
    const b = dp ? await Branch.findById(dp.branch_id, { name: 1 }).session(sess(db)).lean() : null;
    if (dp && b) {
      const name = dp.name || dp.specialty;
      realtime.emitAlert({
        id: `live-${departmentId}`,
        level: c.level,
        source: 'LIVE',
        branchId: b._id,
        branchName: b.name,
        departmentId,
        departmentName: name,
        message: `${name} at ${b.name} is ${c.level}: ${c.waiting} waiting for a remaining capacity of about ${c.capacity} patients (ratio ${c.ratio}).`,
        at: time.toApi(now),
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Patient operations
// ---------------------------------------------------------------------------------------------

/** Active (WAITING/CALLED/IN_SERVICE) token of the patient for a doctor on a date? */
async function hasActiveTokenForDoctor(tx, patientId, doctorId, date) {
  const tokens = await Token.find({ doctor_id: doctorId, token_date: date, status: { $in: ACTIVE_STATUSES } }, { visit_id: 1 })
    .session(sess(tx))
    .lean();
  if (!tokens.length) return false;
  return Boolean(await Visit.exists({ _id: { $in: tokens.map((t) => t.visit_id) }, patient_id: patientId }).session(sess(tx)));
}

/**
 * Issue an OPD token for a patient (FR-03) — also used by appointment check-in (FR-10), which
 * passes the session containing the appointment slot (`slotSession`) so the token goes to that
 * session's service point. Returns the new token id.
 */
async function issueOpdToken(db, patient, doctorId, { appointmentId = null, session: slotSession = null, now = time.clock.now() } = {}) {
  const doctor = await scheduleService.getDoctor(db, doctorId);
  if (!doctor || !scheduleService.isDoctorBookable(doctor)) throw notFound('Doctor not found or not active');
  const date = slotSession ? time.formatDate(slotSession.start) : time.formatDate(now);
  const sessions = await scheduleService.doctorSessions(db, doctorId, date);
  const session = slotSession || scheduleService.pickSession(sessions, date, now);
  if (!session) throw conflict('The doctor is not scheduled today');
  if (!config.demoAlwaysOpen && now >= session.end) throw conflict("The doctor's session has ended for today");

  const issuedAt = time.dbDate(now);
  const tokenId = await db.transaction(async (tx) => {
    // First write of the transaction: the service point lock (serialises this queue).
    await lockServicePoints(tx, [session.servicePointId]);
    if (await hasActiveTokenForDoctor(tx, patient.user_id, doctorId, date)) {
      throw conflict('You already have an active token for this doctor today');
    }
    if (!appointmentId && session.maxPatients) {
      // max_patients is per session: count only tokens issued in this session's window.
      const issued = await scheduleService.sessionIssuedCount(tx, doctorId, date, sessions, session);
      if (issued >= session.maxPatients) throw conflict('The doctor is not accepting more patients in this session');
    }
    const visitId = await getOrCreateVisit(tx, patient.user_id, doctor.branch_id, date);
    const tokenNumber = await nextTokenNumber(tx, session.servicePointId, date);
    const id = await insertToken(tx, {
      visitId,
      servicePointId: session.servicePointId,
      doctorId,
      appointmentId,
      tokenNumber,
      date,
      queueType: 'OPD',
      priorityLevel: priorityFromCategory(patient.priority_category, patient.date_of_birth, date),
      issuedAt,
    });
    await insertEvent(tx, {
      tokenId: id,
      type: 'ISSUED',
      by: patient.user_id,
      from: session.servicePointId,
      note: appointmentId ? `Checked in for appointment #${appointmentId}` : null,
      at: issuedAt,
    });
    if (appointmentId) {
      // Guarded: a concurrent check-in / cancel of the same appointment rolls this one back.
      const r = await Appointment.updateOne(
        { _id: appointmentId, status: 'BOOKED' },
        { $set: { status: 'CHECKED_IN', updated_at: issuedAt } },
        { session: sess(tx) }
      );
      if (r.matchedCount !== 1) throw conflict('Appointment changed, please refresh');
    }
    return id;
  });

  const key = { servicePointId: session.servicePointId, date, doctorId };
  await propagate(db, [key], { now, skipApproaching: [tokenId] });
  const detail = await getTokenDetail(db, tokenId, { now });
  await notificationService.notify(db, patient.user_id, {
    tokenId,
    message: `Token ${detail.displayNumber} issued for ${doctor.full_name} at ${detail.servicePoint.name}, ${
      doctor.branch_name
    }. Position ${detail.position || '-'}, estimated wait ${time.waitText(detail.estimate ? detail.estimate.minutes : 0)}.`,
    email: true,
    subject: `Your OPD token ${detail.displayNumber}`,
  });
  return detail;
}

/** Patient cancels own WAITING token. */
async function cancelToken(db, user, tokenId, now = time.clock.now()) {
  const row = await requireTokenRow(db, tokenId);
  if (row.patient_id !== user.user_id) throw forbidden('You can only cancel your own tokens');
  if (row.status !== 'WAITING') throw conflict('Only waiting tokens can be cancelled');
  const at = time.dbDate(now);
  await db.transaction(async (tx) => {
    const r = await Token.updateOne({ _id: tokenId, status: 'WAITING' }, { $set: { status: 'CANCELLED' } }, { session: sess(tx) });
    if (r.matchedCount !== 1) throw conflict('Token status changed, please refresh');
    await insertEvent(tx, { tokenId, type: 'CANCELLED', by: user.user_id, from: row.service_point_id, at });
    if (row.appointment_id) {
      await Appointment.updateOne(
        { _id: row.appointment_id },
        { $set: { status: 'CANCELLED', updated_at: at } },
        { session: sess(tx) }
      );
    }
  });
  realtime.emitTokenUpdated(tokenId, 'CANCELLED', row.patient_id);
  await propagate(db, [queueKeyOf(row)], { now });
  return getTokenDetail(db, tokenId, { now });
}

async function activeTokensForPatient(db, patientId, now = time.clock.now()) {
  const visitIds = await Visit.distinct('_id', { patient_id: patientId }).session(sess(db));
  const rows = visitIds.length
    ? await Token.find(
        { visit_id: { $in: visitIds }, status: { $in: ACTIVE_STATUSES }, token_date: time.formatDate(now) },
        { _id: 1 }
      )
        .sort({ issued_at: 1, _id: 1 })
        .session(sess(db))
        .lean()
    : [];
  const out = [];
  for (const r of rows) out.push(await getTokenDetail(db, r._id, { now }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Staff operations (FR-12, FR-13)
// ---------------------------------------------------------------------------------------------

async function openTokenAt(tx, servicePointId, date, excludeId = 0) {
  return Token.findOne(
    { service_point_id: servicePointId, token_date: date, status: { $in: OPEN_STATUSES }, _id: { $ne: excludeId } },
    { _id: 1 }
  )
    .session(sess(tx))
    .lean();
}

/** Staff service points list (GET /staff/service-points). */
async function staffServicePoints(db, user, now = time.clock.now()) {
  const ids = [...(await access.staffServicePointIds(db, user.user_id, now))];
  const ownDoctor = await access.getDoctorForUser(db, user.user_id);
  const date = time.formatDate(now);
  const out = [];
  for (const id of ids.sort((a, b) => a - b)) {
    const sp = await access.servicePointRow(db, id);
    if (!sp || !sp.is_active) continue;
    const doc = await roomDoctorToday(db, id, date, now, ownDoctor ? ownDoctor.doctor_id : null);
    out.push({
      id: sp.service_point_id,
      name: sp.name,
      type: sp.type,
      branchId: sp.branch_id,
      branchName: sp.branch_name,
      doctorId: doc ? doc.doctorId : null,
      doctorName: doc ? doc.doctorName : null,
    });
  }
  return out;
}

/**
 * Doctor working in an OPD room today: the given doctor if scheduled there, otherwise the doctor
 * whose session is current/next.
 */
async function roomDoctorToday(db, servicePointId, date, now, preferDoctorId = null) {
  const dow = time.isoDow(time.parseDate(date));
  const schedules = await DoctorSchedule.find({ service_point_id: servicePointId, day_of_week: dow }).session(sess(db)).lean();
  const doctors = await scheduleService.getDoctors(db, schedules.map((s) => s.doctor_id));
  const rows = schedules
    .filter((s) => doctors.get(s.doctor_id) && doctors.get(s.doctor_id).is_active)
    .sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a._id - b._id))
    .map((s) => {
      const d = doctors.get(s.doctor_id);
      return { doctor_id: s.doctor_id, start_time: s.start_time, end_time: s.end_time, full_name: d.full_name, specialty: d.specialty };
    });
  if (!rows.length) {
    if (preferDoctorId) {
      const d = await scheduleService.getDoctor(db, preferDoctorId);
      const sp = await ServicePoint.findById(servicePointId, { type: 1 }).session(sess(db)).lean();
      if (d && sp && sp.type === 'OPD') return { doctorId: d.doctor_id, doctorName: d.full_name, specialty: d.specialty };
    }
    return null;
  }
  const pick =
    rows.find((r) => r.doctor_id === preferDoctorId) ||
    rows.find((r) => time.combine(date, r.end_time) > now) ||
    rows[rows.length - 1];
  return { doctorId: pick.doctor_id, doctorName: pick.full_name, specialty: pick.specialty };
}

/** Live queue of a service point (GET /service-points/:id/queue). */
async function servicePointQueue(db, user, servicePointId, now = time.clock.now()) {
  const sp = await access.assertServicePointAccess(db, user, servicePointId);
  const date = time.formatDate(now);
  const rows = await tokenRows(
    db,
    await Token.find({ service_point_id: servicePointId, token_date: date }).session(sess(db)).lean()
  );
  const waitingRows = rows
    .filter((r) => r.status === 'WAITING')
    .sort((a, b) => b.priority_level - a.priority_level || ms(a.issued_at) - ms(b.issued_at) || a.token_id - b.token_id);
  const preds = await predictionService.latestPredictions(
    db,
    waitingRows.map((r) => r.token_id)
  );
  const waiting = waitingRows.map((r) => {
    const est = predictionService.estimateFromPrediction(preds.get(r.token_id), now);
    return toQueueToken(r, est ? est.minutes : null);
  });
  const open = rows
    .filter((r) => r.status === 'CALLED' || r.status === 'IN_SERVICE')
    .sort((a, b) => ms(b.called_at) - ms(a.called_at));
  const skipped = rows
    .filter((r) => r.status === 'SKIPPED')
    .sort((a, b) => ms(a.called_at) - ms(b.called_at))
    .map((r) => toQueueToken(r));
  // Last 5 consultations completed today (newest first) so staff can still issue linked
  // LAB / PHARMACY tokens for a visit after the consultation has ended (FR-04).
  const recentlyCompleted = rows
    .filter((r) => r.status === 'COMPLETED')
    .sort((a, b) => ms(b.completed_at) - ms(a.completed_at) || b.token_id - a.token_id)
    .slice(0, RECENTLY_COMPLETED_LIMIT)
    .map((r) => ({ ...toQueueToken(r), completedAt: time.toApi(r.completed_at) }));

  const called = rows.filter((r) => r.called_at);
  const waits = called.map((r) =>
    time.minutesBetween(time.parseDateTime(r.issued_at), time.parseDateTime(r.called_at))
  );
  const consults = rows
    .filter((r) => r.status === 'COMPLETED' && r.called_at && r.completed_at)
    .map((r) => time.minutesBetween(time.parseDateTime(r.called_at), time.parseDateTime(r.completed_at)));
  // Patients skipped today (a token skipped twice counts once).
  const allIds = await Token.distinct('_id', { service_point_id: servicePointId, token_date: date }).session(sess(db));
  const skippedTokenIds = allIds.length
    ? await QueueEvent.distinct('token_id', { token_id: { $in: allIds }, event_type: 'SKIPPED' }).session(sess(db))
    : [];
  let avgConsult = consults.length ? consults.reduce((s, d) => s + d, 0) / consults.length : null;
  if (avgConsult === null) {
    if (sp.type === 'OPD') {
      const doc = await roomDoctorToday(db, servicePointId, date, now);
      if (doc) {
        const d = await scheduleService.getDoctor(db, doc.doctorId);
        avgConsult = d ? Number(d.avg_consult_minutes) : null;
      }
    } else {
      avgConsult = await predictionService.servicePointAverage(db, servicePointId, sp.type, date);
    }
  }
  return {
    servicePoint: {
      id: sp.service_point_id,
      name: sp.name,
      type: sp.type,
      branchId: sp.branch_id,
      branchName: sp.branch_name,
    },
    nowServing: open.length ? toQueueToken(open[0]) : null,
    waiting,
    skipped,
    recentlyCompleted,
    summary: {
      completedToday: rows.filter((r) => r.status === 'COMPLETED').length,
      skippedToday: skippedTokenIds.length,
      waiting: waiting.length,
      avgWaitMinutes: waits.length ? time.round(waits.reduce((s, d) => s + d, 0) / waits.length, 1) : null,
      avgConsultMinutes: avgConsult === null ? null : time.round(avgConsult, 1),
    },
  };
}

/** Call the next WAITING token at a service point (FR-12). */
async function callNext(db, user, servicePointId, now = time.clock.now()) {
  const sp = await access.assertServicePointAccess(db, user, servicePointId, { staffOnly: true });
  if (!sp.is_active) throw conflict('Service point is inactive');
  const date = time.formatDate(now);
  const at = time.dbDate(now);
  const ownDoctor = await access.getDoctorForUser(db, user.user_id);

  const called = await db.transaction(async (tx) => {
    await lockServicePoints(tx, [servicePointId]);
    if (await openTokenAt(tx, servicePointId, date)) {
      throw conflict('Another token is still being served here; complete or skip it first');
    }
    const filter = { service_point_id: servicePointId, token_date: date, status: 'WAITING' };
    if (ownDoctor && sp.type === 'OPD') {
      // A doctor only ever calls their own patients (rooms can be shared between sessions):
      // with none waiting the result is { token: null }, never another doctor's patient.
      filter.doctor_id = ownDoctor.doctor_id;
    }
    const next = await Token.findOne(filter, { _id: 1 }).sort(QUEUE_ORDER).session(sess(tx)).lean();
    if (!next) return null;
    const r = await Token.updateOne(
      { _id: next._id, status: 'WAITING' },
      { $set: { status: 'CALLED', called_at: at } },
      { session: sess(tx) }
    );
    if (r.matchedCount !== 1) throw conflict('Queue changed, please retry');
    await insertEvent(tx, { tokenId: next._id, type: 'CALLED', by: user.user_id, from: servicePointId, at });
    return next._id;
  });

  if (!called) return { token: null };
  const row = await requireTokenRow(db, called);
  await afterStatusChange(db, row, now);
  await notificationService.notify(db, row.patient_id, {
    tokenId: called,
    message: `It's your turn: token ${fb.displayNumber(row.queue_type, row.token_number)}, please proceed to ${row.sp_name}.`,
  });
  return { token: toQueueToken(row) };
}

async function afterStatusChange(db, row, now, extraKeys = []) {
  realtime.emitTokenUpdated(row.token_id, row.status, row.patient_id);
  await propagate(db, [queueKeyOf(row), ...extraKeys], { now });
}

/**
 * Generic staff transition on one token with FR-21 event logging.
 */
async function staffTransition(db, user, tokenId, { from, to, event, setCalled = false, setCompleted = false, checkOpen = false, now }) {
  const row = await requireTokenRow(db, tokenId);
  await access.assertServicePointAccess(db, user, row.service_point_id, { staffOnly: true });
  await access.assertOwnsOpdToken(db, user, row);
  if (!from.includes(row.status)) {
    throw conflict(`Token is ${row.status}; expected ${from.join(' or ')}`);
  }
  const at = time.dbDate(now);
  await db.transaction(async (tx) => {
    if (checkOpen) {
      await lockServicePoints(tx, [row.service_point_id]);
      if (await openTokenAt(tx, row.service_point_id, time.toApiDate(row.token_date), row.token_id)) {
        throw conflict('Another token is still being served here; complete or skip it first');
      }
    }
    const set = { status: to };
    if (setCompleted) set.completed_at = at;
    // called_at is the FIRST call time (label of the waiting-time model and of the wait
    // analytics); a recall is recorded only as a RECALLED queue_event and keeps it
    // (update pipeline: called_at = ifNull(called_at, now), like SQL COALESCE).
    const update = setCalled ? [{ $set: { ...set, called_at: { $ifNull: ['$called_at', at] } } }] : { $set: set };
    const r = await Token.updateOne({ _id: tokenId, status: row.status }, update, { session: sess(tx) });
    if (r.matchedCount !== 1) throw conflict('Token status changed, please refresh');
    await insertEvent(tx, { tokenId, type: event, by: user.user_id, from: row.service_point_id, at });
    if (to === 'COMPLETED' && row.appointment_id) {
      await Appointment.updateOne(
        { _id: row.appointment_id },
        { $set: { status: 'COMPLETED', updated_at: at } },
        { session: sess(tx) }
      );
    }
  });
  const updated = await requireTokenRow(db, tokenId);
  await afterStatusChange(db, updated, now);
  return updated;
}

async function startToken(db, user, tokenId, now = time.clock.now()) {
  const row = await staffTransition(db, user, tokenId, { from: ['CALLED'], to: 'IN_SERVICE', event: 'STARTED', now });
  return toQueueToken(row);
}

async function skipToken(db, user, tokenId, now = time.clock.now()) {
  const row = await staffTransition(db, user, tokenId, { from: ['CALLED'], to: 'SKIPPED', event: 'SKIPPED', now });
  await notificationService.notify(db, row.patient_id, {
    tokenId,
    message: `Token ${fb.displayNumber(row.queue_type, row.token_number)} was skipped because you were not present at ${row.sp_name}. Please contact the counter to be recalled.`,
  });
  return toQueueToken(row);
}

async function recallToken(db, user, tokenId, now = time.clock.now()) {
  const row = await staffTransition(db, user, tokenId, {
    from: ['SKIPPED'],
    to: 'CALLED',
    event: 'RECALLED',
    setCalled: true,
    checkOpen: true,
    now,
  });
  await notificationService.notify(db, row.patient_id, {
    tokenId,
    message: `Token ${fb.displayNumber(row.queue_type, row.token_number)} has been recalled: please proceed to ${row.sp_name} now.`,
  });
  return toQueueToken(row);
}

async function completeToken(db, user, tokenId, now = time.clock.now()) {
  const row = await staffTransition(db, user, tokenId, {
    from: ['CALLED', 'IN_SERVICE'],
    to: 'COMPLETED',
    event: 'COMPLETED',
    setCompleted: true,
    now,
  });
  return toQueueToken(row);
}

/** Apply a priority level with a reason (FR-13). */
async function setPriority(db, user, tokenId, level, reason, now = time.clock.now()) {
  const row = await requireTokenRow(db, tokenId);
  await access.assertServicePointAccess(db, user, row.service_point_id, { staffOnly: true });
  await access.assertOwnsOpdToken(db, user, row);
  if (!['WAITING', 'SKIPPED'].includes(row.status)) throw conflict(`Priority cannot be changed for a ${row.status} token`);
  const at = time.dbDate(now);
  await db.transaction(async (tx) => {
    await Token.updateOne({ _id: tokenId }, { $set: { priority_level: level } }, { session: sess(tx) });
    await insertEvent(tx, {
      tokenId,
      type: 'PRIORITY_SET',
      by: user.user_id,
      from: row.service_point_id,
      note: `Level ${level}: ${reason}`,
      at,
    });
  });
  const updated = await requireTokenRow(db, tokenId);
  await afterStatusChange(db, updated, now);
  return getQueueToken(db, tokenId, now);
}

/** Transfer a token to another service point / doctor in the same branch (FR-12). */
async function transferToken(db, user, tokenId, { toServicePointId, toDoctorId = null }, now = time.clock.now()) {
  const row = await requireTokenRow(db, tokenId);
  await access.assertServicePointAccess(db, user, row.service_point_id, { staffOnly: true });
  await access.assertOwnsOpdToken(db, user, row);
  if (!['WAITING', 'CALLED'].includes(row.status)) throw conflict(`A ${row.status} token cannot be transferred`);
  const targetDoc = await ServicePoint.findById(toServicePointId).session(sess(db)).lean();
  const target = targetDoc ? { ...targetDoc, service_point_id: targetDoc._id } : null;
  if (!target || !target.is_active) throw notFound('Target service point not found or inactive');
  if (target.branch_id !== row.branch_id) throw badRequest('Tokens can only be transferred within the same branch');
  if (target.service_point_id === row.service_point_id && (!toDoctorId || toDoctorId === row.doctor_id)) {
    throw badRequest('Target must differ from the current service point');
  }
  const date = time.formatDate(now);
  let doctorId = null;
  if (target.type === 'OPD') {
    if (toDoctorId) {
      const d = await scheduleService.getDoctor(db, toDoctorId);
      if (!d || !scheduleService.isDoctorBookable(d)) throw notFound('Target doctor not found or inactive');
      if (d.branch_id !== row.branch_id) throw badRequest('Target doctor works at another branch');
      // The doctor must actually work in that room today, otherwise nobody could call the token.
      const sessions = await scheduleService.doctorSessions(db, d.doctor_id, date);
      if (!sessions.some((s) => s.servicePointId === target.service_point_id)) {
        throw badRequest('The target doctor is not scheduled in that room today');
      }
      doctorId = d.doctor_id;
    } else {
      const doc = await roomDoctorToday(db, target.service_point_id, date, now);
      if (!doc) throw badRequest('No doctor is scheduled in the target room today; specify toDoctorId');
      doctorId = doc.doctorId;
    }
  }
  const at = time.dbDate(now);
  const fromDisplay = fb.displayNumber(row.queue_type, row.token_number);
  const newId = await db.transaction(async (tx) => {
    // Both service points (ascending id) first, the same order as callNext.
    await lockServicePoints(tx, [row.service_point_id, target.service_point_id]);
    // The appointment linkage moves to the new token (appointment_id is unique among tokens, so
    // it is cleared on the old one first) so the appointment is COMPLETED / NO_SHOW with the new token.
    const r = await Token.updateOne(
      { _id: tokenId, status: row.status },
      { $set: { status: 'TRANSFERRED', appointment_id: null } },
      { session: sess(tx) }
    );
    if (r.matchedCount !== 1) throw conflict('Token status changed, please refresh');
    await insertEvent(tx, {
      tokenId,
      type: 'TRANSFERRED',
      by: user.user_id,
      from: row.service_point_id,
      to: target.service_point_id,
      at,
    });
    const tokenNumber = await nextTokenNumber(tx, target.service_point_id, date);
    const id = await insertToken(tx, {
      visitId: row.visit_id,
      servicePointId: target.service_point_id,
      doctorId,
      appointmentId: row.appointment_id || null,
      tokenNumber,
      date,
      queueType: target.type,
      priorityLevel: Number(row.priority_level),
      issuedAt: at,
    });
    await insertEvent(tx, {
      tokenId: id,
      type: 'ISSUED',
      by: user.user_id,
      from: row.service_point_id,
      to: target.service_point_id,
      note: `Transferred from ${fromDisplay}`,
      at,
    });
    return id;
  });
  const fromRow = await requireTokenRow(db, tokenId);
  const toRow = await requireTokenRow(db, newId);
  await afterStatusChange(db, fromRow, now, [queueKeyOf(toRow)]);
  realtime.emitTokenUpdated(newId, 'WAITING', toRow.patient_id);
  await notificationService.notify(db, row.patient_id, {
    tokenId: newId,
    message: `Your token ${fromDisplay} was transferred to ${target.name} as ${fb.displayNumber(
      toRow.queue_type,
      toRow.token_number
    )}.`,
  });
  return { from: toQueueToken(fromRow), to: await getQueueToken(db, newId, now) };
}

async function waitingAt(db, servicePointId, date) {
  return Token.countDocuments({ service_point_id: servicePointId, token_date: date, status: 'WAITING' }).session(sess(db));
}

/** Transfer targets in the same branch (GET /staff/transfer-targets). */
async function transferTargets(db, user, servicePointId, now = time.clock.now()) {
  const sp = await access.assertServicePointAccess(db, user, servicePointId);
  const date = time.formatDate(now);
  const points = await ServicePoint.find({ branch_id: sp.branch_id, is_active: true, _id: { $ne: servicePointId } })
    .sort({ type: 1, name: 1, _id: 1 })
    .session(sess(db))
    .lean();
  const out = [];
  for (const p of points) {
    const doc = p.type === 'OPD' ? await roomDoctorToday(db, p._id, date, now) : null;
    out.push({
      servicePointId: p._id,
      name: p.name,
      type: p.type,
      doctorId: doc ? doc.doctorId : null,
      doctorName: doc ? doc.doctorName : null,
      specialty: doc ? doc.specialty : null,
      waiting: await waitingAt(db, p._id, date),
    });
  }
  return out;
}

/** Issue a linked LAB/PHARMACY token for a visit (FR-04). */
async function issueLinkedToken(db, user, visitId, { type, servicePointId = null }, now = time.clock.now()) {
  const visitDoc = await Visit.findById(visitId).session(sess(db)).lean();
  const visitBranch = visitDoc ? await Branch.findById(visitDoc.branch_id, { name: 1 }).session(sess(db)).lean() : null;
  if (!visitDoc || !visitBranch) throw notFound('Visit not found');
  const visit = { ...visitDoc, visit_id: visitDoc._id, branch_name: visitBranch.name };
  // Roles matrix (Section 3.2): linked LAB/PHARMACY tokens are issued by the consulting doctor.
  const issuingDoctor = user.role === 'STAFF' ? await access.getDoctorForUser(db, user.user_id) : null;
  if (!issuingDoctor) throw forbidden('Only doctors can issue linked tokens');
  // ...and only for their own patient: the visit must hold an OPD token of this doctor.
  const ownOpd = await Token.exists({ visit_id: visitId, queue_type: 'OPD', doctor_id: issuingDoctor.doctor_id }).session(sess(db));
  if (!ownOpd) throw forbidden('You can only issue linked tokens for your own patients');
  const branches = await access.staffBranchIds(db, user);
  if (!branches.has(visit.branch_id)) throw forbidden('You do not work at this branch');
  const date = time.formatDate(now);
  if (visit.status !== 'OPEN' || time.toApiDate(visit.visit_date) !== date) {
    throw conflict('Linked tokens can only be issued for an open visit today');
  }

  let target;
  if (servicePointId) {
    const t = await ServicePoint.findById(servicePointId).session(sess(db)).lean();
    target = t ? { ...t, service_point_id: t._id } : null;
    if (!target || !target.is_active) throw notFound('Service point not found or inactive');
    if (target.type !== type) throw badRequest(`Service point is not a ${type} counter`);
    if (target.branch_id !== visit.branch_id) throw badRequest('Service point belongs to another branch');
  } else {
    // Default: the branch's active point of that type with the shortest queue.
    const points = await ServicePoint.find({ branch_id: visit.branch_id, type, is_active: true })
      .sort({ _id: 1 })
      .session(sess(db))
      .lean();
    if (!points.length) throw notFound(`No active ${type} counter at ${visit.branch_name}`);
    let best = null;
    for (const p of points) {
      const n = await waitingAt(db, p._id, date);
      if (!best || n < best.n) best = { ...p, service_point_id: p._id, n };
    }
    target = best;
  }

  const at = time.dbDate(now);
  const tokenId = await db.transaction(async (tx) => {
    // Lock first, then the duplicate check (read after the lock write, see lockServicePoints).
    await lockServicePoints(tx, [target.service_point_id]);
    const dup = await Token.exists({
      visit_id: visitId,
      service_point_id: target.service_point_id,
      status: { $in: ACTIVE_STATUSES },
    }).session(sess(tx));
    if (dup) throw conflict(`This visit already has an active ${type} token`);
    const pr = await Token.findOne({ visit_id: visitId }, { priority_level: 1 }).sort({ priority_level: -1 }).session(sess(tx)).lean();
    const tokenNumber = await nextTokenNumber(tx, target.service_point_id, date);
    const id = await insertToken(tx, {
      visitId,
      servicePointId: target.service_point_id,
      doctorId: null,
      appointmentId: null,
      tokenNumber,
      date,
      queueType: type,
      priorityLevel: Number(pr && pr.priority_level) || 0,
      issuedAt: at,
    });
    await insertEvent(tx, {
      tokenId: id,
      type: 'ISSUED',
      by: user.user_id,
      to: target.service_point_id,
      note: `Linked ${type} token`,
      at,
    });
    return id;
  });
  const row = await requireTokenRow(db, tokenId);
  await propagate(db, [queueKeyOf(row)], { now, skipApproaching: [tokenId] });
  realtime.emitTokenUpdated(tokenId, 'WAITING', visit.patient_id);
  const detail = await getTokenDetail(db, tokenId, { now });
  await notificationService.notify(db, visit.patient_id, {
    tokenId,
    message: `Linked ${type} token ${detail.displayNumber} issued at ${target.name}. Estimated wait ${time.waitText(
      detail.estimate ? detail.estimate.minutes : 0
    )}.`,
  });
  return detail;
}

/**
 * End-of-day closure: CALLED/SKIPPED/WAITING tokens of past days -> NO_SHOW (with events),
 * IN_SERVICE tokens of past days -> COMPLETED (completed_at = run time, COMPLETED event noted
 * 'auto-closed at end of day'), their appointments NO_SHOW / COMPLETED accordingly, BOOKED
 * appointments of past days -> NO_SHOW, CHECKED_IN appointments of past days left behind by an
 * ended token -> COMPLETED if their token was completed, else NO_SHOW, OPEN visits of past
 * days -> CLOSED. Runs in one transaction (status changes and their events together, FR-21).
 */
async function endOfDay(db, now = time.clock.now()) {
  const date = time.formatDate(now);
  const at = time.dbDate(now);
  const dayStart = time.dayStart(date);
  return db.transaction(async (tx) => {
    const s = sess(tx);
    const stale = await Token.find(
      { token_date: { $lt: date }, status: { $in: ['WAITING', 'CALLED', 'SKIPPED'] } },
      { service_point_id: 1, appointment_id: 1 }
    )
      .sort({ _id: 1 })
      .session(s)
      .lean();
    for (const t of stale) {
      await Token.updateOne({ _id: t._id }, { $set: { status: 'NO_SHOW' } }, { session: s });
      await insertEvent(tx, { tokenId: t._id, type: 'NO_SHOW', from: t.service_point_id, note: 'End-of-day closure', at });
      if (t.appointment_id) {
        await Appointment.updateOne({ _id: t.appointment_id }, { $set: { status: 'NO_SHOW', updated_at: at } }, { session: s });
      }
    }
    // A consultation left IN_SERVICE (never completed by staff) was served: close it as COMPLETED.
    const inService = await Token.find({ token_date: { $lt: date }, status: 'IN_SERVICE' }, { service_point_id: 1, appointment_id: 1 })
      .sort({ _id: 1 })
      .session(s)
      .lean();
    for (const t of inService) {
      await Token.updateOne({ _id: t._id }, { $set: { status: 'COMPLETED', completed_at: at } }, { session: s });
      await insertEvent(tx, {
        tokenId: t._id,
        type: 'COMPLETED',
        from: t.service_point_id,
        note: 'auto-closed at end of day',
        at,
      });
      if (t.appointment_id) {
        await Appointment.updateOne({ _id: t.appointment_id }, { $set: { status: 'COMPLETED', updated_at: at } }, { session: s });
      }
    }
    const appts = await Appointment.updateMany(
      { status: 'BOOKED', slot_start: { $lt: dayStart } },
      { $set: { status: 'NO_SHOW', updated_at: at } },
      { session: s }
    );
    // Safety net: a CHECKED_IN appointment of a past day whose linked token has ended.
    const checkedIn = await Appointment.distinct('_id', { status: 'CHECKED_IN', slot_start: { $lt: dayStart } }).session(s);
    let done = 0;
    if (checkedIn.length) {
      const completedFor = await Token.distinct('appointment_id', { appointment_id: { $in: checkedIn }, status: 'COMPLETED' }).session(s);
      if (completedFor.length) {
        const r = await Appointment.updateMany(
          { _id: { $in: completedFor }, status: 'CHECKED_IN' },
          { $set: { status: 'COMPLETED', updated_at: at } },
          { session: s }
        );
        done = r.modifiedCount;
      }
    }
    const missedAppts = await Appointment.updateMany(
      { status: 'CHECKED_IN', slot_start: { $lt: dayStart } },
      { $set: { status: 'NO_SHOW', updated_at: at } },
      { session: s }
    );
    const visits = await Visit.updateMany({ status: 'OPEN', visit_date: { $lt: date } }, { $set: { status: 'CLOSED' } }, { session: s });
    return {
      tokens: stale.length,
      autoCompleted: inService.length,
      appointments: appts.modifiedCount + done + missedAppts.modifiedCount,
      visits: visits.modifiedCount,
    };
  });
}

module.exports = {
  ACTIVE_STATUSES,
  priorityFromCategory,
  queueKeyOf,
  tokenRows,
  loadTokenRow,
  requireTokenRow,
  buildTokenDetail,
  getTokenDetail,
  getQueueToken,
  toQueueToken,
  departmentCongestion,
  propagate,
  issueOpdToken,
  cancelToken,
  activeTokensForPatient,
  staffServicePoints,
  roomDoctorToday,
  servicePointQueue,
  callNext,
  startToken,
  skipToken,
  recallToken,
  completeToken,
  setPriority,
  transferToken,
  transferTargets,
  issueLinkedToken,
  endOfDay,
  insertEvent,
};
