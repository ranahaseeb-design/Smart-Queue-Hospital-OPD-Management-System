'use strict';
/**
 * Queue & Token Service (FR-03, FR-04, FR-05, FR-07, FR-12, FR-13, FR-21).
 *
 * - Token numbering per service point per day, queue order = priority DESC, issued_at ASC.
 * - Every status change writes a queue_events row in the same DB transaction (FR-21).
 * - After each change the affected queue is re-predicted (FR-07), patients are notified
 *   (FR-11) and socket events are emitted (FR-05).
 *
 * A queue is identified by { servicePointId, date, doctorId } (doctorId null for LAB/PHARMACY).
 */
const config = require('../config');
const time = require('../utils/time');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const fb = require('./featureBuilder');
const access = require('./accessService');
const scheduleService = require('./scheduleService');
const userService = require('./userService');
const predictionService = require('./predictionService');
const notificationService = require('./notificationService');
const settingsService = require('./settingsService');
const realtime = require('./realtime');

const ACTIVE_STATUSES = ['WAITING', 'CALLED', 'IN_SERVICE'];
const RECENTLY_COMPLETED_LIMIT = 5;
const LEVEL_RANK = { NORMAL: 0, HIGH: 1, CRITICAL: 2 };
const lastDepartmentLevel = new Map(); // departmentId -> last live congestion level (for alert escalation)
// tokenId -> last published queue position, so token:updated is sent whenever a position changes
// even when the estimate stays the same (contract: position/estimate changed).
const lastPosition = new Map();
const LAST_POSITION_LIMIT = 50000;

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

// Columns for isPriorityDeclared (t = tokens, pu = the patient's users row).
const PRIORITY_DECLARED_COLUMNS = `pu.date_of_birth AS patient_dob,
            (SELECT COUNT(*) FROM queue_events pe JOIN tokens pt ON pt.token_id = pe.token_id
              WHERE pt.visit_id = t.visit_id AND pe.event_type = 'PRIORITY_SET') AS priority_confirmed`;

function queueKeyOf(row) {
  return {
    servicePointId: row.service_point_id,
    date: time.toApiDate(row.token_date),
    doctorId: row.doctor_id || null,
  };
}

function doctorFilterSql(doctorId) {
  return doctorId ? { sql: 'AND doctor_id = ?', params: [doctorId] } : { sql: 'AND doctor_id IS NULL', params: [] };
}

/** Token row with visit, branch, service point, doctor and department data. */
async function loadTokenRow(db, tokenId) {
  return db.get(
    `SELECT t.*, v.patient_id, v.branch_id, v.status AS visit_status, b.name AS branch_name,
            sp.name AS sp_name, sp.type AS sp_type,
            du.full_name AS doctor_name, dep.specialty, dep.department_id, dep.name AS department_name,
            pu.full_name AS patient_name, pu.priority_category, ${PRIORITY_DECLARED_COLUMNS}
       FROM tokens t
       JOIN visits v ON v.visit_id = t.visit_id
       JOIN branches b ON b.branch_id = v.branch_id
       JOIN service_points sp ON sp.service_point_id = t.service_point_id
       JOIN users pu ON pu.user_id = v.patient_id
       LEFT JOIN doctors d ON d.doctor_id = t.doctor_id
       LEFT JOIN users du ON du.user_id = d.user_id
       LEFT JOIN departments dep ON dep.department_id = d.department_id
      WHERE t.token_id = ?`,
    [tokenId]
  );
}

async function requireTokenRow(db, tokenId) {
  const row = await loadTokenRow(db, tokenId);
  if (!row) throw notFound('Token not found');
  return row;
}

/** Ordered WAITING token ids of a queue. */
async function waitingIds(db, key) {
  const f = doctorFilterSql(key.doctorId);
  const rows = await db.query(
    `SELECT token_id FROM tokens WHERE service_point_id = ? AND token_date = ? AND status = 'WAITING' ${f.sql}
      ORDER BY priority_level DESC, issued_at ASC, token_id ASC`,
    [key.servicePointId, key.date, ...f.params]
  );
  return rows.map((r) => r.token_id);
}

