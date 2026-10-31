'use strict';
/**
 * HTTP client for the internal AI service (FastAPI, AI_SERVICE_URL).
 * Prediction and ranking calls use a 1.5 s timeout (fetch + AbortController); on any
 * failure the caller falls back silently (baseline prediction / JS scoring / baseline
 * forecast). A short circuit breaker avoids paying the timeout on every request while
 * the service is down (NFR-02).
 */
const config = require('../config');
const { aiUnavailable } = require('../utils/errors');

const BREAKER_MS = 15 * 1000;
let downUntil = 0;
let healthCache = { at: 0, value: null };

class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function enabled() {
  return Boolean(config.ai.url);
}

async function request(method, path, body, timeoutMs = config.ai.timeoutMs) {
  if (!enabled()) throw new AiError('AI service not configured', 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.ai.url}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const detail = data && (data.detail || (data.error && data.error.message));
      throw new AiError(typeof detail === 'string' ? detail : `AI service responded ${res.status}`, res.status);
    }
    return data;
  } catch (err) {
    if (err instanceof AiError) throw err;
    // Network error or timeout: open the breaker.
    downUntil = Date.now() + BREAKER_MS;
    throw new AiError(err.name === 'AbortError' ? 'AI service timed out' : `AI service unreachable: ${err.message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

function breakerOpen() {
  return Date.now() < downUntil;
}

/** Reset breaker and caches (tests / after config change). */
function reset() {
  downUntil = 0;
  healthCache = { at: 0, value: null };
}

/** GET /health -> { status, activeModel } or null. Cached for 10 s. */
async function health() {
  if (!enabled()) return null;
  if (Date.now() - healthCache.at < 10 * 1000) return healthCache.value;
  let value = null;
  if (!breakerOpen()) {
    try {
      value = await request('GET', '/health');
    } catch (_) {
      value = null;
    }
  }
  healthCache = { at: Date.now(), value };
  return value;
}

/**
 * POST /ai/predict-wait. Returns { modelVersion, byTokenId: Map } or null (caller uses baseline).
 */
async function predictWait(items) {
  if (!enabled() || breakerOpen() || !items.length) return null;
  try {
    const data = await request('POST', '/ai/predict-wait', { items });
    if (!data || !Array.isArray(data.predictions) || !data.modelVersion) return null;
    const byTokenId = new Map();
    for (const p of data.predictions) {
      const v = Number(p.predictedMinutes);
      if (Number.isFinite(v)) byTokenId.set(p.tokenId, v);
    }
    return { modelVersion: String(data.modelVersion).slice(0, 20), byTokenId };
  } catch (_) {
    return null;
  }
}

/** POST /ai/rank-branches -> [{ branchId, doctorId, score }] or null. */
async function rankBranches(weights, candidates) {
  if (!enabled() || breakerOpen() || !candidates.length) return null;
  try {
    const data = await request('POST', '/ai/rank-branches', { weights, candidates });
    if (!data || !Array.isArray(data.ranked)) return null;
    return data.ranked;
  } catch (_) {
    return null;
  }
}

/**
 * POST /ai/jobs/forecast -> { generated, modelVersion } or null.
 * Long-running job: a quick health probe first (1.5 s), then a longer job timeout.
 */
async function runForecastJob(days) {
  if (!enabled() || breakerOpen()) return null;
  try {
    await request('GET', '/health');
    const data = await request('POST', '/ai/jobs/forecast', { days }, config.ai.jobTimeoutMs);
    if (!data || typeof data.generated !== 'number') return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Model management proxies (FR-22). These throw 503 AI_UNAVAILABLE on failure. */
async function proxy(method, path, timeoutMs) {
  if (!enabled()) throw aiUnavailable('The AI service is not configured');
  try {
    return await request(method, path, method === 'POST' ? {} : undefined, timeoutMs);
  } catch (err) {
    if (err.status === 404) {
      const e = aiUnavailable(err.message);
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (err.status && err.status >= 400 && err.status < 500) {
      const e = aiUnavailable(err.message);
      e.status = 400;
      e.code = 'VALIDATION_ERROR';
      throw e;
    }
    throw aiUnavailable(`The AI service is unavailable (${err.message})`);
  }
}

const listModels = () => proxy('GET', '/ai/models');
const retrain = () => proxy('POST', '/ai/models/retrain', config.ai.jobTimeoutMs);
const activate = (version) => proxy('POST', `/ai/models/${encodeURIComponent(version)}/activate`);

module.exports = {
  enabled,
  health,
  predictWait,
  rankBranches,
  runForecastJob,
  listModels,
  retrain,
  activate,
  reset,
  breakerOpen,
};
