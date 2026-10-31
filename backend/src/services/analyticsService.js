'use strict';
/**
 * Analytics & Reporting Service: live dashboard KPIs (FR-15), congestion alerts (FR-17),
 * reports with CSV export (FR-16), workload analysis and resource-allocation
 * recommendations (FR-18) and the feedback summary (FR-20).
 * Aggregation happens in JS so the SQL stays portable between MySQL and SQLite.
 */
const config = require('../config');
const time = require('../utils/time');
const { badRequest } = require('../utils/errors');
const fb = require('./featureBuilder');
const scheduleService = require('./scheduleService');
const settingsService = require('./settingsService');

const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
const r1 = (v) => (v === null || v === undefined ? null : time.round(v, 1));

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const minutes = (a, b) => time.minutesBetween(time.parseDateTime(a), time.parseDateTime(b));

/** Load master data in scope: branches, departments, doctors, service points. */
async function loadScope(db, branchId) {
  const bWhere = branchId ? 'WHERE b.branch_id = ?' : '';
  const bParams = branchId ? [branchId] : [];
  const branches = await db.query(`SELECT b.* FROM branches b ${bWhere} ORDER BY b.branch_id`, bParams);
  const departments = await db.query(
    `SELECT dp.*, b.name AS branch_name FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id
      ${branchId ? 'WHERE dp.branch_id = ?' : ''} ORDER BY dp.branch_id, dp.department_id`,
    bParams
  );
  const servicePoints = await db.query(
    `SELECT sp.*, b.name AS branch_name FROM service_points sp JOIN branches b ON b.branch_id = sp.branch_id
      ${branchId ? 'WHERE sp.branch_id = ?' : ''} ORDER BY sp.branch_id, sp.type, sp.service_point_id`,
    bParams
  );
  return { branches, departments, servicePoints };
}

/** Today's sessions of active doctors in scope: Map deptId -> sessions. */
async function todaysSessions(db, dateStr, branchId) {
  const dow = time.isoDow(time.parseDate(dateStr));
  const rows = await db.query(
    `SELECT ds.*, d.department_id, d.avg_consult_minutes FROM doctor_schedules ds
       JOIN doctors d ON d.doctor_id = ds.doctor_id
       JOIN users u ON u.user_id = d.user_id
       JOIN departments dp ON dp.department_id = d.department_id
       JOIN service_points sp ON sp.service_point_id = ds.service_point_id
      WHERE ds.day_of_week = ? AND d.is_active = 1 AND u.is_active = 1 AND sp.is_active = 1 AND dp.is_active = 1
        ${branchId ? 'AND dp.branch_id = ?' : ''}`,
    branchId ? [dow, branchId] : [dow]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.department_id)) map.set(r.department_id, []);
    map.get(r.department_id).push(scheduleService.toSession(r, dateStr));
  }
  return map;
}

function onDutyDoctors(sessions, now) {
  const ids = new Set();
  for (const s of sessions) {
    if (config.demoAlwaysOpen || (s.start <= now && now < s.end)) ids.add(s.doctorId);
  }
  return ids;
}

