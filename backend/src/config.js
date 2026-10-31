'use strict';
/**
 * Central configuration. Loaded first by every entry point so that the hospital
 * time zone (TZ) is applied before any Date is created.
 */
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_ROOT, '.env') });

// All datetimes are hospital local time (contract: TZ=Asia/Karachi).
process.env.TZ = process.env.TZ || 'Asia/Karachi';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  if (nodeEnv === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  jwtSecret = 'dev-only-insecure-secret';
}

const config = {
  backendRoot: BACKEND_ROOT,
  env: nodeEnv,
  port: int(process.env.PORT, 4000),
  tz: process.env.TZ,
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),
  corsOrigins: (process.env.CORS_ORIGINS ||
    'http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  db: {
    client: (process.env.DB_CLIENT || 'sqlite').toLowerCase(),
    sqlitePath: path.resolve(BACKEND_ROOT, process.env.SQLITE_PATH || 'data/smart_opd.db'),
    host: process.env.DB_HOST || 'localhost',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'smart_opd',
    mysqlSchemaPath: path.resolve(
      BACKEND_ROOT,
      process.env.MYSQL_SCHEMA_PATH || '../database/schema.mysql.sql'
    ),
  },
  ai: {
    url: (process.env.AI_SERVICE_URL === undefined ? 'http://localhost:8000' : process.env.AI_SERVICE_URL)
      .replace(/\/+$/, ''),
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 1500),
    jobTimeoutMs: int(process.env.AI_JOB_TIMEOUT_MS, 120000),
  },
  demoAlwaysOpen: bool(process.env.DEMO_ALWAYS_OPEN, false),
  jobsEnabled: bool(process.env.JOBS_ENABLED, nodeEnv !== 'test'),
  autoSeed: bool(process.env.AUTO_SEED, false),
  seedHistoryDays: Math.max(1, int(process.env.SEED_HISTORY_DAYS, 60)),
  logRequests: bool(process.env.LOG_REQUESTS, nodeEnv !== 'test'),
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Smart OPD <no-reply@opd.test>',
  },
};

module.exports = config;
