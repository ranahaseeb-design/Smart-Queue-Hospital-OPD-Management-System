// Thin fetch wrapper around the backend REST API (docs/API_CONTRACT.md).
// - Base URL from VITE_API_URL (default http://localhost:4000), REST under /api.
// - Sends the JWT as "Authorization: Bearer <token>".
// - Errors follow { error: { code, message } } and are thrown as ApiError.
// - Any 401 on an authenticated request triggers the registered logout handler.
import { filenameFromDisposition } from '../utils/reports.js';

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
export const API_BASE = `${API_URL}/api`;

const TOKEN_KEY = 'smartopd.admin.token';
const USER_KEY = 'smartopd.admin.user';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---- token storage (localStorage, as required for the admin app) ----
function safeStorage(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export const session = {
  getToken: () => safeStorage(() => localStorage.getItem(TOKEN_KEY)),
  getUser: () => safeStorage(() => JSON.parse(localStorage.getItem(USER_KEY) || 'null')),
  save(token, user) {
    safeStorage(() => {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    });
  },
  saveUser(user) {
    safeStorage(() => localStorage.setItem(USER_KEY, JSON.stringify(user)));
  },
  clear() {
    safeStorage(() => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    });
  },
};

let unauthorizedHandler = null;
/** Registered by AuthProvider: called once whenever the API answers 401. */
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

/** Builds a query string, skipping null/undefined/'' values. */
export function buildQuery(params) {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function parseError(res) {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || 'Request failed';
  let details;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
      details = body.error.details;
    } else if (body?.message) {
      message = body.message;
    }
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 503 && code === `HTTP_503`) code = 'AI_UNAVAILABLE';
  return new ApiError(res.status, code, message, details);
}

async function rawRequest(method, path, { query, body, signal, auth = true, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = session.getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the server at ${API_URL}. Is the backend running?`);
  }

  if (res.status === 401 && auth) {
    const error = await parseError(res);
    if (unauthorizedHandler) unauthorizedHandler(error);
    throw error;
  }
  if (!res.ok) throw await parseError(res);
  return res;
}

async function request(method, path, opts) {
  const res = await rawRequest(method, path, opts);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: (path, query, opts = {}) => request('GET', path, { ...opts, query }),
  post: (path, body, opts = {}) => request('POST', path, { ...opts, body: body ?? {} }),
  put: (path, body, opts = {}) => request('PUT', path, { ...opts, body }),
  del: (path, opts = {}) => request('DELETE', path, opts),

  /** POST /auth/login. A 401 here means wrong credentials, so it must not trigger logout. */
  login: (identifier, password) =>
    request('POST', '/auth/login', { body: { identifier, password }, auth: false }),

  /**
   * Downloads a file (e.g. report CSV, FR-16) with the auth header and saves it via a blob URL.
   * A plain <a href> cannot be used because the endpoint needs the Bearer token.
   */
  async download(path, query, fallbackName = 'export.csv') {
    const res = await rawRequest('GET', path, { query, accept: 'text/csv, application/json;q=0.5' });
    const blob = await res.blob();
    const name = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  },
};

/** Human-readable message for any thrown value. */
export function errorMessage(err) {
  if (!err) return 'Something went wrong';
  if (err instanceof ApiError) {
    if (err.code === 'AI_UNAVAILABLE') {
      return err.message && err.message !== 'Service Unavailable'
        ? err.message
        : 'The AI service is not available right now.';
    }
    return err.message;
  }
  return err.message || String(err);
}