/** GET /admin/dashboard (FR-15) */
async function dashboard(db, branchId, now = time.clock.now()) {
  const settings = await settingsService.getSettings(db);
  const date = time.formatDate(now);
  const { branches, departments, servicePoints } = await loadScope(db, branchId);
  const tokens = await db.query(
    `SELECT t.token_id, t.status, t.queue_type, t.token_number, t.issued_at, t.called_at, t.service_point_id,
            t.doctor_id, d.department_id, v.branch_id
       FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
       LEFT JOIN doctors d ON d.doctor_id = t.doctor_id
      WHERE t.token_date = ? ${branchId ? 'AND v.branch_id = ?' : ''}`,
    branchId ? [date, branchId] : [date]
  );
  const sessionsByDept = await todaysSessions(db, date, branchId);
  const waitOf = (t) => Math.max(0, time.minutesBetween(time.parseDateTime(t.issued_at), now));

  const waiting = tokens.filter((t) => t.status === 'WAITING');
  const waits = waiting.map(waitOf);
  const allOnDuty = new Set();
  for (const sessions of sessionsByDept.values()) onDutyDoctors(sessions, now).forEach((id) => allOnDuty.add(id));

  const deptRows = departments
    .filter((d) => d.is_active)
    .map((d) => {
      const dWaiting = waiting.filter((t) => t.department_id === d.department_id && t.queue_type === 'OPD');
      const dWaits = dWaiting.map(waitOf);
      const sessions = sessionsByDept.get(d.department_id) || [];
      const c = fb.liveCongestion({
        waiting: dWaiting.length,
        sessions,
        now,
        demoAlwaysOpen: config.demoAlwaysOpen,
        thresholds: settings.congestionThresholds,
      });
      return {
        departmentId: d.department_id,
        branchId: d.branch_id,
        branchName: d.branch_name,
        name: d.name || d.specialty,
        specialty: d.specialty,
        waiting: dWaiting.length,
        activeDoctors: onDutyDoctors(sessions, now).size,
        avgWaitMinutes: r1(mean(dWaits)),
        maxWaitMinutes: dWaits.length ? r1(Math.max(...dWaits)) : null,
        congestionRatio: c.ratio,
        congestionLevel: c.level,
        _capacity: c.capacity,
      };
    });

  const branchRows = branches.map((b) => {
    const bWaiting = waiting.filter((t) => t.branch_id === b.branch_id);
    const bDepts = deptRows.filter((d) => d.branchId === b.branch_id);
    const opdWaiting = bDepts.reduce((s, d) => s + d.waiting, 0);
    const capacity = bDepts.reduce((s, d) => s + d._capacity, 0);
    const ratio = capacity > 0 ? opdWaiting / capacity : opdWaiting > 0 ? 99 : 0;
    return {
      branchId: b.branch_id,
      name: b.name,
      status: b.status,
      waiting: bWaiting.length,
      avgWaitMinutes: r1(mean(bWaiting.map(waitOf))),
      congestionLevel: fb.classifyCongestion(ratio, settings.congestionThresholds),
    };
  });

  const spRows = servicePoints
    .filter((sp) => sp.is_active)
    .map((sp) => {
      const spTokens = tokens.filter((t) => t.service_point_id === sp.service_point_id);
      const serving = spTokens
        .filter((t) => t.status === 'CALLED' || t.status === 'IN_SERVICE')
        .sort((a, b) => String(b.called_at).localeCompare(String(a.called_at)))[0];
      return {
        id: sp.service_point_id,
        name: sp.name,
        type: sp.type,
        branchId: sp.branch_id,
        branchName: sp.branch_name,
        waiting: spTokens.filter((t) => t.status === 'WAITING').length,
        nowServing: serving
          ? { tokenId: serving.token_id, displayNumber: fb.displayNumber(serving.queue_type, serving.token_number) }
          : null,
      };
    });

  // Active service points: OPD rooms with a doctor on duty now + active LAB/PHARMACY counters.
  const roomsOnDuty = new Set();
  for (const sessions of sessionsByDept.values()) {
    for (const s of sessions) {
      if (config.demoAlwaysOpen || (s.start <= now && now < s.end)) roomsOnDuty.add(s.servicePointId);
    }
  }
  const activeServicePoints = spRows.filter((sp) => sp.type !== 'OPD' || roomsOnDuty.has(sp.id)).length;

  return {
    kpis: {
      waiting: waiting.length,
      inService: tokens.filter((t) => t.status === 'CALLED' || t.status === 'IN_SERVICE').length,
      completedToday: tokens.filter((t) => t.status === 'COMPLETED').length,
      avgWaitMinutes: r1(mean(waits)),
      maxWaitMinutes: waits.length ? r1(Math.max(...waits)) : null,
      activeDoctors: allOnDuty.size,
      activeServicePoints,
    },
    branches: branchRows,
    departments: deptRows.map(({ _capacity, ...rest }) => rest),
    servicePoints: spRows,
  };
}

