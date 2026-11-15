'use strict';
/**
 * Committee demo data (config.demoTools, off in production). Adds realistic activity for TODAY on
 * top of the seeded database, without touching existing records:
 *
 *   seedCommitteeDemo — ~48 completed OPD visits from earlier today (3 per Model Town doctor, 1 per
 *     peer-branch doctor; ~40 % with a completed PHARMACY token of ~3 min, ~15 % with LAB), then
 *     5 WAITING tokens for the Model Town Room 1 doctor (Dr. Ahmed Raza) and 2 WAITING tokens at
 *     the Model Town Pharmacy Counter (Sobia Anjum), and a fresh forecast (Random Forest when the AI
 *     service is up). Past visits are written as complete records (visit, token, ISSUED / CALLED /
 *     STARTED / COMPLETED events, flagged is_synthetic); the waiting tokens go through the normal
 *     issue path so predictions, notifications and live updates fire as for real patients.
 *   setPeakCongestion — on: issue WAITING tokens to Model Town doctors (normal path) until the
 *     branch's live load (Eq. 6.5: waiting ÷ remaining capacity) is ≥ 85 %; off: cancel those.
 *   branchLoads — live load per branch, used by the load balancer and the peak toggle.
 */
const crypto = require('crypto');
const config = require('../config');
const time = require('../utils/time');
const { badRequest } = require('../utils/errors');
const { models, insertOne, nextTokenNumber, getDb } = require('../db');
const fb = require('./featureBuilder');
const scheduleService = require('./scheduleService');
const queueService = require('./queueService');
const userService = require('./userService');
const forecastService = require('./forecastService');
const realtime = require('./realtime');

const { User, Visit, Token, Branch, Department, ServicePoint, Doctor } = models;
const MINUTE = 60 * 1000;
const DEMO_DOMAIN = 'demo.opd.local';
const PEAK_PREFIX = 'peak-';
const PEAK_TARGET = 0.85;
const PEAK_MAX_TOKENS = 300;

const FIRST = ['Ali', 'Fatima', 'Usman', 'Ayesha', 'Hamza', 'Zainab', 'Bilal', 'Maryam', 'Hassan', 'Sana', 'Imran', 'Hira',
  'Asad', 'Amna', 'Faisal', 'Rabia', 'Kashif', 'Saima', 'Tariq', 'Nadia', 'Umar', 'Iqra', 'Shahid', 'Mehwish'];
const LAST = ['Khan', 'Ahmed', 'Raza', 'Malik', 'Butt', 'Qureshi', 'Sheikh', 'Chaudhry', 'Mirza', 'Iqbal', 'Hussain', 'Javed',
  'Abbasi', 'Siddiqui', 'Anwar', 'Aslam'];

let cachedHash = null;
async function demoPasswordHash() {
  // One random, never-disclosed password hash for all demo patients (bcrypt per patient is slow).
  if (!cachedHash) cachedHash = await userService.hashPassword(crypto.randomBytes(24).toString('hex'));
  return cachedHash;
}

const pick = (arr) => arr[crypto.randomInt(0, arr.length)];
const between = (lo, hi) => lo + Math.random() * (hi - lo);

