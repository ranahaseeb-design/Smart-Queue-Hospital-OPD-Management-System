'use strict';
/**
 * Seed contents (contract accounts and master data, synthetic history) and the key property of
 * the synthetic history: every stored `features` object equals what the live feature builder writes.
 * The second part drives a scripted day through the live API and checks that the seed's as-of
 * replay (db/history.js) reproduces each live first prediction exactly.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext, ACCOUNTS } = require('./helpers');
const fb = require('../src/services/featureBuilder');
const { replayFirstPredictions } = require('../src/db/history');

let ctx;
let M; // models
before(async () => {
  ctx = await createContext('seed', { historyDays: 10 });
  M = ctx.models;
});
after(async () => {
  await ctx.close();
});

/** { value: count } of a field over a collection (optionally filtered). */
async function countBy(Model, field, filter = {}) {
  const rows = await Model.aggregate([{ $match: filter }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

test('every contract account can log in with the documented password', async () => {
  for (const key of Object.keys(ACCOUNTS)) {
    const [identifier, password] = ACCOUNTS[key];
    const res = await ctx.api.post('/auth/login', null, { identifier, password });
    assert.equal(res.status, 200, identifier);
  }
  const byPhone = await ctx.api.post('/auth/login', null, { identifier: '03001234567', password: 'Patient@123' });
  assert.equal(byPhone.body.user.email, 'patient@opd.test');
  assert.equal(byPhone.body.user.priorityCategory, 'NONE');
  const doctorCount = await M.Doctor.countDocuments();
  const last = await ctx.api.post('/auth/login', null, { identifier: `doctor${doctorCount}@opd.test`, password: 'Staff@123' });
  assert.equal(last.status, 200);
  const byRole = await countBy(M.User, 'role');
  assert.equal(byRole.HOSPITAL_ADMIN, 1);
  assert.equal(byRole.BRANCH_ADMIN, 1);
  assert.equal(byRole.STAFF, doctorCount + 2);
  const ba = await M.User.findOne({ email: 'branchadmin@opd.test' }).lean();
  assert.equal(ba.admin_branch_id, 1);
});

test('master data: 3 Lahore branches, 4-5 departments, 2 doctors each, rooms, counters, schedules', async () => {
  const branches = await M.Branch.find().sort({ _id: 1 }).lean();
  assert.deepEqual(
    branches.map((b) => [b.name, b.latitude, b.longitude]),
    [['Model Town', 31.4834, 74.3255], ['Gulberg', 31.5204, 74.3587], ['DHA', 31.4697, 74.4091]]
  );
  const allowed = ['General Medicine', 'Cardiology', 'Pediatrics', 'ENT', 'Orthopedics', 'Dermatology'];
  for (const b of branches) {
    const depts = await M.Department.find({ branch_id: b._id }).lean();
    assert.ok(depts.length >= 4 && depts.length <= 5);
    assert.ok(depts.every((d) => allowed.includes(d.specialty)));
    assert.ok(depts.some((d) => d.specialty === 'Cardiology'));
    assert.ok(depts.some((d) => d.specialty === 'General Medicine'));
    for (const d of depts) {
      assert.equal(await M.Doctor.countDocuments({ department_id: d._id }), 2);
    }
    const byType = await countBy(M.ServicePoint, 'type', { branch_id: b._id });
    assert.equal(byType.LAB, 1);
    assert.equal(byType.PHARMACY, 1);
    assert.equal(byType.OPD, depts.length * 2);
  }
  const sched = await M.DoctorSchedule.aggregate([
    { $group: { _id: '$doctor_id', days: { $addToSet: '$day_of_week' }, mp: { $min: '$max_patients' } } },
  ]);
  assert.ok(sched.every((s) => s.days.length === 7 && s.mp === 40));
  const shifts = (await M.DoctorSchedule.aggregate([{ $group: { _id: { s: '$start_time', e: '$end_time' } } }]))
    .map((x) => `${x._id.s}-${x._id.e}`)
    .sort();
  assert.deepEqual(shifts, ['08:00:00-14:00:00', '14:00:00-22:00:00']);
  // every doctor is assigned to their own room; lab1 / pharmacy1 to branch-1 counters
  let own = 0;
  for (const d of await M.Doctor.find().lean()) {
    const rooms = await M.StaffAssignment.distinct('service_point_id', { user_id: d.user_id });
    own += await M.DoctorSchedule.countDocuments({ doctor_id: d._id, day_of_week: 1, service_point_id: { $in: rooms } });
  }
  assert.equal(own, sched.length);
  const counters = [];
  for (const email of ['lab1@opd.test', 'pharmacy1@opd.test']) {
    const u = await M.User.findOne({ email }).lean();
    for (const a of await M.StaffAssignment.find({ user_id: u._id }).lean()) {
      const sp = await M.ServicePoint.findById(a.service_point_id).lean();
      counters.push([email, sp.type, sp.branch_id]);
    }
  }
  assert.deepEqual(counters, [
    ['lab1@opd.test', 'LAB', 1],
    ['pharmacy1@opd.test', 'PHARMACY', 1],
  ]);
});

test('synthetic history: flagged rows, events, one prediction per token, feedback, closed visits', async () => {
  const today = ctx.time.today();
  const past = { token_date: { $lt: today } };
  const n = await M.Token.countDocuments(past);
  const synthetic = await M.Token.countDocuments({ ...past, is_synthetic: true });
  const days = (await M.Token.distinct('token_date', past)).length;
  assert.ok(n > 1000);
  assert.equal(synthetic, n);
  assert.equal(days, 10);
  const types = await M.Token.distinct('queue_type');
  assert.deepEqual(types.sort(), ['LAB', 'OPD', 'PHARMACY']);
  const predN = await M.WaitPrediction.countDocuments();
  const predTokens = (await M.WaitPrediction.distinct('token_id')).length;
  const versions = await M.WaitPrediction.distinct('model_version');
  assert.equal(predN, predTokens);
  assert.equal(predTokens, n + 5);
  assert.deepEqual(versions, ['baseline']);
  const sample = await M.WaitPrediction.find().sort({ _id: 1 }).limit(50).lean();
  for (const r of sample) assert.deepEqual(Object.keys(r.features), [...fb.FEATURE_KEYS]);

  const issuedTokens = new Set(await M.QueueEvent.distinct('token_id', { event_type: 'ISSUED' }));
  const allTokens = await M.Token.find({}, { status: 1, completed_at: 1 }).lean();
  assert.equal(allTokens.filter((t) => !issuedTokens.has(t._id)).length, 0);
  const completedEvents = await M.QueueEvent.find({ event_type: 'COMPLETED' }, { token_id: 1, event_time: 1 }).lean();
  const completedAt = new Set(completedEvents.map((e) => `${e.token_id}|${e.event_time.getTime()}`));
  const completedWithoutEvent = allTokens.filter(
    (t) => t.status === 'COMPLETED' && !completedAt.has(`${t._id}|${t.completed_at.getTime()}`)
  );
  assert.equal(completedWithoutEvent.length, 0);
  const kinds = await M.QueueEvent.distinct('event_type');
  for (const k of ['CALLED', 'COMPLETED', 'ISSUED', 'NO_SHOW', 'PRIORITY_SET', 'RECALLED', 'SKIPPED', 'STARTED']) {
    assert.ok(kinds.includes(k), k);
  }
  assert.ok((await M.Token.countDocuments({ priority_level: { $gt: 0 } })) > 0);
  const opdVisits = new Set(await M.Token.distinct('visit_id', { queue_type: 'OPD' }));
  const linkedVisits = await M.Token.distinct('visit_id', { queue_type: { $ne: 'OPD' } });
  assert.ok(linkedVisits.some((v) => opdVisits.has(v)));
  assert.equal(await M.Visit.countDocuments({ status: 'OPEN', visit_date: { $lt: today } }), 0);
  assert.equal(
    await M.Token.countDocuments({ ...past, status: { $in: ['WAITING', 'CALLED', 'IN_SERVICE', 'SKIPPED'] } }),
    0
  );

  const feedbackCount = await M.Feedback.countDocuments();
  const completedVisits = (await M.Token.distinct('visit_id', { queue_type: 'OPD', status: 'COMPLETED' })).length;
  const share = feedbackCount / completedVisits;
  assert.ok(share > 0.2 && share < 0.4, `feedback share ${share}`);
});

test("today's WAITING tokens (incl. doctor1's room) and the demo patient's past visit", async () => {
  const todayTokens = await M.Token.find({ token_date: ctx.time.today() }).lean();
  assert.equal(todayTokens.length, 5);
  for (const t of todayTokens) {
    const v = await M.Visit.findById(t.visit_id).lean();
    assert.equal(t.status, 'WAITING');
    assert.equal(v.status, 'OPEN');
  }
  const doctor1 = await M.User.findOne({ email: 'doctor1@opd.test' }).lean();
  const doctor1Room = await M.StaffAssignment.findOne({ user_id: doctor1._id }).lean();
  assert.equal(todayTokens.filter((t) => t.service_point_id === doctor1Room.service_point_id).length, 3);

  const demoUser = await M.User.findOne({ email: 'patient@opd.test' }).lean();
  const demoVisits = await M.Visit.distinct('_id', { patient_id: demoUser._id });
  const demo = await M.Token.find({ visit_id: { $in: demoVisits }, queue_type: 'OPD' }).lean();
  assert.equal(demo.length, 1);
  assert.equal(demo[0].status, 'COMPLETED');
  assert.equal(await M.Feedback.countDocuments({ visit_id: demo[0].visit_id }), 0);
});

test('doctor averages equal the rolling mean of the last 30 consultations (nightly job is a no-op)', async () => {
  const predictionService = require('../src/services/predictionService');
  const updated = await predictionService.refreshDoctorAverages(ctx.db);
  assert.equal(updated, 0);
  assert.ok((await M.Forecast.countDocuments()) > 0);
});

// ---------------------------------------------------------------------------------------------
// Replay equivalence: live API predictions == seed replay
// ---------------------------------------------------------------------------------------------

const STATUS_OF_EVENT = {
  ISSUED: 'WAITING',
  CALLED: 'CALLED',
  RECALLED: 'CALLED',
  STARTED: 'IN_SERVICE',
  SKIPPED: 'SKIPPED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  TRANSFERRED: 'TRANSFERRED',
  NO_SHOW: 'NO_SHOW',
};

/** Rebuild timelines of a date from the tokens and queue_events collections. */
async function timelinesFromDb(date) {
  const time = ctx.time;
  const tokenDocs = await M.Token.find({ token_date: date }).sort({ _id: 1 }).lean();
  const rows = [];
  for (const t of tokenDocs) {
    const v = await M.Visit.findById(t.visit_id).lean();
    const u = await M.User.findById(v.patient_id).lean();
    const d = t.doctor_id ? await M.Doctor.findById(t.doctor_id).lean() : null;
    rows.push({
      ...t,
      token_id: t._id,
      branch_id: v.branch_id,
      department_id: d ? d.department_id : null,
      priority_category: u.priority_category,
    });
  }
  const events = await M.QueueEvent.find({ token_id: { $in: rows.map((r) => r.token_id) } }).sort({ _id: 1 }).lean();
  const byToken = new Map(rows.map((r) => [r.token_id, []]));
  for (const e of events) byToken.get(e.token_id).push(e);
  const tokens = rows.map((r) => {
    const evs = byToken.get(r.token_id);
    const priorityChanges = evs
      .filter((e) => e.event_type === 'PRIORITY_SET')
      .map((e) => ({ at: time.parseDateTime(e.event_time), level: Number(/^Level (\d)/.exec(e.note)[1]) }));
    return {
      id: r.token_id,
      servicePointId: r.service_point_id,
      doctorId: r.doctor_id,
      departmentId: r.department_id,
      branchId: r.branch_id,
      queueType: r.queue_type,
      issuedAt: time.parseDateTime(r.issued_at),
      changes: evs
        .filter((e) => STATUS_OF_EVENT[e.event_type])
        .map((e) => ({ at: time.parseDateTime(e.event_time), status: STATUS_OF_EVENT[e.event_type] })),
      initialPriority: priorityChanges.length ? (r.priority_category === 'NONE' ? 0 : 1) : Number(r.priority_level),
      priorityChanges,
    };
  });
  const eventMap = new Map(tokens.map((t) => [t.id, byToken.get(t.id).map((e) => ({ type: e.event_type, at: time.parseDateTime(e.event_time) }))]));
  return { tokens, events: eventMap };
}

test('seed replay reproduces the live first prediction of every token (features + minutes)', async () => {
  const scheduleService = require('../src/services/scheduleService');
  const predictionService = require('../src/services/predictionService');
  const { db, api, time } = ctx;
  const today = time.today();
  const maxSeeded = (await M.Token.findOne().sort({ _id: -1 }).lean())._id;

  const d1 = await ctx.login('doctor1');
  const d2 = await ctx.login('doctor2');
  const lab = await ctx.login('lab1');
  const me1 = (await api.get('/auth/me', d1)).body.user;
  const me2 = (await api.get('/auth/me', d2)).body.user;
  const room1 = me1.assignments[0].servicePointId;
  const room2 = me2.assignments[0].servicePointId;
  const labRoom = (await api.get('/auth/me', lab)).body.user.assignments[0].servicePointId;

  const pt = {};
  for (const k of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'L']) {
    pt[k] = await ctx.newPatient(k === 'E' || k === 'H' ? { priorityCategory: 'ELDERLY', dateOfBirth: '1952-06-15' } : {});
  }
  const ok = (res, status = 200) => {
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const join = async (k, doctorId) => ok(await api.post('/tokens', pt[k].token, { doctorId }), 201);
  const step = (m = 1) => ctx.advance(m);

  // F books an appointment with doctor2 later today (before any scenario token exists)
  const slots = ok(await api.get(`/doctors/${me2.doctorId}/slots?date=${today}`, pt.F.token));
  // Check-in opens 60 min before the slot and F checks in ~27 min into the scenario: on days
  // doctor2 works the evening shift, start the scenario 75 min before the slot.
  const s3 = slots.slots[3].start;
  const toSlot = (time.combine(s3.slice(0, 10), s3.slice(11)) - time.clock.now()) / 60000;
  if (toSlot > 75) ctx.advance(toSlot - 75);
  const appt = ok(await api.post('/appointments', pt.F.token, { doctorId: me2.doctorId, slotStart: slots.slots[3].start }), 201);

  const tok = {};
  step(); tok.A = await join('A', me2.doctorId);
  step(2); tok.B = await join('B', me2.doctorId);
  step(); tok.E = await join('E', me2.doctorId);
  step(3); ok(await api.post(`/service-points/${room2}/call-next`, d2));
  step(); ok(await api.post(`/tokens/${tok.E.id}/start`, d2));
  step(4); tok.C = await join('C', me2.doctorId);
  step(5); ok(await api.post(`/tokens/${tok.E.id}/complete`, d2));
  step(); ok(await api.post(`/service-points/${room2}/call-next`, d2));
  step(2); ok(await api.post(`/tokens/${tok.A.id}/skip`, d2));
  step(); tok.D = await join('D', me2.doctorId);
  step(); ok(await api.post(`/service-points/${room2}/call-next`, d2));
  step(); ok(await api.post(`/tokens/${tok.D.id}/priority`, d2, { level: 2, reason: 'Emergency case' }));
  step(2); ok(await api.post(`/tokens/${tok.B.id}/complete`, d2));
  step(); ok(await api.post(`/tokens/${tok.A.id}/recall`, d2));
  step(); tok.F = ok(await api.post(`/appointments/${appt.id}/check-in`, pt.F.token), 201);
  step(3); ok(await api.post(`/tokens/${tok.A.id}/complete`, d2));
  step(); tok.G = await join('G', me2.doctorId);
  step(); tok.LAB = ok(await api.post(`/visits/${tok.B.visitId}/linked-tokens`, d2, { type: 'LAB' }), 201);
  step(); tok.H = await join('H', me1.doctorId);
  step(); ok(await api.del(`/tokens/${tok.C.id}`, pt.C.token));
  step(); tok.I = await join('I', me2.doctorId);
  step(); ok(await api.post(`/service-points/${room1}/call-next`, d1));
  step(); tok.J = await join('J', me1.doctorId);
  step(); ok(await api.post(`/service-points/${labRoom}/call-next`, lab));
  step(); tok.PH = ok(await api.post(`/visits/${tok.E.visitId}/linked-tokens`, d2, { type: 'PHARMACY' }), 201);
  step(); tok.LAB2 = ok(await api.post(`/visits/${tok.A.visitId}/linked-tokens`, d2, { type: 'LAB' }), 201);
  step(); ok(await api.post(`/tokens/${tok.D.id}/transfer`, d2, { toServicePointId: room1 }));
  step(); await join('L', me2.doctorId);

  // Replay context, assembled exactly like the seed does for a simulated day.
  const { tokens, events } = await timelinesFromDb(today);
  const doctors = new Map();
  const departmentSessions = new Map();
  for (const doctorId of [me1.doctorId, me2.doctorId]) {
    const doc = await scheduleService.getDoctor(db, doctorId);
    const sessions = await scheduleService.doctorSessions(db, doctorId, today);
    doctors.set(doctorId, {
      id: doctorId,
      departmentId: doc.department_id,
      branchId: doc.branch_id,
      avgConsultMinutes: Number(doc.avg_consult_minutes),
      session: scheduleService.pickSession(sessions, today, time.clock.now()),
    });
    if (!departmentSessions.has(doc.department_id)) {
      departmentSessions.set(doc.department_id, await scheduleService.departmentSessions(db, doc.department_id, today));
    }
  }
  const counterAverages = new Map();
  for (const sp of await M.ServicePoint.find({ branch_id: 1, type: { $ne: 'OPD' } }).lean()) {
    counterAverages.set(sp._id, await predictionService.servicePointAverage(db, sp._id, sp.type, today));
  }
  const apptDocs = await M.Appointment.find({ doctor_id: me2.doctorId, slot_start: { $gte: time.dayStart(today) } }).lean();
  const apptRows = [];
  for (const a of apptDocs) {
    const t = await M.Token.findOne({ appointment_id: a._id }).lean();
    apptRows.push({ slot_start: a.slot_start, checked_in: t ? t.issued_at : null });
  }
  const appointments = new Map([
    [
      me2.doctorId,
      apptRows.map((a) => ({
        slot: time.parseDateTime(a.slot_start),
        bookedFrom: null,
        bookedUntil: a.checked_in ? time.parseDateTime(a.checked_in) : null,
      })),
    ],
  ]);
  const scenarioIds = new Set(tokens.filter((t) => t.id > maxSeeded).map((t) => t.id));
  assert.ok(scenarioIds.size >= 15);
  const replay = replayFirstPredictions({ tokens, events, doctors, counterAverages, departmentSessions, appointments, only: scenarioIds });

  // First prediction (lowest _id) of every scenario token.
  const first = await M.WaitPrediction.aggregate([
    { $match: { token_id: { $gt: maxSeeded } } },
    { $sort: { _id: 1 } },
    { $group: { _id: '$token_id', predicted_minutes: { $first: '$predicted_minutes' }, features: { $first: '$features' } } },
  ]);
  assert.equal(first.length, scenarioIds.size);
  let interesting = 0;
  for (const row of first) {
    const expected = replay.get(row._id);
    assert.deepEqual(expected.features, row.features, `token ${row._id} features`);
    assert.equal(expected.minutes, row.predicted_minutes, `token ${row._id} minutes`);
    const f = expected.features;
    if (f.interruptions_last_hour > 0 || f.appointments_ahead > 0 || f.priority_ahead > 0 || f.session_started) interesting += 1;
  }
  assert.ok(interesting >= 5, 'scenario exercised interruptions, appointments and priorities');
});

test('rolling averages do not depend on summation order (a mean of exactly x.xx5 rounds the same way)', () => {
  const { meanMinutes } = require('../src/utils/time');
  // 727 s and 728 s average 727.5 s = 12.125 min exactly.
  const durations = [727 / 60, 728 / 60, 727 / 60, 728 / 60];
  assert.equal(meanMinutes(durations), 12.13);
  assert.equal(meanMinutes([...durations].reverse()), 12.13);
  assert.equal(meanMinutes([]), null);
});
