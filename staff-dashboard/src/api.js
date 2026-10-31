// REST client for the backend (docs/API_CONTRACT.md). Adds the JWT, parses the contract's
// error envelope `{ error: { code, message } }` into ApiError, and reports 401s so the app can log out.
import { API_URL } from './config.js';
import { getItem, KEYS } from './utils/storage.js';

/** Upper bound for any single REST call. */
export const REQUEST_TIMEOUT_MS = 15000;

const DEFAULT_MESSAGES = {
  400: 'Some of the information is invalid.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You are not allowed to do that.',
  404: 'The requested item was not found.',
  409: 'That action conflicts with the current queue state.',
  503: 'The service is temporarily unavailable.',
};

const DEFAULT_CODES = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'AI_UNAVAILABLE',
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let unauthorizedHandler = null;

/** Register the callback invoked when an authenticated request returns 401. */
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null;
}

/** Build an ApiError from a non-2xx response status and its (possibly empty) parsed body. */
export function toApiError(status, body) {
  const err = body && typeof body === 'object' ? body.error : null;
  const code = (err && err.code) || DEFAULT_CODES[status] || (status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR');
  const message =
    (err && err.message) ||
    DEFAULT_MESSAGES[status] ||
    (status >= 500 ? 'The server ran into a problem. Please try again.' : `Request failed (HTTP ${status}).`);
  return new ApiError(status, code, message, err && err.details);
}

async function parseBody(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Perform a request against `${API_URL}/api${path}`.
 * @param {string} method HTTP verb
 * @param {string} path   path below /api, starting with '/'
 * @param {object} [body] JSON body
 * @param {{ auth?: boolean, signal?: AbortSignal, timeoutMs?: number }} [opts]
 */
export async function request(method, path, body, opts = {}) {
  const { auth = true, signal, timeoutMs = REQUEST_TIMEOUT_MS } = opts;
  const headers = { Accept: 'application/json' };
  const token = auth ? getItem(KEYS.token) : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // A hung request must not leave staff buttons disabled forever (NFR-02 targets < 2 s responses).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let res;
  let data;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    data = await parseBody(res);
  } catch (e) {
    if (signal && signal.aborted) throw e; // cancelled by the caller
    if (controller.signal.aborted) {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check the connection and try again.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }

  if (!res.ok) {
    const error = toApiError(res.status, data);
    // Only an authenticated call proves the stored session is no longer valid.
    if (res.status === 401 && token && unauthorizedHandler) unauthorizedHandler(error);
    throw error;
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  // FR-01 authentication
  login: (identifier, password) => request('POST', '/auth/login', { identifier, password }, { auth: false }),
  me: () => request('GET', '/auth/me'),

  // FR-12 staff queue view and operations
  servicePoints: () => request('GET', '/staff/service-points'),
  queue: (servicePointId, opts) => request('GET', `/service-points/${enc(servicePointId)}/queue`, undefined, opts),
  callNext: (servicePointId) => request('POST', `/service-points/${enc(servicePointId)}/call-next`),
  start: (tokenId) => request('POST', `/tokens/${enc(tokenId)}/start`),
  skip: (tokenId) => request('POST', `/tokens/${enc(tokenId)}/skip`),
  recall: (tokenId) => request('POST', `/tokens/${enc(tokenId)}/recall`),
  complete: (tokenId) => request('POST', `/tokens/${enc(tokenId)}/complete`),
  transfer: (tokenId, toServicePointId, toDoctorId) =>
    request('POST', `/tokens/${enc(tokenId)}/transfer`, {
      toServicePointId,
      ...(toDoctorId ? { toDoctorId } : {}),
    }),
  transferTargets: (servicePointId) =>
    request('GET', `/staff/transfer-targets?servicePointId=${enc(servicePointId)}`),

  // FR-13 priority handling
  setPriority: (tokenId, level, reason) => request('POST', `/tokens/${enc(tokenId)}/priority`, { level, reason }),

  // FR-04 linked laboratory / pharmacy tokens
  issueLinkedToken: (visitId, type, servicePointId) =>
    request('POST', `/visits/${enc(visitId)}/linked-tokens`, {
      type,
      ...(servicePointId ? { servicePointId } : {}),
    }),
};
