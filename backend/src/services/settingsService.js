'use strict';
/**
 * System settings (key -> JSON value) managed by the Hospital Administrator.
 * Missing keys fall back to the contract defaults.
 */
const { parseJson } = require('../db');
const time = require('../utils/time');
const { badRequest } = require('../utils/errors');

const DEFAULTS = Object.freeze({
  recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 },
  congestionThresholds: { high: 0.85, critical: 1.0 },
  alternativeSuggestionWaitMinutes: 45,
  notifyPositionsAhead: 3,
  slotMinutes: 15,
});

const CACHE_MS = 10 * 1000;
let cache = null;
let cacheAt = 0;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

async function getSettings(db) {
  if (cache && Date.now() - cacheAt < CACHE_MS) return clone(cache);
  const rows = await db.query('SELECT setting_key, setting_value FROM settings', []);
  const merged = clone(DEFAULTS);
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, row.setting_key)) {
      const value = parseJson(row.setting_value, null);
      if (value !== null) {
        merged[row.setting_key] =
          typeof DEFAULTS[row.setting_key] === 'object' ? { ...DEFAULTS[row.setting_key], ...value } : value;
      }
    }
  }
  cache = merged;
  cacheAt = Date.now();
  return clone(merged);
}

function invalidate() {
  cache = null;
}

/** Validate a (partial) settings object and return the full merged settings. */
function validate(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('Settings body must be an object');
  }
  const next = clone(current);

  if (input.recommendationWeights !== undefined) {
    const w = input.recommendationWeights || {};
    const merged = { ...current.recommendationWeights, ...w };
    for (const k of ['wait', 'distance', 'congestion']) {
      const n = Number(merged[k]);
      if (!Number.isFinite(n) || n < 0 || n > 1) throw badRequest(`recommendationWeights.${k} must be between 0 and 1`);
      merged[k] = n;
    }
    const sum = merged.wait + merged.distance + merged.congestion;
    if (sum <= 0) throw badRequest('recommendationWeights must not all be zero');
    // Weights sum to 1 (Eq. 6.3): reject a real mistake, normalise only small rounding differences.
    if (Math.abs(sum - 1) > 0.01) throw badRequest('recommendationWeights must sum to 1');
    if (Math.abs(sum - 1) > 0.001) {
      for (const k of ['wait', 'distance', 'congestion']) merged[k] = Math.round((merged[k] / sum) * 1000) / 1000;
    }
    next.recommendationWeights = merged;
  }

  if (input.congestionThresholds !== undefined) {
    const t = { ...current.congestionThresholds, ...(input.congestionThresholds || {}) };
    const high = Number(t.high);
    const critical = Number(t.critical);
    if (!Number.isFinite(high) || high <= 0) throw badRequest('congestionThresholds.high must be > 0');
    if (!Number.isFinite(critical) || critical <= high) {
      throw badRequest('congestionThresholds.critical must be greater than high');
    }
    next.congestionThresholds = { high, critical };
  }

  const intSetting = (key, min, max) => {
    if (input[key] === undefined) return;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${key} must be an integer between ${min} and ${max}`);
    next[key] = n;
  };
  intSetting('alternativeSuggestionWaitMinutes', 1, 600);
  intSetting('notifyPositionsAhead', 0, 50);
  intSetting('slotMinutes', 5, 120);
  return next;
}

async function updateSettings(db, input) {
  const current = await getSettings(db);
  const next = validate(current, input);
  const now = time.nowDb();
  await db.transaction(async (tx) => {
    for (const key of Object.keys(DEFAULTS)) {
      const value = JSON.stringify(next[key]);
      const existing = await tx.get('SELECT setting_key FROM settings WHERE setting_key = ?', [key]);
      if (existing) {
        await tx.run('UPDATE settings SET setting_value = ?, updated_at = ? WHERE setting_key = ?', [value, now, key]);
      } else {
        await tx.run('INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)', [key, value, now]);
      }
    }
  });
  invalidate();
  return getSettings(db);
}

/** Insert default rows (used by db:init and the seed). */
async function writeDefaults(db) {
  const now = time.nowDb();
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const existing = await db.get('SELECT setting_key FROM settings WHERE setting_key = ?', [key]);
    if (!existing) {
      await db.run('INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)', [
        key,
        JSON.stringify(value),
        now,
      ]);
    }
  }
  invalidate();
}

module.exports = { DEFAULTS, getSettings, updateSettings, writeDefaults, invalidate, validate };
