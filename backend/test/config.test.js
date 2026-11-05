'use strict';
/** JWT secret validation (no insecure fallback in any environment). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configureEnv } = require('./helpers');

configureEnv('config');
const config = require('../src/config');

test('a missing, short or placeholder JWT_SECRET is rejected in every environment', () => {
  const v = config.validateJwtSecret;
  assert.throws(() => v(undefined), /JWT_SECRET is not set/);
  assert.throws(() => v('   '), /JWT_SECRET is not set/);
  assert.throws(() => v('change-me-to-a-long-random-string'), /placeholder/);
  assert.throws(() => v('dev-only-insecure-secret'), /placeholder/);
  assert.throws(() => v('short-secret-123'), /at least 32/);
  assert.throws(() => v('x'.repeat(31)), /at least 32/);
  const strong = require('node:crypto').randomBytes(48).toString('hex');
  assert.equal(v(strong), strong);
});

test('loading the config fails without a strong secret, also in development (child process)', () => {
  const run = (secret) =>
    spawnSync(process.execPath, ['-e', "require('./src/config')"], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development', JWT_SECRET: secret },
      encoding: 'utf8',
    });
  const placeholder = run('change-me-to-a-long-random-string');
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /placeholder/);
  const empty = run('');
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /JWT_SECRET is not set/);
  assert.equal(run('a'.repeat(48)).status, 0);
});
