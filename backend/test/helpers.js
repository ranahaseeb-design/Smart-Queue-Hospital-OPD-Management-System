'use strict';
/**
 * Test helpers. Each test file runs in its own process (node:test), so every file configures
 * the environment once, seeds a fresh temporary SQLite database and builds the Express app.
 *
 * Temporary databases go to $TEST_TMPDIR (if set) or the OS temp directory and are removed
 * when the context is closed. The clock is fixed at 10:00 today (hospital time) so results do
 * not depend on when the suite runs; tests advance it explicitly with ctx.advance(minutes).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ACCOUNTS = Object.freeze({
  admin: ['admin@opd.test', 'Admin@123'],
  branchAdmin: ['branchadmin@opd.test', 'Admin@123'],
  doctor1: ['doctor1@opd.test', 'Staff@123'],
  doctor2: ['doctor2@opd.test', 'Staff@123'],
  doctor3: ['doctor3@opd.test', 'Staff@123'],
  lab1: ['lab1@opd.test', 'Staff@123'],
  pharmacy1: ['pharmacy1@opd.test', 'Staff@123'],
  patient: ['patient@opd.test', 'Patient@123'],
});

/** Closed local port: connections are refused immediately (AI service "down"). */
const AI_DOWN_URL = 'http://127.0.0.1:9';
/** Shared secret the backend sends to the (fake) AI service as X-AI-Service-Token. */
const AI_TEST_SERVICE_TOKEN = 'test-ai-service-token';

function configureEnv(name, { aiUrl = AI_DOWN_URL, env = {} } = {}) {
  const base = process.env.TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `smart-opd-${name}-`));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    TZ: 'Asia/Karachi',
    DB_CLIENT: 'sqlite',
    SQLITE_PATH: path.join(dir, `${name}.db`),
    DEMO_ALWAYS_OPEN: 'true',
    JOBS_ENABLED: 'false',
    LOG_REQUESTS: 'false',
    BCRYPT_ROUNDS: '4',
    JWT_SECRET: 'test-suite-jwt-secret-0123456789abcdef0123456789abcdef',
    AI_SERVICE_URL: aiUrl,
    AI_SERVICE_TOKEN: AI_TEST_SERVICE_TOKEN,
    AI_TIMEOUT_MS: '1500',
    SMTP_HOST: '',
    FIREBASE_SERVICE_ACCOUNT: '',
    AUTO_SEED: 'false',
    ...env,
  });
  return dir;
}

/**
 * Create a seeded test context.
 * @param {string} name
 * @param {{ historyDays?: number, aiUrl?: string, env?: object, clockHour?: number }} [opts]
 */
async function createContext(name, { historyDays = 3, aiUrl, env, clockHour = 10 } = {}) {
  const dir = configureEnv(name, { aiUrl, env });
  const request = require('supertest');
  const time = require('../src/utils/time');
  const real = new Date();
  time.clock.set(new Date(real.getFullYear(), real.getMonth(), real.getDate(), clockHour, 0, 0));

  const { getDb, closeDb, createSchema } = require('../src/db');
  const { seed } = require('../src/db/seed');
  const { createApp } = require('../src/app');
  const settingsService = require('../src/services/settingsService');
  const db = getDb();
  await createSchema(db);
  const summary = await seed(db, { historyDays, logger: null });
  settingsService.invalidate();
  const app = createApp();

  const withAuth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
  const api = {
    get: (p, token) => withAuth(request(app).get(`/api${p}`), token),
    post: (p, token, body) => withAuth(request(app).post(`/api${p}`), token).send(body === undefined ? {} : body),
    put: (p, token, body) => withAuth(request(app).put(`/api${p}`), token).send(body === undefined ? {} : body),
    del: (p, token) => withAuth(request(app).delete(`/api${p}`), token),
  };

  const tokens = new Map();
  async function login(account) {
    const [identifier, password] = Array.isArray(account) ? account : ACCOUNTS[account];
    if (tokens.has(identifier)) return tokens.get(identifier);
    const res = await api.post('/auth/login', null, { identifier, password });
    if (res.status !== 200) throw new Error(`login ${identifier} failed: ${res.status} ${JSON.stringify(res.body)}`);
    tokens.set(identifier, res.body.token);
    return res.body.token;
  }

  let patientNo = 0;
  /** Register a fresh patient; returns { token, user }. */
  async function newPatient(extra = {}) {
    patientNo += 1;
    const res = await api.post('/auth/register', null, {
      fullName: `Test Patient ${patientNo}`,
      email: `p${patientNo}.${name}@example.com`,
      password: 'secret123',
      ...extra,
    });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  return {
    app,
    db,
    time,
    api,
    dir,
    summary,
    login,
    newPatient,
    advance(minutes = 1) {
      time.clock.advance(minutes * 60 * 1000);
    },
    async close() {
      await closeDb();
      time.clock.reset();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        /* Windows may still hold the file briefly; the OS temp cleaner will remove it */
      }
    },
  };
}

/** Assert no response body ever leaks a password hash. */
function assertNoSecrets(assert, body) {
  const text = JSON.stringify(body);
  assert.ok(!/password_hash|passwordHash|\$2[aby]\$/.test(text), 'response must not contain password hashes');
}

module.exports = { ACCOUNTS, AI_DOWN_URL, AI_TEST_SERVICE_TOKEN, configureEnv, createContext, assertNoSecrets };