async function createDemoPatient(db, { prefix = 'demo-', fullName = null } = {}) {
  const tag = `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const id = await insertOne(db, User, {
    full_name: fullName || `${pick(FIRST)} ${pick(LAST)}`,
    email: `${prefix}${tag}@${DEMO_DOMAIN}`,
    phone: null,
    password_hash: await demoPasswordHash(),
    role: 'PATIENT',
    date_of_birth: null,
    priority_category: 'NONE',
    admin_branch_id: null,
    fcm_token: null,
    is_active: true,
    created_at: time.nowDb(),
  });
  return userService.getUserRow(db, id);
}

/** Active, bookable doctors with today's session (room). */
async function doctorsToday(db, now) {
  const ids = await Doctor.distinct('_id', { is_active: true });
  const doctors = [...(await scheduleService.getDoctors(db, ids)).values()].filter(scheduleService.isDoctorBookable);
  const date = time.formatDate(now);
  const out = [];
  for (const d of doctors) {
    const avail = await scheduleService.availability(db, d, date, now);
    if (avail.session) out.push({ ...d, session: avail.session, acceptingNow: avail.acceptingNow, queueLength: avail.queueLength });
  }
  return out.sort((a, b) => a.doctor_id - b.doctor_id);
}

async function modelTownBranch() {
  const branches = await Branch.find({ status: 'ACTIVE' }).sort({ _id: 1 }).lean();
  return branches.find((b) => b.name === 'Model Town') || branches[0] || null;
}

/** The doctor shown first at a branch: room "Room 1" if any, else the lowest doctor id. */
function roomOneDoctor(doctors, branchId) {
  const here = doctors.filter((d) => d.branch_id === branchId);
  return here.find((d) => d.session.servicePointName === 'Room 1') || here[0] || null;
}

async function insertEvent(db, tokenId, type, at, by = null) {
  await insertOne(db, models.QueueEvent, {
    token_id: tokenId,
    event_type: type,
    performed_by: by,
    from_point_id: null,
    to_point_id: null,
    note: 'Committee demo data',
    event_time: at,
  });
}

/** A finished token with its event trail; returns the token id. */
async function insertFinishedToken(db, { visitId, servicePointId, doctorId = null, queueType, date, issued, called, started, completed, by }) {
  const tokenNumber = await nextTokenNumber(servicePointId, date);
  const id = await insertOne(db, Token, {
    visit_id: visitId,
    service_point_id: servicePointId,
    doctor_id: doctorId,
    appointment_id: null,
    token_number: tokenNumber,
    token_date: date,
    queue_type: queueType,
    priority_level: 0,
    status: 'COMPLETED',
    issued_at: issued,
    called_at: called,
    completed_at: completed,
    is_synthetic: true,
  });
  await insertEvent(db, id, 'ISSUED', issued);
  await insertEvent(db, id, 'CALLED', called, by);
  await insertEvent(db, id, 'STARTED', started, by);
  await insertEvent(db, id, 'COMPLETED', completed, by);
  return id;
}

/** Window for "earlier today" activity: up to 6 h before now, ending 15 min ago. */
function historyWindow(now) {
  const dayStart = time.startOfDay(now).getTime();
  const end = now.getTime() - 15 * MINUTE;
  let start = Math.max(dayStart + 8 * 60 * MINUTE, now.getTime() - 6 * 60 * MINUTE);
  if (start > end - 60 * MINUTE) start = Math.max(dayStart + MINUTE, end - 3 * 60 * MINUTE);
  return { start, end: Math.max(end, start + 30 * MINUTE) };
}

/** Live load of every active branch (Eq. 6.5 summed over its departments). */
async function branchLoads(db, now = time.clock.now()) {
  const branches = await Branch.find({ status: 'ACTIVE' }).sort({ _id: 1 }).lean();
  const departments = await Department.find({ is_active: true, branch_id: { $in: branches.map((b) => b._id) } }).lean();
  const out = [];
  for (const b of branches) {
    let waiting = 0;
    let capacity = 0;
    const depts = [];
    for (const d of departments.filter((x) => x.branch_id === b._id)) {
      const c = await queueService.departmentCongestion(db, d._id, now);
      waiting += c.waiting;
      capacity += c.capacity;
      depts.push({ departmentId: d._id, name: d.name, specialty: d.specialty, waiting: c.waiting, capacity: c.capacity, ratio: c.ratio, level: c.level });
    }
    const ratio = capacity > 0 ? time.round(waiting / capacity, 2) : waiting > 0 ? 99 : 0;
    out.push({ branch: b, waiting, capacity: time.round(capacity, 1), ratio, departments: depts });
  }
  return out;
}

async function seedCommitteeDemo(db = getDb(), { now = time.clock.now() } = {}) {
  if (!config.demoTools) throw badRequest('Demo tools are not enabled');
  const date = time.formatDate(now);
  const modelTown = await modelTownBranch();
  if (!modelTown) throw badRequest('No active branch to seed');
  const doctors = await doctorsToday(db, now);
  const counters = await ServicePoint.find({ is_active: true, type: { $in: ['LAB', 'PHARMACY'] } }).lean();
  const counterOf = (branchId, type) => counters.find((c) => c.branch_id === branchId && c.type === type) || null;
  const touched = new Map(); // servicePointId -> branchId
  const { start, end } = historyWindow(now);

  let completedVisits = 0;
  const linked = { PHARMACY: 0, LAB: 0 };
  for (const doc of doctors) {
    const perDoctor = doc.branch_id === modelTown._id ? 3 : 1;
    const slot = (end - start) / perDoctor;
    const avg = Number(doc.avg_consult_minutes) || 10;
    const userRow = await userService.getUserRow(db, doc.user_id);
    for (let i = 0; i < perDoctor; i += 1) {
      const consult = Math.max(3, avg * between(0.7, 1.3)) * MINUTE;
      const issued = start + i * slot + between(0, slot * 0.25);
      const called = Math.min(issued + between(6, 32) * MINUTE, end - consult - 2 * MINUTE);
      const startedAt = called + between(0.5, 2) * MINUTE;
      const completedAt = startedAt + consult;
      const patient = await createDemoPatient(db);
      const visitId = await insertOne(db, Visit, { patient_id: patient.user_id, branch_id: doc.branch_id, visit_date: date, status: 'CLOSED' });
      await insertFinishedToken(db, {
        visitId,
        servicePointId: doc.session.servicePointId,
        doctorId: doc.doctor_id,
        queueType: 'OPD',
        date,
        issued: new Date(issued),
        called: new Date(Math.max(called, issued + MINUTE)),
        started: new Date(Math.max(startedAt, issued + 2 * MINUTE)),
        completed: new Date(Math.max(completedAt, issued + 5 * MINUTE)),
        by: userRow.user_id,
      });
      completedVisits += 1;
      touched.set(doc.session.servicePointId, doc.branch_id);

      // Referrals after the consultation: pharmacy (~40 %, ~3 min service), lab (~15 %).
      for (const [type, share, service] of [['PHARMACY', 0.4, [2, 4]], ['LAB', 0.15, [4, 8]]]) {
        const counter = counterOf(doc.branch_id, type);
        if (!counter || Math.random() >= share) continue;
        const lIssued = completedAt + MINUTE;
        const lCalled = Math.min(lIssued + between(2, 12) * MINUTE, now.getTime() - 6 * MINUTE);
        const lStarted = lCalled + 0.5 * MINUTE;
        const lCompleted = Math.min(lStarted + between(service[0], service[1]) * MINUTE, now.getTime() - MINUTE);
        if (lCompleted <= lIssued) continue;
        await insertFinishedToken(db, {
          visitId,
          servicePointId: counter._id,
          queueType: type,
          date,
          issued: new Date(lIssued),
          called: new Date(lCalled),
          started: new Date(lStarted),
          completed: new Date(lCompleted),
          by: null,
        });
        linked[type] += 1;
        touched.set(counter._id, doc.branch_id);
      }
    }
  }

  // Live queues to demonstrate "Call next": 5 waiting for the Room 1 doctor at Model Town ...
  const roomOne = roomOneDoctor(doctors, modelTown._id);
  const doctorWaiting = [];
  if (roomOne) {
    for (let i = 0; i < 5; i += 1) {
      const patient = await createDemoPatient(db);
      const detail = await queueService.issueOpdToken(db, patient, roomOne.doctor_id, { now });
      await Token.updateOne({ _id: detail.id }, { $set: { is_synthetic: true } });
      doctorWaiting.push(detail.displayNumber);
    }
  }
  // ... and 2 waiting at the Model Town pharmacy counter, referred by that doctor today.
  const pharmacyWaiting = [];
  const pharmacy = counterOf(modelTown._id, 'PHARMACY');
  if (roomOne && pharmacy) {
    const doctorUser = await userService.getUserRow(db, roomOne.user_id);
    for (let i = 0; i < 2; i += 1) {
      const patient = await createDemoPatient(db);
      const visitId = await insertOne(db, Visit, { patient_id: patient.user_id, branch_id: modelTown._id, visit_date: date, status: 'OPEN' });
      const done = now.getTime() - (12 - i * 5) * MINUTE;
      await insertFinishedToken(db, {
        visitId,
        servicePointId: roomOne.session.servicePointId,
        doctorId: roomOne.doctor_id,
        queueType: 'OPD',
        date,
        issued: new Date(done - 25 * MINUTE),
        called: new Date(done - 14 * MINUTE),
        started: new Date(done - 13 * MINUTE),
        completed: new Date(done),
        by: doctorUser.user_id,
      });
      const detail = await queueService.issueLinkedToken(db, doctorUser, visitId, { type: 'PHARMACY', servicePointId: pharmacy._id }, now);
      await Token.updateOne({ _id: detail.id }, { $set: { is_synthetic: true } });
      pharmacyWaiting.push(detail.displayNumber);
    }
  }

  for (const [spId, branchId] of touched) realtime.emitQueueUpdated(spId, branchId);
  const forecast = await forecastService.runForecasts(db, { now, preferAi: true }).catch((err) => ({ error: err.message }));

  return {
    date,
    completedVisits,
    linkedCompleted: { pharmacy: linked.PHARMACY, lab: linked.LAB },
    waiting: {
      doctor: roomOne ? { doctorName: roomOne.full_name, servicePointName: roomOne.session.servicePointName, branchName: modelTown.name, tokens: doctorWaiting } : null,
      pharmacy: pharmacy ? { servicePointName: pharmacy.name, branchName: modelTown.name, tokens: pharmacyWaiting } : null,
    },
    forecast: forecast && forecast.source ? { generated: forecast.generated, source: forecast.source } : forecast,
  };
}

/** Peak congestion toggle for Model Town (demo). */
async function setPeakCongestion(db = getDb(), enabled, { now = time.clock.now() } = {}) {
  if (!config.demoTools) throw badRequest('Demo tools are not enabled');
  const modelTown = await modelTownBranch();
  const loadOf = async () => (await branchLoads(db, now)).find((l) => l.branch._id === modelTown._id);
  let added = 0;
  let cancelled = 0;

  const date = time.formatDate(now);
  const keys = new Map(); // queue key id -> key, re-predicted once at the end
  const keyOf = (spId, doctorId) => {
    const key = { servicePointId: spId, date, doctorId };
    keys.set(`${spId}|${doctorId}`, key);
  };

  if (enabled) {
    const load = await loadOf();
    // Tokens needed for the branch to reach the target load (Eq. 6.5: waiting ÷ capacity).
    const need = Math.min(PEAK_MAX_TOKENS, Math.max(0, Math.ceil(PEAK_TARGET * load.capacity) - load.waiting + 1));
    const doctors = (await doctorsToday(db, now)).filter((d) => d.branch_id === modelTown._id && d.acceptingNow);
    if (need > 0 && doctors.length) {
      const queueLen = new Map(doctors.map((d) => [d.doctor_id, d.queueLength]));
      // Bulk path (a live button must be quick): patient, open visit, WAITING token and its ISSUED
      // event, spread over the doctors with the shortest queues; each queue is re-predicted once.
      for (let i = 0; i < need; i += 1) {
        const doctor = doctors.reduce((best, d) => (queueLen.get(d.doctor_id) < queueLen.get(best.doctor_id) ? d : best), doctors[0]);
        queueLen.set(doctor.doctor_id, queueLen.get(doctor.doctor_id) + 1);
        const patient = await createDemoPatient(db, { prefix: PEAK_PREFIX });
        const visitId = await insertOne(db, Visit, { patient_id: patient.user_id, branch_id: modelTown._id, visit_date: date, status: 'OPEN' });
        const issued = new Date(now.getTime() - (need - i) * 15 * 1000); // keeps arrival order
        const tokenId = await insertOne(db, Token, {
          visit_id: visitId,
          service_point_id: doctor.session.servicePointId,
          doctor_id: doctor.doctor_id,
          appointment_id: null,
          token_number: await nextTokenNumber(doctor.session.servicePointId, date),
          token_date: date,
          queue_type: 'OPD',
          priority_level: 0,
          status: 'WAITING',
          issued_at: issued,
          called_at: null,
          completed_at: null,
          is_synthetic: true,
        });
        await insertOne(db, models.QueueEvent, { token_id: tokenId, event_type: 'ISSUED', performed_by: null, from_point_id: null, to_point_id: null, note: 'Demo peak congestion', event_time: issued });
        keyOf(doctor.session.servicePointId, doctor.doctor_id);
        added += 1;
      }
    }
  } else {
    const peakPatients = await User.find({ email: { $regex: `^${PEAK_PREFIX}.*@${DEMO_DOMAIN.replace(/\./g, '\\.')}$` } }, { _id: 1 }).lean();
    const visits = await Visit.find({ patient_id: { $in: peakPatients.map((p) => p._id) } }, { _id: 1 }).lean();
    const waiting = await Token.find({ visit_id: { $in: visits.map((v) => v._id) }, status: 'WAITING' }, { _id: 1, service_point_id: 1, doctor_id: 1 }).lean();
    const at = time.dbDate(now);
    for (const t of waiting) {
      const res = await Token.updateOne({ _id: t._id, status: 'WAITING' }, { $set: { status: 'CANCELLED', completed_at: at } });
      if (!res.modifiedCount) continue;
      await insertOne(db, models.QueueEvent, { token_id: t._id, event_type: 'CANCELLED', performed_by: null, from_point_id: null, to_point_id: null, note: 'Demo peak congestion cleared', event_time: at });
      keyOf(t.service_point_id, t.doctor_id);
      cancelled += 1;
    }
    await Visit.updateMany({ _id: { $in: visits.map((v) => v._id) }, status: 'OPEN' }, { $set: { status: 'CLOSED' } });
  }

  // Re-predict each touched queue once (FR-07) and push the live updates (FR-05).
  await queueService.propagate(db, [...keys.values()], { now });
  for (const key of keys.values()) realtime.emitQueueUpdated(key.servicePointId, modelTown._id);

  const load = await loadOf();
  return {
    enabled: Boolean(enabled),
    branch: { id: modelTown._id, name: modelTown.name },
    added,
    cancelled,
    load: { waiting: load.waiting, capacity: load.capacity, ratio: load.ratio, percent: Math.round(load.ratio * 100) },
    peakActive: await peakActive(db),
  };
}

/** Whether peak-congestion demo tokens are currently waiting. */
async function peakActive() {
  const peakPatients = await User.find({ email: { $regex: `^${PEAK_PREFIX}.*@${DEMO_DOMAIN.replace(/\./g, '\\.')}$` } }, { _id: 1 }).lean();
  if (!peakPatients.length) return false;
  const visits = await Visit.distinct('_id', { patient_id: { $in: peakPatients.map((p) => p._id) } });
  return Boolean(await Token.exists({ visit_id: { $in: visits }, status: 'WAITING' }));
}

/**
 * POST /demo/reset — delete everything the demo tools created: demo, peak and walk-in kiosk patients
 * (generated e-mail domains) with their visits, tokens, queue events, predictions, notifications,
 * feedback and appointments. Seeded accounts and the seeded history are not touched. Queues that
 * lose WAITING tokens are re-predicted once and pushed live.
 */
const GENERATED_DOMAINS = [DEMO_DOMAIN, 'walkin.opd.local'];
async function resetDemoData(db = getDb(), { now = time.clock.now() } = {}) {
  if (!config.demoTools) throw badRequest('Demo tools are not enabled');
  const pattern = `@(${GENERATED_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})$`;
  const patients = await User.find({ role: 'PATIENT', email: { $regex: pattern } }, { _id: 1 }).lean();
  const patientIds = patients.map((p) => p._id);
  const visitIds = await Visit.distinct('_id', { patient_id: { $in: patientIds } });
  const tokens = await Token.find({ visit_id: { $in: visitIds } }, { _id: 1, status: 1, service_point_id: 1, doctor_id: 1, token_date: 1 }).lean();
  const tokenIds = tokens.map((t) => t._id);
  const today = time.formatDate(now);
  const keys = new Map();
  for (const t of tokens) {
    if (t.token_date !== today || !['WAITING', 'CALLED', 'IN_SERVICE'].includes(t.status)) continue;
    keys.set(`${t.service_point_id}:${t.doctor_id || 0}`, { servicePointId: t.service_point_id, date: today, doctorId: t.doctor_id || null });
  }
  const removed = {
    patients: patientIds.length,
    visits: visitIds.length,
    tokens: tokenIds.length,
    events: (await models.QueueEvent.deleteMany({ token_id: { $in: tokenIds } })).deletedCount,
    predictions: (await models.WaitPrediction.deleteMany({ token_id: { $in: tokenIds } })).deletedCount,
    notifications: (await models.Notification.deleteMany({ $or: [{ user_id: { $in: patientIds } }, { token_id: { $in: tokenIds } }] })).deletedCount,
    feedback: (await models.Feedback.deleteMany({ visit_id: { $in: visitIds } })).deletedCount,
    appointments: (await models.Appointment.deleteMany({ patient_id: { $in: patientIds } })).deletedCount,
  };
  await Token.deleteMany({ _id: { $in: tokenIds } });
  await Visit.deleteMany({ _id: { $in: visitIds } });
  await User.deleteMany({ _id: { $in: patientIds } });
  if (keys.size) {
    await queueService.propagate(db, [...keys.values()], { now });
    const points = await ServicePoint.find({ _id: { $in: [...new Set([...keys.values()].map((k) => k.servicePointId))] } }, { branch_id: 1 }).lean();
    for (const sp of points) realtime.emitQueueUpdated(sp._id, sp.branch_id);
  }
  return { removed, peakActive: false };
}

module.exports = { resetDemoData, seedCommitteeDemo, setPeakCongestion, peakActive, branchLoads, doctorsToday, haversineKm: fb.haversineKm };