async function nowServingOf(db, key) {
  const f = doctorFilterSql(key.doctorId);
  const row = await db.get(
    `SELECT token_id, token_number, queue_type FROM tokens
      WHERE service_point_id = ? AND token_date = ? AND status IN ('CALLED', 'IN_SERVICE') ${f.sql}
      ORDER BY called_at DESC, token_id DESC LIMIT 1`,
    [key.servicePointId, key.date, ...f.params]
  );
  return row ? { tokenId: row.token_id, displayNumber: fb.displayNumber(row.queue_type, row.token_number) } : null;
}

/** Live department congestion (Eq. 6.5) for today. */
async function departmentCongestion(db, departmentId, now = time.clock.now()) {
  const date = time.formatDate(now);
  const settings = await settingsService.getSettings(db);
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM tokens t JOIN doctors d ON d.doctor_id = t.doctor_id
      WHERE d.department_id = ? AND t.token_date = ? AND t.status = 'WAITING' AND t.queue_type = 'OPD'`,
    [departmentId, date]
  );
  const sessions = await scheduleService.departmentSessions(db, departmentId, date);
  return fb.liveCongestion({
    waiting: Number(row.n) || 0,
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
    const others = await db.query('SELECT token_id FROM tokens WHERE visit_id = ? AND token_id <> ? ORDER BY token_id', [
      row.visit_id,
      row.token_id,
    ]);
    detail.linkedTokens = [];
    for (const o of others) {
      const r = await loadTokenRow(db, o.token_id);
      if (r) detail.linkedTokens.push(await buildTokenDetail(db, r, { includeLinked: false, now }));
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
  await tx.run(
    `INSERT INTO queue_events (token_id, event_type, performed_by, from_point_id, to_point_id, note, event_time)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tokenId, type, by, from, to, note ? String(note).slice(0, 255) : null, at]
  );
}

/**
 * Lock service points in ascending id order. Every transaction that numbers tokens or changes
 * a queue takes these locks FIRST (before any plain SELECT, which would fix the InnoDB
 * REPEATABLE READ snapshot) and before any token row lock, so the global lock order is
 * service_points (ascending) -> doctors -> users -> tokens and transactions cannot deadlock.
 */
async function lockServicePoints(tx, ids) {
  const unique = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  for (const id of unique) await tx.lockRow('service_points', 'service_point_id', id);
}

/** Next token number at a service point. Caller must already hold the service point lock. */
async function nextTokenNumber(tx, servicePointId, date) {
  // Locking read on MySQL: reads the latest committed MAX even if the snapshot is older.
  const row = await tx.getForUpdate(
    'SELECT MAX(token_number) AS n FROM tokens WHERE service_point_id = ? AND token_date = ?',
    [servicePointId, date]
  );
  return (Number(row && row.n) || 0) + 1;
}

/** Caller must hold the patient's users-row lock so two OPEN visits cannot be created. */
async function getOrCreateVisit(tx, patientId, branchId, date) {
  const existing = await tx.get(
    `SELECT visit_id FROM visits WHERE patient_id = ? AND branch_id = ? AND visit_date = ? AND status = 'OPEN'
      ORDER BY visit_id DESC LIMIT 1`,
    [patientId, branchId, date]
  );
  if (existing) return existing.visit_id;
  const { insertId } = await tx.run(
    `INSERT INTO visits (patient_id, branch_id, visit_date, status) VALUES (?, ?, ?, 'OPEN')`,
    [patientId, branchId, date]
  );
  return insertId;
}