/** GET /admin/alerts (FR-17): live congestion + upcoming HIGH/CRITICAL forecasts (next 24 h). */
async function alerts(db, branchId, now = time.clock.now()) {
  const dash = await dashboard(db, branchId, now);
  const out = [];
  for (const d of dash.departments) {
    if (d.congestionLevel === 'NORMAL') continue;
    out.push({
      id: `live-${d.departmentId}`,
      level: d.congestionLevel,
      source: 'LIVE',
      branchId: d.branchId,
      branchName: d.branchName,
      departmentId: d.departmentId,
      departmentName: d.name,
      message: `${d.name} at ${d.branchName} is ${d.congestionLevel}: ${d.waiting} waiting, congestion ratio ${d.congestionRatio} (longest wait ${
        d.maxWaitMinutes === null ? 0 : Math.round(d.maxWaitMinutes)
      } min).`,
      at: time.toApi(now),
    });
  }
  const from = time.formatDateTime(time.startOfHour(now));
  const to = time.formatDateTime(new Date(now.getTime() + time.DAY));
  const rows = await db.query(
    `SELECT f.*, dp.name AS department_name, dp.specialty, b.name AS branch_name
       FROM forecasts f JOIN departments dp ON dp.department_id = f.department_id
       JOIN branches b ON b.branch_id = f.branch_id
      WHERE f.forecast_hour >= ? AND f.forecast_hour < ? AND f.congestion_level IN ('HIGH', 'CRITICAL')
        AND dp.is_active = 1 ${branchId ? 'AND f.branch_id = ?' : ''}
      ORDER BY f.forecast_hour`,
    branchId ? [from, to, branchId] : [from, to]
  );
  for (const f of rows) {
    const at = time.parseDateTime(f.forecast_hour);
    const name = f.department_name || f.specialty;
    out.push({
      id: `forecast-${f.forecast_id}`,
      level: f.congestion_level,
      source: 'FORECAST',
      branchId: f.branch_id,
      branchName: f.branch_name,
      departmentId: f.department_id,
      departmentName: name,
      message: `${name} at ${f.branch_name}: forecast ${Number(f.expected_arrivals)} arrivals vs capacity ${Number(
        f.capacity
      )} on ${time.dayName(at)} ${time.formatTime(at)}-${time.formatTime(new Date(at.getTime() + time.HOUR))}${
        f.is_peak ? ' (peak hour)' : ''
      }.`,
      at: time.toApi(f.forecast_hour),
    });
  }
  const rank = { CRITICAL: 0, HIGH: 1 };
  out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'LIVE' ? -1 : 1) || rank[a.level] - rank[b.level] || a.at.localeCompare(b.at));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reports (FR-16)
// ---------------------------------------------------------------------------------------------

const REPORT_TYPES = ['doctor-consult', 'department-traffic', 'branch-utilization', 'waiting-times', 'feedback'];

function resolveRange(from, to, now) {
  const toStr = to || time.formatDate(now);
  const fromStr = from || time.addDaysStr(toStr, -29);
  if (fromStr > toStr) throw badRequest('from must not be after to');
  return { from: fromStr, to: toStr, endExclusive: time.addDaysStr(toStr, 1) };
}

function daysInRange(range) {
  let n = 0;
  for (let d = range.from; d <= range.to; d = time.addDaysStr(d, 1)) n += 1;
  return n;
}

/** Scheduled doctor-minutes per department over a date range. */
async function scheduledMinutes(db, range, branchId) {
  const rows = await db.query(
    `SELECT ds.day_of_week, ds.start_time, ds.end_time, d.department_id, dp.branch_id
       FROM doctor_schedules ds JOIN doctors d ON d.doctor_id = ds.doctor_id
       JOIN departments dp ON dp.department_id = d.department_id
      WHERE d.is_active = 1 ${branchId ? 'AND dp.branch_id = ?' : ''}`,
    branchId ? [branchId] : []
  );
  const dowCount = new Map();
  for (let d = range.from; d <= range.to; d = time.addDaysStr(d, 1)) {
    const dow = time.isoDow(time.parseDate(d));
    dowCount.set(dow, (dowCount.get(dow) || 0) + 1);
  }
  const byDept = new Map();
  const byBranch = new Map();
  for (const r of rows) {
    const [sh, sm] = String(r.start_time).split(':').map(Number);
    const [eh, em] = String(r.end_time).split(':').map(Number);
    const mins = Math.max(0, eh * 60 + em - (sh * 60 + sm)) * (dowCount.get(r.day_of_week) || 0);
    byDept.set(r.department_id, (byDept.get(r.department_id) || 0) + mins);
    byBranch.set(r.branch_id, (byBranch.get(r.branch_id) || 0) + mins);
  }
  return { byDept, byBranch };
}

