'use strict';
/**
 * Admin module: CRUD of every master-data resource (FR-14) with branch scoping, dashboard
 * (FR-15), reports + CSV (FR-16), alerts and forecasts (FR-17), workload recommendations (FR-18),
 * feedback (FR-20), settings and model management (FR-22, AI down -> 503).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext, assertNoSecrets } = require('./helpers');

let ctx;
let admin;
let branchAdmin;
const created = {};

before(async () => {
  ctx = await createContext('admin', { historyDays: 14 });
  admin = await ctx.login('admin');
  branchAdmin = await ctx.login('branchAdmin');
});
after(async () => {
  await ctx.close();
});

test('only administrators reach /admin; patients and staff get 403', async () => {
  assert.equal((await ctx.api.get('/admin/dashboard', await ctx.login('patient'))).status, 403);
  assert.equal((await ctx.api.get('/admin/branches', await ctx.login('doctor1'))).status, 403);
  assert.equal((await ctx.api.get('/admin/branches')).status, 401);
});

test('branches: hospital admin CRUD with soft deactivation; branch admin read-only own branch', async () => {
  const list = await ctx.api.get('/admin/branches', admin);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3);

  const own = await ctx.api.get('/admin/branches', branchAdmin);
  assert.deepEqual(own.body.map((b) => b.id), [1]);
  assert.equal((await ctx.api.get('/admin/branches/2', branchAdmin)).status, 403);
  assert.equal((await ctx.api.get('/admin/branches?branchId=2', branchAdmin)).status, 403);
  assert.equal((await ctx.api.post('/admin/branches', branchAdmin, { name: 'X', latitude: 1, longitude: 1 })).status, 403);
  assert.equal((await ctx.api.put('/admin/branches/1', branchAdmin, { name: 'X' })).status, 403);
  assert.equal((await ctx.api.del('/admin/branches/1', branchAdmin)).status, 403);

  assert.equal((await ctx.api.post('/admin/branches', admin, { name: 'Johar Town' })).status, 400);
  assert.equal((await ctx.api.post('/admin/branches', admin, { name: 'Johar Town', latitude: 95, longitude: 74 })).status, 400);
  const res = await ctx.api.post('/admin/branches', admin, {
    name: 'Johar Town',
    address: 'Block G, Johar Town, Lahore',
    latitude: 31.4697,
    longitude: 74.2728,
    status: 'ACTIVE',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Johar Town');
  assert.equal(res.body.status, 'ACTIVE');
  created.branch = res.body;
  assert.equal((await ctx.api.post('/admin/branches', admin, { name: 'johar town', latitude: 1, longitude: 1 })).status, 409);

  const upd = await ctx.api.put(`/admin/branches/${created.branch.id}`, admin, { address: 'Johar Town, Lahore' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.address, 'Johar Town, Lahore');
  assert.equal((await ctx.api.get(`/admin/branches/${created.branch.id}`, admin)).body.name, 'Johar Town');
  assert.equal((await ctx.api.get('/admin/branches/999', admin)).status, 404);
  assert.equal((await ctx.api.get('/admin/branches/abc', admin)).status, 400);
});

test('departments: CRUD, duplicate specialty 409, branch admin scoped to own branch', async () => {
  const ownList = await ctx.api.get('/admin/departments', branchAdmin);
  assert.equal(ownList.status, 200);
  assert.ok(ownList.body.length === 5 && ownList.body.every((d) => d.branchId === 1));
  assert.ok(ownList.body.every((d) => d.doctorCount === 2));
  assert.equal((await ctx.api.get('/admin/departments?branchId=2', branchAdmin)).status, 403);
  const gulbergDept = (await ctx.api.get('/admin/departments?branchId=2', admin)).body[0];
  assert.equal((await ctx.api.get(`/admin/departments/${gulbergDept.id}`, branchAdmin)).status, 403);
  assert.equal((await ctx.api.put(`/admin/departments/${gulbergDept.id}`, branchAdmin, { name: 'X' })).status, 403);
  assert.equal(
    (await ctx.api.post('/admin/departments', branchAdmin, { branchId: 2, specialty: 'Neurology' })).status,
    403
  );
  assert.equal((await ctx.api.post('/admin/departments', branchAdmin, { branchId: 1, specialty: 'Cardiology' })).status, 409);

  const res = await ctx.api.post('/admin/departments', admin, {
    branchId: created.branch.id,
    specialty: 'Cardiology',
    name: 'Cardiology OPD',
    isActive: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.branchName, 'Johar Town');
  assert.equal(res.body.isActive, true);
  assert.equal(res.body.doctorCount, 0);
  created.department = res.body;
  const upd = await ctx.api.put(`/admin/departments/${res.body.id}`, admin, { name: 'Heart Clinic' });
  assert.equal(upd.body.name, 'Heart Clinic');
  assert.equal((await ctx.api.post('/admin/departments', admin, { branchId: created.branch.id })).status, 400);

  const own = await ctx.api.post('/admin/departments', branchAdmin, { branchId: 1, specialty: 'Dermatology' });
  assert.equal(own.status, 201);
  const del = await ctx.api.del(`/admin/departments/${own.body.id}`, branchAdmin);
  assert.equal(del.status, 200);
  assert.equal(del.body.isActive, false);
});

test('service points: CRUD with soft deactivation and scoping', async () => {
  const res = await ctx.api.post('/admin/service-points', admin, { branchId: created.branch.id, type: 'opd', name: 'Room 1' });
  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'OPD');
  assert.equal(res.body.isActive, true);
  created.room = res.body;
  assert.equal((await ctx.api.post('/admin/service-points', admin, { branchId: created.branch.id, type: 'OPD', name: 'Room 1' })).status, 409);
  assert.equal((await ctx.api.post('/admin/service-points', admin, { branchId: created.branch.id, type: 'XRAY', name: 'R' })).status, 400);
  const lab = await ctx.api.post('/admin/service-points', admin, { branchId: created.branch.id, type: 'LAB', name: 'Lab Counter' });
  assert.equal(lab.status, 201);
  created.lab = lab.body;
  assert.equal((await ctx.api.post('/admin/service-points', branchAdmin, { branchId: 2, type: 'LAB', name: 'L2' })).status, 403);
  const own = await ctx.api.get('/admin/service-points', branchAdmin);
  assert.ok(own.body.length === 12 && own.body.every((s) => s.branchId === 1));
  const labs = await ctx.api.get('/admin/service-points?type=LAB', admin);
  assert.ok(labs.body.every((s) => s.type === 'LAB'));

  const upd = await ctx.api.put(`/admin/service-points/${created.lab.id}`, admin, { name: 'Laboratory' });
  assert.equal(upd.body.name, 'Laboratory');
  const del = await ctx.api.del(`/admin/service-points/${created.lab.id}`, admin);
  assert.equal(del.body.isActive, false);
  // a room with tokens cannot change type
  assert.equal((await ctx.api.put('/admin/service-points/1', admin, { type: 'LAB' })).status, 409);
});

test('doctors: create STAFF user + doctor, login works, update, soft delete blocks login', async () => {
  const body = {
    fullName: 'Dr. New Doctor',
    email: 'new.doctor@opd.test',
    password: 'Doctor@123',
    departmentId: created.department.id,
    avgConsultMinutes: 12.5,
  };
  assert.equal((await ctx.api.post('/admin/doctors', admin, { ...body, password: '1' })).status, 400);
  assert.equal((await ctx.api.post('/admin/doctors', branchAdmin, body)).status, 403);
  const res = await ctx.api.post('/admin/doctors', admin, body);
  assert.equal(res.status, 201);
  for (const key of ['id', 'userId', 'fullName', 'email', 'phone', 'departmentId', 'departmentName', 'specialty', 'branchId', 'branchName', 'avgConsultMinutes', 'isActive']) {
    assert.ok(key in res.body, key);
  }
  assert.equal(res.body.avgConsultMinutes, 12.5);
  assert.equal(res.body.branchName, 'Johar Town');
  assertNoSecrets(assert, res.body);
  created.doctor = res.body;
  assert.equal((await ctx.api.post('/admin/doctors', admin, body)).status, 409);

  const login = await ctx.api.post('/auth/login', null, { identifier: body.email, password: body.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'STAFF');
  assert.equal(login.body.user.doctorId, res.body.id);

  const upd = await ctx.api.put(`/admin/doctors/${res.body.id}`, admin, { avgConsultMinutes: 9 });
  assert.equal(upd.body.avgConsultMinutes, 9);
  const ownDoctors = await ctx.api.get('/admin/doctors', branchAdmin);
  assert.ok(ownDoctors.body.length === 10 && ownDoctors.body.every((d) => d.branchId === 1));
  assert.equal((await ctx.api.get(`/admin/doctors/${res.body.id}`, branchAdmin)).status, 403);
  const byDept = await ctx.api.get(`/admin/doctors?departmentId=${created.department.id}`, admin);
  assert.deepEqual(byDept.body.map((d) => d.id), [res.body.id]);
});

test('schedules: create, overlap 409, update, hard delete', async () => {
  const s = {
    doctorId: created.doctor.id,
    servicePointId: created.room.id,
    dayOfWeek: 1,
    startTime: '09:00',
    endTime: '13:00',
    maxPatients: 30,
  };
  assert.equal((await ctx.api.post('/admin/schedules', admin, { ...s, endTime: '08:00' })).status, 400);
  assert.equal((await ctx.api.post('/admin/schedules', admin, { ...s, dayOfWeek: 8 })).status, 400);
  assert.equal((await ctx.api.post('/admin/schedules', admin, { ...s, servicePointId: 1 })).status, 400); // other branch
  const res = await ctx.api.post('/admin/schedules', admin, s);
  assert.equal(res.status, 201);
  assert.equal(res.body.startTime, '09:00');
  assert.equal(res.body.endTime, '13:00');
  assert.equal(res.body.doctorName, 'Dr. New Doctor');
  assert.equal(res.body.servicePointName, 'Room 1');
  assert.equal(res.body.maxPatients, 30);
  const overlap = await ctx.api.post('/admin/schedules', admin, { ...s, startTime: '12:00', endTime: '15:00' });
  assert.equal(overlap.status, 409);
  const upd = await ctx.api.put(`/admin/schedules/${res.body.id}`, admin, { endTime: '14:00', maxPatients: null });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.endTime, '14:00');
  assert.equal(upd.body.maxPatients, null);
  const list = await ctx.api.get(`/admin/schedules?doctorId=${created.doctor.id}`, admin);
  assert.equal(list.body.length, 1);
  const ownList = await ctx.api.get('/admin/schedules', branchAdmin);
  assert.ok(ownList.body.length === 70 && ownList.body.every((x) => x.branchId === 1));
  assert.equal((await ctx.api.get(`/admin/schedules/${res.body.id}`, branchAdmin)).status, 403);
  // seeded room 1 is already used by doctor1 every day
  const roomClash = await ctx.api.post('/admin/schedules', branchAdmin, {
    doctorId: 2, servicePointId: 1, dayOfWeek: 1, startTime: '08:00', endTime: '22:00',
  });
  assert.equal(roomClash.status, 409);
  const del = await ctx.api.del(`/admin/schedules/${res.body.id}`, admin);
  assert.equal(del.status, 200);
  assert.equal((await ctx.api.get(`/admin/schedules/${res.body.id}`, admin)).status, 404);
});

test('doctor soft delete deactivates the account', async () => {
  const del = await ctx.api.del(`/admin/doctors/${created.doctor.id}`, admin);
  assert.equal(del.status, 200);
  assert.equal(del.body.isActive, false);
  const login = await ctx.api.post('/auth/login', null, { identifier: 'new.doctor@opd.test', password: 'Doctor@123' });
  assert.equal(login.status, 403);
  const reactivate = await ctx.api.put(`/admin/doctors/${created.doctor.id}`, admin, { isActive: true });
  assert.equal(reactivate.body.isActive, true);
});

test('users: hospital admin manages all roles; branch admin only staff of own branch', async () => {
  const all = await ctx.api.get('/admin/users?role=BRANCH_ADMIN', admin);
  assert.deepEqual(all.body.map((u) => u.email), ['branchadmin@opd.test']);
  assertNoSecrets(assert, all.body);
  assert.equal((await ctx.api.get('/admin/users?role=HOSPITAL_ADMIN', branchAdmin)).status, 403);
  const staff = await ctx.api.get('/admin/users', branchAdmin);
  assert.ok(staff.body.length >= 12);
  assert.ok(staff.body.every((u) => u.role === 'STAFF'));
  assert.ok(staff.body.some((u) => u.email === 'lab1@opd.test'));
  assert.ok(!staff.body.some((u) => u.email === 'doctor11@opd.test')); // Gulberg doctor
  assertNoSecrets(assert, staff.body);

  const forbiddenRole = await ctx.api.post('/admin/users', branchAdmin, {
    fullName: 'Second Admin', email: 'second.admin@opd.test', password: 'secret1', role: 'BRANCH_ADMIN', adminBranchId: 1,
  });
  assert.equal(forbiddenRole.status, 403);
  const staffRes = await ctx.api.post('/admin/users', branchAdmin, {
    fullName: 'Reception Staff', email: 'reception1@opd.test', password: 'secret1', role: 'STAFF',
  });
  assert.equal(staffRes.status, 201);
  assert.equal(staffRes.body.adminBranchId, 1);
  assert.equal(staffRes.body.role, 'STAFF');
  created.staff = staffRes.body;

  const ba = await ctx.api.post('/admin/users', admin, {
    fullName: 'Gulberg Admin', email: 'gulberg.admin@opd.test', password: 'secret1', role: 'BRANCH_ADMIN', adminBranchId: 2,
  });
  assert.equal(ba.status, 201);
  assert.equal(ba.body.adminBranchName, 'Gulberg');
  assert.equal((await ctx.api.post('/admin/users', admin, {
    fullName: 'No Branch', email: 'nb@opd.test', password: 'secret1', role: 'BRANCH_ADMIN',
  })).status, 400);
  assert.equal((await ctx.api.post('/admin/users', admin, {
    fullName: 'Bad Role', email: 'br@opd.test', password: 'secret1', role: 'PATIENT',
  })).status, 400);

  // branch admin cannot touch the other branch's administrator or a Gulberg doctor's account
  assert.equal((await ctx.api.get(`/admin/users/${ba.body.id}`, branchAdmin)).status, 403);
  const gulbergDoctor = (await ctx.api.get('/admin/users?branchId=2&role=STAFF', admin)).body[0];
  assert.equal((await ctx.api.put(`/admin/users/${gulbergDoctor.id}`, branchAdmin, { fullName: 'X Y' })).status, 403);

  const upd = await ctx.api.put(`/admin/users/${created.staff.id}`, branchAdmin, { fullName: 'Front Desk', password: 'newpass1' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.fullName, 'Front Desk');
  assert.equal((await ctx.api.put(`/admin/users/${created.staff.id}`, branchAdmin, { role: 'HOSPITAL_ADMIN' })).status, 403);
  const me = (await ctx.api.get('/auth/me', admin)).body.user;
  assert.equal((await ctx.api.del(`/admin/users/${me.id}`, admin)).status, 409);
  const patients = await ctx.api.get('/admin/users?role=PATIENT', admin);
  assert.ok(patients.body.length > 100);
});

test('assignments: create, duplicate 409, scoping, delete; staff then sees the counter', async () => {
  const lab = (await ctx.api.get('/admin/service-points?type=LAB&branchId=1', admin)).body[0];
  const res = await ctx.api.post('/admin/assignments', branchAdmin, { userId: created.staff.id, servicePointId: lab.id });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ['branchId', 'branchName', 'id', 'servicePointId', 'servicePointName', 'type', 'userId', 'userName']);
  assert.equal(res.body.userName, 'Front Desk');
  assert.equal((await ctx.api.post('/admin/assignments', branchAdmin, { userId: created.staff.id, servicePointId: lab.id })).status, 409);
  const gulbergLab = (await ctx.api.get('/admin/service-points?type=LAB&branchId=2', admin)).body[0];
  assert.equal((await ctx.api.post('/admin/assignments', branchAdmin, { userId: created.staff.id, servicePointId: gulbergLab.id })).status, 403);
  const patient = (await ctx.api.get('/auth/me', await ctx.login('patient'))).body.user;
  assert.equal((await ctx.api.post('/admin/assignments', admin, { userId: patient.id, servicePointId: lab.id })).status, 400);

  const login = await ctx.api.post('/auth/login', null, { identifier: 'reception1@opd.test', password: 'newpass1' });
  const sps = await ctx.api.get('/staff/service-points', login.body.token);
  assert.deepEqual(sps.body.map((s) => s.id), [lab.id]);

  const list = await ctx.api.get(`/admin/assignments?userId=${created.staff.id}`, branchAdmin);
  assert.equal(list.body.length, 1);
  assert.equal((await ctx.api.get(`/admin/assignments/${res.body.id}`, admin)).status, 200);
  const del = await ctx.api.del(`/admin/assignments/${res.body.id}`, branchAdmin);
  assert.equal(del.status, 200);
  assert.equal((await ctx.api.get(`/admin/assignments/${res.body.id}`, admin)).status, 404);

  const deact = await ctx.api.del(`/admin/users/${created.staff.id}`, branchAdmin);
  assert.equal(deact.body.isActive, false);
  assert.equal((await ctx.api.get('/auth/me', login.body.token)).status, 401);
});

test('live dashboard KPIs (FR-15) with branch scoping', async () => {
  const res = await ctx.api.get('/admin/dashboard', admin);
  assert.equal(res.status, 200);
  for (const key of ['waiting', 'inService', 'completedToday', 'avgWaitMinutes', 'maxWaitMinutes', 'activeDoctors', 'activeServicePoints']) {
    assert.ok(key in res.body.kpis, key);
  }
  assert.equal(res.body.kpis.waiting, 5);
  assert.equal(res.body.branches.length, 4);
  const dept = res.body.departments[0];
  for (const key of ['departmentId', 'branchId', 'branchName', 'name', 'specialty', 'waiting', 'activeDoctors', 'avgWaitMinutes', 'maxWaitMinutes', 'congestionRatio', 'congestionLevel']) {
    assert.ok(key in dept, key);
  }
  assert.ok(res.body.servicePoints.every((sp) => 'nowServing' in sp && 'waiting' in sp));
  const own = await ctx.api.get('/admin/dashboard', branchAdmin);
  assert.deepEqual(own.body.branches.map((b) => b.branchId), [1]);
  assert.equal(own.body.kpis.waiting, 3);
  assert.equal((await ctx.api.get('/admin/dashboard?branchId=2', branchAdmin)).status, 403);
  const filtered = await ctx.api.get('/admin/dashboard?branchId=2', admin);
  assert.equal(filtered.body.kpis.waiting, 2);
});

test('reports: five types as JSON and CSV (FR-16)', async () => {
  const types = ['doctor-consult', 'department-traffic', 'branch-utilization', 'waiting-times', 'feedback'];
  for (const type of types) {
    const res = await ctx.api.get(`/admin/reports?type=${type}`, admin);
    assert.equal(res.status, 200, type);
    assert.equal(res.body.type, type);
    assert.ok(res.body.title);
    assert.ok(res.body.columns.length >= 3);
    assert.ok(res.body.rows.length > 0, `${type} has rows`);
    for (const c of res.body.columns) assert.ok(c.key in res.body.rows[0], `${type}.${c.key}`);
  }
  const traffic = await ctx.api.get('/admin/reports?type=department-traffic', admin);
  assert.ok(traffic.body.rows.some((r) => r.tokensIssued > 0));

  const csv = await ctx.api.get('/admin/reports?type=doctor-consult&format=csv', admin);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /^text\/csv/);
  assert.match(csv.headers['content-disposition'], /attachment; filename="doctor-consult_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = csv.text.trim().split(/\r\n/);
  assert.equal(lines[0], 'Doctor,Specialty,Branch,Consultations,Avg consult (min),Min (min),Max (min),Rolling avg used for prediction (min)');
  assert.equal(lines.length, 1 + 28 + 1); // all doctors incl. the new one

  const scoped = await ctx.api.get('/admin/reports?type=branch-utilization', branchAdmin);
  assert.deepEqual(scoped.body.rows.map((r) => r.branchId), [1]);
  const ranged = await ctx.api.get(`/admin/reports?type=feedback&from=${ctx.time.addDaysStr(ctx.time.today(), -3)}&to=${ctx.time.today()}`, admin);
  assert.equal(ranged.status, 200);
  assert.equal((await ctx.api.get('/admin/reports?type=nope', admin)).status, 400);
  assert.equal((await ctx.api.get('/admin/reports?type=feedback&from=2026-13-01', admin)).status, 400);
  assert.equal((await ctx.api.get('/admin/reports?type=feedback&from=2026-10-10&to=2026-10-01', admin)).status, 400);
});

test('forecasts: run falls back to the JS seasonal baseline when AI is down; list + alerts (FR-17)', async () => {
  // Running forecasts regenerates every branch: hospital administrator only.
  const denied = await ctx.api.post('/admin/forecasts/run', branchAdmin);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'FORBIDDEN');
  const run = await ctx.api.post('/admin/forecasts/run', admin);
  assert.equal(run.status, 200);
  assert.equal(run.body.source, 'baseline');
  assert.ok(run.body.generated > 0);
  const list = await ctx.api.get(`/admin/forecasts?date=${ctx.time.addDaysStr(ctx.time.today(), 1)}`, admin);
  assert.equal(list.status, 200);
  assert.ok(list.body.length > 0);
  const f = list.body[0];
  for (const key of ['branchId', 'departmentId', 'departmentName', 'forecastHour', 'expectedArrivals', 'capacity', 'congestionRatio', 'congestionLevel', 'isPeak', 'source']) {
    assert.ok(key in f, key);
  }
  assert.equal(f.source, 'baseline');
  assert.ok(list.body.some((x) => x.isPeak));
  const own = await ctx.api.get('/admin/forecasts', branchAdmin);
  assert.ok(own.body.every((x) => x.branchId === 1));
  const gulbergDept = (await ctx.api.get('/admin/departments?branchId=2', admin)).body[0];
  assert.equal((await ctx.api.get(`/admin/forecasts?departmentId=${gulbergDept.id}`, branchAdmin)).status, 403);

  const alerts = await ctx.api.get('/admin/alerts', admin);
  assert.equal(alerts.status, 200);
  for (const a of alerts.body) {
    assert.ok(['HIGH', 'CRITICAL'].includes(a.level));
    assert.ok(['LIVE', 'FORECAST'].includes(a.source));
    assert.ok(a.message && a.branchName && a.departmentName && a.at);
  }
});

test('workload and resource-allocation recommendations (FR-18)', async () => {
  const res = await ctx.api.get('/admin/recommendations', admin);
  assert.equal(res.status, 200);
  assert.equal(res.body.workload.length, 4);
  const w = res.body.workload.find((x) => x.branchId === 1);
  assert.ok(w.patientsPerDoctorHour > 0);
  assert.ok(w.utilization > 0 && w.utilization < 2);
  assert.ok(w.avgWaitMinutes > 0);
  assert.ok(Array.isArray(res.body.recommendations));
  for (const r of res.body.recommendations) {
    for (const key of ['branchId', 'branchName', 'departmentId', 'departmentName', 'date', 'timeRange', 'shortfallSessions', 'message']) {
      assert.ok(key in r, key);
    }
  }
});

test('feedback summary (FR-20)', async () => {
  const res = await ctx.api.get('/admin/feedback', admin);
  assert.equal(res.status, 200);
  assert.ok(res.body.summary.count > 0);
  assert.deepEqual(Object.keys(res.body.summary.distribution), ['1', '2', '3', '4', '5']);
  const total = Object.values(res.body.summary.distribution).reduce((s, n) => s + n, 0);
  assert.equal(total, res.body.summary.count);
  assert.ok(res.body.summary.average >= 1 && res.body.summary.average <= 5);
  const item = res.body.items[0];
  for (const key of ['id', 'rating', 'comment', 'createdAt', 'patientName', 'branchName', 'visitDate']) assert.ok(key in item, key);
  const own = await ctx.api.get('/admin/feedback', branchAdmin);
  assert.ok(own.body.items.every((i) => i.branchName === 'Model Town'));
});

test('settings: defaults per contract; only the hospital admin can change them', async () => {
  const res = await ctx.api.get('/admin/settings', branchAdmin);
  assert.deepEqual(res.body, {
    recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 },
    congestionThresholds: { high: 0.85, critical: 1.0 },
    alternativeSuggestionWaitMinutes: 45,
    notifyPositionsAhead: 3,
    slotMinutes: 15,
  });
  assert.equal((await ctx.api.put('/admin/settings', branchAdmin, { slotMinutes: 20 })).status, 403);
  assert.equal((await ctx.api.put('/admin/settings', admin, { notifyPositionsAhead: -1 })).status, 400);
  assert.equal((await ctx.api.put('/admin/settings', admin, { congestionThresholds: { high: 1.2, critical: 1.0 } })).status, 400);
  const upd = await ctx.api.put('/admin/settings', admin, { slotMinutes: 20, recommendationWeights: { wait: 0.5, distance: 0.3, congestion: 0.2 } });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.slotMinutes, 20);
  assert.deepEqual(upd.body.recommendationWeights, { wait: 0.5, distance: 0.3, congestion: 0.2 });
  const doctorId = (await ctx.api.get('/auth/me', await ctx.login('doctor1'))).body.user.doctorId;
  const slots = await ctx.api.get(`/doctors/${doctorId}/slots?date=${ctx.time.addDaysStr(ctx.time.today(), 1)}`, await ctx.login('patient'));
  assert.equal(slots.body.slotMinutes, 20);
  await ctx.api.put('/admin/settings', admin, { slotMinutes: 15, recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 } });
});

test('model management answers 503 AI_UNAVAILABLE while the AI service is down (FR-22)', async () => {
  const list = await ctx.api.get('/admin/models', admin);
  assert.equal(list.status, 503);
  assert.equal(list.body.error.code, 'AI_UNAVAILABLE');
  assert.equal((await ctx.api.post('/admin/models/retrain', branchAdmin)).status, 403);
  const retrain = await ctx.api.post('/admin/models/retrain', admin);
  assert.equal(retrain.status, 503);
  assert.equal((await ctx.api.post('/admin/models/rf-1/activate', admin)).status, 503);
  assert.equal((await ctx.api.post('/admin/models/rf-1/activate', branchAdmin)).status, 403);
});

test('branch soft delete hides it from patients', async () => {
  const del = await ctx.api.del(`/admin/branches/${created.branch.id}`, admin);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'INACTIVE');
  const patientView = await ctx.api.get('/branches', await ctx.login('patient'));
  assert.ok(!patientView.body.some((b) => b.id === created.branch.id));
  const adminView = await ctx.api.get('/branches', admin);
  assert.ok(adminView.body.some((b) => b.id === created.branch.id));
});
