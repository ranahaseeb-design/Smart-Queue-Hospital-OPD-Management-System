'use strict';
/** Appointment management (FR-10): slots, booking, double booking, reschedule, cancel, check-in. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let doctorId;
let tomorrow;
let A;
let B;
let booking;

async function slots(date, token = A.token) {
  const res = await ctx.api.get(`/doctors/${doctorId}/slots?date=${date}`, token);
  assert.equal(res.status, 200);
  return res.body;
}

before(async () => {
  ctx = await createContext('appointments');
  const me = await ctx.api.get('/auth/me', await ctx.login('doctor1'));
  doctorId = me.body.user.doctorId;
  tomorrow = ctx.time.addDaysStr(ctx.time.today(), 1);
  A = await ctx.newPatient();
  B = await ctx.newPatient();
});
after(async () => {
  await ctx.close();
});

test('slots come from the weekday schedule in settings.slotMinutes steps', async () => {
  const s = await slots(tomorrow);
  assert.equal(s.doctorId, doctorId);
  assert.equal(s.date, tomorrow);
  assert.equal(s.slotMinutes, 15);
  assert.ok(s.slots.length === 24 || s.slots.length === 32, 'a 6 h or 8 h session');
  assert.ok(s.slots.every((x) => x.available));
  assert.match(s.slots[0].start, /^\d{4}-\d{2}-\d{2}T(08|14):00:00$/);
  // past slots of today are excluded (clock is 10:00)
  const today = await slots(ctx.time.today());
  assert.ok(today.slots.every((x) => x.start > `${ctx.time.today()}T10:00:00`));
  assert.equal((await ctx.api.get(`/doctors/${doctorId}/slots?date=nope`, A.token)).status, 400);
  assert.equal((await ctx.api.get('/doctors/99999/slots', A.token)).status, 404);
});

test('book a slot; the same slot cannot be double-booked (409)', async () => {
  const s = await slots(tomorrow);
  const res = await ctx.api.post('/appointments', A.token, { doctorId, slotStart: s.slots[0].start });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'BOOKED');
  assert.equal(res.body.slotStart, s.slots[0].start);
  assert.equal(res.body.doctor.id, doctorId);
  assert.equal(res.body.branch.name, 'Model Town');
  assert.equal(res.body.tokenId, null);
  booking = res.body;

  const taken = await ctx.api.post('/appointments', B.token, { doctorId, slotStart: s.slots[0].start });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'CONFLICT');
  const sameDay = await ctx.api.post('/appointments', A.token, { doctorId, slotStart: s.slots[3].start });
  assert.equal(sameDay.status, 409);
  const after = await slots(tomorrow);
  assert.equal(after.slots[0].available, false);

  const notes = await ctx.api.get('/notifications', A.token);
  assert.ok(notes.body.some((n) => n.message.startsWith('Appointment booked')));
});

test('invalid slots are rejected (off-grid, past, outside schedule, staff role)', async () => {
  const offGrid = `${tomorrow}T${booking.slotStart.slice(11, 13)}:07:00`;
  assert.equal((await ctx.api.post('/appointments', B.token, { doctorId, slotStart: offGrid })).status, 400);
  const yesterday = ctx.time.addDaysStr(ctx.time.today(), -1);
  assert.equal((await ctx.api.post('/appointments', B.token, { doctorId, slotStart: `${yesterday}T09:00:00` })).status, 400);
  assert.equal((await ctx.api.post('/appointments', B.token, { doctorId, slotStart: `${tomorrow}T03:00:00` })).status, 400);
  assert.equal((await ctx.api.post('/appointments', B.token, { doctorId, slotStart: 'tomorrow' })).status, 400);
  assert.equal((await ctx.api.post('/appointments', await ctx.login('doctor1'), { doctorId, slotStart: booking.slotStart })).status, 403);
});

test('reschedule releases the old slot; only BOOKED appointments can be rescheduled', async () => {
  const s = await slots(tomorrow);
  const res = await ctx.api.put(`/appointments/${booking.id}`, A.token, { slotStart: s.slots[2].start });
  assert.equal(res.status, 200);
  assert.equal(res.body.slotStart, s.slots[2].start);
  const after = await slots(tomorrow);
  assert.equal(after.slots[0].available, true);
  assert.equal(after.slots[2].available, false);
  assert.equal((await ctx.api.put(`/appointments/${booking.id}`, B.token, { slotStart: s.slots[4].start })).status, 403);
  // B cannot move into A's slot
  const bBook = await ctx.api.post('/appointments', B.token, { doctorId, slotStart: s.slots[5].start });
  assert.equal(bBook.status, 201);
  assert.equal((await ctx.api.put(`/appointments/${bBook.body.id}`, B.token, { slotStart: s.slots[2].start })).status, 409);
});

test('cancel releases the slot; a cancelled appointment cannot be changed', async () => {
  const res = await ctx.api.del(`/appointments/${booking.id}`, A.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'CANCELLED');
  const s = await slots(tomorrow);
  assert.equal(s.slots[2].available, true);
  assert.equal((await ctx.api.put(`/appointments/${booking.id}`, A.token, { slotStart: s.slots[6].start })).status, 409);
  assert.equal((await ctx.api.del(`/appointments/${booking.id}`, A.token)).status, 409);
  // the released slot can be booked by somebody else
  const C = await ctx.newPatient();
  assert.equal((await ctx.api.post('/appointments', C.token, { doctorId, slotStart: s.slots[2].start })).status, 201);
});

test('check-in only on the appointment day: creates a token linked to the appointment', async () => {
  const future = await ctx.api.post('/appointments', A.token, { doctorId, slotStart: (await slots(tomorrow)).slots[7].start });
  assert.equal(future.status, 201);
  const early = await ctx.api.post(`/appointments/${future.body.id}/check-in`, A.token);
  assert.equal(early.status, 409);

  const today = await slots(ctx.time.today());
  const free = today.slots.find((x) => x.available);
  const appt = await ctx.api.post('/appointments', A.token, { doctorId, slotStart: free.start });
  assert.equal(appt.status, 201);
  ctx.advance(2);
  const res = await ctx.api.post(`/appointments/${appt.body.id}/check-in`, A.token);
  assert.equal(res.status, 201);
  assert.equal(res.body.queueType, 'OPD');
  assert.equal(res.body.status, 'WAITING');
  assert.equal(res.body.doctor.id, doctorId);

  const list = await ctx.api.get('/appointments', A.token);
  const checked = list.body.find((a) => a.id === appt.body.id);
  assert.equal(checked.status, 'CHECKED_IN');
  assert.equal(checked.tokenId, res.body.id);
  // newest slot first
  for (let i = 1; i < list.body.length; i += 1) assert.ok(list.body[i - 1].slotStart >= list.body[i].slotStart);
  assert.equal((await ctx.api.post(`/appointments/${appt.body.id}/check-in`, A.token)).status, 409);

  const doctorToken = await ctx.login('doctor1');
  const room = (await ctx.api.get('/staff/service-points', doctorToken)).body[0];
  const q = await ctx.api.get(`/service-points/${room.id}/queue`, doctorToken);
  const token = q.body.waiting.find((w) => w.id === res.body.id);
  assert.equal(token.fromAppointment, true);
  const issued = await ctx.db.get(`SELECT note FROM queue_events WHERE token_id = ? AND event_type = 'ISSUED'`, [res.body.id]);
  assert.equal(issued.note, `Checked in for appointment #${appt.body.id}`);
});
