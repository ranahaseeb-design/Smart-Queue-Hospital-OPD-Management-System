'use strict';
/**
 * Peak-hour and congestion forecasting (FR-17, Section 6.6).
 *
 * POST /admin/forecasts/run first asks the AI service (/ai/jobs/forecast). If it is unavailable,
 * the JS seasonal baseline runs instead:
 *   expected arrivals(dept, hour h of date D) = mean arrivals at the same weekday + hour over the
 *     last 4 weeks of history,
 *   capacity C_h = sum over doctors on duty in h of (minutes on duty in h / avg consult)   (Eq. 6.5)
 *   congestion level from rho = expected / capacity and the configured thresholds,
 *   is_peak = expected > 80th percentile of the department's hourly arrival history.
 * Forecasts are generated hourly for the next 7 days.
 */
const time = require('../utils/time');
const { insertMany } = require('../db');
const fb = require('./featureBuilder');
const ai = require('./aiClient');
const { conflict } = require('../utils/errors');
const settingsService = require('./settingsService');

const HISTORY_WEEKS = 4;
const PEAK_PERCENTILE = 0.8;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

/** Doctor-capacity (patients/hour) of each department for weekday+hour. */
async function loadCapacity(db) {
  const rows = await db.query(
    `SELECT ds.day_of_week, ds.start_time, ds.end_time, d.department_id, d.avg_consult_minutes
       FROM doctor_schedules ds
       JOIN doctors d ON d.doctor_id = ds.doctor_id
       JOIN users u ON u.user_id = d.user_id
       JOIN service_points sp ON sp.service_point_id = ds.service_point_id
      WHERE d.is_active = 1 AND u.is_active = 1 AND sp.is_active = 1`,
    []
  );
  // capacity[deptId][dow][hour] = patients per hour
  const capacity = new Map();
  for (const r of rows) {
    const [sh, sm] = String(r.start_time).split(':').map(Number);
    const [eh, em] = String(r.end_time).split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    const avg = Number(r.avg_consult_minutes) || 10;
    if (!capacity.has(r.department_id)) capacity.set(r.department_id, new Map());
    const byDow = capacity.get(r.department_id);
    if (!byDow.has(r.day_of_week)) byDow.set(r.day_of_week, new Array(24).fill(0));
    const hours = byDow.get(r.day_of_week);
    for (let h = 0; h < 24; h += 1) {
      const overlap = Math.max(0, Math.min(end, (h + 1) * 60) - Math.max(start, h * 60));
      if (overlap > 0) hours[h] += overlap / avg;
    }
  }
  return capacity;
}

/** Run the JS seasonal baseline and replace future forecast rows. Returns rows generated. */
async function runBaselineForecast(db, { now = time.clock.now(), days = 7 } = {}) {
  const settings = await settingsService.getSettings(db);
  const thresholds = settings.congestionThresholds;
  const todayStr = time.formatDate(now);
  const histStartStr = time.addDaysStr(todayStr, -7 * HISTORY_WEEKS);

  const departments = await db.query(
    `SELECT dp.department_id, dp.branch_id FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id
      WHERE dp.is_active = 1 AND b.status = 'ACTIVE'`,
    []
  );
  const arrivals = await db.query(
    `SELECT t.issued_at, d.department_id FROM tokens t JOIN doctors d ON d.doctor_id = t.doctor_id
      WHERE t.queue_type = 'OPD' AND t.issued_at >= ? AND t.issued_at < ?`,
    [`${histStartStr} 00:00:00`, `${todayStr} 00:00:00`]
  );
  // counts[dept]["YYYY-MM-DD|h"] = n ; daysWithData = set of dates seen in history
  const counts = new Map();
  const datesWithData = new Set();
  for (const a of arrivals) {
    const s = String(a.issued_at);
    const date = s.slice(0, 10);
    const hour = Number(s.slice(11, 13));
    datesWithData.add(date);
    if (!counts.has(a.department_id)) counts.set(a.department_id, new Map());
    const m = counts.get(a.department_id);
    const k = `${date}|${hour}`;
    m.set(k, (m.get(k) || 0) + 1);
  }
  const earliest = [...datesWithData].sort()[0] || todayStr;

  // Sample dates per weekday: the most recent HISTORY_WEEKS occurrences before today with data coverage.
  const samplesByDow = new Map();
  for (let i = 1; i <= 7 * HISTORY_WEEKS; i += 1) {
    const d = time.addDaysStr(todayStr, -i);
    if (d < earliest) break;
    const dow = time.isoDow(time.parseDate(d));
    if (!samplesByDow.has(dow)) samplesByDow.set(dow, []);
    samplesByDow.get(dow).push(d);
  }

  const capacity = await loadCapacity(db);
  // Same horizon as the AI job (from today 00:00), so a fallback run replaces all of today's rows
  // instead of leaving earlier AI rows mixed in.
  const start = time.parseDate(todayStr);
  const end = new Date(start.getTime() + days * time.DAY);
  const generatedAt = time.formatDateTime(now);
  const rows = [];

  for (const dept of departments) {
    const m = counts.get(dept.department_id) || new Map();
    const p80 = percentile([...m.values()], PEAK_PERCENTILE);
    for (let t = start.getTime(); t < end.getTime(); t += time.HOUR) {
      const hourDate = new Date(t);
      const dow = time.isoDow(hourDate);
      const h = hourDate.getHours();
      const samples = samplesByDow.get(dow) || [];
      const expected = samples.length
        ? samples.reduce((s, d) => s + (m.get(`${d}|${h}`) || 0), 0) / samples.length
        : 0;
      const capRow = capacity.get(dept.department_id);
      const cap = capRow && capRow.get(dow) ? capRow.get(dow)[h] : 0;
      if (expected <= 0 && cap <= 0) continue;
      const ratio = cap > 0 ? expected / cap : null;
      rows.push([
        dept.branch_id,
        dept.department_id,
        time.formatDateTime(hourDate),
        time.round(expected, 1),
        time.round(cap, 1),
        fb.classifyCongestion(ratio, thresholds),
        expected > p80 && expected > 0 ? 1 : 0,
        'baseline',
        generatedAt,
      ]);
    }
  }

  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM forecasts WHERE forecast_hour >= ?', [time.formatDateTime(start)]);
    await insertMany(
      tx,
      'forecasts',
      ['branch_id', 'department_id', 'forecast_hour', 'expected_arrivals', 'capacity', 'congestion_level', 'is_peak', 'source', 'generated_at'],
      rows
    );
  });
  return rows.length;
}

