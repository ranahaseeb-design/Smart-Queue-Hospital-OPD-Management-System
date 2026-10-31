'use strict';
/**
 * Recommendation Service (FR-08, FR-09, Section 6.5).
 *
 * Candidates: active departments of the requested standardised specialty (in active branches)
 * with at least one doctor accepting patients now. For every branch the doctor with the lowest
 * predicted wait for a hypothetical token joining now is used. Each candidate gets
 *   W = predicted wait, d = haversine distance (Eq. 6.4), rho = live congestion ratio (Eq. 6.5)
 * and is scored with Eq. 6.3 after min-max normalisation (lower = better). The AI service's
 * /ai/rank-branches is used when available, otherwise the same scoring runs in JS.
 * The patient's coordinates are only used in memory and never stored or logged (NFR-05).
 */
const config = require('../config');
const time = require('../utils/time');
const fb = require('./featureBuilder');
const ai = require('./aiClient');
const scheduleService = require('./scheduleService');
const predictionService = require('./predictionService');
const settingsService = require('./settingsService');
const queueService = require('./queueService');

/** Min-max normalise; all equal -> 0. */
function normalise(values) {
  const finite = values.filter((v) => v !== null && Number.isFinite(v));
  if (!finite.length) return values.map(() => 0);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return values.map((v) => (v === null || !Number.isFinite(v) || max === min ? 0 : (v - min) / (max - min)));
}

/** Effective weights: without location the distance weight is redistributed proportionally. */
function effectiveWeights(weights, hasLocation) {
  if (hasLocation) return { ...weights };
  const rest = weights.wait + weights.congestion;
  if (rest <= 0) return { wait: 0.5, distance: 0, congestion: 0.5 };
  return {
    wait: time.round(weights.wait / rest, 4),
    distance: 0,
    congestion: time.round(weights.congestion / rest, 4),
  };
}

/** Eq. 6.3 scoring in JS: S = w1*norm(W) + w2*norm(d) + w3*norm(rho). */
function scoreCandidates(candidates, weights) {
  const W = normalise(candidates.map((c) => c.predictedWaitMinutes));
  const D = normalise(candidates.map((c) => c.distanceKm));
  const R = normalise(candidates.map((c) => c.congestionRatio));
  return candidates.map((c, i) => time.round(weights.wait * W[i] + weights.distance * D[i] + weights.congestion * R[i], 4));
}

