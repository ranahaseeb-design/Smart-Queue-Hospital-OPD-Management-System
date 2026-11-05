'use strict';
/**
 * Seed contents (contract accounts and master data, synthetic history) and the key property of
 * the synthetic history: every stored features_json equals what the live feature builder writes.
 * The second part drives a scripted day through the live API and checks that the seed's as-of
 * replay (db/history.js) reproduces each live first prediction exactly.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext, ACCOUNTS } = require('./helpers');
const fb = require('../src/services/featureBuilder');
const { replayFirstPredictions } = require('../src/db/history');

let ctx;
before(async () => {
  ctx = await createContext('seed', { historyDays: 10 });
});
after(async () => {
  await ctx.close();
});

test('every contract account can log in with the documented password', async () => {
  for (const key of Object.keys(ACCOUNTS)) {
    const [identifier, password] = ACCOUNTS[key];
    const res = await ctx.api.post('/auth/login', null, { identifier, password });
    assert.equal(res.status, 200, identifier);
  }
  const byPhone = await ctx.api.post('/auth/login', null, { identifier: '03001234567', password: 'Patient@123' });
  assert.equal(byPhone.body.user.email, 'patient@opd.test');
  assert.equal(byPhone.body.user.priorityCategory, 'NONE');
  const doctorCount = await ctx.db.get('SELECT COUNT(*) AS n FROM doctors', []);
  const last = await ctx.api.post('/auth/login', null, { identifier: `doctor${doctorCount.n}@opd.test`, password: 'Staff@123' });
  assert.equal(last.status, 200);
  const roles = await ctx.db.query('SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role', []);
  const byRole = Object.fromEntries(roles.map((r) => [r.role, r.n]));
  assert.equal(byRole.HOSPITAL_ADMIN, 1);
  assert.equal(byRole.BRANCH_ADMIN, 1);
  assert.equal(byRole.STAFF, doctorCount.n + 2);
  const ba = await ctx.db.get(`SELECT admin_branch_id FROM users WHERE email = 'branchadmin@opd.test'`, []);
  assert.equal(ba.admin_branch_id, 1);
});

test('master data: 3 Lahore branches, 4-5 departments, 2 doctors each, rooms, counters, schedules', async () => {
  const branches = await ctx.db.query('SELECT * FROM branches ORDER BY branch_id', []);
  assert.deepEqual(
    branches.map((b) => [b.name, b.latitude, b.longitude]),
    [['Model Town', 31.4834, 74.3255], ['Gulberg', 31.5204, 74.3587], ['DHA', 31.4697, 74.4091]]
  );
  const allowed = ['General Medicine', 'Cardiology', 'Pediatrics', 'ENT', 'Orthopedics', 'Dermatology'];
  for (const b of branches) {
    const depts = await ctx.db.query('SELECT * FROM departments WHERE branch_id = ?', [b.branch_id]);
    assert.ok(depts.length >= 4 && depts.length <= 5);
    assert.ok(depts.every((d) => allowed.includes(d.specialty)));
    assert.ok(depts.some((d) => d.specialty === 'Cardiology'));
    assert.ok(depts.some((d) => d.specialty === 'General Medicine'));
    for (const d of depts) {
      const n = await ctx.db.get('SELECT COUNT(*) AS n FROM doctors WHERE department_id = ?', [d.department_id]);
      assert.equal(n.n, 2);
    }
    const sp = await ctx.db.query('SELECT type, COUNT(*) AS n FROM service_points WHERE branch_id = ? GROUP BY type', [b.branch_id]);
    const byType = Object.fromEntries(sp.map((r) => [r.type, r.n]));
    assert.equal(byType.LAB, 1);
    assert.equal(byType.PHARMACY, 1);
    assert.equal(byType.OPD, depts.length * 2);
  }
  const sched = await ctx.db.query('SELECT doctor_id, COUNT(DISTINCT day_of_week) AS days, MIN(max_patients) AS mp FROM doctor_schedules GROUP BY doctor_id', []);
  assert.ok(sched.every((s) => s.days === 7 && s.mp === 40));
  const shifts = await ctx.db.query('SELECT DISTINCT start_time, end_time FROM doctor_schedules ORDER BY start_time', []);
  assert.deepEqual(shifts.map((s) => `${s.start_time}-${s.end_time}`), ['08:00:00-14:00:00', '14:00:00-22:00:00']);
  // every doctor is assigned to their own room; lab1 / pharmacy1 to branch-1 counters
  const own = await ctx.db.query(
    `SELECT COUNT(*) AS n FROM doctors d JOIN staff_assignments sa ON sa.user_id = d.user_id
       JOIN doctor_schedules ds ON ds.doctor_id = d.doctor_id AND ds.service_point_id = sa.service_point_id AND ds.day_of_week = 1`,
    []
  );
  assert.equal(own[0].n, sched.length);
  const counters = await ctx.db.query(
    `SELECT u.email, sp.type, sp.branch_id FROM staff_assignments sa JOIN users u ON u.user_id = sa.user_id
       JOIN service_points sp ON sp.service_point_id = sa.service_point_id WHERE u.email IN ('lab1@opd.test', 'pharmacy1@opd.test')
      ORDER BY u.email`,
    []
  );
  assert.deepEqual(counters.map((c) => [c.email, c.type, c.branch_id]), [
    ['lab1@opd.test', 'LAB', 1],
    ['pharmacy1@opd.test', 'PHARMACY', 1],
  ]);
});

test('synthetic history: flagged rows, events, one prediction per token, feedback, closed visits', async () => {
  const today = ctx.time.today();
  const tokens = await ctx.db.get(
    `SELECT COUNT(*) AS n, SUM(is_synthetic) AS s, COUNT(DISTINCT token_date) AS days FROM tokens WHERE token_date < ?`,
    [today]
  );
  assert.ok(tokens.n > 1000);
  assert.equal(tokens.s, tokens.n);
  assert.equal(tokens.days, 10);
  const types = await ctx.db.query(`SELECT queue_type, COUNT(*) AS n FROM tokens GROUP BY queue_type`, []);
  assert.deepEqual(types.map((t) => t.queue_type).sort(), ['LAB', 'OPD', 'PHARMACY']);
  const preds = await ctx.db.get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT token_id) AS t, MIN(model_version) AS mv, MAX(model_version) AS mv2 FROM wait_predictions`,
    []
  );
  assert.equal(preds.n, preds.t);
  assert.equal(preds.t, tokens.n + 5);
  assert.equal(preds.mv, 'baseline');
  assert.equal(preds.mv2, 'baseline');
  const sample = await ctx.db.query('SELECT features_json FROM wait_predictions ORDER BY prediction_id LIMIT 50', []);
  for (const r of sample) assert.deepEqual(Object.keys(JSON.parse(r.features_json)), [...fb.FEATURE_KEYS]);

  const noIssued = await ctx.db.get(
    `SELECT COUNT(*) AS n FROM tokens t WHERE NOT EXISTS (SELECT 1 FROM queue_events e WHERE e.token_id = t.token_id AND e.event_type = 'ISSUED')`,
    []
  );
  assert.equal(noIssued.n, 0);
  const completedWithoutEvent = await ctx.db.get(
    `SELECT COUNT(*) AS n FROM tokens t WHERE t.status = 'COMPLETED' AND NOT EXISTS
       (SELECT 1 FROM queue_events e WHERE e.token_id = t.token_id AND e.event_type = 'COMPLETED' AND e.event_time = t.completed_at)`,
    []
  );
  assert.equal(completedWithoutEvent.n, 0);
  const kinds = await ctx.db.query('SELECT DISTINCT event_type FROM queue_events ORDER BY event_type', []);
  for (const k of ['CALLED', 'COMPLETED', 'ISSUED', 'NO_SHOW', 'PRIORITY_SET', 'RECALLED', 'SKIPPED', 'STARTED']) {
    assert.ok(kinds.some((x) => x.event_type === k), k);
  }
  const priority = await ctx.db.get(`SELECT COUNT(*) AS n FROM tokens WHERE priority_level > 0`, []);
  assert.ok(priority.n > 0);
  const linked = await ctx.db.get(
    `SELECT COUNT(*) AS n FROM tokens l JOIN tokens o ON o.visit_id = l.visit_id AND o.queue_type = 'OPD' WHERE l.queue_type <> 'OPD'`,
    []
  );
  assert.ok(linked.n > 0);
  const open = await ctx.db.get(`SELECT COUNT(*) AS n FROM visits WHERE status = 'OPEN' AND visit_date < ?`, [today]);
  assert.equal(open.n, 0);
  const stale = await ctx.db.get(`SELECT COUNT(*) AS n FROM tokens WHERE token_date < ? AND status IN ('WAITING', 'CALLED', 'IN_SERVICE', 'SKIPPED')`, [today]);
  assert.equal(stale.n, 0);

  const fbRow = await ctx.db.get(
    `SELECT COUNT(*) AS f, (SELECT COUNT(DISTINCT visit_id) FROM tokens WHERE queue_type = 'OPD' AND status = 'COMPLETED') AS v FROM feedback`,
    []
  );
  const share = fbRow.f / fbRow.v;
  assert.ok(share > 0.2 && share < 0.4, `feedback share ${share}`);
});

test("today's WAITING tokens (incl. doctor1's room) and the demo patient's past visit", async () => {
  const rows = await ctx.db.query(
    `SELECT t.service_point_id, t.status, v.status AS visit_status FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
      WHERE t.token_date = ?`,
    [ctx.time.today()]
  );
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.status === 'WAITING' && r.visit_status === 'OPEN'));
  const doctor1Room = await ctx.db.get(
    `SELECT sa.service_point_id FROM staff_assignments sa JOIN users u ON u.user_id = sa.user_id WHERE u.email = 'doctor1@opd.test'`,
    []
  );
  assert.equal(rows.filter((r) => r.service_point_id === doctor1Room.service_point_id).length, 3);

  const demo = await ctx.db.query(
    `SELECT v.visit_id, v.status, t.status AS token_status, t.queue_type,
            (SELECT COUNT(*) FROM feedback f WHERE f.visit_id = v.visit_id) AS feedback
       FROM visits v JOIN users u ON u.user_id = v.patient_id JOIN tokens t ON t.visit_id = v.visit_id
      WHERE u.email = 'patient@opd.test' AND t.queue_type = 'OPD'`,
    []
  );
  assert.equal(demo.length, 1);
  assert.equal(demo[0].token_status, 'COMPLETED');
  assert.equal(demo[0].feedback, 0);
});

test('doctor averages equal the rolling mean of the last 30 consultations (nightly job is a no-op)', async () => {
  const predictionService = require('../src/services/predictionService');
  const updated = await predictionService.refreshDoctorAverages(ctx.db);
  assert.equal(updated, 0);
  const forecasts = await ctx.db.get('SELECT COUNT(*) AS n FROM forecasts', []);
  assert.ok(forecasts.n > 0);
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

/** Rebuild timelines of a date from the tokens and queue_events tables. */
async function timelinesFromDb(db, date) {
  const time = ctx.time;
  const rows = await db.query(
    `SELECT t.*, v.branch_id, d.department_id, u.priority_category
       FROM tokens t JOIN visits v ON v.visit_id = t.visit_id JOIN users u ON u.user_id = v.patient_id
       LEFT JOIN doctors d ON d.doctor_id = t.doctor_id
      WHERE t.token_date = ? ORDER BY t.token_id`,
    [date]
  );
  const events = await db.query(
    `SELECT e.* FROM queue_events e JOIN tokens t ON t.token_id = e.token_id WHERE t.token_date = ? ORDER BY e.event_id`,
    [date]
  );
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
  const maxSeeded = (await db.get('SELECT MAX(token_id) AS m FROM tokens', [])).m;

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
  const { tokens, events } = await timelinesFromDb(db, today);
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
  for (const sp of await db.query(`SELECT service_point_id, type FROM service_points WHERE branch_id = 1 AND type <> 'OPD'`, [])) {
    counterAverages.set(sp.service_point_id, await predictionService.servicePointAverage(db, sp.service_point_id, sp.type, today));
  }
  const apptRows = await db.query(
    `SELECT a.slot_start, (SELECT issued_at FROM tokens t WHERE t.appointment_id = a.appointment_id) AS checked_in
       FROM appointments a WHERE a.doctor_id = ? AND a.slot_start >= ?`,
    [me2.doctorId, `${today} 00:00:00`]
  );
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

  const first = await db.query(
    `SELECT wp.token_id, wp.predicted_minutes, wp.features_json FROM wait_predictions wp
      WHERE wp.prediction_id IN (SELECT MIN(prediction_id) FROM wait_predictions WHERE token_id > ? GROUP BY token_id)`,
    [maxSeeded]
  );
  assert.equal(first.length, scenarioIds.size);
  let interesting = 0;
  for (const row of first) {
    const expected = replay.get(row.token_id);
    assert.deepEqual(expected.features, JSON.parse(row.features_json), `token ${row.token_id} features`);
    assert.equal(expected.minutes, row.predicted_minutes, `token ${row.token_id} minutes`);
    const f = expected.features;
    if (f.interruptions_last_hour > 0 || f.appointments_ahead > 0 || f.priority_ahead > 0 || f.session_started) interesting += 1;
  }
  assert.ok(interesting >= 5, 'scenario exercised interruptions, appointments and priorities');
});
