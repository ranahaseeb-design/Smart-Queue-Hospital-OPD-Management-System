'use strict';
/**
 * Patient portal / kiosk support: PATIENT login portal, walk-in guest check-in (POST /auth/guest)
 * and the demo queue load simulator (POST /demo/load-queue), both behind config.demoTools.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let doctorToken;
let room;

before(async () => {
  ctx = await createContext('demo');
  doctorToken = await ctx.login('doctor1');
  room = (await ctx.api.get('/staff/service-points', doctorToken)).body.find((s) => s.type === 'OPD');
});
after(async () => {
  await ctx.close();
});

test('patients sign in through the Patient Portal card; other accounts are pointed elsewhere', async () => {
  const ok = await ctx.api.post('/auth/login', null, { identifier: '03001234567', password: 'Patient@123', portal: 'PATIENT' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.role, 'PATIENT');
  const doctor = await ctx.api.post('/auth/login', null, { identifier: 'doctor1@opd.test', password: 'Staff@123', portal: 'PATIENT' });
  assert.equal(doctor.status, 403);
  assert.match(doctor.body.error.message, /Doctor Login/);
  const patientAsStaff = await ctx.api.post('/auth/login', null, { identifier: 'patient@opd.test', password: 'Patient@123', portal: 'STAFF' });
  assert.equal(patientAsStaff.status, 403);
  assert.match(patientAsStaff.body.error.message, /Patient Portal/);
});

test('walk-in guest check-in returns a PATIENT session that can join a queue at once', async () => {
  const guest = await ctx.api.post('/auth/guest', null, {});
  assert.equal(guest.status, 201, JSON.stringify(guest.body));
  assert.equal(guest.body.user.role, 'PATIENT');
  assert.match(guest.body.user.fullName, /^Walk-in Guest \d{4}$/);
  assert.equal(guest.body.user.priorityCategory, 'NONE');
  assert.equal(JSON.stringify(guest.body).includes('password'), false);

  const named = await ctx.api.post('/auth/guest', null, { fullName: '  Ayesha Bibi ' });
  assert.equal(named.body.user.fullName, 'Ayesha Bibi');
  assert.notEqual(named.body.user.id, guest.body.user.id);

  const joined = await ctx.api.post('/tokens', guest.body.token, { doctorId: room.doctorId });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.status, 'WAITING');
  const queue = (await ctx.api.get(`/service-points/${room.id}/queue`, doctorToken)).body;
  assert.ok(queue.waiting.some((t) => t.id === joined.body.id), 'the guest token is in the doctor queue');

  assert.equal((await ctx.api.post('/auth/guest', null, { fullName: 'x' })).status, 400);
});

test('walk-in with phone and Urgent / Senior priority: seniors (60+) are prioritised, urgency is for staff', async () => {
  const thisYear = Number(ctx.time.today().slice(0, 4));
  const senior = await ctx.api.post('/auth/guest', null, {
    fullName: 'Rashid Ali', phone: `0399${String(Date.now()).slice(-7)}`, priority: 'URGENT_SENIOR', birthYear: thisYear - 72,
  });
  assert.equal(senior.status, 201, JSON.stringify(senior.body));
  assert.equal(senior.body.user.priorityCategory, 'ELDERLY');
  assert.equal(senior.body.user.dateOfBirth, `${thisYear - 72}-01-01`);
  const token = await ctx.api.post('/tokens', senior.body.token, { doctorId: room.doctorId });
  assert.equal(token.status, 201);
  assert.equal(token.body.priorityLevel, 1, 'senior walk-in queued with priority');

  const young = await ctx.api.post('/auth/guest', null, { priority: 'URGENT_SENIOR', birthYear: thisYear - 30 });
  assert.equal(young.status, 400);
  assert.match(young.body.error.message, /reception desk/);
  assert.equal((await ctx.api.post('/auth/guest', null, { priority: 'URGENT_SENIOR' })).status, 400);
  assert.equal((await ctx.api.post('/auth/guest', null, { priority: 'EMERGENCY' })).status, 400);
  // A phone that already has an account must sign in instead.
  const taken = await ctx.api.post('/auth/guest', null, { phone: '03001234567' });
  assert.equal(taken.status, 409);
  assert.equal((await ctx.api.post('/auth/guest', null, { phone: '12' })).status, 400);
});

test('demo load simulator fills the doctor queue with N synthetic tokens through the normal path', async () => {
  const before = (await ctx.api.get(`/service-points/${room.id}/queue`, doctorToken)).body.waiting.length;
  const guest = (await ctx.api.post('/auth/guest', null, {})).body;
  const res = await ctx.api.post('/demo/load-queue', guest.token, { doctorId: room.doctorId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.issued.length, 5);
  assert.equal(new Set(res.body.issued.map((t) => t.displayNumber)).size, 5);
  assert.equal(res.body.servicePoint.id, room.id);
  assert.equal(res.body.waitingNow, before + 5);

  const queue = (await ctx.api.get(`/service-points/${room.id}/queue`, doctorToken)).body;
  assert.equal(queue.waiting.length, before + 5);
  const ids = res.body.issued.map((t) => t.id);
  const stored = await ctx.models.Token.find({ _id: { $in: ids } }).lean();
  assert.ok(stored.every((t) => t.is_synthetic === true), 'flagged synthetic');
  const events = await ctx.models.QueueEvent.countDocuments({ token_id: { $in: ids }, event_type: 'ISSUED' });
  assert.equal(events, 5, 'ISSUED event per token (FR-21)');
  const predictions = await ctx.models.WaitPrediction.countDocuments({ token_id: { $in: ids } });
  assert.ok(predictions >= 5, 'each token got a prediction (FR-06)');

  const three = await ctx.api.post('/demo/load-queue', doctorToken, { doctorId: room.doctorId, count: 3 });
  assert.equal(three.status, 201);
  assert.equal(three.body.issued.length, 3);
  assert.equal((await ctx.api.post('/demo/load-queue', doctorToken, { doctorId: room.doctorId, count: 11 })).status, 400);
  assert.equal((await ctx.api.post('/demo/load-queue', null, { doctorId: room.doctorId })).status, 401);
});

test('doctor list reports which model produced each estimate', async () => {
  const pt = (await ctx.api.post('/auth/guest', null, {})).body.token;
  const branches = (await ctx.api.get('/branches', pt)).body;
  const deps = (await ctx.api.get(`/branches/${branches[0].id}/departments`, pt)).body;
  const doctors = (await ctx.api.get(`/departments/${deps[0].id}/doctors`, pt)).body;
  const withEstimate = doctors.filter((d) => d.estimatedWaitMinutes !== null);
  assert.ok(withEstimate.length > 0);
  // The AI service is down in tests, so the Eq. 6.2 baseline answers.
  assert.ok(withEstimate.every((d) => d.estimateModelVersion === 'baseline'));
});

test('doctor / room switcher: list doctors and open another doctor without signing out', async () => {
  const list = await ctx.api.get('/demo/doctors', doctorToken);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.length >= 2);
  const me = list.body.find((d) => d.doctorId === room.doctorId);
  assert.ok(me && me.servicePointName, 'own row with today’s room');
  const other = list.body.find((d) => d.doctorId !== room.doctorId && d.servicePointName);

  const sw = await ctx.api.post('/demo/switch-doctor', doctorToken, { doctorId: other.doctorId });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  assert.equal(sw.body.user.doctorId, other.doctorId);
  assert.equal(sw.body.user.role, 'STAFF');
  const theirRooms = (await ctx.api.get('/staff/service-points', sw.body.token)).body;
  assert.ok(theirRooms.some((s) => s.type === 'OPD' && s.doctorId === other.doctorId), 'the new session sees that doctor’s room');
  assert.equal((await ctx.api.get('/staff/service-points', doctorToken)).status, 200, 'the original session still works');

  // Admins may open doctors too (hospital admin: any; branch admin: own branch only).
  const admin = await ctx.login('admin');
  assert.equal((await ctx.api.post('/demo/switch-doctor', admin, { doctorId: other.doctorId })).status, 200);
  const branchAdmin = await ctx.login('branchAdmin');
  const own = (await ctx.api.get('/demo/doctors', branchAdmin)).body;
  assert.ok(own.length > 0 && own.every((d) => d.branchId === own[0].branchId));
  const foreign = list.body.find((d) => d.branchId !== own[0].branchId);
  assert.equal((await ctx.api.post('/demo/switch-doctor', branchAdmin, { doctorId: foreign.doctorId })).status, 403);

  // Patients cannot; unknown doctors are 404.
  const guest = (await ctx.api.post('/auth/guest', null, {})).body.token;
  assert.equal((await ctx.api.get('/demo/doctors', guest)).status, 403);
  assert.equal((await ctx.api.post('/demo/switch-doctor', guest, { doctorId: other.doctorId })).status, 403);
  assert.equal((await ctx.api.post('/demo/switch-doctor', doctorToken, { doctorId: 999999 })).status, 404);
});

test('with demo tools off, guest check-in and the simulator do not exist', async () => {
  const config = require('../src/config');
  const saved = config.demoTools;
  config.demoTools = false;
  try {
    assert.equal((await ctx.api.post('/auth/guest', null, {})).status, 404);
    assert.equal((await ctx.api.post('/demo/load-queue', doctorToken, { doctorId: room.doctorId })).status, 404);
    assert.equal((await ctx.api.get('/demo/doctors', doctorToken)).status, 404);
    assert.equal((await ctx.api.post('/demo/switch-doctor', doctorToken, { doctorId: room.doctorId })).status, 404);
  } finally {
    config.demoTools = saved;
  }
});
