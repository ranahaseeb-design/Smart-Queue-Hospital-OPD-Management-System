// Runtime configuration (Vite injects import.meta.env at build time).
const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};

const trimSlash = (url) => String(url || '').replace(/\/+$/, '');

/** Backend origin, e.g. http://localhost:4000 (REST lives under /api). */
export const API_URL = trimSlash(env.VITE_API_URL || 'http://localhost:4000');

/** Socket.IO origin; same server as the REST API unless overridden. */
export const SOCKET_URL = trimSlash(env.VITE_SOCKET_URL || API_URL);

/** Fallback polling interval used while the live channel is down (FR-05, NFR-01). */
export const POLL_INTERVAL_MS = 15000;

/**
 * Hospital time zone. Contract datetimes are hospital local wall-clock time without a zone suffix
 * (server TZ=Asia/Karachi), so elapsed-time counters ("waiting 12 min") compare them with the current
 * wall-clock time in this zone — correct even when the browser runs in another time zone.
 */
export const HOSPITAL_TIME_ZONE = env.VITE_HOSPITAL_TZ || 'Asia/Karachi';
