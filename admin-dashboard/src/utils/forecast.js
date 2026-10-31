// Pure helpers for the Forecasts screen (FR-17).
import { congestionLevel, DEFAULT_THRESHOLDS } from './settings.js';
import { formatHour } from './format.js';

/**
 * Collapses forecast rows (one per department and hour) into one point per hour.
 * With several departments, arrivals and capacity are summed and the ratio recomputed
 * (Eq. 6.5 applied to the aggregate); an hour is a peak if any department flags it as one.
 * With a single department the server's own ratio and level are kept.
 */
export function aggregateForecastByHour(rows, thresholds = DEFAULT_THRESHOLDS) {
  const byHour = new Map();
  for (const r of rows || []) {
    const key = r.forecastHour;
    const cur = byHour.get(key) || {
      forecastHour: key, expectedArrivals: 0, capacity: 0, isPeak: false, items: [], sources: new Set(),
    };
    cur.expectedArrivals += Number(r.expectedArrivals) || 0;
    cur.capacity += Number(r.capacity) || 0;
    cur.isPeak = cur.isPeak || Boolean(r.isPeak);
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
      return {
        forecastHour: p.forecastHour,
        hour: formatHour(p.forecastHour),
        expectedArrivals: Math.round(p.expectedArrivals * 10) / 10,
        capacity: Math.round(p.capacity * 10) / 10,
        congestionRatio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : null,
        congestionLevel: level,
        isPeak: p.isPeak,
        departments: p.items.length,
        sources: [...p.sources],
      };
    });
}
