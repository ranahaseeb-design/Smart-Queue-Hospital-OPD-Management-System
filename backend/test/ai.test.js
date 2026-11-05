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

const fake = { slow: false, predictCalls: [], rankCalls: 0, tokenHeaders: [] };
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
        if (req.headers['x-ai-service-token'] !== AI_TEST_SERVICE_TOKEN) {
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
      if (req.method === 'POST' && req.url === '/ai/jobs/forecast') return send(200, { generated: 7, modelVersion: 'rf-test' });
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
        return send(200, { version: 'rf-test-2', metrics: { mae: 5.9 }, accepted: true, activated: false });
      }
      const m = /^\/ai\/models\/([^/]+)\/activate$/.exec(req.url);
      if (req.method === 'POST' && m) {
        if (m[1] === 'missing') return send(404, { detail: 'Unknown model version' });
        if (m[1] === 'rf-rejected') {
          return send(409, { detail: 'Model version rf-rejected was REJECTED by the acceptance rules and cannot be activated.' });
        }
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
  const row = await ctx.db.get('SELECT * FROM wait_predictions WHERE token_id = ? ORDER BY prediction_id LIMIT 1', [res.body.id]);
  assert.equal(row.model_version, 'rf-test');
  assert.equal(row.predicted_minutes, 42.4);
  assert.deepEqual(JSON.parse(row.features_json), item.features);

  const dept = await ctx.db.get('SELECT department_id FROM doctors WHERE doctor_id = ?', [doctorId]);
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
  const row = await ctx.db.get('SELECT model_version, features_json FROM wait_predictions WHERE token_id = ? ORDER BY prediction_id LIMIT 1', [res.body.id]);
  assert.equal(row.model_version, 'baseline');
  const f = JSON.parse(row.features_json);
  assert.equal(
    Math.round(res.body.estimate.minutes),
    Math.round((f.patients_ahead + f.priority_ahead) * f.doctor_avg_consult + f.minutes_to_start)
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
