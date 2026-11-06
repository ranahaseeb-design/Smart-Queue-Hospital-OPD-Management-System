'use strict';
/**
 * HTTP client for the internal AI service (FastAPI, AI_SERVICE_URL).
 * Prediction and ranking calls use a 1.5 s timeout (fetch + AbortController); on any
 * failure the caller falls back silently (baseline prediction / JS scoring / baseline
 * forecast). A short circuit breaker avoids paying the timeout on every request while
 * the service is down (NFR-02).
 */
const config = require('../config');
const { aiUnavailable, badRequest, conflict, notFound } = require('../utils/errors');

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

/**
 * `job: true` marks a long-running job call (forecast, retrain): its timeout means "still busy",
 * not "down", so it must not open the breaker that the live prediction path relies on.
 */
async function request(method, path, body, timeoutMs = config.ai.timeoutMs, { job = false } = {}) {
  if (!enabled()) throw new AiError('AI service not configured', 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};
    if (config.ai.serviceToken) headers['X-AI-Service-Token'] = config.ai.serviceToken; // shared secret
    const res = await fetch(`${config.ai.url}${path}`, {
      method,
      headers,
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
    const timedOut = err.name === 'AbortError';
    // Network error or timeout of a short call: open the breaker and forget the cached health.
    if (!(job && timedOut)) {
      downUntil = Date.now() + BREAKER_MS;
      healthCache = { at: 0, value: null };
    }
    const e = new AiError(timedOut ? 'AI service timed out' : `AI service unreachable: ${err.message}`, 0);
    e.timedOut = timedOut;
    throw e;
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

/**
 * GET /health -> { status, activeModel } or null. Cached for 10 s. /health itself needs no token,
 * so a cheap authenticated call checks the shared AI_SERVICE_TOKEN too: with a mismatched token
 * every /ai/* call fails, and the service must not be reported as available.
 */
async function health() {
  if (!enabled()) return null;
  if (Date.now() - healthCache.at < 10 * 1000) return healthCache.value;
  let value = null;
  if (!breakerOpen()) {
    try {
      value = await request('GET', '/health');
      await request('GET', '/ai/models');
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
 * POST /ai/jobs/forecast -> { generated, modelVersion }, { pending: true } when a job is already
 * running (409) or this one outlived the job timeout (it keeps writing rows), or null when the
 * AI service is unavailable (caller runs the JS baseline).
 * Long-running job: a quick health probe first (1.5 s), then a longer job timeout.
 */
async function runForecastJob(days) {
  if (!enabled() || breakerOpen()) return null;
  try {
    await request('GET', '/health');
    const data = await request('POST', '/ai/jobs/forecast', { days }, config.ai.jobTimeoutMs, { job: true });
    if (!data || typeof data.generated !== 'number') return null;
    return data;
  } catch (err) {
    if (err.status === 409 || err.timedOut) return { pending: true };
    return null;
  }
}

/**
 * Model management proxies (FR-22). AI 404 -> 404 NOT_FOUND, 409 (e.g. a retraining job is already
 * running) -> 409 CONFLICT, 401/403 (AI_SERVICE_TOKEN mismatch: a server misconfiguration, not a
 * client error) -> 503 AI_UNAVAILABLE, other 4xx -> 400 VALIDATION_ERROR, all with the AI's message;
 * anything else (5xx, timeout, unreachable) -> 503 AI_UNAVAILABLE.
 */
async function proxy(method, path, timeoutMs, options) {
  if (!enabled()) throw aiUnavailable('The AI service is not configured');
  try {
    return await request(method, path, method === 'POST' ? {} : undefined, timeoutMs, options);
  } catch (err) {
    if (err.status === 404) throw notFound(err.message);
    if (err.status === 409) throw conflict(err.message);
    if (err.status === 401 || err.status === 403) {
      throw aiUnavailable('The AI service rejected the backend (check that AI_SERVICE_TOKEN matches on both sides)');
    }
    if (err.status && err.status >= 400 && err.status < 500) throw badRequest(err.message);
    throw aiUnavailable(`The AI service is unavailable (${err.message})`);
  }
}

const listModels = () => proxy('GET', '/ai/models');
const retrain = () => proxy('POST', '/ai/models/retrain', config.ai.jobTimeoutMs, { job: true });
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
