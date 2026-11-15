'use strict';
/**
 * Live operations views:
 *  - loadBalancer: the haversine cross-branch load balancer (FR-08/09/15/18) — live load per branch
 *    (Eq. 6.5: waiting ÷ remaining capacity), average and best predicted wait per branch (Random
 *    Forest via predictHypothetical, Eq. 6.2 fallback), haversine distances between branches
 *    (Eq. 6.4) and redirect recommendations from branches at ≥ 75 % load to the best nearby branch.
 *  - displayBoard: the waiting-room board (/display): now serving, next 3 and waiting per service
 *    point, live estimated wait per department. Token numbers only — never patient names.
 */
const config = require('../config');
const time = require('../utils/time');
const { notFound } = require('../utils/errors');
const { models, sess } = require('../db');
const fb = require('./featureBuilder');
const scheduleService = require('./scheduleService');
const queueService = require('./queueService');
const predictionService = require('./predictionService');
const settingsService = require('./settingsService');
const demoService = require('./demoService');

const { Branch, ServicePoint, Token, Department } = models;
const REDIRECT_LOAD = 0.75;
const MIN_SAVING = 5;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

// The admin Overview polls the load balancer and it predicts every accepting doctor once; the inputs
// are reused for 10 s (not under tests, where the clock is simulated). Demo data changes clear it.
const LB_CACHE_MS = 10000;
let lbCache = { at: 0, inputs: null };
function clearLoadBalancerCache() {
  lbCache = { at: 0, inputs: null };
}

async function loadBalancerInputs(db, now) {
  if (config.env !== 'test' && lbCache.inputs && Date.now() - lbCache.at < LB_CACHE_MS) return lbCache.inputs;
  const loads = await demoService.branchLoads(db, now);
  const doctors = await demoService.doctorsToday(db, now);
  const accepting = doctors.filter((d) => d.acceptingNow);
  const predictions = await predictionService.predictHypothetical(db, accepting, { now });
  lbCache = { at: Date.now(), inputs: { loads, accepting, predictions } };
  return lbCache.inputs;
}

async function loadBalancer(db, user, now = time.clock.now()) {
  const settings = await settingsService.getSettings(db);
  const { loads, accepting, predictions } = await loadBalancerInputs(db, now);

  const branches = loads.map((l) => {
    const here = accepting.filter((d) => d.branch_id === l.branch._id);
    const waits = here.map((d) => predictions.get(d.doctor_id)).filter(Boolean).map((p) => p.minutes);
    const versions = [...new Set(here.map((d) => predictions.get(d.doctor_id)?.modelVersion).filter(Boolean))];
    return {
      branchId: l.branch._id,
      name: l.branch.name,
      latitude: Number(l.branch.latitude),
      longitude: Number(l.branch.longitude),
      waiting: l.waiting,
      capacity: l.capacity,
      loadPercent: Math.round(l.ratio * 100),
      level: fb.classifyCongestion(l.ratio, settings.congestionThresholds),
      activeDoctors: here.length,
      avgWaitMinutes: round1(mean(waits)),
      bestWaitMinutes: waits.length ? round1(Math.min(...waits)) : null,
      modelVersion: versions.length === 1 ? versions[0] : versions.length ? 'mixed' : null,
    };
  });

  const distances = [];
  for (const a of branches) {
    for (const b of branches) {
      if (a.branchId < b.branchId) {
        distances.push({
          fromBranchId: a.branchId,
          toBranchId: b.branchId,
          km: round1(fb.haversineKm(a.latitude, a.longitude, b.latitude, b.longitude)),
        });
      }
    }
  }
  const km = (x, y) => distances.find((d) => (d.fromBranchId === x && d.toBranchId === y) || (d.fromBranchId === y && d.toBranchId === x))?.km ?? null;

  const recommendations = [];
  for (const from of branches.filter((b) => b.loadPercent >= REDIRECT_LOAD * 100)) {
    const options = branches
      .filter((to) => to.branchId !== from.branchId && to.loadPercent < REDIRECT_LOAD * 100 && to.bestWaitMinutes !== null)
      .map((to) => ({
        to,
        distanceKm: km(from.branchId, to.branchId),
        waitSavedMinutes: from.avgWaitMinutes !== null ? Math.round(from.avgWaitMinutes - to.bestWaitMinutes) : null,
      }))
      .filter((o) => o.waitSavedMinutes === null || o.waitSavedMinutes >= MIN_SAVING)
      // Lower load first, then the nearer branch.
      .sort((x, y) => x.to.loadPercent - y.to.loadPercent || (x.distanceKm ?? 1e9) - (y.distanceKm ?? 1e9));
    const best = options[0];
    if (!best) continue;
    recommendations.push({
      fromBranchId: from.branchId,
      fromBranchName: from.name,
      toBranchId: best.to.branchId,
      toBranchName: best.to.name,
      distanceKm: best.distanceKm,
      waitSavedMinutes: best.waitSavedMinutes,
      fromLoadPercent: from.loadPercent,
      toLoadPercent: best.to.loadPercent,
      message:
        `Redirect new ${from.name} walk-ins to ${best.to.name}: ${best.distanceKm} km away`
        + `${best.waitSavedMinutes !== null ? `, about ${best.waitSavedMinutes} min shorter wait` : ''}`
        + ` (load ${from.loadPercent}% → ${best.to.loadPercent}%).`,
    });
  }

  // Branch admins see every branch's aggregate load (needed to balance) but only the redirects
  // that involve their own branch, labelled outgoing / incoming.
  let visible = recommendations;
  if (user.role === 'BRANCH_ADMIN') {
    visible = recommendations
      .filter((r) => r.fromBranchId === user.admin_branch_id || r.toBranchId === user.admin_branch_id)
      .map((r) => ({ ...r, direction: r.fromBranchId === user.admin_branch_id ? 'OUTGOING' : 'INCOMING' }));
  }

  return {
    generatedAt: time.toApi(now),
    redirectThresholdPercent: REDIRECT_LOAD * 100,
    scopeBranchId: user.role === 'BRANCH_ADMIN' ? user.admin_branch_id : null,
    branches,
    distances,
    recommendations: visible,
  };
}