function buildReason(c, all, reference) {
  const parts = [];
  const minWait = Math.min(...all.map((x) => x.predictedWaitMinutes));
  if (reference !== null && reference !== undefined) {
    const diff = Math.round(reference - c.predictedWaitMinutes);
    if (diff >= 5) parts.push(`about ${diff} min shorter wait`);
    else if (diff <= -5) parts.push(`about ${-diff} min longer wait`);
    else parts.push(`similar wait (about ${Math.round(c.predictedWaitMinutes)} min)`);
  } else if (c.predictedWaitMinutes === minWait && all.length > 1) {
    parts.push(`shortest predicted wait (about ${Math.round(c.predictedWaitMinutes)} min)`);
  } else {
    parts.push(`about ${Math.round(c.predictedWaitMinutes)} min wait`);
  }
  if (c.distanceKm !== null) {
    const minDist = Math.min(...all.map((x) => x.distanceKm));
    parts.push(`${c.distanceKm} km away${c.distanceKm === minDist && all.length > 1 ? ' (nearest)' : ''}`);
  }
  if (c.congestionLevel !== 'NORMAL') parts.push(`queue is ${c.congestionLevel.toLowerCase()} right now`);
  else if (all.length > 1 && c.congestionRatio === Math.min(...all.map((x) => x.congestionRatio))) {
    parts.push('least crowded');
  }
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {{ specialty: string, lat?: number|null, lng?: number|null, excludeDoctorId?: number|null, user: object }} q
 */
async function recommend(db, { specialty, lat = null, lng = null, excludeDoctorId = null, user }, now = time.clock.now()) {
  const settings = await settingsService.getSettings(db);
  const hasLocation = lat !== null && lng !== null;
  const weights = effectiveWeights(settings.recommendationWeights, hasLocation);
  const priorityLevel = user && user.role === 'PATIENT' ? queueService.priorityFromCategory(user.priority_category) : 0;
  const date = time.formatDate(now);

  const departments = (
    await db.query(
      `SELECT dp.department_id, dp.specialty, dp.name, b.branch_id, b.name AS branch_name, b.address, b.latitude, b.longitude
         FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id
        WHERE dp.is_active = 1 AND b.status = 'ACTIVE'`,
      []
    )
  ).filter((d) => d.specialty.trim().toLowerCase() === specialty.trim().toLowerCase());

  const canonicalSpecialty = departments.length ? departments[0].specialty : specialty;
  const accepting = [];
  let referenceDoctor = null;
  for (const dept of departments) {
    const doctors = await db.query(
      `SELECT d.doctor_id FROM doctors d JOIN users u ON u.user_id = d.user_id
        WHERE d.department_id = ? AND d.is_active = 1 AND u.is_active = 1`,
      [dept.department_id]
    );
    for (const { doctor_id: doctorId } of doctors) {
      const doctor = await scheduleService.getDoctor(db, doctorId);
      const avail = await scheduleService.availability(db, doctor, date, now);
      if (doctorId === excludeDoctorId) {
        if (avail.session) referenceDoctor = { ...doctor, session: avail.session };
        continue;
      }
      if (avail.acceptingNow) accepting.push({ ...doctor, session: avail.session, dept });
    }
  }

  const toPredict = referenceDoctor ? [...accepting, referenceDoctor] : accepting;
  const predictions = await predictionService.predictHypothetical(db, toPredict, { priorityLevel, now });
  const reference = referenceDoctor && predictions.has(referenceDoctor.doctor_id)
    ? predictions.get(referenceDoctor.doctor_id).minutes
    : null;

  // Best doctor (lowest predicted wait) per branch.
  const byBranch = new Map();
  for (const doc of accepting) {
    const p = predictions.get(doc.doctor_id);
    if (!p) continue;
    const current = byBranch.get(doc.branch_id);
    if (!current || p.minutes < current.prediction.minutes) byBranch.set(doc.branch_id, { doc, prediction: p });
  }

  const candidates = [];
  for (const { doc, prediction } of byBranch.values()) {
    const congestion = await queueService.departmentCongestion(db, doc.department_id, now);
    const distanceKm = hasLocation
      ? time.round(fb.haversineKm(lat, lng, Number(doc.latitude), Number(doc.longitude)), 1)
      : null;
    candidates.push({
      branchId: doc.branch_id,
      branchName: doc.branch_name,
      address: doc.branch_address,
      doctorId: doc.doctor_id,
      doctorName: doc.full_name,
      predictedWaitMinutes: Math.round(prediction.minutes),
      distanceKm,
      congestionRatio: congestion.ratio,
      congestionLevel: congestion.level,
      modelVersion: prediction.modelVersion,
    });
  }

  let scores = null;
  if (candidates.length) {
    const ranked = await ai.rankBranches(
      weights,
      candidates.map((c) => ({
        branchId: c.branchId,
        doctorId: c.doctorId,
        predictedWaitMinutes: c.predictedWaitMinutes,
        distanceKm: c.distanceKm,
        congestionRatio: c.congestionRatio,
      }))
    );
    if (ranked && ranked.length === candidates.length) {
      const map = new Map(ranked.map((r) => [`${r.branchId}|${r.doctorId}`, Number(r.score)]));
      if (candidates.every((c) => Number.isFinite(map.get(`${c.branchId}|${c.doctorId}`)))) {
        scores = candidates.map((c) => time.round(map.get(`${c.branchId}|${c.doctorId}`), 4));
      }
    }
    if (!scores) scores = scoreCandidates(candidates, weights);
  }

  const items = candidates
    .map((c, i) => ({
      branchId: c.branchId,
      branchName: c.branchName,
      address: c.address,
      doctorId: c.doctorId,
      doctorName: c.doctorName,
      predictedWaitMinutes: c.predictedWaitMinutes,
      distanceKm: c.distanceKm,
      congestionRatio: c.congestionRatio,
      congestionLevel: c.congestionLevel,
      score: scores[i],
      reason: buildReason(c, candidates, reference),
    }))
    .sort((a, b) => a.score - b.score || a.predictedWaitMinutes - b.predictedWaitMinutes);

  return { specialty: canonicalSpecialty, weights, items };
}

module.exports = { recommend, scoreCandidates, normalise, effectiveWeights, buildReason, config };
