'use strict';
/**
 * Concurrency (replaces the former SQL lock-order tests). MongoDB transactions + atomic counters +
 * unique / partial unique indexes must keep these rules under simultaneous requests:
 *   - concurrent joins get distinct token numbers; one patient gets ONE open visit per branch/day;
 *   - two simultaneous call-next on one service point: one call succeeds, the other is a 409;
 *   - no double booking of an appointment slot (and one booking per patient/doctor/day);
 *   - one active linked token per visit and counter;
 *   - a duplicate key (E11000) that reaches the error middleware is a 409 CONFLICT.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let doctorToken;
let room;
let doctor2Id;

const statuses = (results) => results.map((r) => r.status).sort((a, b) => a - b);

before(async () => {
  ctx = await createContext('locking');
  doctorToken = await ctx.login('doctor1');
  room = (await ctx.api.get('/staff/service-points', doctorToken)).body.find((s) => s.type === 'OPD');
  const u2 = await ctx.models.User.findOne({ email: 'doctor2@opd.test' }).lean();
  doctor2Id = (await ctx.models.Doctor.findOne({ user_id: u2._id }).lean())._id;
});
after(async () => {
  await ctx.close();
});

test('concurrent joins get distinct numbers; one patient gets one OPEN visit for two doctors', async () => {
  const patients = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => ctx.newPatient()));
  const results = await Promise.all(patients.map((p) => ctx.api.post('/tokens', p.token, { doctorId: room.doctorId })));
  assert.deepEqual(statuses(results), [201, 201, 201, 201, 201, 201, 201, 201]);
  const numbers = results.map((r) => r.body.tokenNumber);
  assert.equal(new Set(numbers).size, numbers.length, 'token numbers are unique');
  // Numbers are consecutive after the seeded ones (the counter gives none away).
  const sorted = [...numbers].sort((a, b) => a - b);
  assert.equal(sorted[sorted.length - 1] - sorted[0], numbers.length - 1);

  const p = await ctx.newPatient();
  const [a, b] = await Promise.all([
    ctx.api.post('/tokens', p.token, { doctorId: room.doctorId }),
    ctx.api.post('/tokens', p.token, { doctorId: doctor2Id }),
  ]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.body.visitId, b.body.visitId);
  assert.equal(await ctx.models.Visit.countDocuments({ patient_id: p.user.id, status: 'OPEN' }), 1);
});

test('the same patient joining the same doctor twice at once gets one token and one 409', async () => {
  const p = await ctx.newPatient();
  const results = await Promise.all([1, 2].map(() => ctx.api.post('/tokens', p.token, { doctorId: room.doctorId })));
  assert.deepEqual(statuses(results), [201, 409]);
  const visits = await ctx.models.Visit.distinct('_id', { patient_id: p.user.id });
  const active = await ctx.models.Token.countDocuments({
    visit_id: { $in: visits },
    doctor_id: room.doctorId,
    status: { $in: ['WAITING', 'CALLED', 'IN_SERVICE'] },
  });
  assert.equal(active, 1);
});

test('two simultaneous call-next on one service point: one succeeds, the other is a 409', async () => {
  const results = await Promise.all([1, 2].map(() => ctx.api.post(`/service-points/${room.id}/call-next`, doctorToken)));
  assert.deepEqual(statuses(results), [200, 409]);
  const called = results.find((r) => r.status === 200).body.token;
  assert.ok(called && called.status === 'CALLED');
  const open = await ctx.models.Token.countDocuments({
    service_point_id: room.id,
    token_date: ctx.time.today(),
    status: { $in: ['CALLED', 'IN_SERVICE'] },
  });
  assert.equal(open, 1, 'exactly one open token at the service point');
  const events = await ctx.models.QueueEvent.countDocuments({ token_id: called.id, event_type: 'CALLED' });
  assert.equal(events, 1, 'one CALLED event, written with the status change (FR-21)');
  ctx.advance(1);
  assert.equal((await ctx.api.post(`/tokens/${called.id}/complete`, doctorToken)).status, 200);
});

test('no double booking: simultaneous bookings of one slot give one 201 and one 409', async () => {
  const [p1, p2] = await Promise.all([ctx.newPatient(), ctx.newPatient()]);
  const tomorrow = ctx.time.addDaysStr(ctx.time.today(), 1);
  const slots = (await ctx.api.get(`/doctors/${doctor2Id}/slots?date=${tomorrow}`, p1.token)).body.slots;
  const slotStart = slots[2].start;
  const results = await Promise.all([p1, p2].map((p) => ctx.api.post('/appointments', p.token, { doctorId: doctor2Id, slotStart })));
  assert.deepEqual(statuses(results), [201, 409]);
  const loser = results.find((r) => r.status === 409);
  assert.equal(loser.body.error.code, 'CONFLICT');
  const active = await ctx.models.Appointment.countDocuments({
    doctor_id: doctor2Id,
    slot_start: ctx.time.parseDateTime(slotStart),
    status: { $in: ['BOOKED', 'CHECKED_IN'] },
  });
  assert.equal(active, 1);

  // One patient booking two slots of the same doctor and day at once: one booking only.
  const p3 = await ctx.newPatient();
  const two = await Promise.all(
    [slots[4].start, slots[5].start].map((s) => ctx.api.post('/appointments', p3.token, { doctorId: doctor2Id, slotStart: s }))
  );
  assert.deepEqual(statuses(two), [201, 409]);
});

test('transfers renumber in the target queue; same-room transfer needs the doctor scheduled there', async () => {
  const p = await ctx.newPatient();
  const issued = await ctx.api.post('/tokens', p.token, { doctorId: room.doctorId });
  assert.equal(issued.status, 201);
  ctx.advance(1);
  const notScheduled = await ctx.api.post(`/tokens/${issued.body.id}/transfer`, doctorToken, {
    toServicePointId: room.id,
    toDoctorId: doctor2Id,
  });
  assert.equal(notScheduled.status, 400);
  const shared = await ctx.dbLayer.insertOne(ctx.db, ctx.models.DoctorSchedule, {
    doctor_id: doctor2Id,
    service_point_id: room.id,
    day_of_week: ctx.time.isoDow(ctx.time.clock.now()),
    start_time: '06:00:00',
    end_time: '07:00:00',
    max_patients: null,
  });
  const res = await ctx.api.post(`/tokens/${issued.body.id}/transfer`, doctorToken, { toServicePointId: room.id, toDoctorId: doctor2Id });
  await ctx.models.DoctorSchedule.deleteOne({ _id: shared });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.from.status, 'TRANSFERRED');
  assert.equal(res.body.to.status, 'WAITING');
  assert.notEqual(res.body.to.tokenNumber, issued.body.tokenNumber);

  // Cross-room transfers issued at the same moment get distinct numbers at the LAB counter.
  const lab = await ctx.models.ServicePoint.findOne({ branch_id: issued.body.branch.id, type: 'LAB' }).lean();
  const ps = await Promise.all([ctx.newPatient(), ctx.newPatient()]);
  const tokens = [];
  for (const q of ps) tokens.push((await ctx.api.post('/tokens', q.token, { doctorId: room.doctorId })).body);
  ctx.advance(1);
  const moved = await Promise.all(
    tokens.map((t) => ctx.api.post(`/tokens/${t.id}/transfer`, doctorToken, { toServicePointId: lab._id }))
  );
  assert.deepEqual(statuses(moved), [200, 200]);
  assert.notEqual(moved[0].body.to.tokenNumber, moved[1].body.to.tokenNumber);
});

test('simultaneous linked tokens for one visit and counter: one 201, one 409', async () => {
  const p = await ctx.newPatient();
  const issued = await ctx.api.post('/tokens', p.token, { doctorId: room.doctorId });
  assert.equal(issued.status, 201);
  const results = await Promise.all(
    [1, 2].map(() => ctx.api.post(`/visits/${issued.body.visitId}/linked-tokens`, doctorToken, { type: 'PHARMACY' }))
  );
  assert.deepEqual(statuses(results), [201, 409]);
});

test('a duplicate key reaching the error middleware is a 409 CONFLICT', async () => {
  const { errorHandler } = require('../src/app');
  const { isUniqueViolation } = require('../src/utils/errors');
  assert.equal(isUniqueViolation({ code: 11000 }), true);
  assert.equal(isUniqueViolation({ writeErrors: [{ code: 11000 }] }), true);
  assert.equal(isUniqueViolation({ code: 112 }), false);

  // A real E11000 from the unique token-number index...
  const t = await ctx.models.Token.findOne({ token_date: ctx.time.today() }).lean();
  let err = null;
  try {
    await ctx.models.Token.create([{ ...t, _id: t._id + 1000000 }]);
  } catch (e) {
    err = e;
  }
  assert.ok(err && isUniqueViolation(err), 'unique index uq_token_number rejects a duplicate number');
  // ...is answered with the contract error envelope.
  const res = {
    headersSent: false,
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  errorHandler(err, { method: 'POST', originalUrl: '/api/x' }, res, () => {});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, 'CONFLICT');
});
