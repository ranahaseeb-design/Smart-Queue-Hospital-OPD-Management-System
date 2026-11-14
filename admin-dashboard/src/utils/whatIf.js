// "+1 extra doctor session" what-if for the Workload screen (FR-18 decision support).
// Client-side ESTIMATE only (Decision 6): nothing is written anywhere and schedules never change.
//
// Model (simple hourly backlog / fluid queue on the hourly forecast):
//   extra capacity per hour   e   = 60 / avgConsultMinutes      (one more doctor, contract)
//   capacity                  C'h = Ch + e   for hours inside the recommendation's time range
//   backlog at end of hour    Qh  = max(0, Q(h-1) + Âh − Ch)     (patients still waiting)
//   estimated wait in hour    Wh  = Qh / Ch × 60 minutes          (time to clear the backlog at
//                                                                  that hour's service rate)
// Summary window: from the start of the range until the first hour at or after its end where
// the current plan's backlog is cleared (the effect of a session carries over), capped at the
// end of the forecast day. Average waits are over window hours with capacity > 0.
import { parseLocal } from './format.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round1 = (n) => Math.round(n * 10) / 10;

/** "16:00-17:00" (also "16:00 – 17:00") -> { startHour: 16, endHour: 17 } (end exclusive). */
export function parseTimeRange(range) {
  const m = /(\d{1,2}):(\d{2})\s*[-–—to]+\s*(\d{1,2}):(\d{2})/.exec(String(range || ''));
  if (!m) return null;
  const start = Number(m[1]) + Number(m[2]) / 60;
  let end = Number(m[3]) + Number(m[4]) / 60;
  if (end <= start) end = 24; // e.g. 23:00-00:00 runs to midnight
  if (start < 0 || start >= 24 || end > 24) return null;
  return { startHour: Math.floor(start), endHour: Math.ceil(end) };
}

/** Hour of day of a forecast point ("2026-11-14T16:00:00" or { hour: "16:00" }). */
export function hourOf(point) {
  const d = parseLocal(point?.forecastHour);
  if (d) return d.getHours();
  const m = /^(\d{1,2}):/.exec(String(point?.hour || ''));
  return m ? Number(m[1]) : null;
}

/** Extra patients per hour one more doctor can see: 60 / avgConsultMinutes (null if unknown). */
export function extraCapacityPerHour(avgConsultMinutes) {
  if (!isNum(avgConsultMinutes) || Number(avgConsultMinutes) <= 0) return null;
  return 60 / Number(avgConsultMinutes);
}

/**
 * Average consultation minutes for a department: the forecast's `avgConsultMinutes` (contract),
 * else the mean `avgConsultMinutes` of the department's active doctors (GET /admin/doctors),
 * which is the same definition. { value: null } when neither is available.
 */
export function resolveAvgConsult(forecastRows, doctors, departmentId) {
  const fromForecast = (forecastRows || []).find((r) => String(r.departmentId) === String(departmentId) && isNum(r.avgConsultMinutes) && Number(r.avgConsultMinutes) > 0);
  if (fromForecast) return { value: Number(fromForecast.avgConsultMinutes), source: 'forecast' };
  const values = (doctors || [])
    .filter((d) => String(d.departmentId) === String(departmentId) && d.isActive !== false && isNum(d.avgConsultMinutes) && Number(d.avgConsultMinutes) > 0)
    .map((d) => Number(d.avgConsultMinutes));
  if (values.length) return { value: round1(values.reduce((s, v) => s + v, 0) / values.length), source: 'doctors' };
  return { value: null, source: null };
}

/** Hourly backlog and estimated wait for a capacity series (see the model above). */
export function backlogSeries(points, capacityOf = (p) => p.capacity) {
  let q = 0;
  return (points || []).map((p) => {
    const a = Number(p.expectedArrivals) || 0;
    const c = Math.max(0, Number(capacityOf(p)) || 0);
    q = Math.max(0, q + a - c);
    const wait = c > 0 ? (q / c) * 60 : (q > 0 ? null : 0);
    return { backlog: q, wait };
  });
}

