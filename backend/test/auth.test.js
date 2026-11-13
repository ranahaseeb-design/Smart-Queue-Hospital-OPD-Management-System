'use strict';
/** FR-01 accounts + health + browse (FR-02). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext, assertNoSecrets } = require('./helpers');

let ctx;
before(async () => {
  ctx = await createContext('auth');
});
after(async () => {
  await ctx.close();
});

test('GET /health is public and reports the driver and AI status', async () => {
  const res = await ctx.api.get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.db, 'mongodb');
  assert.equal(res.body.ai, false);
});

test('protected endpoints require a valid JWT', async () => {
  assert.equal((await ctx.api.get('/branches')).status, 401);
  const bad = await ctx.api.get('/branches', 'not-a-jwt');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'UNAUTHORIZED');
});

test('register creates a PATIENT and returns a token (password never returned)', async () => {
  const res = await ctx.api.post('/auth/register', null, {
    fullName: 'Hamid Ali',
    email: 'Hamid@Example.com',
    phone: '0333-1234567',
    password: 'secret1',
    dateOfBirth: '1950-02-03',
    priorityCategory: 'elderly',
    role: 'HOSPITAL_ADMIN', // ignored: self-registration is always a patient
  });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  const u = res.body.user;
  assert.equal(u.role, 'PATIENT');
  assert.equal(u.email, 'hamid@example.com');
  assert.equal(u.phone, '03331234567');
  assert.equal(u.priorityCategory, 'ELDERLY');
  assert.equal(u.dateOfBirth, '1950-02-03');
  assert.equal(u.isActive, true);
  assert.deepEqual(u.assignments, []);
  assertNoSecrets(assert, res.body);
});

test('register validation and uniqueness', async () => {
  const noContact = await ctx.api.post('/auth/register', null, { fullName: 'X Y', password: 'secret1' });
  assert.equal(noContact.status, 400);
  assert.equal(noContact.body.error.code, 'VALIDATION_ERROR');
  const shortPw = await ctx.api.post('/auth/register', null, { fullName: 'X Y', email: 'x@y.com', password: '123' });
  assert.equal(shortPw.status, 400);
  const badEmail = await ctx.api.post('/auth/register', null, { fullName: 'X Y', email: 'nope', password: 'secret1' });
  assert.equal(badEmail.status, 400);
  const future = await ctx.api.post('/auth/register', null, {
    fullName: 'X Y',
    email: 'f@y.com',
    password: 'secret1',
    dateOfBirth: '2999-01-01',
  });
  assert.equal(future.status, 400);
  const dup = await ctx.api.post('/auth/register', null, { fullName: 'Dup', email: 'patient@opd.test', password: 'secret1' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CONFLICT');
  const invalidJson = await ctx.api.post('/auth/register', null).set('Content-Type', 'application/json').send('{oops');
  assert.equal(invalidJson.status, 400);
});

test('login with e-mail or phone; wrong password is 401', async () => {
  const byEmail = await ctx.api.post('/auth/login', null, { identifier: 'patient@opd.test', password: 'Patient@123' });
  assert.equal(byEmail.status, 200);
  assert.equal(byEmail.body.user.role, 'PATIENT');
  const byPhone = await ctx.api.post('/auth/login', null, { identifier: '03001234567', password: 'Patient@123' });
  assert.equal(byPhone.status, 200);
  assert.equal(byPhone.body.user.id, byEmail.body.user.id);
  const wrong = await ctx.api.post('/auth/login', null, { identifier: 'patient@opd.test', password: 'nope!!' });
  assert.equal(wrong.status, 401);
  const missing = await ctx.api.post('/auth/login', null, {});
  assert.equal(missing.status, 400);
});

test('ELDERLY is derived from the date of birth (age >= 60); DIFFERENTLY_ABLED may be declared (FR-13)', async () => {
  const reg = (extra) => ctx.api.post('/auth/register', null, { fullName: 'Prio Test', password: 'secret1', ...extra });
  const noDob = await reg({ email: 'prio1@example.com', priorityCategory: 'ELDERLY' });
  assert.equal(noDob.status, 400);
  assert.equal(noDob.body.error.code, 'VALIDATION_ERROR');
  const young = ctx.time.addDaysStr(ctx.time.today(), -(59 * 366));
  assert.equal((await reg({ email: 'prio2@example.com', priorityCategory: 'ELDERLY', dateOfBirth: young })).status, 400);
  const derived = await reg({ email: 'prio3@example.com', dateOfBirth: '1955-01-01' });
  assert.equal(derived.status, 201);
  assert.equal(derived.body.user.priorityCategory, 'ELDERLY');
  const declared = await reg({ email: 'prio4@example.com', priorityCategory: 'DIFFERENTLY_ABLED' });
  assert.equal(declared.status, 201);
  assert.equal(declared.body.user.priorityCategory, 'DIFFERENTLY_ABLED');

  // PUT /auth/me follows the same rule; a younger corrected DOB drops ELDERLY.
  const token = derived.body.token;
  assert.equal((await ctx.api.put('/auth/me', declared.body.token, { priorityCategory: 'ELDERLY' })).status, 400);
  const corrected = await ctx.api.put('/auth/me', token, { dateOfBirth: young });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.user.priorityCategory, 'NONE');
  const older = await ctx.api.put('/auth/me', token, { dateOfBirth: '1940-03-03', priorityCategory: 'ELDERLY' });
  assert.equal(older.body.user.priorityCategory, 'ELDERLY');
});

test('GET/PUT /auth/me; staff users carry doctorId and assignments', async () => {
  const { token } = await ctx.newPatient();
  const me = await ctx.api.get('/auth/me', token);
  assert.equal(me.status, 200);
  const upd = await ctx.api.put('/auth/me', token, { fullName: 'Renamed Patient', priorityCategory: 'DIFFERENTLY_ABLED' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.user.fullName, 'Renamed Patient');
  assert.equal(upd.body.user.priorityCategory, 'DIFFERENTLY_ABLED');
  const pw = await ctx.api.put('/auth/me', token, { password: 'newpass1' });
  assert.equal(pw.status, 200);
  const relogin = await ctx.api.post('/auth/login', null, { identifier: me.body.user.email, password: 'newpass1' });
  assert.equal(relogin.status, 200);

  const doctor = await ctx.api.get('/auth/me', await ctx.login('doctor1'));
  assert.equal(doctor.body.user.role, 'STAFF');
  assert.ok(doctor.body.user.doctorId);
  assert.equal(doctor.body.user.assignments.length, 1);
  assert.equal(doctor.body.user.assignments[0].type, 'OPD');
  assertNoSecrets(assert, doctor.body);
});

test('browse: branches, specialties, departments, doctors (FR-02)', async () => {
  const token = await ctx.login('patient');
  const branches = await ctx.api.get('/branches', token);
  assert.equal(branches.status, 200);
  assert.deepEqual(
    branches.body.map((b) => b.name),
    ['Model Town', 'Gulberg', 'DHA']
  );
  assert.equal(branches.body[0].latitude, 31.4834);
  assert.equal(branches.body[0].longitude, 74.3255);

  const specialties = await ctx.api.get('/specialties', token);
  assert.ok(specialties.body.includes('Cardiology'));
  assert.ok(specialties.body.includes('General Medicine'));

  const depts = await ctx.api.get(`/branches/${branches.body[0].id}/departments`, token);
  assert.equal(depts.status, 200);
  assert.equal(depts.body.length, 5);
  for (const d of depts.body) assert.equal(d.doctorCount, 2);

  const gm = depts.body.find((d) => d.specialty === 'General Medicine');
  const doctors = await ctx.api.get(`/departments/${gm.id}/doctors`, token);
  assert.equal(doctors.status, 200);
  assert.equal(doctors.body.length, 2);
  const d1 = doctors.body[0];
  for (const key of [
    'id', 'fullName', 'departmentId', 'specialty', 'branchId', 'avgConsultMinutes', 'servicePointId',
    'servicePointName', 'session', 'availableToday', 'acceptingNow', 'queueLength', 'estimatedWaitMinutes',
  ]) {
    assert.ok(key in d1, `doctor field ${key}`);
  }
  assert.equal(d1.availableToday, true);
  assert.equal(d1.acceptingNow, true);
  assert.equal(d1.queueLength, 3); // seeded WAITING tokens in doctor1's queue today
  assert.ok(d1.estimatedWaitMinutes > 0);
  assert.match(d1.session.startTime, /^\d{2}:\d{2}$/);

  const otherDay = await ctx.api.get(`/departments/${gm.id}/doctors?date=2030-01-07`, token);
  assert.equal(otherDay.status, 200);
  assert.equal(otherDay.body[0].acceptingNow, false);
  assert.equal(otherDay.body[0].estimatedWaitMinutes, null);
  assert.equal((await ctx.api.get(`/departments/${gm.id}/doctors?date=bad`, token)).status, 400);
  assert.equal((await ctx.api.get('/branches/999/departments', token)).status, 404);
});

test('unknown API route answers 404 in the contract error shape', async () => {
  const res = await ctx.api.get('/does-not-exist', await ctx.login('patient'));
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
});
