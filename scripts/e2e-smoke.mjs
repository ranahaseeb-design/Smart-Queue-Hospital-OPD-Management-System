#!/usr/bin/env node
/**
 * End-to-end smoke test (Upgrade 2026, Phase 3) against a running backend.
 *
 *   node scripts/e2e-smoke.mjs                      # http://127.0.0.1:4000/api
 *   E2E_API=http://127.0.0.1:4100/api node scripts/e2e-smoke.mjs
 *
 * Scenario: a new patient joins the most congested OPD department → reads the AI wait range,
 * its explanation and the branch recommendations → switches to the top-ranked branch (FR-09)
 * → that doctor sets emergency priority, calls next, starts, issues linked LAB + PHARMACY
 * tokens (FR-04) and completes → the patient sees the journey, the waiting-room board shows
 * the LAB token, and the admin dashboard KPIs / trend / alerts / forecasts reflect it.
 *
 * Uses only seeded development accounts (backend/src/db/seed.js) and registers one throwaway
 * patient. Needs a freshly seeded database with live queues (npm run seed) and
 * DEMO_ALWAYS_OPEN=true or clinic hours. Exit code 0 = all checks passed.
 */
const API = (process.env.E2E_API || 'http://127.0.0.1:4000/api').replace(/\/$/, '');
const STAFF_PASSWORD = 'Staff@123';
const ADMIN = { identifier: 'admin@opd.test', password: 'Admin@123' };

let passed = 0;
const failures = [];

function check(cond, label, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✖ ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
  return cond;
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json };
}

