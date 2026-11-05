'use strict';
/**
 * Doctor scoping of staff queue operations (FR-12, NFR-04):
 * - a doctor only calls / operates OPD tokens with their own doctor_id, even in a room they
 *   can access (shared rooms) and even when they have no patients waiting;
 * - schedule-derived room access only counts for TODAY's weekday (explicit assignments always).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let d1; // { token, doctorId, room }
let d2;
let d3;

async function doctor(account) {
  const token = await ctx.login(account);
  const me = await ctx.api.get('/auth/me', token);
  const sps = await ctx.api.get('/staff/service-points', token);
  return { token, userId: me.body.user.id, doctorId: me.body.user.doctorId, room: sps.body.find((s) => s.type === 'OPD') };
}

before(async () => {
  ctx = await createContext('doctorscope');
  d1 = await doctor('doctor1');
  d2 = await doctor('doctor2');
  d3 = await doctor('doctor3');
  assert.notEqual(d1.room.id, d2.room.id);
  // doctor1 also works in doctor2's room (explicit assignment, e.g. a shared room).
  await ctx.db.run('INSERT INTO staff_assignments (user_id, service_point_id) VALUES (?, ?)', [d1.userId, d2.room.id]);
});
after(async () => {
  await ctx.close();
});

test("a doctor cannot call or operate another doctor's patients in a shared room", async () => {
  // doctor1 has no patients waiting in doctor2's room; doctor2's patients are waiting there.
  const p = await ctx.newPatient();
  const joined = await ctx.api.post('/tokens', p.token, { doctorId: d2.doctorId });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.servicePoint.id, d2.room.id);

  // doctor1 can see the room's queue ...
  assert.equal((await ctx.api.get(`/service-points/${d2.room.id}/queue`, d1.token)).status, 200);
  // ... but call-next never falls back to doctor2's patients.
  const call = await ctx.api.post(`/service-points/${d2.room.id}/call-next`, d1.token);
  assert.equal(call.status, 200);
  assert.equal(call.body.token, null);

  const id = joined.body.id;
  for (const [path, body] of [
    [`/tokens/${id}/priority`, { level: 2, reason: 'Emergency' }],
    [`/tokens/${id}/transfer`, { toServicePointId: d1.room.id, toDoctorId: d1.doctorId }],
  ]) {
    const res = await ctx.api.post(path, d1.token, body);
    assert.equal(res.status, 403, path);
  }

  // doctor2 calls their own patient; doctor1 cannot start / skip / complete it.
  ctx.advance(1);
  let called;
  for (let i = 0; i < 20; i += 1) {
    const r = await ctx.api.post(`/service-points/${d2.room.id}/call-next`, d2.token);
    assert.equal(r.status, 200);
    if (r.body.token.id === id) {
      called = r.body.token;
      break;
    }
    await ctx.api.post(`/tokens/${r.body.token.id}/complete`, d2.token);
  }
  assert.ok(called, "doctor2 reached the patient's token");
  for (const action of ['start', 'skip', 'complete']) {
    assert.equal((await ctx.api.post(`/tokens/${id}/${action}`, d1.token)).status, 403, action);
  }
  assert.equal((await ctx.api.post(`/tokens/${id}/skip`, d2.token)).status, 200);
  assert.equal((await ctx.api.post(`/tokens/${id}/recall`, d1.token)).status, 403);
  assert.equal((await ctx.api.post(`/tokens/${id}/recall`, d2.token)).status, 200);
  assert.equal((await ctx.api.post(`/tokens/${id}/complete`, d2.token)).status, 200);
});

test('doctor1 still calls its own patients in its own room', async () => {
  const p = await ctx.newPatient();
  const joined = await ctx.api.post('/tokens', p.token, { doctorId: d1.doctorId });
  assert.equal(joined.status, 201);
  const call = await ctx.api.post(`/service-points/${d1.room.id}/call-next`, d1.token);
  assert.equal(call.status, 200);
  assert.equal(call.body.token.doctorId, d1.doctorId);
});

test("schedule-derived room access only applies on the schedule's weekday", async () => {
  const today = ctx.time.isoDow(ctx.time.clock.now());
  const otherDay = (today % 7) + 1;
  // doctor3 is scheduled in doctor2's room, but on another weekday: no access today.
  const { insertId } = await ctx.db.run(
    `INSERT INTO doctor_schedules (doctor_id, service_point_id, day_of_week, start_time, end_time, max_patients)
     VALUES (?, ?, ?, '07:00:00', '08:00:00', NULL)`,
    [d3.doctorId, d2.room.id, otherDay]
  );
  assert.equal((await ctx.api.get(`/service-points/${d2.room.id}/queue`, d3.token)).status, 403);
  assert.equal((await ctx.api.post(`/service-points/${d2.room.id}/call-next`, d3.token)).status, 403);
  let list = (await ctx.api.get('/staff/service-points', d3.token)).body;
  assert.ok(!list.some((s) => s.id === d2.room.id));
  assert.ok(list.some((s) => s.id === d3.room.id), 'own room (assignment) still listed');

  // The same schedule on today's weekday grants access.
  await ctx.db.run('UPDATE doctor_schedules SET day_of_week = ? WHERE schedule_id = ?', [today, insertId]);
  assert.equal((await ctx.api.get(`/service-points/${d2.room.id}/queue`, d3.token)).status, 200);
  list = (await ctx.api.get('/staff/service-points', d3.token)).body;
  assert.ok(list.some((s) => s.id === d2.room.id));
  await ctx.db.run('DELETE FROM doctor_schedules WHERE schedule_id = ?', [insertId]);
});

test('lab staff are unaffected by doctor scoping', async () => {
  const lab = await ctx.login('lab1');
  const counter = (await ctx.api.get('/staff/service-points', lab)).body.find((s) => s.type === 'LAB');
  assert.ok(counter);
  assert.equal((await ctx.api.post(`/service-points/${counter.id}/call-next`, lab)).status, 200);
});
