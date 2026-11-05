'use strict';
/**
 * max_patients is enforced per SESSION (FR-03): only the doctor's OPD tokens issued within the
 * current session's window count, and browse's acceptingNow uses the same count.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');
let scheduleService; // required after createContext() configured the environment

let ctx;
let doc; // { doctorId, departmentId, roomId }
let base; // doctor's OPD tokens already issued today before the first session ends
const S1 = { start: '05:00:00', end: '10:30:00' };
const S2 = { start: '11:00:00', end: '23:00:00' };

async function acceptingNow() {
  const patient = await ctx.newPatient();
  const res = await ctx.api.get(`/departments/${doc.departmentId}/doctors`, patient.token);
  assert.equal(res.status, 200);
  return res.body.find((d) => d.id === doc.doctorId).acceptingNow;
}

async function join() {
  const p = await ctx.newPatient();
  return ctx.api.post('/tokens', p.token, { doctorId: doc.doctorId });
}

before(async () => {
  ctx = await createContext('maxpatients'); // clock: 10:00 today
  scheduleService = require('../src/services/scheduleService');
  const token = await ctx.login('doctor3');
  const me = await ctx.api.get('/auth/me', token);
  const d = await ctx.db.get('SELECT doctor_id, department_id FROM doctors WHERE doctor_id = ?', [me.body.user.doctorId]);
  const room = (await ctx.api.get('/staff/service-points', token)).body.find((s) => s.type === 'OPD');
  doc = { doctorId: d.doctor_id, departmentId: d.department_id, roomId: room.id };
  const now = ctx.time.clock.now();
  const date = ctx.time.formatDate(now);
  const row = await ctx.db.get(
    `SELECT COUNT(*) AS n FROM tokens WHERE doctor_id = ? AND token_date = ? AND queue_type = 'OPD'
       AND status NOT IN ('CANCELLED', 'TRANSFERRED') AND issued_at < ?`,
    [doc.doctorId, date, `${date} ${S1.end}`]
  );
  base = Number(row.n);
  // Two sessions today: S1 holds the seeded tokens + 1 more, S2 the same number.
  const dow = ctx.time.isoDow(now);
  await ctx.db.run('DELETE FROM doctor_schedules WHERE doctor_id = ? AND day_of_week = ?', [doc.doctorId, dow]);
  for (const s of [S1, S2]) {
    await ctx.db.run(
      `INSERT INTO doctor_schedules (doctor_id, service_point_id, day_of_week, start_time, end_time, max_patients)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [doc.doctorId, doc.roomId, dow, s.start, s.end, base + 1]
    );
  }
});
after(async () => {
  await ctx.close();
});

test('session windows partition the day like pickSession', async () => {
  const date = ctx.time.formatDate(ctx.time.clock.now());
  const sessions = await scheduleService.doctorSessions(ctx.db, doc.doctorId, date);
  assert.equal(sessions.length, 2);
  assert.deepEqual(scheduleService.sessionWindow(sessions, sessions[0], date), {
    from: `${date} 00:00:00`,
    to: `${date} ${S1.end}`,
  });
  const next = ctx.time.addDaysStr(date, 1);
  assert.deepEqual(scheduleService.sessionWindow(sessions, sessions[1], date), {
    from: `${date} ${S1.end}`,
    to: `${next} 00:00:00`,
  });
});

test('first session fills up at its own max_patients', async () => {
  assert.equal(await acceptingNow(), true);
  const first = await join();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(await acceptingNow(), false);
  const full = await join();
  assert.equal(full.status, 409);
});

test("tokens of the earlier session do not count against the next session's max_patients", async () => {
  ctx.advance(45); // 10:45: S1 has ended, S2 is the current session
  // Whole-day count (base + 1) already equals S2's max: the old per-day rule would refuse here.
  assert.equal(await acceptingNow(), true);
  for (let i = 0; i < base + 1; i += 1) {
    const res = await join();
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  assert.equal(await acceptingNow(), false);
  assert.equal((await join()).status, 409);
});