async function login(identifier, password) {
  const r = await call('POST', '/auth/login', null, { identifier, password });
  if (r.status !== 200) throw new Error(`login ${identifier} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const step = (title) => console.log(`\n▸ ${title}`);
const rank = { CRITICAL: 2, HIGH: 1, NORMAL: 0 };

async function main() {
  step('Health and accounts');
  const health = await call('GET', '/health');
  check(health.status === 200 && health.body?.db === 'mongodb', 'backend healthy on MongoDB', health.body);
  const adminToken = await login(ADMIN.identifier, ADMIN.password);
  const phone = `0399${String(Date.now()).slice(-7)}`;
  const reg = await call('POST', '/auth/register', null, { fullName: 'E2E Smoke Patient', phone, password: 'Smoke@1234' });
  check(reg.status === 201, 'throwaway patient registered', reg.body);
  const pt = reg.body.token;
  const kpisBefore = (await call('GET', '/admin/dashboard', adminToken)).body?.kpis;

  step('Patient finds the most congested department (FR-02)');
  const branches = await call('GET', '/branches', pt);
  check(branches.status === 200 && branches.body.length === 3, '3 active branches', branches.body?.map((b) => b.name));
  check(branches.body.every((b) => b.load && 'congestionLevel' in b.load), 'every branch carries live load');
  let target = null;
  for (const b of branches.body) {
    const deps = (await call('GET', `/branches/${b.id}/departments`, pt)).body || [];
    for (const d of deps) {
      const doctors = (await call('GET', `/departments/${d.id}/doctors`, pt)).body || [];
      const doc = doctors.filter((x) => x.acceptingNow).sort((x, y) => (y.queueLength || 0) - (x.queueLength || 0))[0];
      if (!doc) continue;
      const score = (rank[d.congestionLevel] ?? 0) * 1000 + (d.waiting || 0);
      if (!target || score > target.score) target = { branch: b, dep: d, doc, score };
    }
  }
  if (!check(Boolean(target), 'found a department with a doctor accepting now')) return;
  console.log(`    → ${target.dep.specialty} at ${target.branch.name} (${target.dep.congestionLevel}, ${target.dep.waiting} waiting), ${target.doc.fullName}`);
  check(['HIGH', 'CRITICAL'].includes(target.dep.congestionLevel), 'seed leaves a HIGH/CRITICAL department', target.dep.congestionLevel);

  step('Patient joins and reads the AI estimate (FR-03, FR-06, FR-07)');
  const join = await call('POST', '/tokens', pt, { doctorId: target.doc.id });
  if (!check(join.status === 201, 'token issued', join.body)) return;
  const first = join.body;
  const est = first.estimate;
  check(est && est.low <= est.minutes && est.minutes <= est.high, `wait range ${est?.low}–${est?.high} min`, est);
  check(est?.explain && typeof est.explain.baselineMinutes === 'number', 'estimate.explain present', est?.explain);
  if (est?.explain) {
    const x = est.explain;
    check(x.normalAhead + x.priorityAhead === x.patientsAhead, 'explain: normalAhead + priorityAhead = patientsAhead', x);
    check(x.method === 'MODEL' ? x.modelAdjustmentMinutes !== null : x.reason !== null, `explain method ${x.method}${x.reason ? ` (${x.reason})` : ''}`, x);
    check(['MODEL', 'BASELINE'].includes(x.method) && (x.method === 'MODEL') === (est.modelVersion !== 'baseline'), 'modelVersion matches method', { modelVersion: est.modelVersion, method: x.method });
  }

  step('Branch recommendation (FR-08, FR-09)');
  const rec = await call('GET', `/recommendations?specialty=${encodeURIComponent(target.dep.specialty)}&lat=31.4697&lng=74.2728&excludeDoctorId=${target.doc.id}`, pt);
  check(rec.status === 200 && rec.body.items.length > 0, `${rec.body?.items?.length} ranked alternatives`, rec.body);
  const items = rec.body?.items || [];
  check(items.every((it, i) => i === 0 || items[i - 1].score <= it.score), 'sorted by score ascending');
  check(items.every((it) => typeof it.distanceKm === 'number' && it.reason), 'distance and reason on every item');
  const alt = items.find((it) => it.doctorId !== target.doc.id && it.branchId !== target.branch.id) || items.find((it) => it.doctorId !== target.doc.id);
  if (!check(Boolean(alt), 'an alternative doctor to switch to')) return;
  console.log(`    → top pick: ${alt.branchName} · ${alt.doctorName} — "${alt.reason}"`);

  step('Patient switches the token (FR-09, POST /tokens/:id/switch)');
  const sw = await call('POST', `/tokens/${first.id}/switch`, pt, { doctorId: alt.doctorId });
  if (!check(sw.status === 201, 'switch accepted', sw.body)) return;
  check(sw.body.cancelled?.status === 'CANCELLED', 'old token cancelled');
  const tok = sw.body.token;
  check(tok.status === 'WAITING' && tok.doctor?.id === alt.doctorId, `new token ${tok.displayNumber} with ${tok.doctor?.fullName}`);
  const again = await call('POST', `/tokens/${first.id}/switch`, pt, { doctorId: alt.doctorId });
  check(again.status >= 400 && again.status < 500, 'switching a cancelled token is refused', again.status);

  step('Staff triage: priority, call next, start, linked LAB + PHARMACY, complete (FR-12, FR-13, FR-04)');
  const doctors = (await call('GET', '/admin/doctors', adminToken)).body || [];
  const docRow = doctors.find((d) => d.id === alt.doctorId);
  if (!check(Boolean(docRow?.email), 'doctor account found', docRow)) return;
  const st = await login(docRow.email, STAFF_PASSWORD);
  const room = ((await call('GET', '/staff/service-points', st)).body || []).find((s) => s.type === 'OPD' && s.doctorId === alt.doctorId);
  if (!check(Boolean(room), `doctor's room ${room?.name}`)) return;
  const pr = await call('POST', `/tokens/${tok.id}/priority`, st, { level: 2, reason: 'E2E smoke: emergency' });
  check(pr.status === 200 && pr.body.priorityLevel === 2, 'emergency priority set', pr.body);
  let q = (await call('GET', `/service-points/${room.id}/queue`, st)).body;
  check(q.waiting[0]?.id === tok.id, 'emergency token is first in the waiting queue', q.waiting.slice(0, 3).map((t) => t.displayNumber));
  if (q.nowServing) {
    const done = await call('POST', `/tokens/${q.nowServing.id}/complete`, st);
    check(done.status === 200, `completed the open token ${q.nowServing.displayNumber} first`);
  }
  const next = await call('POST', `/service-points/${room.id}/call-next`, st);
  check(next.status === 200 && next.body.token?.id === tok.id, 'call next calls our token', next.body);
  check((await call('POST', `/tokens/${tok.id}/start`, st)).status === 200, 'service started');
  const lab = await call('POST', `/visits/${tok.visitId}/linked-tokens`, st, { type: 'LAB' });
  const pharm = await call('POST', `/visits/${tok.visitId}/linked-tokens`, st, { type: 'PHARMACY' });
  check(lab.status === 201 && lab.body.queueType === 'LAB', `linked LAB token ${lab.body?.displayNumber}`, lab.body);
  check(pharm.status === 201 && pharm.body.queueType === 'PHARMACY', `linked PHARMACY token ${pharm.body?.displayNumber}`, pharm.body);
  check((await call('POST', `/tokens/${tok.id}/complete`, st)).status === 200, 'consultation completed');

  step('Patient journey (FR-04, FR-05)');
  const mine = (await call('GET', `/tokens/${tok.id}`, pt)).body;
  check(mine.status === 'COMPLETED', 'OPD token COMPLETED');
  const types = (mine.linkedTokens || []).map((t) => t.queueType).sort();
  check(types.includes('LAB') && types.includes('PHARMACY'), 'journey links LAB and PHARMACY', types);
  const active = (await call('GET', '/tokens/active', pt)).body || [];
  check(active.some((t) => t.queueType === 'LAB') && active.some((t) => t.queueType === 'PHARMACY'), 'LAB and PHARMACY tokens are active for the patient');

  step('Waiting-room board (GET /display)');
  const disp = await call('GET', `/display?branchId=${tok.branch.id}`, st);
  check(disp.status === 200, 'board data for the branch', disp.body);
  const labPoint = disp.body?.servicePoints?.find((s) => s.type === 'LAB' && (s.next || []).some((n) => n.displayNumber === lab.body.displayNumber));
  check(Boolean(labPoint) || disp.body?.servicePoints?.some((s) => s.nowServing?.displayNumber === lab.body.displayNumber), 'LAB token shown on the board');
  check(!JSON.stringify(disp.body || {}).includes('E2E Smoke Patient'), 'board shows no patient names');
  const ptDisplay = await call('GET', `/display?branchId=${tok.branch.id}`, pt);
  check(ptDisplay.status === 403, 'patients cannot read the board', ptDisplay.status);

  step('Admin dashboard reflects it (FR-15, FR-17, FR-18)');
  const dash = (await call('GET', '/admin/dashboard', adminToken)).body;
  check(dash.kpis.completedToday >= (kpisBefore?.completedToday ?? 0) + 1, `completedToday ${kpisBefore?.completedToday} → ${dash.kpis.completedToday}`);
  check(Array.isArray(dash.trend) && dash.trend.length > 0, `trend has ${dash.trend?.length} hours`);
  check(dash.departments.every((d) => Array.isArray(d.doctors)), 'departments carry per-doctor rows');
  const alerts = (await call('GET', '/admin/alerts', adminToken)).body || [];
  check(alerts.some((a) => ['HIGH', 'CRITICAL'].includes(a.level)), `${alerts.length} congestion alerts`);
  const fc = (await call('GET', '/admin/forecasts', adminToken)).body || [];
  check(fc.length > 0 && fc.every((r) => 'shortfallDoctorHours' in r && 'avgConsultMinutes' in r), `${fc.length} forecast rows with shortfall fields`);
  const recs = (await call('GET', '/admin/recommendations', adminToken)).body;
  check(Array.isArray(recs?.recommendations), `${recs?.recommendations?.length} resource recommendations`);
  const models = await call('GET', '/admin/models', adminToken);
  check(models.status === 200 || models.status === 503, `models endpoint ${models.status === 503 ? '503 (AI service not running)' : 'ok'}`);
}

main()
  .catch((e) => {
    failures.push(`crash: ${e.message}`);
    console.error('\nCRASH', e);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  });