async function opdTokensInRange(db, range, branchId) {
  return db.query(
    `SELECT t.token_id, t.status, t.queue_type, t.issued_at, t.called_at, t.completed_at, t.doctor_id, t.token_date,
            d.department_id, v.branch_id
       FROM tokens t JOIN visits v ON v.visit_id = t.visit_id
       LEFT JOIN doctors d ON d.doctor_id = t.doctor_id
      WHERE t.token_date >= ? AND t.token_date <= ? ${branchId ? 'AND v.branch_id = ?' : ''}`,
    branchId ? [range.from, range.to, branchId] : [range.from, range.to]
  );
}

async function report(db, { type, from, to, branchId }, now = time.clock.now()) {
  if (!REPORT_TYPES.includes(type)) throw badRequest(`type must be one of ${REPORT_TYPES.join(', ')}`);
  const range = resolveRange(from, to, now);
  const scope = await loadScope(db, branchId);
  const period = `${range.from} to ${range.to}`;

  if (type === 'feedback') {
    const rows = await db.query(
      `SELECT f.rating, v.branch_id FROM feedback f JOIN visits v ON v.visit_id = f.visit_id
        WHERE v.visit_date >= ? AND v.visit_date <= ? ${branchId ? 'AND v.branch_id = ?' : ''}`,
      branchId ? [range.from, range.to, branchId] : [range.from, range.to]
    );
    return {
      type,
      title: `Patient feedback by branch (${period})`,
      columns: [
        { key: 'branchName', label: 'Branch' },
        { key: 'responses', label: 'Responses' },
        { key: 'averageRating', label: 'Average rating' },
        { key: 'rating5', label: '5 stars' },
        { key: 'rating4', label: '4 stars' },
        { key: 'rating3', label: '3 stars' },
        { key: 'rating2', label: '2 stars' },
        { key: 'rating1', label: '1 star' },
      ],
      rows: scope.branches.map((b) => {
        const ratings = rows.filter((r) => r.branch_id === b.branch_id).map((r) => Number(r.rating));
        const row = {
          branchId: b.branch_id,
          branchName: b.name,
          responses: ratings.length,
          averageRating: ratings.length ? time.round(mean(ratings), 2) : null,
        };
        for (let s = 1; s <= 5; s += 1) row[`rating${s}`] = ratings.filter((r) => r === s).length;
        return row;
      }),
    };
  }

  const tokens = await opdTokensInRange(db, range, branchId);
  const opd = tokens.filter((t) => t.queue_type === 'OPD');

  if (type === 'doctor-consult') {
    const doctors = await db.query(
      `SELECT d.doctor_id, d.avg_consult_minutes, u.full_name, dp.name AS department_name, dp.specialty, b.name AS branch_name, dp.branch_id
         FROM doctors d JOIN users u ON u.user_id = d.user_id JOIN departments dp ON dp.department_id = d.department_id
         JOIN branches b ON b.branch_id = dp.branch_id ${branchId ? 'WHERE dp.branch_id = ?' : ''}
        ORDER BY dp.branch_id, dp.department_id, d.doctor_id`,
      branchId ? [branchId] : []
    );
    return {
      type,
      title: `Average consultation time per doctor (${period})`,
      columns: [
        { key: 'doctorName', label: 'Doctor' },
        { key: 'specialty', label: 'Specialty' },
        { key: 'branchName', label: 'Branch' },
        { key: 'consultations', label: 'Consultations' },
        { key: 'avgConsultMinutes', label: 'Avg consult (min)' },
        { key: 'minConsultMinutes', label: 'Min (min)' },
        { key: 'maxConsultMinutes', label: 'Max (min)' },
        { key: 'rollingAvgMinutes', label: 'Rolling avg used for prediction (min)' },
      ],
      rows: doctors.map((d) => {
        const consults = opd
          .filter((t) => t.doctor_id === d.doctor_id && t.status === 'COMPLETED' && t.called_at && t.completed_at)
          .map((t) => minutes(t.called_at, t.completed_at));
        return {
          doctorId: d.doctor_id,
          doctorName: d.full_name,
          specialty: d.specialty,
          departmentName: d.department_name,
          branchName: d.branch_name,
          consultations: consults.length,
          avgConsultMinutes: r1(mean(consults)),
          minConsultMinutes: consults.length ? r1(Math.min(...consults)) : null,
          maxConsultMinutes: consults.length ? r1(Math.max(...consults)) : null,
          rollingAvgMinutes: time.round(Number(d.avg_consult_minutes), 2),
        };
      }),
    };
  }

  if (type === 'department-traffic') {
    const days = daysInRange(range);
    return {
      type,
      title: `Patient traffic per department (${period})`,
      columns: [
        { key: 'branchName', label: 'Branch' },
        { key: 'departmentName', label: 'Department' },
        { key: 'specialty', label: 'Specialty' },
        { key: 'tokensIssued', label: 'Tokens issued' },
        { key: 'completed', label: 'Completed' },
        { key: 'cancelled', label: 'Cancelled' },
        { key: 'noShow', label: 'No-show' },
        { key: 'avgPerDay', label: 'Avg per day' },
        { key: 'peakHour', label: 'Busiest hour' },
      ],
      rows: scope.departments.map((d) => {
        const dt = opd.filter((t) => t.department_id === d.department_id && t.status !== 'TRANSFERRED');
        const byHour = new Array(24).fill(0);
        dt.forEach((t) => {
          byHour[Number(String(t.issued_at).slice(11, 13))] += 1;
        });
        const peak = dt.length ? byHour.indexOf(Math.max(...byHour)) : null;
        return {
          departmentId: d.department_id,
          branchName: d.branch_name,
          departmentName: d.name || d.specialty,
          specialty: d.specialty,
          tokensIssued: dt.length,
          completed: dt.filter((t) => t.status === 'COMPLETED').length,
          cancelled: dt.filter((t) => t.status === 'CANCELLED').length,
          noShow: dt.filter((t) => t.status === 'NO_SHOW').length,
          avgPerDay: time.round(dt.length / days, 1),
          peakHour: peak === null ? null : `${String(peak).padStart(2, '0')}:00`,
        };
      }),
    };
  }

  if (type === 'branch-utilization') {
    const sched = await scheduledMinutes(db, range, branchId);
    return {
      type,
      title: `Branch-wise OPD utilization (${period})`,
      columns: [
        { key: 'branchName', label: 'Branch' },
        { key: 'opdTokens', label: 'OPD tokens' },
        { key: 'completedConsultations', label: 'Completed consultations' },
        { key: 'labTokens', label: 'Lab tokens' },
        { key: 'pharmacyTokens', label: 'Pharmacy tokens' },
        { key: 'scheduledDoctorHours', label: 'Scheduled doctor-hours' },
        { key: 'consultHours', label: 'Consultation hours' },
        { key: 'utilizationPercent', label: 'Utilization (%)' },
        { key: 'patientsPerDoctorHour', label: 'Patients per doctor-hour' },
      ],
      rows: scope.branches.map((b) => {
        const bt = tokens.filter((t) => t.branch_id === b.branch_id);
        const completed = bt.filter((t) => t.queue_type === 'OPD' && t.status === 'COMPLETED' && t.called_at && t.completed_at);
        const consultMin = completed.reduce((s, t) => s + minutes(t.called_at, t.completed_at), 0);
        const schedMin = sched.byBranch.get(b.branch_id) || 0;
        return {
          branchId: b.branch_id,
          branchName: b.name,
          opdTokens: bt.filter((t) => t.queue_type === 'OPD' && t.status !== 'TRANSFERRED').length,
          completedConsultations: completed.length,
          labTokens: bt.filter((t) => t.queue_type === 'LAB').length,
          pharmacyTokens: bt.filter((t) => t.queue_type === 'PHARMACY').length,
          scheduledDoctorHours: time.round(schedMin / 60, 1),
          consultHours: time.round(consultMin / 60, 1),
          utilizationPercent: schedMin > 0 ? time.round((consultMin / schedMin) * 100, 1) : null,
          patientsPerDoctorHour: schedMin > 0 ? time.round(completed.length / (schedMin / 60), 2) : null,
        };
      }),
    };
  }

  // waiting-times: actual wait (called - issued) and accuracy of the first prediction per token.
  const called = opd.filter((t) => t.called_at);
  const preds = await db.query(
    `SELECT wp.token_id, wp.predicted_minutes, wp.prediction_id FROM wait_predictions wp
       JOIN tokens t ON t.token_id = wp.token_id JOIN visits v ON v.visit_id = t.visit_id
      WHERE t.token_date >= ? AND t.token_date <= ? AND t.queue_type = 'OPD' AND t.called_at IS NOT NULL
        ${branchId ? 'AND v.branch_id = ?' : ''}`,
    branchId ? [range.from, range.to, branchId] : [range.from, range.to]
  );
  const firstPred = new Map();
  for (const p of preds) {
    const cur = firstPred.get(p.token_id);
    if (!cur || p.prediction_id < cur.prediction_id) firstPred.set(p.token_id, p);
  }
  return {
    type,
    title: `Waiting times per department (${period})`,
    columns: [
      { key: 'branchName', label: 'Branch' },
      { key: 'departmentName', label: 'Department' },
      { key: 'patientsCalled', label: 'Patients called' },
      { key: 'avgWaitMinutes', label: 'Avg wait (min)' },
      { key: 'medianWaitMinutes', label: 'Median wait (min)' },
      { key: 'p90WaitMinutes', label: '90th percentile (min)' },
      { key: 'maxWaitMinutes', label: 'Max wait (min)' },
      { key: 'avgPredictedMinutes', label: 'Avg first prediction (min)' },
      { key: 'predictionMaeMinutes', label: 'Prediction MAE (min)' },
    ],
    rows: scope.departments.map((d) => {
      const dt = called.filter((t) => t.department_id === d.department_id);
      const waits = dt.map((t) => minutes(t.issued_at, t.called_at));
      const withPred = dt.filter((t) => firstPred.has(t.token_id));
      const predicted = withPred.map((t) => Number(firstPred.get(t.token_id).predicted_minutes));
      const errors = withPred.map((t) => Math.abs(Number(firstPred.get(t.token_id).predicted_minutes) - minutes(t.issued_at, t.called_at)));
      return {
        departmentId: d.department_id,
        branchName: d.branch_name,
        departmentName: d.name || d.specialty,
        patientsCalled: dt.length,
        avgWaitMinutes: r1(mean(waits)),
        medianWaitMinutes: r1(quantile(waits, 0.5)),
        p90WaitMinutes: r1(quantile(waits, 0.9)),
        maxWaitMinutes: waits.length ? r1(Math.max(...waits)) : null,
        avgPredictedMinutes: r1(mean(predicted)),
        predictionMaeMinutes: r1(mean(errors)),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Workload & resource allocation (FR-18)
// ---------------------------------------------------------------------------------------------

async function workloadAndRecommendations(db, branchId, now = time.clock.now()) {
  const todayStr = time.formatDate(now);
  const range = { from: time.addDaysStr(todayStr, -7), to: time.addDaysStr(todayStr, -1) };
  const scope = await loadScope(db, branchId);
  const tokens = (await opdTokensInRange(db, range, branchId)).filter((t) => t.queue_type === 'OPD');
  const sched = await scheduledMinutes(db, range, branchId);

  const workload = scope.branches.map((b) => {
    const bt = tokens.filter((t) => t.branch_id === b.branch_id);
    const completed = bt.filter((t) => t.status === 'COMPLETED' && t.called_at && t.completed_at);
    const consultMin = completed.reduce((s, t) => s + minutes(t.called_at, t.completed_at), 0);
    const schedMin = sched.byBranch.get(b.branch_id) || 0;
    const waits = bt.filter((t) => t.called_at).map((t) => minutes(t.issued_at, t.called_at));
    return {
      branchId: b.branch_id,
      branchName: b.name,
      patientsPerDoctorHour: schedMin > 0 ? time.round(completed.length / (schedMin / 60), 2) : null,
      utilization: schedMin > 0 ? time.round(consultMin / schedMin, 2) : null,
      avgWaitMinutes: r1(mean(waits)),
    };
  });

  // Forecast peaks where expected arrivals exceed scheduled capacity (next 7 days).
  const from = time.formatDateTime(time.startOfHour(now));
  const to = time.formatDateTime(new Date(now.getTime() + 7 * time.DAY));
  const fc = await db.query(
    `SELECT f.*, dp.name AS department_name, dp.specialty, b.name AS branch_name
       FROM forecasts f JOIN departments dp ON dp.department_id = f.department_id
       JOIN branches b ON b.branch_id = f.branch_id
      WHERE f.forecast_hour >= ? AND f.forecast_hour < ? AND dp.is_active = 1 ${branchId ? 'AND f.branch_id = ?' : ''}
      ORDER BY f.department_id, f.forecast_hour`,
    branchId ? [from, to, branchId] : [from, to]
  );
  const avgByDept = new Map();
  const docs = await db.query(
    'SELECT department_id, avg_consult_minutes FROM doctors WHERE is_active = 1',
    []
  );
  for (const d of docs) {
    if (!avgByDept.has(d.department_id)) avgByDept.set(d.department_id, []);
    avgByDept.get(d.department_id).push(Number(d.avg_consult_minutes));
  }

  const recommendations = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    const avg = mean(avgByDept.get(group.departmentId) || []) || 10;
    const hours = group.hours.length;
    const shortfallPatients = group.hours.reduce((s, h) => s + h.shortfall, 0);
    const extraDoctorCapacity = hours * (60 / avg);
    const sessions = Math.max(1, Math.ceil(shortfallPatients / extraDoctorCapacity - 0.15));
    const startD = group.hours[0].at;
    const endD = new Date(group.hours[hours - 1].at.getTime() + time.HOUR);
    const timeRange = `${time.formatTime(startD)}-${time.formatTime(endD)}`;
    recommendations.push({
      branchId: group.branchId,
      branchName: group.branchName,
      departmentId: group.departmentId,
      departmentName: group.departmentName,
      date: time.formatDate(startD),
      timeRange,
      shortfallSessions: sessions,
      shortfallPatients: time.round(shortfallPatients, 1),
      message: `${group.departmentName}, ${group.branchName}, ${time.dayName(startD)} ${timeRange}: forecast exceeds capacity by about ${
        sessions === 1 ? 'one doctor session' : `${sessions} doctor sessions`
      } (~${Math.round(shortfallPatients)} patients); consider adding a session or opening an additional consultation room.`,
    });
    group = null;
  };
  for (const f of fc) {
    const expected = Number(f.expected_arrivals) || 0;
    const capacity = Number(f.capacity) || 0;
    const shortfall = expected - capacity;
    const at = time.parseDateTime(f.forecast_hour);
    if (shortfall > 0 && f.congestion_level === 'CRITICAL') {
      const contiguous =
        group &&
        group.departmentId === f.department_id &&
        at.getTime() - group.hours[group.hours.length - 1].at.getTime() === time.HOUR;
      if (!contiguous) {
        flush();
        group = {
          branchId: f.branch_id,
          branchName: f.branch_name,
          departmentId: f.department_id,
          departmentName: f.department_name || f.specialty,
          hours: [],
        };
      }
      group.hours.push({ at, shortfall });
    } else if (group && group.departmentId === f.department_id) {
      flush();
    }
  }
  flush();
  recommendations.sort((a, b) => a.date.localeCompare(b.date) || a.timeRange.localeCompare(b.timeRange));
  return { workload, recommendations };
}

// ---------------------------------------------------------------------------------------------
// Feedback (FR-20)
// ---------------------------------------------------------------------------------------------

async function feedbackSummary(db, branchId, { limit = 200 } = {}) {
  const where = branchId ? 'WHERE v.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  const dist = await db.query(
    `SELECT f.rating, COUNT(*) AS n FROM feedback f JOIN visits v ON v.visit_id = f.visit_id ${where} GROUP BY f.rating`,
    params
  );
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const d of dist) {
    const n = Number(d.n);
    distribution[d.rating] = n;
    count += n;
    sum += n * Number(d.rating);
  }
  const items = await db.query(
    `SELECT f.feedback_id, f.rating, f.comment, f.created_at, u.full_name, b.name AS branch_name, v.visit_date
       FROM feedback f JOIN visits v ON v.visit_id = f.visit_id
       JOIN users u ON u.user_id = v.patient_id JOIN branches b ON b.branch_id = v.branch_id
      ${where} ORDER BY f.created_at DESC, f.feedback_id DESC LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 200))}`,
    params
  );
  return {
    summary: {
      count,
      average: count ? time.round(sum / count, 2) : null,
      distribution: {
        1: distribution[1],
        2: distribution[2],
        3: distribution[3],
        4: distribution[4],
        5: distribution[5],
      },
    },
    items: items.map((i) => ({
      id: i.feedback_id,
      rating: Number(i.rating),
      comment: i.comment,
      createdAt: time.toApi(i.created_at),
      patientName: i.full_name,
      branchName: i.branch_name,
      visitDate: time.toApiDate(i.visit_date),
    })),
  };
}

module.exports = { dashboard, alerts, report, REPORT_TYPES, workloadAndRecommendations, feedbackSummary, quantile };
