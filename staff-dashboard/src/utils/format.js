// Formatting helpers shared by the queue screens.
import { HOSPITAL_TIME_ZONE } from '../config.js';

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Parse a contract datetime ("YYYY-MM-DDTHH:mm:ss", hospital local time, no zone suffix)
 * explicitly as local time so browsers never treat it as UTC.
 */
export function parseLocalDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = DATETIME_RE.exec(String(value));
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
}

/** "09:12" style clock time. */
export function formatClock(value) {
  const d = parseLocalDateTime(value);
  if (!d) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Wall-clock fields of a contract datetime as a comparable number (the fields read as if they were UTC).
 * Returns null for empty or unparseable values.
 */
function wallClockMs(value) {
  if (!value) return null;
  if (value instanceof Date) return localFieldsMs(value);
  const m = DATETIME_RE.exec(String(value));
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : localFieldsMs(d);
  }
  const [, y, mo, d, h, mi, s] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
}

/** Browser-local wall-clock fields of an instant, read as UTC. */
function localFieldsMs(date) {
  return Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
}

const zoneFormatters = new Map();

/**
 * Wall-clock fields of `instant` in `timeZone` (IANA name), read as UTC so they compare directly with
 * contract datetimes. Falls back to the browser's zone when `timeZone` is empty or unknown.
 */
export function wallClockInZoneMs(instant, timeZone) {
  if (!timeZone) return localFieldsMs(instant);
  let fmt = zoneFormatters.get(timeZone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      fmt = null; // unknown zone name
    }
    zoneFormatters.set(timeZone, fmt);
  }
  if (!fmt) return localFieldsMs(instant);
  const parts = {};
  fmt.formatToParts(instant).forEach((p) => {
    parts[p.type] = p.value;
  });
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
}

/**
 * Whole minutes elapsed since the contract datetime `value` (never negative). `now` is an instant;
 * it is converted to hospital wall-clock time (`timeZone`, default HOSPITAL_TIME_ZONE) before comparing,
 * so counters are right even when the browser runs in another zone. `timeZone = null` uses the browser zone.
 */
export function minutesSince(value, now = new Date(), timeZone = HOSPITAL_TIME_ZONE) {
  const then = wallClockMs(value);
  if (then === null) return null;
  const current = wallClockInZoneMs(now, timeZone);
  return Math.max(0, Math.floor((current - then) / 60000));
}

/** Clock time ("13:05:42") of an instant in the hospital time zone, e.g. for "Updated …". */
export function formatInstantClock(instant, timeZone = HOSPITAL_TIME_ZONE) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return '—';
  const d = new Date(wallClockInZoneMs(instant, timeZone));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Human friendly duration: "4 min", "1 h 05 min". */
export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = Math.max(0, Math.round(Number(minutes)));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Priority levels (FR-13): 0 normal, 1 elderly / differently-abled, 2 emergency. */
export const PRIORITY_LEVELS = [
  { level: 0, label: 'Normal', description: 'Standard order by arrival time' },
  { level: 1, label: 'Elderly / differently-abled', description: 'Served ahead of normal tokens' },
  { level: 2, label: 'Emergency', description: 'Served ahead of all other tokens' },
];

/** Short badge text for a token's priority, or null for normal tokens. */
export function priorityLabel(level, category) {
  const lvl = Number(level) || 0;
  if (lvl >= 2) return 'Emergency';
  if (lvl === 1) {
    if (category === 'ELDERLY') return 'Elderly';
    if (category === 'DIFFERENTLY_ABLED') return 'Differently-abled';
    return 'Priority';
  }
  return null;
}

/** CSS modifier for a priority level: 'emergency' | 'priority' | 'normal'. */
export function priorityTone(level) {
  const lvl = Number(level) || 0;
  if (lvl >= 2) return 'emergency';
  if (lvl === 1) return 'priority';
  return 'normal';
}

