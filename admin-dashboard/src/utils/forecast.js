// Pure helpers for the Forecasts screen (FR-17).
import { congestionLevel, DEFAULT_THRESHOLDS } from './settings.js';
import { formatHour } from './format.js';

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round1 = (n) => Math.round(n * 10) / 10;

/** Patients above capacity in one forecast row (never negative). */
export function excessPatients(row) {
  return Math.max(0, (Number(row?.expectedArrivals) || 0) - (Number(row?.capacity) || 0));
}

/**
 * Doctor-hours missing in one forecast row. Uses the API's `shortfallDoctorHours` when present;
 * otherwise applies the contract formula max(0, arrivals − capacity) × avgConsultMinutes / 60
 * to the row's own `avgConsultMinutes`. Null when neither field is available (older backend).
 */
export function rowShortfallDoctorHours(row) {
  if (isNum(row?.shortfallDoctorHours)) return Number(row.shortfallDoctorHours);
  if (isNum(row?.avgConsultMinutes) && Number(row.avgConsultMinutes) > 0) {
    return round1((excessPatients(row) * Number(row.avgConsultMinutes)) / 60);
  }
  return null;
}

/**
 * Collapses forecast rows (one per department and hour) into one point per hour.
 * With several departments, arrivals and capacity are summed and the ratio recomputed
 * (Eq. 6.5 applied to the aggregate); an hour is a peak if any department flags it as one.
 * With a single department the server's own ratio and level are kept.
 * Shortfalls are summed per department (capacity cannot move between departments), so an hour
 * is a shortfall hour when any department in scope is above its capacity.
 */
export function aggregateForecastByHour(rows, thresholds = DEFAULT_THRESHOLDS) {
  const byHour = new Map();
  for (const r of rows || []) {
    const key = r.forecastHour;
    const cur = byHour.get(key) || {
      forecastHour: key, expectedArrivals: 0, capacity: 0, isPeak: false, items: [], sources: new Set(),
      excess: 0, shortfall: 0, shortfallKnown: 0,
    };
    cur.expectedArrivals += Number(r.expectedArrivals) || 0;
    cur.capacity += Number(r.capacity) || 0;
    cur.isPeak = cur.isPeak || Boolean(r.isPeak);
    cur.excess += excessPatients(r);
    const sdh = rowShortfallDoctorHours(r);
    if (sdh !== null) {
      cur.shortfall += sdh;
      cur.shortfallKnown += 1;
    }
    cur.items.push(r);
    if (r.source) cur.sources.add(r.source);
    byHour.set(key, cur);
  }
  return [...byHour.values()]
    .sort((a, b) => String(a.forecastHour).localeCompare(String(b.forecastHour)))
    .map((p) => {
      const single = p.items.length === 1 ? p.items[0] : null;
      let ratio;
      if (single && single.congestionRatio !== undefined && single.congestionRatio !== null) {
        ratio = Number(single.congestionRatio);
      } else if (p.capacity > 0) {
        ratio = p.expectedArrivals / p.capacity;
      } else {
        ratio = p.expectedArrivals > 0 ? Infinity : 0;
      }
      const level = (single && single.congestionLevel) || congestionLevel(ratio, thresholds);
      const excess = round1(p.excess);
      return {
        forecastHour: p.forecastHour,
        hour: formatHour(p.forecastHour),
        expectedArrivals: round1(p.expectedArrivals),
        capacity: round1(p.capacity),
        congestionRatio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
        congestionLevel: level,
        isPeak: p.isPeak,
        excessPatients: excess,
        isShortfall: excess > 0,
        // Only when every department in the hour reported it, so a partial sum is never shown.
        shortfallDoctorHours: p.shortfallKnown === p.items.length ? round1(p.shortfall) : null,
        avgConsultMinutes: single && isNum(single.avgConsultMinutes) ? Number(single.avgConsultMinutes) : null,
        departments: p.items.length,
        sources: [...p.sources],
      };
    });
}

/** Totals for the KPI row: shortfall doctor-hours over the day (null when unknown). */
export function forecastTotals(points) {
  const list = points || [];
  const known = list.every((p) => p.shortfallDoctorHours !== null && p.shortfallDoctorHours !== undefined);
  return {
    arrivals: round1(list.reduce((s, p) => s + (Number(p.expectedArrivals) || 0), 0)),
    shortfallHours: list.filter((p) => p.isShortfall).length,
    shortfallDoctorHours: list.length && known ? round1(list.reduce((s, p) => s + Number(p.shortfallDoctorHours), 0)) : null,
    excessPatients: round1(list.reduce((s, p) => s + (Number(p.excessPatients) || 0), 0)),
  };
}
