'use strict';
/**
 * Admin module (FR-14 .. FR-18, FR-20, FR-22). Mounted at /api/admin behind authenticate +
 * requireRole('BRANCH_ADMIN', 'HOSPITAL_ADMIN'). BRANCH_ADMIN is scoped to their own branch
 * (403 for any other branch); HOSPITAL_ADMIN sees everything with an optional ?branchId= filter.
 */
const { createRouter, badRequest, forbidden } = require('../utils/errors');
const { getDb, models, sess } = require('../db');
const v = require('../utils/validate');
const { toCsv } = require('../utils/csv');
const admin = require('../services/adminService');
const analyticsService = require('../services/analyticsService');
const forecastService = require('../services/forecastService');
const settingsService = require('../services/settingsService');
const ai = require('../services/aiClient');
const operationsService = require('../services/operationsService');
const time = require('../utils/time');

const router = createRouter();

// ---- Master data and accounts CRUD (FR-14) ----
function crud(path, resource, { update = true } = {}) {
  router.get(`/${path}`, async (req, res) => {
    res.json(await resource.list(getDb(), req.user, req.query));
  });
  router.get(`/${path}/:id`, async (req, res) => {
    res.json(await resource.get(getDb(), req.user, v.id(req.params.id)));
  });
  router.post(`/${path}`, async (req, res) => {
    res.status(201).json(await resource.create(getDb(), req.user, req.body));
  });
  if (update) {
    router.put(`/${path}/:id`, async (req, res) => {
      res.json(await resource.update(getDb(), req.user, v.id(req.params.id), req.body));
    });
  }
  router.delete(`/${path}/:id`, async (req, res) => {
    res.json(await resource.remove(getDb(), req.user, v.id(req.params.id)));
  });
}

crud('branches', admin.branches);
crud('departments', admin.departments);
crud('doctors', admin.doctors);
crud('schedules', admin.schedules);
crud('service-points', admin.servicePoints);
crud('users', admin.users);
crud('assignments', admin.assignments, { update: false });

// ---- Live monitoring (FR-15) and alerts (FR-17) ----
router.get('/dashboard', async (req, res) => {
  res.json(await analyticsService.dashboard(getDb(), admin.listScope(req.user, req.query)));
});

router.get('/alerts', async (req, res) => {
  res.json(await analyticsService.alerts(getDb(), admin.listScope(req.user, req.query)));
});

// ---- Reports with CSV export (FR-16) ----
router.get('/reports', async (req, res) => {
  const type = v.str(req.query.type, 'type', { required: true, max: 40 });
  if (!analyticsService.REPORT_TYPES.includes(type)) {
    throw badRequest(`type must be one of ${analyticsService.REPORT_TYPES.join(', ')}`);
  }
  const from = v.date(req.query.from, 'from');
  const to = v.date(req.query.to, 'to');
  const format = (v.oneOf(req.query.format, 'format', ['JSON', 'CSV']) || 'JSON').toLowerCase();
  const branchId = admin.listScope(req.user, req.query);
  const report = await analyticsService.report(getDb(), { type, from, to, branchId });
  if (format === 'csv') {
    const period = report.title.match(/\((\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\)/);
    const suffix = period ? `_${period[1]}_${period[2]}` : '';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${type}${suffix}.csv"`);
    res.send(toCsv(report.columns, report.rows));
    return;
  }
  res.json(report);
});

// ---- Haversine cross-branch load balancer (FR-08/09, FR-15, FR-18) ----
router.get('/load-balancer', async (req, res) => {
  res.json(await operationsService.loadBalancer(getDb(), req.user));
});

// ---- Forecast / model status banner (FR-17, FR-22) ----
// Which engine produced the current forecasts (ai = Random Forest in the AI service, baseline =
// seasonal average) and the active waiting-time model's training size and validation MAE.
router.get('/forecast-status', async (req, res) => {
  const db = getDb();
  const since = time.startOfDay(time.clock.now());
  const rows = await models.Forecast.aggregate([
    { $match: { forecast_hour: { $gte: since } } },
    { $group: { _id: '$source', rows: { $sum: 1 }, generatedAt: { $max: '$generated_at' } } },
  ]);
  const latest = rows.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))[0] || null;
  const lastRunDoc = await models.Setting.findById('lastForecastRun').lean();
  const lastRun = lastRunDoc ? lastRunDoc.value : null;
  let waitModel = null;
  let aiAvailable = true;
  try {
    const versions = await ai.listModels();
    const active = (versions || []).find((m) => m.isActive);
    if (active) {
      waitModel = {
        version: active.version,
        trainedAt: active.trainedAt,
        trainingRows: active.trainingRows,
        testRows: active.metrics ? active.metrics.testRows : null,
        maeMinutes: active.metrics ? active.metrics.mae : null,
        baselineMaeMinutes: active.metrics ? active.metrics.baselineMae : null,
        r2: active.metrics ? active.metrics.r2 : null,
      };
    }
  } catch {
    aiAvailable = false;
  }
  res.json({
    aiAvailable,
    forecast: latest
      ? {
        source: latest._id,
        engine: forecastService.ENGINE_LABELS[latest._id] || latest._id,
        isRandomForest: latest._id === 'rf-forecast',
        rows: latest.rows,
        generatedAt: time.toApi(latest.generatedAt),
        // Backtest of the run that wrote these rows (Section 6.7.2): RF vs seasonal baseline MAE.
        evaluation: lastRun && lastRun.engine === latest._id ? lastRun.evaluation : null,
      }
      : null,
    waitModel,
  });
});

