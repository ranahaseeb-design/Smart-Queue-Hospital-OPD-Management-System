// Formatting helpers. The API serialises datetimes in hospital local time WITHOUT a zone
// suffix ("YYYY-MM-DDTHH:mm:ss"); we always parse them as local time (API contract).

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

/** Parse an API date/datetime string as local time. Returns null for empty/invalid input. */
export function parseLocal(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = DATETIME_RE.exec(String(value));
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

const pad = (n) => String(n).padStart(2, '0');

/** Date -> "YYYY-MM-DD" in local time. */
export function toDateInput(date) {
  const d = date instanceof Date ? date : parseLocal(date);
  if (!d) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Hospital time zone (backend `TZ`, default Asia/Karachi). API datetimes are hospital wall-clock
 * times, so "now" must be the hospital's wall clock too, even when the browser runs in another
 * zone (e.g. a laptop set to UTC); otherwise relative times and "today" drift by hours.
 */
export const HOSPITAL_TZ = import.meta.env?.VITE_HOSPITAL_TZ || 'Asia/Karachi';

/**
 * Current hospital wall-clock time as a Date whose *local* fields (getHours(), getDate(), ...)
 * equal the hospital's clock, i.e. directly comparable with parseLocal() results.
 */
export function hospitalNow(instant = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: HOSPITAL_TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant).map((p) => [p.type, p.value]));
    return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
  } catch {
    return instant; // unknown time zone: fall back to the browser clock
  }
}

/** Today's hospital date, "YYYY-MM-DD". */
export function today() {
  return toDateInput(hospitalNow());
}

export function addDays(dateStr, days) {
  const d = parseLocal(dateStr) || new Date();
  d.setDate(d.getDate() + days);
  return toDateInput(d);
}

export function formatDateTime(value) {
  const d = parseLocal(value);
  if (!d) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatDate(value) {
  const d = parseLocal(value);
  if (!d) return '—';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "HH:mm" from an API datetime (forecast hours, alert times). */
export function formatHour(value) {
  const d = parseLocal(value);
  if (!d) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Relative time such as "3 min ago" for live alerts and "last updated", or "in 5 h" for future
 * instants (forecast alerts carry the forecast hour, which is usually later today or tomorrow).
 */
export function timeAgo(value, now) {
  const d = parseLocal(value);
  if (!d) return '—';
  // Client-side instants (Date objects, e.g. "last updated") compare with the browser clock,
  // API strings (hospital wall-clock time) with the hospital clock.
  if (!now) now = value instanceof Date ? new Date() : hospitalNow();
  const diffSec = Math.round((now - d) / 1000);
  const future = diffSec < 0;
  const sec = Math.abs(diffSec);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min} min` : `${min} min ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return future ? `in ${hrs} h` : `${hrs} h ago`;
  return formatDateTime(value);
}

/** Number with a fixed number of decimals, or an em dash for null/undefined/NaN. */
export function fmtNum(value, decimals = 0) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtMinutes(value) {
  if (value === null || value === undefined) return '—';
  return `${fmtNum(value, 0)} min`;
}

/** Ratio (0..n) shown as a percentage. */
export function fmtPercent(value, decimals = 0) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return `${fmtNum(Number(value) * 100, decimals)}%`;
}

/** Normalises "HH:mm:ss" or "HH:mm" to "HH:mm" (schedules). */
export function toHHmm(value) {
  if (!value) return '';
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value));
  return m ? `${pad(Number(m[1]))}:${m[2]}` : String(value);
}

/** Days of week, ISO numbering used by the schema and API: 1 = Monday ... 7 = Sunday. */
export const DAYS_OF_WEEK = [
  { value: 1, short: 'Mon', label: 'Monday' },
  { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' },
  { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' },
  { value: 6, short: 'Sat', label: 'Saturday' },
  { value: 7, short: 'Sun', label: 'Sunday' },
];

export function dayName(n, short = true) {
  const d = DAYS_OF_WEEK.find((x) => x.value === Number(n));
  return d ? (short ? d.short : d.label) : '—';
}
