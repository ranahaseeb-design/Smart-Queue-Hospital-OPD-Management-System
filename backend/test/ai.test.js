'use strict';
/**
 * AI service integration (Section 6, FR-06/07/08/17/22) against a fake FastAPI stand-in:
 * predictions, ranking, forecast job and model proxies use the AI when it answers, and the
 * backend falls back silently (Eq. 6.2 baseline, JS scoring, JS seasonal forecast) when it is
 * slow (1.5 s timeout) or down; model management then answers 503 AI_UNAVAILABLE.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createContext, AI_TEST_SERVICE_TOKEN } = require('./helpers');

const fake = {
  slow: false,
  predictCalls: [],
  rankCalls: 0,
  tokenHeaders: [],
  retrainBusy: false,
  forecastBusy: false,
  rejectToken: false, // simulates an AI_SERVICE_TOKEN mismatch between backend and AI service
};
let server;
let ctx;
let doctorId;

function startFakeAi() {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'ok', activeModel: 'rf-test', db: true });
      // Like the real service: every /ai/* call needs the shared secret.
      if (req.url.startsWith('/ai/')) {
        fake.tokenHeaders.push(req.headers['x-ai-service-token']);
        if (fake.rejectToken || req.headers['x-ai-service-token'] !== AI_TEST_SERVICE_TOKEN) {
          return send(401, { detail: 'Missing or invalid X-AI-Service-Token header' });
        }
      }
      if (req.method === 'POST' && req.url === '/ai/predict-wait') {
        fake.predictCalls.push(body);
        const reply = () =>
          send(200, {
            modelVersion: 'rf-test',
            predictions: body.items.map((i) => ({ tokenId: i.tokenId, predictedMinutes: 42.4, extraField: 'ignored' })),
          });
        if (fake.slow) return setTimeout(reply, 2500);
        return reply();
      }
      if (req.method === 'POST' && req.url === '/ai/rank-branches') {
        fake.rankCalls += 1;
        const ranked = body.candidates
          .map((c) => ({ branchId: c.branchId, doctorId: c.doctorId, score: c.branchId / 10 }))
          .sort((a, b) => a.score - b.score);
        return send(200, { ranked });
      }
      if (req.method === 'POST' && req.url === '/ai/jobs/forecast') {
        if (fake.forecastBusy) return send(409, { detail: 'A forecast job is already running.' });
        return send(200, { generated: 7, modelVersion: 'rf-test' });
      }
      if (req.method === 'GET' && req.url === '/ai/models') {
        return send(200, [
          {
            version: 'rf-test',
            trainedAt: '2026-10-29T10:00:00',
            trainingRows: 1000,
            dataSource: 'synthetic',
            status: 'ACTIVE',
            isActive: true,
            metrics: { mae: 6.1, rmse: 8.2, r2: 0.7, within10: 81.5, baselineMae: 9.9, testRows: 200 },
          },
        ]);
      }
      if (req.method === 'POST' && req.url === '/ai/models/retrain') {
        if (fake.retrainBusy) return send(409, { detail: 'A retraining job is already running.' });
        return send(200, { version: 'rf-test-2', metrics: { mae: 5.9 }, accepted: true, activated: false });
      }
      const m = /^\/ai\/models\/([^/]+)\/activate$/.exec(req.url);
      if (req.method === 'POST' && m) {
        if (m[1] === 'missing') return send(404, { detail: 'Unknown model version' });
        if (m[1] === 'rf-rejected') {
          return send(409, { detail: 'Model version rf-rejected was REJECTED by the acceptance rules and cannot be activated.' });
        }
        if (m[1] === 'rejected') return send(422, { detail: 'Model rejected by the acceptance criteria' });
        return send(200, { version: decodeURIComponent(m[1]), activated: true });
      }
      return send(404, { detail: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  const port = await startFakeAi();
  ctx = await createContext('ai', { aiUrl: `http://127.0.0.1:${port}` });
  doctorId = (await ctx.api.get('/auth/me', await ctx.login('doctor1'))).body.user.doctorId;
});
after(async () => {
  await ctx.close();
  if (server.listening) await new Promise((r) => server.close(r));
});

test('health reports the AI service as up', async () => {
  const res = await ctx.api.get('/health');
  assert.equal(res.body.ai, true);
  assert.equal(res.body.aiActiveModel, 'rf-test');
});

test('token estimates come from the active model with the contract feature keys (FR-06)', async () => {
  const p = await ctx.newPatient();
  fake.predictCalls.length = 0;
  const res = await ctx.api.post('/tokens', p.token, { doctorId });
  assert.equal(res.status, 201);
  assert.equal(res.body.estimate.modelVersion, 'rf-test');
  assert.equal(res.body.estimate.minutes, 42);
  assert.equal(res.body.estimate.low, 34);
  assert.equal(res.body.estimate.high, 50);
  const call = fake.predictCalls.find((c) => c.items.some((i) => i.tokenId === res.body.id));
  assert.ok(call, 'the queue was sent to /ai/predict-wait');
  const item = call.items.find((i) => i.tokenId === res.body.id);
  assert.deepEqual(Object.keys(item.features), [
    'patients_ahead', 'priority_ahead', 'doctor_avg_consult', 'doctor_recent_consult', 'interruptions_last_hour',
    'session_started', 'minutes_to_start', 'hour_of_day', 'day_of_week', 'appointments_ahead', 'department_load',
    'doctor_id', 'department_id', 'branch_id',
  ]);
  const row = await ctx.models.WaitPrediction.findOne({ token_id: res.body.id }).sort({ _id: 1 }).lean();
  assert.equal(row.model_version, 'rf-test');
  assert.equal(row.predicted_minutes, 42.4);
  assert.deepEqual(row.features, item.features);

  const dept = await ctx.models.Doctor.findById(doctorId).lean();
  const doctors = await ctx.api.get(`/departments/${dept.department_id}/doctors`, p.token);
  assert.equal(doctors.body[0].estimatedWaitMinutes, 42);
});

test('recommendations use /ai/rank-branches scores when available (FR-08)', async () => {
  const p = await ctx.newPatient();
  const before = fake.rankCalls;
  const res = await ctx.api.get('/recommendations?specialty=Cardiology', p.token);
  assert.equal(res.status, 200);
  assert.equal(fake.rankCalls, before + 1);
  assert.deepEqual(res.body.items.map((i) => i.score), [0.1, 0.2, 0.3]);
  assert.deepEqual(res.body.items.map((i) => i.branchName), ['Model Town', 'Gulberg', 'DHA']);
});

test('forecast job and model management are proxied to the AI service (FR-17, FR-22)', async () => {
  const admin = await ctx.login('admin');
  const run = await ctx.api.post('/admin/forecasts/run', admin);
  assert.deepEqual(run.body, { generated: 7, source: 'ai' });
  const models = await ctx.api.get('/admin/models', admin);
  assert.equal(models.status, 200);
  assert.equal(models.body[0].version, 'rf-test');
  assert.equal(models.body[0].metrics.baselineMae, 9.9);
  const retrain = await ctx.api.post('/admin/models/retrain', admin);
  assert.deepEqual(retrain.body, { version: 'rf-test-2', metrics: { mae: 5.9 }, accepted: true, activated: false });
  const act = await ctx.api.post('/admin/models/rf-test-2/activate', admin);
  assert.deepEqual(act.body, { version: 'rf-test-2', activated: true });
  const missing = await ctx.api.post('/admin/models/missing/activate', admin);
  assert.equal(missing.status, 404);
  assert.equal((await ctx.api.post('/admin/models/bad%20version/activate', admin)).status, 400);
  // AI 409 passes through as CONFLICT with the AI's message; other 4xx become 400.
  fake.retrainBusy = true;
  const busy = await ctx.api.post('/admin/models/retrain', admin);
  fake.retrainBusy = false;
  assert.equal(busy.status, 409);
  assert.deepEqual(busy.body, { error: { code: 'CONFLICT', message: 'A retraining job is already running.' } });
  const rejected = await ctx.api.post('/admin/models/rejected/activate', admin);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
  assert.equal(rejected.body.error.message, 'Model rejected by the acceptance criteria');
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('activating a REJECTED model surfaces the AI service refusal (FR-22)', async () => {
  const admin = await ctx.login('admin');
  const res = await ctx.api.post('/admin/models/rf-rejected/activate', admin);
  // The route must not swallow the refusal: a client error carrying the AI service's message
  // (aiClient maps the AI 409 to 409 CONFLICT; older mapping: 400).
  assert.ok([400, 409].includes(res.status), `status ${res.status}`);
  assert.match(res.body.error.message, /REJECTED/);
});

test('every /ai/* call carries the X-AI-Service-Token shared secret', async () => {
  assert.ok(fake.tokenHeaders.length >= 5, 'AI endpoints were called');
  assert.ok(fake.tokenHeaders.every((h) => h === AI_TEST_SERVICE_TOKEN));
});

test('a token mismatch is a 503 (not a client error) and health reports the AI as unavailable', async () => {
  const ai = require('../src/services/aiClient');
  const admin = await ctx.login('admin');
  fake.rejectToken = true;
  ai.reset();
  try {
    for (const [method, path] of [
      ['get', '/admin/models'],
      ['post', '/admin/models/retrain'],
      ['post', '/admin/models/rf-test/activate'],
    ]) {
      const res = await ctx.api[method](path, admin);
      assert.equal(res.status, 503, path);
      assert.equal(res.body.error.code, 'AI_UNAVAILABLE');
      assert.match(res.body.error.message, /AI_SERVICE_TOKEN/);
    }
    const health = await ctx.api.get('/health');
    assert.equal(health.body.ai, false, '/health alone would answer, but every /ai/* call is refused');
  } finally {
    fake.rejectToken = false;
    ai.reset();
  }
  assert.equal((await ctx.api.get('/health')).body.ai, true);
});

test('a busy AI forecast job is a 409 and the baseline does not run over it', async () => {
  const admin = await ctx.login('admin');
  const { Forecast } = ctx.models;
  const lastGenerated = async () => {
    const top = await Forecast.findOne({}).sort({ generated_at: -1 }).lean();
    return top ? top.generated_at.getTime() : null;
  };
  const before = await Forecast.countDocuments({ source: 'baseline' });
  const stamp = await lastGenerated();
  fake.forecastBusy = true;
  try {
    const res = await ctx.api.post('/admin/forecasts/run', admin);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CONFLICT');
  } finally {
    fake.forecastBusy = false;
  }
  const after = await Forecast.countDocuments({ source: 'baseline' });
  assert.equal(after, before);
  assert.equal(await lastGenerated(), stamp);
  // The live prediction path is unaffected (no breaker opened by the job call).
  assert.equal(require('../src/services/aiClient').breakerOpen(), false);
});

test('a slow AI service is abandoned after the 1.5 s timeout and the baseline is used', async () => {
  const p = await ctx.newPatient();
  fake.slow = true;
  const started = Date.now();
  const res = await ctx.api.post('/tokens', p.token, { doctorId });
  const elapsed = Date.now() - started;
  fake.slow = false;
  assert.equal(res.status, 201);
  assert.equal(res.body.estimate.modelVersion, 'baseline');
  assert.ok(elapsed < 2400, `answered in ${elapsed} ms`);
  require('../src/services/aiClient').reset();
});

test('AI service down: baseline predictions, JS ranking, baseline forecast, 503 for models', async () => {
  await new Promise((r) => server.close(r));
  const ai = require('../src/services/aiClient');
  ai.reset();
  const p = await ctx.newPatient();
  const res = await ctx.api.post('/tokens', p.token, { doctorId });
  assert.equal(res.status, 201);
  assert.equal(res.body.estimate.modelVersion, 'baseline');
  const row = await ctx.models.WaitPrediction.findOne({ token_id: res.body.id }).sort({ _id: 1 }).lean();
  assert.equal(row.model_version, 'baseline');
  const f = row.features;
  assert.equal(
    Math.round(res.body.estimate.minutes),
    Math.round(f.patients_ahead * f.doctor_avg_consult + f.minutes_to_start)
  );

  const rec = await ctx.api.get('/recommendations?specialty=Cardiology', p.token);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.items.length, 3);
  assert.ok(rec.body.items.every((i) => i.score >= 0 && i.score <= 1));

  const admin = await ctx.login('admin');
  const run = await ctx.api.post('/admin/forecasts/run', admin);
  assert.equal(run.body.source, 'baseline');
  assert.ok(run.body.generated > 0);
  const models = await ctx.api.get('/admin/models', admin);
  assert.equal(models.status, 503);
  assert.equal(models.body.error.code, 'AI_UNAVAILABLE');
  ai.reset();
  const health = await ctx.api.get('/health');
  assert.equal(health.body.ai, false);
});

test('Eq. 6.2 baseline does not double-count priority tokens already in patients_ahead', () => {
  const fb = require('../src/services/featureBuilder');
  const base = { patients_ahead: 3, priority_ahead: 0, doctor_avg_consult: 10, minutes_to_start: 0 };
  assert.equal(fb.baselineMinutes(base), 30);
  // All three patients ahead are priority tokens: still 3 consultations ahead, not 6.
  assert.equal(fb.baselineMinutes({ ...base, priority_ahead: 3 }), 30);
  assert.equal(fb.baselineMinutes({ ...base, minutes_to_start: 15 }), 45);
});

test('the JS baseline forecast replaces today from 00:00, like the AI job (no mixed sources today)', async () => {
  const forecastService = require('../src/services/forecastService');
  const today = ctx.time.today();
  const { Forecast } = ctx.models;
  const midnight = ctx.time.dayStart(today);
  await Forecast.updateMany({ forecast_hour: { $gte: midnight } }, { $set: { source: 'rf-forecast' } });
  await forecastService.runBaselineForecast(ctx.db, { now: ctx.time.clock.now() });
  const mixed = await Forecast.countDocuments({ forecast_hour: { $gte: midnight }, source: { $ne: 'baseline' } });
  assert.equal(mixed, 0);
  const first = await Forecast.findOne({ forecast_hour: { $gte: midnight } }).sort({ forecast_hour: 1 }).lean();
  assert.ok(ctx.time.formatDate(first.forecast_hour) === today);
});