/**
 * Runs the what-if for one department's hourly forecast (sorted or not; one row per hour).
 * Returns { available: false, reason } when it cannot be estimated honestly.
 */
export function simulateExtraSession(points, { avgConsultMinutes, timeRange } = {}) {
  const range = parseTimeRange(timeRange);
  if (!range) return { available: false, reason: 'NO_TIME_RANGE' };
  const sorted = [...(points || [])]
    .map((p) => ({ ...p, h: hourOf(p) }))
    .filter((p) => p.h !== null)
    .sort((a, b) => a.h - b.h);
  const inRange = (p) => p.h >= range.startHour && p.h < range.endHour;
  if (!sorted.some(inRange)) return { available: false, reason: 'NO_FORECAST' };
  const extra = extraCapacityPerHour(avgConsultMinutes);
  if (extra === null) return { available: false, reason: 'NO_CONSULT_TIME' };

  const before = backlogSeries(sorted);
  const after = backlogSeries(sorted, (p) => (Number(p.capacity) || 0) + (inRange(p) ? extra : 0));
  const series = sorted.map((p, i) => ({
    hour: p.hour || `${String(p.h).padStart(2, '0')}:00`,
    h: p.h,
    forecastHour: p.forecastHour,
    expectedArrivals: round1(Number(p.expectedArrivals) || 0),
    capacity: round1(Number(p.capacity) || 0),
    simulatedCapacity: round1((Number(p.capacity) || 0) + (inRange(p) ? extra : 0)),
    inRange: inRange(p),
    backlogBefore: round1(before[i].backlog),
    backlogAfter: round1(after[i].backlog),
    waitBefore: before[i].wait === null ? null : round1(before[i].wait),
    waitAfter: after[i].wait === null ? null : round1(after[i].wait),
  }));

  const startIdx = series.findIndex((p) => p.inRange);
  let endIdx = series.length - 1;
  for (let i = startIdx; i < series.length; i += 1) {
    if (series[i].h >= range.endHour - 1 && series[i].backlogBefore === 0) { endIdx = i; break; }
  }
  const windowPts = series.slice(startIdx, endIdx + 1);
  const avg = (key) => {
    const vals = windowPts.map((p) => p[key]).filter((v) => v !== null);
    return vals.length ? round1(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  };
  const avgWaitBefore = avg('waitBefore');
  const avgWaitAfter = avg('waitAfter');
  const peakBefore = Math.max(0, ...windowPts.map((p) => p.backlogBefore));
  const peakAfter = Math.max(0, ...windowPts.map((p) => p.backlogAfter));
  const rangeHours = series.filter((p) => p.inRange).length;

  return {
    available: true,
    extraPerHour: round1(extra),
    addedCapacity: round1(extra * rangeHours),
    startHour: range.startHour,
    endHour: range.endHour,
    points: series,
    window: { from: windowPts[0].hour, to: windowPts[windowPts.length - 1].hour, hours: windowPts.length },
    avgWaitBefore,
    avgWaitAfter,
    waitReduction: avgWaitBefore !== null && avgWaitAfter !== null ? round1(Math.max(0, avgWaitBefore - avgWaitAfter)) : null,
    peakBacklogBefore: round1(peakBefore),
    peakBacklogAfter: round1(peakAfter),
    backlogReduction: round1(Math.max(0, peakBefore - peakAfter)),
  };
}

export const WHAT_IF_REASONS = {
  NO_CONSULT_TIME: 'The department’s average consultation time is not available, so the extra capacity cannot be estimated.',
  NO_TIME_RANGE: 'The recommendation has no time range to add a session to.',
  NO_FORECAST: 'There is no hourly forecast for this department and date.',
};