async function insertToken(tx, t) {
  const { insertId } = await tx.run(
    `INSERT INTO tokens (visit_id, service_point_id, doctor_id, appointment_id, token_number, token_date, queue_type,
                         priority_level, status, issued_at, called_at, completed_at, is_synthetic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', ?, NULL, NULL, 0)`,
    [t.visitId, t.servicePointId, t.doctorId || null, t.appointmentId || null, t.tokenNumber, t.date, t.queueType,
      t.priorityLevel, t.issuedAt]
  );
  return insertId;
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
    const dept = await db.get(
      `SELECT dp.department_id, dp.name, dp.specialty, b.branch_id, b.name AS branch_name
         FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id WHERE dp.department_id = ?`,
      [departmentId]
    );
    if (dept) {
      realtime.emitAlert({
        id: `live-${departmentId}`,
        level: c.level,
        source: 'LIVE',
        branchId: dept.branch_id,
        branchName: dept.branch_name,
        departmentId,
        departmentName: dept.name || dept.specialty,
        message: `${dept.name || dept.specialty} at ${dept.branch_name} is ${c.level}: ${c.waiting} waiting for a remaining capacity of about ${c.capacity} patients (ratio ${c.ratio}).`,
        at: time.toApi(now),
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Patient operations
// ---------------------------------------------------------------------------------------------

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

  const issuedAt = time.formatDateTime(now);
  const tokenId = await db.transaction(async (tx) => {
    // Lock order: service point -> doctor -> patient (see lockServicePoints).
    await lockServicePoints(tx, [session.servicePointId]);
    await tx.lockRow('doctors', 'doctor_id', doctorId);
    await tx.lockRow('users', 'user_id', patient.user_id);
    const dup = await tx.get(
      `SELECT t.token_id FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
        WHERE v.patient_id = ? AND t.doctor_id = ? AND t.token_date = ? AND t.status IN ('WAITING', 'CALLED', 'IN_SERVICE')`,
      [patient.user_id, doctorId, date]
    );
    if (dup) throw conflict('You already have an active token for this doctor today');
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
      const r = await tx.run(
        `UPDATE appointments SET status = 'CHECKED_IN', updated_at = ? WHERE appointment_id = ? AND status = 'BOOKED'`,
        [issuedAt, appointmentId]
      );
      if (r.changes !== 1) throw conflict('Appointment changed, please refresh');
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
  const at = time.formatDateTime(now);
  await db.transaction(async (tx) => {
    const r = await tx.run(`UPDATE tokens SET status = 'CANCELLED' WHERE token_id = ? AND status = 'WAITING'`, [tokenId]);
    if (r.changes !== 1) throw conflict('Token status changed, please refresh');
    await insertEvent(tx, { tokenId, type: 'CANCELLED', by: user.user_id, from: row.service_point_id, at });
    if (row.appointment_id) {
      await tx.run(`UPDATE appointments SET status = 'CANCELLED', updated_at = ? WHERE appointment_id = ?`, [
        at,
        row.appointment_id,
      ]);
    }
  });
  realtime.emitTokenUpdated(tokenId, 'CANCELLED', row.patient_id);
  await propagate(db, [queueKeyOf(row)], { now });
  return getTokenDetail(db, tokenId, { now });
}

async function activeTokensForPatient(db, patientId, now = time.clock.now()) {
  const rows = await db.query(
    `SELECT t.token_id FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
      WHERE v.patient_id = ? AND t.status IN ('WAITING', 'CALLED', 'IN_SERVICE') AND t.token_date = ?
      ORDER BY t.issued_at`,
    [patientId, time.formatDate(now)]
  );
  const out = [];
  for (const r of rows) out.push(await getTokenDetail(db, r.token_id, { now }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Staff operations (FR-12, FR-13)
// ---------------------------------------------------------------------------------------------

async function openTokenAt(tx, servicePointId, date, excludeId = 0) {
  return tx.get(
    `SELECT token_id FROM tokens WHERE service_point_id = ? AND token_date = ? AND status IN ('CALLED', 'IN_SERVICE')
       AND token_id <> ? LIMIT 1`,
    [servicePointId, date, excludeId]
  );
}

/** Staff service points list (GET /staff/service-points). */
async function staffServicePoints(db, user, now = time.clock.now()) {
  const ids = [...(await access.staffServicePointIds(db, user.user_id, now))];
  const ownDoctor = await access.getDoctorForUser(db, user.user_id);
  const date = time.formatDate(now);
  const out = [];
  for (const id of ids.sort((a, b) => a - b)) {
    const sp = await db.get(
      `SELECT sp.service_point_id, sp.name, sp.type, sp.branch_id, sp.is_active, b.name AS branch_name
         FROM service_points sp JOIN branches b ON b.branch_id = sp.branch_id WHERE sp.service_point_id = ?`,
      [id]
    );
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
  const rows = await db.query(
    `SELECT ds.doctor_id, ds.start_time, ds.end_time, u.full_name, dp.specialty
       FROM doctor_schedules ds JOIN doctors d ON d.doctor_id = ds.doctor_id
       JOIN users u ON u.user_id = d.user_id JOIN departments dp ON dp.department_id = d.department_id
      WHERE ds.service_point_id = ? AND ds.day_of_week = ? AND d.is_active = 1
      ORDER BY ds.start_time`,
    [servicePointId, dow]
  );
  if (!rows.length) {
    if (preferDoctorId) {
      const d = await scheduleService.getDoctor(db, preferDoctorId);
      const sp = await db.get('SELECT type FROM service_points WHERE service_point_id = ?', [servicePointId]);
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
  const rows = await db.query(
    `SELECT t.*, pu.full_name AS patient_name, pu.priority_category, ${PRIORITY_DECLARED_COLUMNS}
       FROM tokens t JOIN visits v ON v.visit_id = t.visit_id JOIN users pu ON pu.user_id = v.patient_id
      WHERE t.service_point_id = ? AND t.token_date = ?`,
    [servicePointId, date]
  );
  const waitingRows = rows
    .filter((r) => r.status === 'WAITING')
    .sort(
      (a, b) =>
        b.priority_level - a.priority_level ||
        String(a.issued_at).localeCompare(String(b.issued_at)) ||
        a.token_id - b.token_id
    );
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
    .sort((a, b) => String(b.called_at).localeCompare(String(a.called_at)));
  const skipped = rows
    .filter((r) => r.status === 'SKIPPED')
    .sort((a, b) => String(a.called_at).localeCompare(String(b.called_at)))
    .map((r) => toQueueToken(r));
  // Last 5 consultations completed today (newest first) so staff can still issue linked
  // LAB / PHARMACY tokens for a visit after the consultation has ended (FR-04).
  const recentlyCompleted = rows
    .filter((r) => r.status === 'COMPLETED')
    .sort(
      (a, b) => String(b.completed_at).localeCompare(String(a.completed_at)) || b.token_id - a.token_id
    )
    .slice(0, RECENTLY_COMPLETED_LIMIT)
    .map((r) => ({ ...toQueueToken(r), completedAt: time.toApi(r.completed_at) }));

  const called = rows.filter((r) => r.called_at);
  const waits = called.map((r) =>
    time.minutesBetween(time.parseDateTime(r.issued_at), time.parseDateTime(r.called_at))
  );
  const consults = rows
    .filter((r) => r.status === 'COMPLETED' && r.called_at && r.completed_at)
    .map((r) => time.minutesBetween(time.parseDateTime(r.called_at), time.parseDateTime(r.completed_at)));
  const skippedEvents = await db.get(
    // Patients skipped today (a token skipped twice counts once).
    `SELECT COUNT(DISTINCT e.token_id) AS n FROM queue_events e JOIN tokens t ON t.token_id = e.token_id
      WHERE t.service_point_id = ? AND t.token_date = ? AND e.event_type = 'SKIPPED'`,
    [servicePointId, date]
  );
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
      skippedToday: Number(skippedEvents.n) || 0,
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
  const at = time.formatDateTime(now);
  const ownDoctor = await access.getDoctorForUser(db, user.user_id);

  const called = await db.transaction(async (tx) => {
    await lockServicePoints(tx, [servicePointId]);
    if (await openTokenAt(tx, servicePointId, date)) {
      throw conflict('Another token is still being served here; complete or skip it first');
    }
    let doctorSql = '';
    const params = [servicePointId, date];
    if (ownDoctor && sp.type === 'OPD') {
      // A doctor only ever calls their own patients (rooms can be shared between sessions):
      // with none waiting the result is { token: null }, never another doctor's patient.
      doctorSql = 'AND doctor_id = ?';
      params.push(ownDoctor.doctor_id);
    }
    const next = await tx.get(
      `SELECT token_id FROM tokens WHERE service_point_id = ? AND token_date = ? AND status = 'WAITING' ${doctorSql}
        ORDER BY priority_level DESC, issued_at ASC, token_id ASC LIMIT 1`,
      params
    );
    if (!next) return null;
    const r = await tx.run(
      `UPDATE tokens SET status = 'CALLED', called_at = ? WHERE token_id = ? AND status = 'WAITING'`,
      [at, next.token_id]
    );
    if (r.changes !== 1) throw conflict('Queue changed, please retry');
    await insertEvent(tx, { tokenId: next.token_id, type: 'CALLED', by: user.user_id, from: servicePointId, at });
    return next.token_id;
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
  const at = time.formatDateTime(now);
  await db.transaction(async (tx) => {
    if (checkOpen) {
      await lockServicePoints(tx, [row.service_point_id]);
      if (await openTokenAt(tx, row.service_point_id, time.toApiDate(row.token_date), row.token_id)) {
        throw conflict('Another token is still being served here; complete or skip it first');
      }
    }
    const sets = ['status = ?'];
    const params = [to];
    if (setCalled) {
      // called_at is the FIRST call time (label of the waiting-time model and of the wait
      // analytics); a recall is recorded only as a RECALLED queue_event and keeps it.
      sets.push('called_at = COALESCE(called_at, ?)');
      params.push(at);
    }
    if (setCompleted) {
      sets.push('completed_at = ?');
      params.push(at);
    }
    const r = await tx.run(
      `UPDATE tokens SET ${sets.join(', ')} WHERE token_id = ? AND status = ?`,
      [...params, tokenId, row.status]
    );
    if (r.changes !== 1) throw conflict('Token status changed, please refresh');
    await insertEvent(tx, { tokenId, type: event, by: user.user_id, from: row.service_point_id, at });
    if (to === 'COMPLETED' && row.appointment_id) {
      await tx.run(`UPDATE appointments SET status = 'COMPLETED', updated_at = ? WHERE appointment_id = ?`, [
        at,
        row.appointment_id,
      ]);
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
  const at = time.formatDateTime(now);
  await db.transaction(async (tx) => {
    await tx.run('UPDATE tokens SET priority_level = ? WHERE token_id = ?', [level, tokenId]);
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
  const target = await db.get(
    'SELECT service_point_id, branch_id, type, name, is_active FROM service_points WHERE service_point_id = ?',
    [toServicePointId]
  );
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
  const at = time.formatDateTime(now);
  const fromDisplay = fb.displayNumber(row.queue_type, row.token_number);
  const newId = await db.transaction(async (tx) => {
    // Service points (ascending id) before the token row, the same order as callNext.
    await lockServicePoints(tx, [row.service_point_id, target.service_point_id]);
    // The appointment linkage moves to the new token (tokens.appointment_id is UNIQUE, so it is
    // cleared on the old one first) so the appointment is COMPLETED / NO_SHOW with the new token.
    const r = await tx.run(
      `UPDATE tokens SET status = 'TRANSFERRED', appointment_id = NULL WHERE token_id = ? AND status = ?`,
      [tokenId, row.status]
    );
    if (r.changes !== 1) throw conflict('Token status changed, please refresh');
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

/** Transfer targets in the same branch (GET /staff/transfer-targets). */
async function transferTargets(db, user, servicePointId, now = time.clock.now()) {
  const sp = await access.assertServicePointAccess(db, user, servicePointId);
  const date = time.formatDate(now);
  const points = await db.query(
    `SELECT service_point_id, name, type FROM service_points
      WHERE branch_id = ? AND is_active = 1 AND service_point_id <> ? ORDER BY type, name`,
    [sp.branch_id, servicePointId]
  );
  const out = [];
  for (const p of points) {
    const doc = p.type === 'OPD' ? await roomDoctorToday(db, p.service_point_id, date, now) : null;
    const w = await db.get(
      `SELECT COUNT(*) AS n FROM tokens WHERE service_point_id = ? AND token_date = ? AND status = 'WAITING'`,
      [p.service_point_id, date]
    );
    out.push({
      servicePointId: p.service_point_id,
      name: p.name,
      type: p.type,
      doctorId: doc ? doc.doctorId : null,
      doctorName: doc ? doc.doctorName : null,
      specialty: doc ? doc.specialty : null,
      waiting: Number(w.n) || 0,
    });
  }
  return out;
}

/** Issue a linked LAB/PHARMACY token for a visit (FR-04). */
async function issueLinkedToken(db, user, visitId, { type, servicePointId = null }, now = time.clock.now()) {
  const visit = await db.get(
    `SELECT v.*, b.name AS branch_name FROM visits v JOIN branches b ON b.branch_id = v.branch_id WHERE v.visit_id = ?`,
    [visitId]
  );
  if (!visit) throw notFound('Visit not found');
  // Roles matrix (Section 3.2): linked LAB/PHARMACY tokens are issued by the consulting doctor.
  const issuingDoctor = user.role === 'STAFF' ? await access.getDoctorForUser(db, user.user_id) : null;
  if (!issuingDoctor) throw forbidden('Only doctors can issue linked tokens');
  // ...and only for their own patient: the visit must hold an OPD token of this doctor.
  const ownOpd = await db.get(
    `SELECT token_id FROM tokens WHERE visit_id = ? AND queue_type = 'OPD' AND doctor_id = ?`,
    [visitId, issuingDoctor.doctor_id]
  );
  if (!ownOpd) throw forbidden('You can only issue linked tokens for your own patients');
  const branches = await access.staffBranchIds(db, user);
  if (!branches.has(visit.branch_id)) throw forbidden('You do not work at this branch');
  const date = time.formatDate(now);
  if (visit.status !== 'OPEN' || time.toApiDate(visit.visit_date) !== date) {
    throw conflict('Linked tokens can only be issued for an open visit today');
  }

  let target;
  if (servicePointId) {
    target = await db.get(
      'SELECT service_point_id, branch_id, type, name, is_active FROM service_points WHERE service_point_id = ?',
      [servicePointId]
    );
    if (!target || !target.is_active) throw notFound('Service point not found or inactive');
    if (target.type !== type) throw badRequest(`Service point is not a ${type} counter`);
    if (target.branch_id !== visit.branch_id) throw badRequest('Service point belongs to another branch');
  } else {
    // Default: the branch's active point of that type with the shortest queue.
    const points = await db.query(
      `SELECT service_point_id, branch_id, type, name, is_active FROM service_points
        WHERE branch_id = ? AND type = ? AND is_active = 1 ORDER BY service_point_id`,
      [visit.branch_id, type]
    );
    if (!points.length) throw notFound(`No active ${type} counter at ${visit.branch_name}`);
    let best = null;
    for (const p of points) {
      const w = await db.get(
        `SELECT COUNT(*) AS n FROM tokens WHERE service_point_id = ? AND token_date = ? AND status = 'WAITING'`,
        [p.service_point_id, date]
      );
      const n = Number(w.n) || 0;
      if (!best || n < best.n) best = { ...p, n };
    }
    target = best;
  }

  const at = time.formatDateTime(now);
  const tokenId = await db.transaction(async (tx) => {
    // Lock first: the duplicate check below must not fix a stale InnoDB snapshot.
    await lockServicePoints(tx, [target.service_point_id]);
    const dup = await tx.get(
      `SELECT token_id FROM tokens WHERE visit_id = ? AND service_point_id = ? AND status IN ('WAITING', 'CALLED', 'IN_SERVICE')`,
      [visitId, target.service_point_id]
    );
    if (dup) throw conflict(`This visit already has an active ${type} token`);
    const pr = await tx.get('SELECT MAX(priority_level) AS p FROM tokens WHERE visit_id = ?', [visitId]);
    const tokenNumber = await nextTokenNumber(tx, target.service_point_id, date);
    const id = await insertToken(tx, {
      visitId,
      servicePointId: target.service_point_id,
      doctorId: null,
      appointmentId: null,
      tokenNumber,
      date,
      queueType: type,
      priorityLevel: Number(pr && pr.p) || 0,
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
 * days -> CLOSED.
 */
async function endOfDay(db, now = time.clock.now()) {
  const date = time.formatDate(now);
  const at = time.formatDateTime(now);
  return db.transaction(async (tx) => {
    const stale = await tx.query(
      `SELECT token_id, service_point_id, appointment_id FROM tokens
        WHERE token_date < ? AND status IN ('WAITING', 'CALLED', 'SKIPPED')`,
      [date]
    );
    for (const t of stale) {
      await tx.run(`UPDATE tokens SET status = 'NO_SHOW' WHERE token_id = ?`, [t.token_id]);
      await insertEvent(tx, { tokenId: t.token_id, type: 'NO_SHOW', from: t.service_point_id, note: 'End-of-day closure', at });
      if (t.appointment_id) {
        await tx.run(`UPDATE appointments SET status = 'NO_SHOW', updated_at = ? WHERE appointment_id = ?`, [
          at,
          t.appointment_id,
        ]);
      }
    }
    // A consultation left IN_SERVICE (never completed by staff) was served: close it as COMPLETED.
    const inService = await tx.query(
      `SELECT token_id, service_point_id, appointment_id FROM tokens WHERE token_date < ? AND status = 'IN_SERVICE'`,
      [date]
    );
    for (const t of inService) {
      await tx.run(`UPDATE tokens SET status = 'COMPLETED', completed_at = ? WHERE token_id = ?`, [at, t.token_id]);
      await insertEvent(tx, {
        tokenId: t.token_id,
        type: 'COMPLETED',
        from: t.service_point_id,
        note: 'auto-closed at end of day',
        at,
      });
      if (t.appointment_id) {
        await tx.run(`UPDATE appointments SET status = 'COMPLETED', updated_at = ? WHERE appointment_id = ?`, [
          at,
          t.appointment_id,
        ]);
      }
    }
    const appts = await tx.run(
      `UPDATE appointments SET status = 'NO_SHOW', updated_at = ? WHERE status = 'BOOKED' AND slot_start < ?`,
      [at, `${date} 00:00:00`]
    );
    // Safety net: a CHECKED_IN appointment of a past day whose linked token has ended.
    const doneAppts = await tx.run(
      `UPDATE appointments SET status = 'COMPLETED', updated_at = ?
        WHERE status = 'CHECKED_IN' AND slot_start < ?
          AND EXISTS (SELECT 1 FROM tokens t WHERE t.appointment_id = appointments.appointment_id AND t.status = 'COMPLETED')`,
      [at, `${date} 00:00:00`]
    );
    const missedAppts = await tx.run(
      `UPDATE appointments SET status = 'NO_SHOW', updated_at = ? WHERE status = 'CHECKED_IN' AND slot_start < ?`,
      [at, `${date} 00:00:00`]
    );
    const visits = await tx.run(`UPDATE visits SET status = 'CLOSED' WHERE status = 'OPEN' AND visit_date < ?`, [date]);
    return {
      tokens: stale.length,
      autoCompleted: inService.length,
      appointments: appts.changes + doneAppts.changes + missedAppts.changes,
      visits: visits.changes,
    };
  });
}

module.exports = {
  ACTIVE_STATUSES,
  priorityFromCategory,
  queueKeyOf,
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