const TYPE_ORDER = { OPD: 0, LAB: 1, PHARMACY: 2 };

/** Public board data: the requested branch, or the first active branch. */
async function displayBoard(db, requestedBranchId = null, now = time.clock.now()) {
  const activeBranches = await Branch.find({ status: 'ACTIVE' }, { name: 1 }).sort({ _id: 1 }).session(sess(db)).lean();
  if (!activeBranches.length) throw notFound('No active branch');
  const branch = requestedBranchId ? activeBranches.find((b) => b._id === requestedBranchId) : activeBranches[0];
  if (!branch) throw notFound('Branch not found');
  const branchId = branch._id;
  const date = time.formatDate(now);
  const points = (await ServicePoint.find({ branch_id: branchId, is_active: true }).session(sess(db)).lean())
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const tokens = await Token.find({ service_point_id: { $in: points.map((p) => p._id) }, token_date: date, status: { $in: ['WAITING', 'CALLED', 'IN_SERVICE'] } })
    .sort({ priority_level: -1, issued_at: 1, _id: 1 })
    .session(sess(db))
    .lean();
  const doctors = await demoService.doctorsToday(db, now);
  // Random Forest wait for a patient joining each doctor's queue now (Eq. 6.2 fallback).
  const accepting = doctors.filter((d) => d.branch_id === branchId && d.acceptingNow);
  const predictions = await predictionService.predictHypothetical(db, accepting, { now });

  const servicePoints = [];
  for (const sp of points) {
    const here = tokens.filter((t) => t.service_point_id === sp._id);
    const serving = here.filter((t) => t.status !== 'WAITING').sort((a, b) => new Date(b.called_at) - new Date(a.called_at))[0] || null;
    const waiting = here.filter((t) => t.status === 'WAITING');
    const doctor = sp.type === 'OPD' ? doctors.find((d) => d.session.servicePointId === sp._id) : null;
    const estimate = doctor && doctor.acceptingNow ? predictions.get(doctor.doctor_id) : null;
    servicePoints.push({
      id: sp._id,
      name: sp.name,
      type: sp.type,
      departmentName: doctor ? doctor.department_name : null,
      doctorName: doctor ? doctor.full_name : null,
      nowServing: serving
        ? { displayNumber: fb.displayNumber(serving.queue_type, serving.token_number), status: serving.status, calledAt: time.toApi(serving.called_at) }
        : null,
      next: waiting.slice(0, 3).map((t) => ({
        displayNumber: fb.displayNumber(t.queue_type, t.token_number),
        priorityLevel: t.priority_level,
        fromAppointment: Boolean(t.appointment_id),
      })),
      waiting: waiting.length,
      // OPD rooms: predicted wait for a new patient (null for counters / doctors not accepting).
      estimatedWaitMinutes: estimate ? Math.round(estimate.minutes) : null,
      estimateModelVersion: estimate ? estimate.modelVersion : null,
    });
  }

  const departments = [];
  const depts = await Department.find({ branch_id: branchId, is_active: true }).session(sess(db)).lean();
  for (const d of depts) {
    const c = await queueService.departmentCongestion(db, d._id, now);
    const waits = accepting.filter((x) => x.department_id === d._id).map((x) => predictions.get(x.doctor_id)?.minutes).filter((m) => m !== undefined);
    departments.push({
      departmentId: d._id,
      name: d.name,
      waiting: c.waiting,
      estimatedWaitMinutes: waits.length ? Math.round(Math.min(...waits)) : null,
      congestionLevel: c.level,
    });
  }

  return {
    branch: { id: branch._id, name: branch.name },
    branches: activeBranches.map((b) => ({ id: b._id, name: b.name })),
    generatedAt: time.toApi(now),
    servicePoints,
    departments,
  };
}

module.exports = { loadBalancer, clearLoadBalancerCache, displayBoard, REDIRECT_LOAD };
