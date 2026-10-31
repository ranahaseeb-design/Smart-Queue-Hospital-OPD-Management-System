'use strict';
/** Scheduled jobs: end-of-day closure, nightly consult averages, forecast refresh + alerts. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let jobs;
before(async () => {
  ctx = await createContext('jobs');
  jobs = require('../src/jobs');
});
after(async () => {
  await ctx.close();
});

test('nightly maintenance closes the previous day: NO_SHOW tokens with events, CLOSED visits, NO_SHOW appointments', async () => {
  const today = ctx.time.today();
  const patient = await ctx.newPatient();
  const doctorId = (await ctx.api.get('/auth/me', await ctx.login('doctor1'))).body.user.doctorId;
  const slots = (await ctx.api.get(`/doctors/${doctorId}/slots?date=${today}`, patient.token)).body.slots;
  const appt = await ctx.api.post('/appointments', patient.token, { doctorId, slotStart: slots[0].start });
  assert.equal(appt.status, 201);

  // next day, 00:05
  const tomorrow = ctx.time.parseDate(ctx.time.addDaysStr(today, 1));
  ctx.time.clock.set(new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 5, 0));
  const result = await jobs.runDailyMaintenance(ctx.db);
  assert.equal(result.tokens, 5); // the seeded WAITING tokens of "yesterday"
  assert.equal(result.appointments, 1);
  assert.ok(result.visits >= 5);

  const rows = await ctx.db.query(`SELECT status FROM tokens WHERE token_date = ?`, [today]);
  assert.ok(rows.every((r) => r.status === 'NO_SHOW'));
  const events = await ctx.db.query(
    `SELECT e.note FROM queue_events e JOIN tokens t ON t.token_id = e.token_id WHERE t.token_date = ? AND e.event_type = 'NO_SHOW'`,
    [today]
  );
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.note === 'End-of-day closure'));
  const open = await ctx.db.get(`SELECT COUNT(*) AS n FROM visits WHERE status = 'OPEN'`, []);
  assert.equal(open.n, 0);
  const a = await ctx.db.get('SELECT status FROM appointments WHERE appointment_id = ?', [appt.body.id]);
  assert.equal(a.status, 'NO_SHOW');
  // running it again is harmless
  const again = await jobs.runDailyMaintenance(ctx.db);
  assert.deepEqual([again.tokens, again.appointments, again.visits], [0, 0, 0]);
});

test('forecast refresh falls back to the baseline and writes the next 7 days', async () => {
  const result = await jobs.runForecastRefresh(ctx.db);
  assert.equal(result.source, 'baseline');
  assert.ok(result.generated > 0);
  const range = await ctx.db.get('SELECT MIN(forecast_hour) AS a, MAX(forecast_hour) AS b FROM forecasts WHERE generated_at = ?', [
    ctx.time.nowDb(),
  ]);
  assert.ok(range.a >= `${ctx.time.today()} 00:00:00`);
  assert.ok(range.b < `${ctx.time.addDaysStr(ctx.time.today(), 7)} 01:00:00`);
});

test('the scheduler starts and stops cleanly', async () => {
  const handle = jobs.start(ctx.db, { logger: { log() {}, error() {} } });
  handle.stop();
  handle.stop();
});
