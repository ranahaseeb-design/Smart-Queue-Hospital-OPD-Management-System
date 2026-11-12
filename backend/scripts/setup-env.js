#!/usr/bin/env node
'use strict';
/**
 * `npm run setup` — prepare backend/.env for local development.
 *
 *  - Creates backend/.env from backend/.env.example when it does not exist.
 *  - Fills JWT_SECRET (48 random bytes as hex) and AI_SERVICE_TOKEN (24 random bytes as hex) when
 *    they are empty or a published placeholder.
 *  - Never overwrites real values, and prints what it did.
 *
 * Remember to put the same AI_SERVICE_TOKEN into ai-service/.env.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(BACKEND_ROOT, '.env');
const EXAMPLE_FILE = path.join(BACKEND_ROOT, '.env.example');

// Values that were ever published (docs, .env.example, old fallbacks) — same list as src/config.js.
const PLACEHOLDERS = new Set([
  'change-me-to-a-long-random-string',
  'dev-only-insecure-secret',
  'test-only-secret',
  'secret',
  'changeme',
  'change-me',
]);

const GENERATED = {
  JWT_SECRET: () => crypto.randomBytes(48).toString('hex'),
  AI_SERVICE_TOKEN: () => crypto.randomBytes(24).toString('hex'),
};

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function isPlaceholder(value) {
  const v = unquote(value || '');
  return !v || PLACEHOLDERS.has(v.toLowerCase()) || /^<.*>$/.test(v);
}

/**
 * Apply the setup to the text of an .env file. Returns { text, actions }.
 * Exported for tests; main() does the file I/O.
 */
function applySetup(text, generators = GENERATED) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const actions = [];
  for (const [key, generate] of Object.entries(generators)) {
    const re = new RegExp(`^\\s*${key}\\s*=(.*)$`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx < 0) {
      if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, `${key}=${generate()}`);
      else lines.push(`${key}=${generate()}`);
      actions.push(`${key}: added a generated value`);
      continue;
    }
    const current = re.exec(lines[idx])[1];
    if (isPlaceholder(current)) {
      lines[idx] = `${key}=${generate()}`;
      actions.push(`${key}: generated a new value (was ${unquote(current) ? 'a placeholder' : 'empty'})`);
    } else {
      actions.push(`${key}: kept the existing value`);
    }
  }
  return { text: lines.join(eol), actions };
}

function main() {
  let created = false;
  if (!fs.existsSync(ENV_FILE)) {
    if (!fs.existsSync(EXAMPLE_FILE)) {
      console.error(`[setup] ${EXAMPLE_FILE} not found`);
      process.exitCode = 1;
      return;
    }
    fs.copyFileSync(EXAMPLE_FILE, ENV_FILE);
    created = true;
  }
  const before = fs.readFileSync(ENV_FILE, 'utf8');
  const { text, actions } = applySetup(before);
  if (text !== before) fs.writeFileSync(ENV_FILE, text);
  console.log(`[setup] ${created ? 'Created' : 'Found'} ${path.relative(process.cwd(), ENV_FILE) || ENV_FILE}${created ? ' from .env.example' : ''}`);
  for (const a of actions) console.log(`[setup]   ${a}`);
  console.log('[setup] Put the same AI_SERVICE_TOKEN into ai-service/.env, check MONGODB_URI, then run `npm run seed`.');
}

if (require.main === module) main();

module.exports = { applySetup, isPlaceholder };
