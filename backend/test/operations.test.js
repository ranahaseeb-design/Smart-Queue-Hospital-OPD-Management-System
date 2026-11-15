'use strict';
/**
 * Committee demo data (POST /demo/seed), the peak-congestion toggle (/demo/peak), the haversine
 * cross-branch load balancer (GET /admin/load-balancer), the waiting-room board (GET /display),
 * the forecast status banner (GET /admin/forecast-status) and department live load fields.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');

let ctx;
let admin;
let branchAdmin;
let doctorToken;
let pharmacyToken;
let room;
let pharmacyPoint;

before(async () => {
  ctx = await createContext('operations');
  admin = await ctx.login('admin');
  branchAdmin = await ctx.login('branchAdmin');
  doctorToken = await ctx.login('doctor1');
  pharmacyToken = await ctx.login('pharmacy1');
  room = (await ctx.api.get('/staff/service-points', doctorToken)).body.find((s) => s.type === 'OPD');
  pharmacyPoint = (await ctx.api.get('/staff/service-points', pharmacyToken)).body.find((s) => s.type === 'PHARMACY');
});
after(async () => {
  await ctx.close();
});

const queue = async (token, spId) => (await ctx.api.get(`/service-points/${spId}/queue`, token)).body;

test('committee demo data: 40+ completed visits today, 5 waiting for Room 1, 2 waiting at the pharmacy', async () => {
  const before = (await ctx.api.get('/admin/dashboard', admin)).body.kpis;
  const doctorBefore = (await queue(doctorToken, room.id)).waiting.length;
  const pharmacyBefore = (await queue(pharmacyToken, pharmacyPoint.id)).waiting.length;

  const res = await ctx.api.post('/demo/seed', admin, {});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(res.body.completedVisits >= 40, `completed ${res.body.completedVisits}`);
  assert.equal(res.body.waiting.doctor.tokens.length, 5);
  assert.equal(res.body.waiting.doctor.servicePointName, room.name);
  assert.equal(res.body.waiting.pharmacy.tokens.length, 2);
  assert.ok(['ai', 'baseline'].includes(res.body.forecast.source));

  const after = (await ctx.api.get('/admin/dashboard', admin)).body.kpis;
  assert.ok(after.completedToday >= before.completedToday + 40, `${before.completedToday} -> ${after.completedToday}`);
  assert.equal((await queue(doctorToken, room.id)).waiting.length, doctorBefore + 5);
  const pq = await queue(pharmacyToken, pharmacyPoint.id);
  assert.equal(pq.waiting.length, pharmacyBefore + 2, 'Sobia Anjum sees the 2 referred tokens');
  assert.ok(pq.summary.completedToday > 0, 'pharmacy completions from the demo day');
  assert.ok(pq.summary.avgConsultMinutes >= 2 && pq.summary.avgConsultMinutes <= 4, `avg service ${pq.summary.avgConsultMinutes}`);

  // Past demo visits are complete records: closed visit, 4 events, synthetic flag.
  const demoToken = await ctx.models.Token.findOne({ status: 'COMPLETED', token_date: ctx.time.today(), is_synthetic: true, queue_type: 'OPD' }).sort({ _id: -1 }).lean();
  const events = await ctx.models.QueueEvent.find({ token_id: demoToken._id }).lean();
  assert.deepEqual(events.map((e) => e.event_type).sort(), ['CALLED', 'COMPLETED', 'ISSUED', 'STARTED']);
  assert.ok(demoToken.issued_at < demoToken.called_at && demoToken.called_at < demoToken.completed_at);
  assert.ok(demoToken.completed_at <= ctx.time.clock.now());
});

test('peak congestion toggle pushes Model Town above 85 % and back; the load balancer recommends a redirect', async () => {
  const on = await ctx.api.post('/demo/peak', admin, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.ok(on.body.load.percent >= 85, `load ${on.body.load.percent}%`);
  assert.equal(on.body.peakActive, true);
  assert.equal((await ctx.api.get('/demo/peak', doctorToken)).body.peakActive, true);

  const lb = await ctx.api.get('/admin/load-balancer', admin);
  assert.equal(lb.status, 200, JSON.stringify(lb.body));
  assert.equal(lb.body.branches.length, 3);
  assert.equal(lb.body.distances.length, 3);
  const mt = lb.body.branches.find((b) => b.name === 'Model Town');
  assert.ok(mt.loadPercent >= 85);
  const rec = lb.body.recommendations.find((r) => r.fromBranchName === 'Model Town');
  assert.ok(rec, 'redirect away from Model Town');
  assert.ok(rec.distanceKm > 0 && rec.toLoadPercent < 75);
  assert.match(rec.message, /km away/);

  // Branch admin (Model Town): sees all branches, only redirects involving Model Town, as OUTGOING.
  const own = (await ctx.api.get('/admin/load-balancer', branchAdmin)).body;
  assert.equal(own.branches.length, 3);
  assert.ok(own.recommendations.length > 0 && own.recommendations.every((r) => r.direction === 'OUTGOING'));
  assert.equal((await ctx.api.get('/admin/load-balancer', doctorToken)).status, 403);

  // The patient-facing department load reflects it.
  const pt = (await ctx.api.post('/auth/guest', null, {})).body.token;
  const deps = (await ctx.api.get(`/branches/${mt.branchId}/departments`, pt)).body;
  assert.ok(deps.every((d) => typeof d.loadPercent === 'number' && d.congestionLevel));
  assert.ok(deps.some((d) => d.loadPercent >= 75));

  const off = await ctx.api.post('/demo/peak', admin, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.cancelled, on.body.added);
  assert.equal(off.body.peakActive, false);
  assert.ok(off.body.load.percent < on.body.load.percent);
  assert.equal((await ctx.api.post('/demo/peak', admin, {})).status, 400);
});

test('waiting-room board: token numbers per room and counter, no patient names, branch-scoped', async () => {
  const board = await ctx.api.get('/display', null);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.branch.name, 'Model Town');
  const types = board.body.servicePoints.map((s) => s.type);
  assert.deepEqual(types, [...types].sort((a, b) => ['OPD', 'LAB', 'PHARMACY'].indexOf(a) - ['OPD', 'LAB', 'PHARMACY'].indexOf(b)));
  const opd = board.body.servicePoints.find((s) => s.id === room.id);
  assert.ok(opd.doctorName && opd.next.length <= 3 && opd.waiting >= opd.next.length);
  assert.ok(board.body.departments.length > 0);
  // No patient data: only these fields exist on the board (doctor names are public room labels).
  const allowed = {
    servicePoint: ['id', 'name', 'type', 'departmentName', 'doctorName', 'nowServing', 'next', 'waiting'],
    serving: ['displayNumber', 'status', 'calledAt'],
    next: ['displayNumber', 'priorityLevel', 'fromAppointment'],
  };
  for (const sp of board.body.servicePoints) {
    assert.deepEqual(Object.keys(sp).sort(), [...allowed.servicePoint].sort());
    if (sp.nowServing) assert.deepEqual(Object.keys(sp.nowServing).sort(), [...allowed.serving].sort());
    for (const n of sp.next) assert.deepEqual(Object.keys(n).sort(), [...allowed.next].sort());
  }
  assert.doesNotMatch(JSON.stringify(board.body), /patient|phone|email/i);

  // Public: a TV opens it without signing in; any active branch can be chosen.
  const anon = await ctx.api.get('/display', null);
  assert.equal(anon.status, 200);
  assert.equal(anon.body.branch.name, 'Model Town');
  assert.equal(anon.body.branches.length, 3);
  const gulberg = anon.body.branches.find((b) => b.name === 'Gulberg');
  const other = await ctx.api.get(`/display?branchId=${gulberg.id}`, null);
  assert.equal(other.status, 200);
  assert.equal(other.body.branch.name, 'Gulberg');
  assert.equal((await ctx.api.get('/display?branchId=999', null)).status, 404);
});

test('forecast status reports the engine of the current forecasts and the AI availability', async () => {
  const res = await ctx.api.get('/admin/forecast-status', admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.aiAvailable, false); // AI service is down in tests
  assert.ok(res.body.forecast && ['ai', 'baseline'].includes(res.body.forecast.source));
  assert.equal(res.body.forecast.engine, 'Seasonal baseline (fallback: AI service unavailable)');
  assert.equal(res.body.forecast.isRandomForest, false);
  assert.equal(res.body.waitModel, null);
});
