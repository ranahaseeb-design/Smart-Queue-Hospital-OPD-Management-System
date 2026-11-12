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
const { models, sess, byIds, nextIds } = require('../db');
const scheduleService = require('./scheduleService');

const { Department, Branch, Doctor, Token, Forecast } = models;
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
  // Every weekday's schedules of active doctors (active account) in active service points.
  const rows = await scheduleService.activeSchedules(db, null);
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

  const activeBranchIds = await Branch.distinct('_id', { status: 'ACTIVE' }).session(sess(db));
  const departments = (
    await Department.find({ is_active: true, branch_id: { $in: activeBranchIds } }, { branch_id: 1 })
      .sort({ _id: 1 })
      .session(sess(db))
      .lean()
  ).map((d) => ({ department_id: d._id, branch_id: d.branch_id }));
  // Hourly OPD arrivals per doctor over the history window, grouped by the server in hospital
  // local time (aggregation pipeline), then mapped to departments.
  const arrivals = await Token.aggregate([
    {
      $match: {
        queue_type: 'OPD',
        doctor_id: { $ne: null },
        issued_at: { $gte: time.dayStart(histStartStr), $lt: time.dayStart(todayStr) },
      },
    },
    {
      $group: {
        _id: {
          doctor: '$doctor_id',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$issued_at', timezone: time.tzName() } },
          hour: { $hour: { date: '$issued_at', timezone: time.tzName() } },
        },
        n: { $sum: 1 },
      },
    },
  ]).session(sess(db));
  const doctorDept = await byIds(db, Doctor, arrivals.map((a) => a._id.doctor), { department_id: 1 });
  // counts[dept]["YYYY-MM-DD|h"] = n ; daysWithData = set of dates seen in history
  const counts = new Map();
  const datesWithData = new Set();
  for (const a of arrivals) {
    const d = doctorDept.get(a._id.doctor);
    if (!d) continue;
    const { date, hour } = a._id;
    datesWithData.add(date);
    if (!counts.has(d.department_id)) counts.set(d.department_id, new Map());
    const m = counts.get(d.department_id);
    const k = `${date}|${hour}`;
    m.set(k, (m.get(k) || 0) + a.n);
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
  const generatedAt = time.dbDate(now);
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
      rows.push({
        branch_id: dept.branch_id,
        department_id: dept.department_id,
        forecast_hour: hourDate,
        expected_arrivals: time.round(expected, 1),
        capacity: time.round(cap, 1),
        congestion_level: fb.classifyCongestion(ratio, thresholds),
        is_peak: expected > p80 && expected > 0,
        source: 'baseline',
        generated_at: generatedAt,
      });
    }
  }

  // Ids first (outside the transaction), then replace the horizon atomically.
  const ids = await nextIds('forecasts', rows.length);
  await db.transaction(async (tx) => {
    await Forecast.deleteMany({ forecast_hour: { $gte: start } }, { session: sess(tx) });
    for (let i = 0; i < rows.length; i += 1000) {
      await Forecast.insertMany(
        rows.slice(i, i + 1000).map((r, k) => ({ ...r, _id: ids[i + k] })),
        { session: sess(tx), ordered: true }
      );
    }
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
/**
 * Forecast rows matching `filter`, joined with department (name, specialty, is_active) and branch
 * name (inner-join semantics), sorted by `sort`.
 */
async function forecastRows(db, filter, sort, { activeDepartmentsOnly = false } = {}) {
  const docs = await Forecast.find(filter).sort(sort).session(sess(db)).lean();
  const depts = await byIds(db, Department, docs.map((f) => f.department_id));
  const branches = await byIds(db, Branch, docs.map((f) => f.branch_id), { name: 1 });
  const out = [];
  for (const f of docs) {
    const dp = depts.get(f.department_id);
    const b = branches.get(f.branch_id);
    if (!dp || !b || (activeDepartmentsOnly && !dp.is_active)) continue;
    out.push({ ...f, forecast_id: f._id, department_name: dp.name, specialty: dp.specialty, branch_name: b.name });
  }
  return out;
}

/** GET /admin/forecasts */
async function listForecasts(db, { branchId = null, departmentId = null, date = null, now = time.clock.now() }) {
  const filter = {};
  if (date) {
    filter.forecast_hour = time.dayRange(date);
  } else {
    const todayStr = time.formatDate(now);
    filter.forecast_hour = { $gte: time.dayStart(todayStr), $lt: time.dayStart(time.addDaysStr(todayStr, 7)) };
  }
  if (branchId) filter.branch_id = branchId;
  if (departmentId) filter.department_id = departmentId;
  const rows = await forecastRows(db, filter, { forecast_hour: 1, branch_id: 1, department_id: 1 });
  return rows.map(toForecast);
}

module.exports = { runBaselineForecast, runForecasts, listForecasts, forecastRows, toForecast, percentile, loadCapacity };
