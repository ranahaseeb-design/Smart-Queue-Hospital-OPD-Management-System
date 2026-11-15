'use strict';
/**
 * Patient-consented token switch (FR-09, Section 6.5.3), the "Explain AI estimate" breakdown on
 * TokenDetail.estimate.explain, and the cold-start rule (Section 6.4.4).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let roomA;
let roomB;

async function opdRoom(account) {
  const token = await ctx.login(account);
  const sps = await ctx.api.get('/staff/service-points', token);
  assert.equal(sps.status, 200);
  const room = sps.body.find((s) => s.type === 'OPD');
  assert.ok(room, `${account} has an OPD room`);
  return room;
}

before(async () => {
  ctx = await createContext('switch');
  roomA = await opdRoom('doctor1');
  roomB = await opdRoom('doctor2');
  assert.notEqual(roomA.doctorId, roomB.doctorId);
});
after(async () => {
  await ctx.close();
});

test('TokenDetail.estimate.explain shows the Eq. 6.2 inputs and why the baseline was used', async () => {
  const p = await ctx.newPatient();
  const res = await ctx.api.post('/tokens', p.token, { doctorId: roomA.doctorId });
  assert.equal(res.status, 201);
  const ex = res.body.estimate.explain;
  assert.ok(ex, 'explain present');
  assert.equal(ex.method, 'BASELINE');
  assert.equal(ex.reason, 'AI_UNAVAILABLE'); // the test AI URL is unreachable
  assert.equal(ex.patientsAhead, res.body.patientsAhead);
  assert.ok(ex.doctorAvgConsultMinutes > 0);
  assert.equal(typeof ex.baselineMinutes, 'number');
  const pred = await ctx.models.WaitPrediction.findOne({ token_id: res.body.id }).lean();
  assert.equal(pred.baseline_reason, 'AI_UNAVAILABLE');
});

test('switch: new token with the chosen doctor, old token CANCELLED with a note', async () => {
  const p = await ctx.newPatient();
  const first = await ctx.api.post('/tokens', p.token, { doctorId: roomA.doctorId });
  assert.equal(first.status, 201);
  ctx.advance(1);
  const res = await ctx.api.post(`/tokens/${first.body.id}/switch`, p.token, { doctorId: roomB.doctorId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.cancelled.status, 'CANCELLED');
  assert.equal(res.body.token.status, 'WAITING');
  assert.equal(res.body.token.doctor.id, roomB.doctorId);
  const ev = await ctx.models.QueueEvent.findOne({ token_id: first.body.id, event_type: 'CANCELLED' }).lean();
  assert.match(ev.note, /^Switched to /);
  const active = await ctx.api.get('/tokens/active', p.token);
  assert.deepEqual(active.body.map((t) => t.id), [res.body.token.id]);
});

test('switch is refused for the same doctor, someone else\'s token, or a non-waiting token', async () => {
  const p = await ctx.newPatient();
  const other = await ctx.newPatient();
  const t = await ctx.api.post('/tokens', p.token, { doctorId: roomA.doctorId });
  assert.equal((await ctx.api.post(`/tokens/${t.body.id}/switch`, p.token, { doctorId: roomA.doctorId })).status, 400);
  assert.equal((await ctx.api.post(`/tokens/${t.body.id}/switch`, other.token, { doctorId: roomB.doctorId })).status, 403);
  assert.equal((await ctx.api.post(`/tokens/${t.body.id}/switch`, p.token, {})).status, 400);
  assert.equal((await ctx.api.del(`/tokens/${t.body.id}`, p.token)).status, 200);
  assert.equal((await ctx.api.post(`/tokens/${t.body.id}/switch`, p.token, { doctorId: roomB.doctorId })).status, 409);
});

test('a refused new token leaves the old one untouched (already active with that doctor)', async () => {
  const p = await ctx.newPatient();
  const a = await ctx.api.post('/tokens', p.token, { doctorId: roomA.doctorId });
  const b = await ctx.api.post('/tokens', p.token, { doctorId: roomB.doctorId });
  assert.equal(b.status, 201);
  const res = await ctx.api.post(`/tokens/${a.body.id}/switch`, p.token, { doctorId: roomB.doctorId });
  assert.equal(res.status, 409);
  const row = await ctx.models.Token.findById(a.body.id).lean();
  assert.equal(row.status, 'WAITING');
});

test('cold start: doctors below the consultation threshold are reported', async () => {
  const predictionService = require('../src/services/predictionService');
  const config = require('../src/config');
  const saved = config.coldStartMinConsults;
  try {
    config.coldStartMinConsults = 1e9;
    predictionService.clearCaches();
    const cold = await predictionService.coldStartDoctors(ctx.db, [roomA.doctorId]);
    assert.ok(cold.has(roomA.doctorId));
    config.coldStartMinConsults = 0;
    predictionService.clearCaches();
    assert.equal((await predictionService.coldStartDoctors(ctx.db, [roomA.doctorId])).size, 0);
  } finally {
    config.coldStartMinConsults = saved;
    predictionService.clearCaches();
  }
});