/** POST /admin/forecasts/run — AI job first, JS seasonal baseline as fallback. */
async function runForecasts(db, { now = time.clock.now(), days = 7, preferAi = true } = {}) {
  if (preferAi) {
    const result = await ai.runForecastJob(days);
    if (result && result.pending) {
      // The AI job is busy or still running and will write its own rows: running the baseline now
      // would race with it on the same forecast hours.
      throw conflict('An AI forecast job is still running; try again in a few minutes');
    }
    if (result) return { generated: Number(result.generated) || 0, source: 'ai' };
  }
  const generated = await runBaselineForecast(db, { now, days });
  return { generated, source: 'baseline' };
}

function toForecast(r) {
  const expected = r.expected_arrivals === null ? null : Number(r.expected_arrivals);
  const capacity = r.capacity === null ? null : Number(r.capacity);
  return {
    id: r.forecast_id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    departmentId: r.department_id,
    departmentName: r.department_name || r.specialty,
    forecastHour: time.toApi(r.forecast_hour),
    expectedArrivals: expected,
    capacity,
    congestionRatio: capacity && capacity > 0 && expected !== null ? time.round(expected / capacity, 2) : null,
    congestionLevel: r.congestion_level,
    isPeak: Boolean(r.is_peak),
    source: r.source,
  };
}

/** GET /admin/forecasts */
async function listForecasts(db, { branchId = null, departmentId = null, date = null, now = time.clock.now() }) {
  const where = [];
  const params = [];
  if (date) {
    where.push('f.forecast_hour >= ? AND f.forecast_hour < ?');
    params.push(`${date} 00:00:00`, `${time.addDaysStr(date, 1)} 00:00:00`);
  } else {
    const todayStr = time.formatDate(now);
    where.push('f.forecast_hour >= ? AND f.forecast_hour < ?');
    params.push(`${todayStr} 00:00:00`, `${time.addDaysStr(todayStr, 7)} 00:00:00`);
  }
  if (branchId) {
    where.push('f.branch_id = ?');
    params.push(branchId);
  }
  if (departmentId) {
    where.push('f.department_id = ?');
    params.push(departmentId);
  }
  const rows = await db.query(
    `SELECT f.*, dp.name AS department_name, dp.specialty, b.name AS branch_name
       FROM forecasts f
       JOIN departments dp ON dp.department_id = f.department_id
       JOIN branches b ON b.branch_id = f.branch_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.forecast_hour, f.branch_id, f.department_id`,
    params
  );
  return rows.map(toForecast);
}

module.exports = { runBaselineForecast, runForecasts, listForecasts, toForecast, percentile, loadCapacity };