// ---- Congestion / peak-hour forecasts (FR-17) ----
router.get('/forecasts', async (req, res) => {
  const db = getDb();
  const branchId = admin.listScope(req.user, req.query);
  const departmentId = v.int(req.query.departmentId, 'departmentId', { min: 1 });
  const date = v.date(req.query.date, 'date');
  if (departmentId && req.user.role === 'BRANCH_ADMIN') {
    const dept = await models.Department.findById(departmentId, { branch_id: 1 }).session(sess(db)).lean();
    if (dept && dept.branch_id !== req.user.admin_branch_id) {
      throw forbidden('Branch administrators can only access their own branch');
    }
  }
  res.json(await forecastService.listForecasts(db, { branchId, departmentId, date }));
});

router.post('/forecasts/run', async (req, res) => {
  // Regenerates forecasts for every branch, so it is a hospital-wide action.
  admin.requireHospitalAdmin(req.user, 'forecast runs');
  const engine = v.oneOf((req.body || {}).engine, 'engine', ['AUTO', 'RF', 'BASELINE']) || 'AUTO';
  res.json(await forecastService.runForecasts(getDb(), { engine: engine.toLowerCase() }));
});

// ---- Workload analysis and resource-allocation recommendations (FR-18) ----
router.get('/recommendations', async (req, res) => {
  res.json(await analyticsService.workloadAndRecommendations(getDb(), admin.listScope(req.user, req.query)));
});

// ---- Feedback summary (FR-20) ----
router.get('/feedback', async (req, res) => {
  const limit = v.int(req.query.limit, 'limit', { min: 1, max: 1000 }) || 200;
  res.json(await analyticsService.feedbackSummary(getDb(), admin.listScope(req.user, req.query), { limit }));
});

// ---- System settings: read by both admin roles, changed by the hospital admin only ----
router.get('/settings', async (req, res) => {
  res.json(await settingsService.getSettings(getDb()));
});

router.put('/settings', async (req, res) => {
  admin.requireHospitalAdmin(req.user, 'settings changes');
  res.json(await settingsService.updateSettings(getDb(), req.body));
});

// ---- Model management (FR-22): proxied to the AI service, 503 AI_UNAVAILABLE when it is down ----
router.get('/models', async (req, res) => {
  res.json(await ai.listModels());
});

router.post('/models/retrain', async (req, res) => {
  admin.requireHospitalAdmin(req.user, 'model retraining');
  res.json(await ai.retrain());
});

router.post('/models/:version/activate', async (req, res) => {
  admin.requireHospitalAdmin(req.user, 'model activation');
  const version = v.str(req.params.version, 'version', { required: true, max: 40 });
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw badRequest('version contains invalid characters');
  res.json(await ai.activate(version));
});

module.exports = router;
