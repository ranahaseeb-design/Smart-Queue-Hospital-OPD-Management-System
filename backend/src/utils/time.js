'use strict';
/**
 * Local-time helpers. The database stores hospital local time as
 * "YYYY-MM-DD HH:mm:ss" strings (portable between MySQL DATETIME and SQLite TEXT);
 * the API serialises them as "YYYY-MM-DDTHH:mm:ss" without a zone suffix.
 * All date arithmetic is done in JavaScript (no NOW()/DATE() in SQL).
 */

// Overridable clock so tests (and the seed) can run at a fixed point in time.
let fixedNow = null;
const clock = {
  now() {
    return fixedNow ? new Date(fixedNow.getTime()) : new Date();
  },
  set(date) {
    fixedNow = date ? new Date(date.getTime()) : null;
  },
  advance(ms) {
    if (!fixedNow) fixedNow = new Date();
    fixedNow = new Date(fixedNow.getTime() + ms);
  },
  reset() {
    fixedNow = null;
  },
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (n) => String(n).padStart(2, '0');

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(d) {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Parse "YYYY-MM-DD" into a local Date at midnight (null if invalid). */
function parseDate(str) {
  if (typeof str !== 'string') return null;
  const m = DATE_RE.exec(str.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (formatDate(d) !== str.trim()) return null; // rejects 2026-02-31 etc.
  return d;
}

/**
 * Parse a local datetime ("YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm[:ss]").
 * Strings with an explicit zone (Z / +05:00) are honoured and converted to local time.
 */
function parseDateTime(str) {
  if (str instanceof Date) return new Date(str.getTime());
  if (typeof str !== 'string' || !str) return null;
  const s = str.trim();
  const m = DT_RE.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Normalise "8:00", "08:00" or "08:00:00" to "HH:mm:ss" (null if invalid). */
function normalizeTime(str) {
  if (typeof str !== 'string') return null;
  const m = TIME_RE.exec(str.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return `${pad(h)}:${pad(mi)}:${pad(s)}`;
}

/** "HH:mm:ss" -> "HH:mm" */
function shortTime(t) {
  return t ? String(t).slice(0, 5) : null;
}

/** Combine a "YYYY-MM-DD" date and "HH:mm[:ss]" time into a local Date. */
function combine(dateStr, timeStr) {
  const d = parseDate(dateStr);
  const t = normalizeTime(String(timeStr));
  const [h, mi, s] = t.split(':').map(Number);
  d.setHours(h, mi, s, 0);
  return d;
}

/** DB datetime string -> API string ("YYYY-MM-DDTHH:mm:ss"). */
function toApi(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return formatDateTime(value).replace(' ', 'T');
  const s = String(value);
  return s.length >= 19 ? `${s.slice(0, 10)}T${s.slice(11, 19)}` : s.replace(' ', 'T');
}

/** DB date (string or Date) -> "YYYY-MM-DD" */
function toApiDate(value) {
  if (!value) return null;
  if (value instanceof Date) return formatDate(value);
  return String(value).slice(0, 10);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
function isoDow(d) {
  return ((d.getDay() + 6) % 7) + 1;
}

function addDays(date, n) {
  const d = typeof date === 'string' ? parseDate(date) : new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function addDaysStr(dateStr, n) {
  return formatDate(addDays(dateStr, n));
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfHour(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours());
}

function minutesBetween(a, b) {
  return (b.getTime() - a.getTime()) / MINUTE;
}

function today() {
  return formatDate(clock.now());
}

function nowDb() {
  return formatDateTime(clock.now());
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function dayName(d) {
  return DAY_NAMES[isoDow(d) - 1];
}

function round(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

module.exports = {
  clock,
  MINUTE,
  HOUR,
  DAY,
  formatDate,
  formatTime,
  formatDateTime,
  parseDate,
  parseDateTime,
  normalizeTime,
  shortTime,
  combine,
  toApi,
  toApiDate,
  isoDow,
  addDays,
  addDaysStr,
  startOfDay,
  startOfHour,
  minutesBetween,
  today,
  nowDb,
  dayName,
  round,
};
