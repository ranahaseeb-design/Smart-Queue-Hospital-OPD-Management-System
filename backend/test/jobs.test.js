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

  const { Token, QueueEvent, Visit, Appointment } = ctx.models;
  const rows = await Token.find({ token_date: today }).lean();
  assert.ok(rows.every((r) => r.status === 'NO_SHOW'));
  const events = await QueueEvent.find({ token_id: { $in: rows.map((r) => r._id) }, event_type: 'NO_SHOW' }).lean();
  assert.equal(events.length, 5);
  assert.ok(events.every((e) => e.note === 'End-of-day closure'));
  const open = await Visit.countDocuments({ status: 'OPEN' });
  assert.equal(open, 0);
  const a = await Appointment.findById(appt.body.id).lean();
  assert.equal(a.status, 'NO_SHOW');
  // running it again is harmless
  const again = await jobs.runDailyMaintenance(ctx.db);
  assert.deepEqual([again.tokens, again.appointments, again.visits], [0, 0, 0]);
});

test('transfer moves the appointment to the new token; end of day auto-completes IN_SERVICE tokens + their appointment', async () => {
  // The clock is the next day 00:05 (previous test). Book doctor1's first slot and check in.
  const day = ctx.time.today();
  const patient = await ctx.newPatient();
  const doctorToken = await ctx.login('doctor1');
  const doctorId = (await ctx.api.get('/auth/me', doctorToken)).body.user.doctorId;
  const slot = (await ctx.api.get(`/doctors/${doctorId}/slots?date=${day}`, patient.token)).body.slots[0].start;
  const appt = await ctx.api.post('/appointments', patient.token, { doctorId, slotStart: slot });
  assert.equal(appt.status, 201);
  ctx.time.clock.set(new Date(ctx.time.combine(day, slot.slice(11)).getTime() - 30 * 60000));
  const checked = await ctx.api.post(`/appointments/${appt.body.id}/check-in`, patient.token);
  assert.equal(checked.status, 201);

  const targets = await ctx.api.get(`/staff/transfer-targets?servicePointId=${checked.body.servicePoint.id}`, doctorToken);
  const target = targets.body.find((t) => t.type === 'OPD' && t.doctorId);
  const moved = await ctx.api.post(`/tokens/${checked.body.id}/transfer`, doctorToken, { toServicePointId: target.servicePointId });
  assert.equal(moved.status, 200);
  const { Token, QueueEvent, Appointment } = ctx.models;
  const linkOf = async (id) => (await Token.findById(id).lean()).appointment_id;
  assert.equal(await linkOf(checked.body.id), null);
  assert.equal(await linkOf(moved.body.to.id), appt.body.id);
  const list = (await ctx.api.get('/appointments', patient.token)).body;
  assert.equal(list.find((a) => a.id === appt.body.id).tokenId, moved.body.to.id);

  // Staff started the consultation but never completed it.
  await Token.updateOne({ _id: moved.body.to.id }, { $set: { status: 'IN_SERVICE', called_at: ctx.time.nowDb() } });
  const next = ctx.time.parseDate(ctx.time.addDaysStr(day, 1));
  ctx.time.clock.set(new Date(next.getFullYear(), next.getMonth(), next.getDate(), 0, 5, 0));
  const result = await jobs.runDailyMaintenance(ctx.db);
  assert.equal(result.autoCompleted, 1);
  const tok = await Token.findById(moved.body.to.id).lean();
  assert.equal(tok.status, 'COMPLETED');
  assert.equal(tok.completed_at.getTime(), ctx.time.nowDb().getTime());
  const ev = await QueueEvent.findOne({ token_id: moved.body.to.id, event_type: 'COMPLETED' }).lean();
  assert.equal(ev.note, 'auto-closed at end of day');
  const a = await Appointment.findById(appt.body.id).lean();
  assert.equal(a.status, 'COMPLETED');
});

test('forecast refresh falls back to the baseline and writes the next 7 days', async () => {
  const result = await jobs.runForecastRefresh(ctx.db);
  assert.equal(result.source, 'baseline');
  assert.ok(result.generated > 0);
  const { Forecast } = ctx.models;
  const generated = { generated_at: ctx.time.nowDb() };
  const first = await Forecast.findOne(generated).sort({ forecast_hour: 1 }).lean();
  const last = await Forecast.findOne(generated).sort({ forecast_hour: -1 }).lean();
  assert.ok(first.forecast_hour >= ctx.time.dayStart(ctx.time.today()));
  assert.ok(last.forecast_hour < ctx.time.combine(ctx.time.addDaysStr(ctx.time.today(), 7), '01:00:00'));
});

test('the scheduler starts and stops cleanly', async () => {
  const handle = jobs.start(ctx.db, { logger: { log() {}, error() {} } });
  handle.stop();
  handle.stop();
});
