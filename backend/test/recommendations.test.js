'use strict';
/** Smart branch recommendation (FR-08, FR-09): Eq. 6.3 scoring, haversine, reasons, congestion. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');
const fb = require('../src/services/featureBuilder');

let ctx;
let patient;

/** Recompute Eq. 6.3 from the returned items (min-max normalisation, all equal -> 0). */
function expectedScores(items, w) {
  const norm = (vals) => {
    const finite = vals.filter((x) => x !== null);
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    return vals.map((x) => (x === null || max === min ? 0 : (x - min) / (max - min)));
  };
  const W = norm(items.map((i) => i.predictedWaitMinutes));
  const D = norm(items.map((i) => i.distanceKm));
  const R = norm(items.map((i) => i.congestionRatio));
  return items.map((_, i) => w.wait * W[i] + w.distance * D[i] + w.congestion * R[i]);
}

before(async () => {
  ctx = await createContext('recommendations');
  patient = await ctx.newPatient();
});
after(async () => {
  await ctx.close();
});

test('without location: one candidate per branch, distance weight redistributed, sorted by score', async () => {
  const res = await ctx.api.get('/recommendations?specialty=cardiology', patient.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.specialty, 'Cardiology');
  assert.equal(res.body.weights.distance, 0);
  assert.ok(Math.abs(res.body.weights.wait + res.body.weights.congestion - 1) < 1e-3);
  assert.ok(Math.abs(res.body.weights.wait / res.body.weights.congestion - 0.6 / 0.15) < 1e-2);
  const { items } = res.body;
  assert.equal(items.length, 3);
  assert.deepEqual(new Set(items.map((i) => i.branchName)), new Set(['Model Town', 'Gulberg', 'DHA']));
  for (const i of items) {
    for (const key of ['branchId', 'branchName', 'address', 'doctorId', 'doctorName', 'predictedWaitMinutes', 'distanceKm', 'congestionRatio', 'congestionLevel', 'score', 'reason']) {
      assert.ok(key in i, key);
    }
    assert.equal(i.distanceKm, null);
    assert.equal(typeof i.reason, 'string');
    assert.ok(i.reason.length > 5);
  }
  for (let k = 1; k < items.length; k += 1) assert.ok(items[k - 1].score <= items[k].score);
  const expected = expectedScores(items, res.body.weights);
  items.forEach((i, k) => assert.ok(Math.abs(i.score - expected[k]) < 1e-3, `score ${i.score} vs ${expected[k]}`));
});

test('with location: haversine distance, nearest branch flagged in the reason; location never stored', async () => {
  const lat = 31.4697;
  const lng = 74.4091; // standing at DHA
  const res = await ctx.api.get(`/recommendations?specialty=Cardiology&lat=${lat}&lng=${lng}`, patient.token);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.weights, { wait: 0.6, distance: 0.25, congestion: 0.15 });
  const dha = res.body.items.find((i) => i.branchName === 'DHA');
  const mt = res.body.items.find((i) => i.branchName === 'Model Town');
  assert.equal(dha.distanceKm, 0);
  assert.equal(mt.distanceKm, Math.round(fb.haversineKm(lat, lng, 31.4834, 74.3255) * 10) / 10);
  assert.ok(mt.distanceKm > 7 && mt.distanceKm < 9);
  assert.match(dha.reason, /0 km away \(nearest\)/);
  const expected = expectedScores(res.body.items, res.body.weights);
  res.body.items.forEach((i, k) => assert.ok(Math.abs(i.score - expected[k]) < 1e-3));
  // NFR-05: coordinates are not persisted anywhere
  const rows = await ctx.db.query("SELECT COUNT(*) AS n FROM notifications WHERE message LIKE '%31.4697%'", []);
  assert.equal(rows[0].n, 0);
});

test('a congested branch drops to the bottom; excludeDoctorId produces comparative reasons (FR-09)', async () => {
  const depts = (await ctx.api.get('/branches/1/departments', patient.token)).body;
  const cardio = depts.find((d) => d.specialty === 'Cardiology');
  const doctors = (await ctx.api.get(`/departments/${cardio.id}/doctors`, patient.token)).body;
  // 12 patients join both Model Town cardiologists
  for (let i = 0; i < 12; i += 1) {
    const p = await ctx.newPatient();
    for (const d of doctors) {
      const res = await ctx.api.post('/tokens', p.token, { doctorId: d.id });
      assert.equal(res.status, 201);
    }
  }
  const res = await ctx.api.get('/recommendations?specialty=Cardiology', patient.token);
  const items = res.body.items;
  assert.equal(items[items.length - 1].branchName, 'Model Town');
  const mt = items[items.length - 1];
  assert.ok(mt.predictedWaitMinutes > items[0].predictedWaitMinutes);
  assert.ok(mt.congestionRatio > items[0].congestionRatio);

  const ex = await ctx.api.get(`/recommendations?specialty=Cardiology&excludeDoctorId=${doctors[0].id}`, patient.token);
  assert.equal(ex.status, 200);
  assert.ok(!ex.body.items.some((i) => i.doctorId === doctors[0].id));
  assert.ok(ex.body.items.some((i) => /min shorter wait/.test(i.reason)));

  // the patient's own token shows the congestion / alternative suggestion flags
  const p = await ctx.newPatient();
  const t = await ctx.api.post('/tokens', p.token, { doctorId: doctors[0].id });
  assert.equal(t.status, 201);
  assert.ok(['NORMAL', 'HIGH', 'CRITICAL'].includes(t.body.congestion.level));
  const settings = (await ctx.api.get('/admin/settings', await ctx.login('admin'))).body;
  const shouldSuggest = t.body.estimate.minutes >= settings.alternativeSuggestionWaitMinutes || t.body.congestion.level !== 'NORMAL';
  assert.equal(t.body.congestion.suggestAlternatives, shouldSuggest);
});

test('validation and empty results', async () => {
  assert.equal((await ctx.api.get('/recommendations', patient.token)).status, 400);
  assert.equal((await ctx.api.get('/recommendations?specialty=ENT&lat=31.5', patient.token)).status, 400);
  assert.equal((await ctx.api.get('/recommendations?specialty=ENT&lat=200&lng=74', patient.token)).status, 400);
  const none = await ctx.api.get('/recommendations?specialty=Neurology', patient.token);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.items, []);
  const ent = await ctx.api.get('/recommendations?specialty=ENT', patient.token);
  assert.deepEqual(new Set(ent.body.items.map((i) => i.branchName)), new Set(['Model Town', 'DHA']));
});