const STATUS_LABELS = {
  WAITING: 'Waiting',
  CALLED: 'Called',
  IN_SERVICE: 'In service',
  SKIPPED: 'Skipped',
  TRANSFERRED: 'Transferred',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '—';
}

const TYPE_LABELS = { OPD: 'OPD room', LAB: 'Laboratory', PHARMACY: 'Pharmacy' };

export function servicePointTypeLabel(type) {
  return TYPE_LABELS[type] || type || '';
}

/**
 * Queue badge for a token (Upgrade 2026, Decision 2 — the same mapping in every UI):
 * level 2 -> EMERGENCY (crimson, pulsing), level 1 -> ELDERLY / DIFFERENTLY_ABLED from `priorityCategory`
 * (amber; "PRIORITY" when staff raised the level without a category), level 0 + `fromAppointment` ->
 * APPOINTMENT (blue), else NORMAL (slate). Always text + colour, never colour alone.
 * @param {{ priorityLevel?: number, priorityCategory?: string, fromAppointment?: boolean }|null} token
 * @returns {{ kind: string, label: string, tone: 'emergency'|'elevated'|'appointment'|'normal' }}
 */
export function queueBadge(token) {
  const t = token || {};
  const lvl = Number(t.priorityLevel) || 0;
  if (lvl >= 2) return { kind: 'EMERGENCY', label: 'Emergency', tone: 'emergency' };
  if (lvl === 1) {
    if (t.priorityCategory === 'ELDERLY') return { kind: 'ELDERLY', label: 'Elderly', tone: 'elevated' };
    if (t.priorityCategory === 'DIFFERENTLY_ABLED') {
      return { kind: 'DIFFERENTLY_ABLED', label: 'Differently-abled', tone: 'elevated' };
    }
    return { kind: 'PRIORITY', label: 'Priority', tone: 'elevated' };
  }
  if (t.fromAppointment) return { kind: 'APPOINTMENT', label: 'Appointment', tone: 'appointment' };
  return { kind: 'NORMAL', label: 'Normal', tone: 'normal' };
}

/**
 * Whole seconds elapsed since the contract datetime `value` (never negative), compared in hospital
 * wall-clock time like `minutesSince`. Null for empty / invalid values.
 */
export function secondsSince(value, now = new Date(), timeZone = HOSPITAL_TIME_ZONE) {
  const then = wallClockMs(value);
  if (then === null) return null;
  const current = wallClockInZoneMs(now, timeZone);
  return Math.max(0, Math.floor((current - then) / 1000));
}

/** Stopwatch text for elapsed seconds: "07:32", "1:02:05"; "—" when unknown. */
export function formatElapsed(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—';
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** From this multiple of the average a consultation is "well over" (crimson). */
export const PACE_CRITICAL_RATIO = 1.5;

/**
 * Pace of the current consultation against the rolling average (staff pace gauge):
 * 'ok' below the average (emerald), 'over' from the average (amber), 'critical' from 1.5x (crimson),
 * 'unknown' when there is no average yet. `ratio` = elapsed / average (null when unknown).
 */
export function paceState(elapsedSeconds, avgMinutes) {
  const avg = Number(avgMinutes);
  if (elapsedSeconds == null || avgMinutes == null || !Number.isFinite(avg) || avg <= 0) {
    return { level: 'unknown', ratio: null, label: 'No average yet' };
  }
  const ratio = Number(elapsedSeconds) / (avg * 60);
  if (ratio >= PACE_CRITICAL_RATIO) return { level: 'critical', ratio, label: 'Well over average' };
  if (ratio >= 1) return { level: 'over', ratio, label: 'Over average' };
  return { level: 'ok', ratio, label: 'On pace' };
}

/** Date of an instant in the hospital time zone, e.g. "Sat 14 Nov 2026". */
export function formatInstantDate(instant, timeZone = HOSPITAL_TIME_ZONE) {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return '—';
  const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(instant);
  }
}
