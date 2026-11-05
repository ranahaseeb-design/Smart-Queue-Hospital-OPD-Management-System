'use strict';
/**
 * Point-in-time ("as-of") replay of queue history, used by the seed to store, for every
 * synthetic token, the wait_predictions row that the live Prediction Service would have written
 * when the token was issued (Section 6.3, FR-06).
 *
 * The live service builds the feature vector from the database state at issue time; the seed
 * generates a whole day at once, so it reconstructs that state from token timelines:
 *
 *   timeline token = {
 *     id, servicePointId, doctorId (null for LAB/PHARMACY), departmentId, branchId, queueType,
 *     issuedAt: Date,
 *     changes: [{ at: Date, status }]        status history, first = { at: issuedAt, status: 'WAITING' }
 *     initialPriority, priorityChanges: [{ at: Date, level }]
 *   }
 *
 * A token "exists" for another token's prediction when it was issued earlier (ties broken by id,
 * like the live INSERT order). Its status / called_at / completed_at / priority are the values
 * the tokens table held at that instant. The same fb.computeFeatures, fb.baselineMinutes and
 * fb.boundMinutes used by the live service then produce the stored features and minutes.
 * test/seed.test.js checks this replay against the predictions written by the live API.
 */
const fb = require('../services/featureBuilder');

const HOUR_MS = 60 * 60 * 1000;

/** State of a timeline token at instant t (inclusive). */
function stateAt(tok, t) {
  const tm = t.getTime();
  let status = null;
  let calledAt = null;
  let completedAt = null;
  for (const c of tok.changes) {
    if (c.at.getTime() > tm) break;
    status = c.status;
    if (c.status === 'CALLED' && !calledAt) calledAt = c.at; // first call; a recall keeps it
    else if (c.status === 'COMPLETED') completedAt = c.at;
  }
  let priorityLevel = tok.initialPriority;
  for (const p of tok.priorityChanges || []) {
    if (p.at.getTime() > tm) break;
    priorityLevel = p.level;
  }
  return { status, calledAt, completedAt, priorityLevel };
}

/** Was `other` already in the tokens table when `ref` was inserted? */
function existedBefore(other, ref) {
  const a = other.issuedAt.getTime();
  const b = ref.issuedAt.getTime();
  return a < b || (a === b && other.id <= ref.id);
}

function queueKey(tok) {
  return `${tok.servicePointId}|${tok.doctorId || 0}`;
}

/**
 * Replay the first prediction of tokens of ONE day.
 *
 * @param {object} day
 * @param {object[]} day.tokens                 all timeline tokens of the date (every queue)
 * @param {Map<number, {type:string, at:Date}[]>} day.events   queue events per token id
 * @param {Map<number, {id, departmentId, branchId, avgConsultMinutes, session:{start:Date,end:Date}|null}>} day.doctors
 * @param {Map<number, number>} day.counterAverages            LAB/PHARMACY service point id -> avg minutes
 * @param {Map<number, {doctorId:number, start:Date, end:Date}[]>} day.departmentSessions
 * @param {Map<number, {slot:Date, bookedFrom?:Date|null, bookedUntil:Date|null}[]>} day.appointments
 *        per doctor: appointments that are BOOKED from bookedFrom (null = before the day) until
 *        bookedUntil (null = the whole day; check-in / cancellation time otherwise)
 * @param {Set<number>} [day.only]              restrict to these token ids
 * @returns {Map<number, { features: object, minutes: number }>}
 */
function replayFirstPredictions(day) {
  const queues = new Map();
  const departmentTokens = new Map();
  for (const tok of day.tokens) {
    const key = queueKey(tok);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(tok);
    if (tok.queueType === 'OPD' && tok.departmentId) {
      if (!departmentTokens.has(tok.departmentId)) departmentTokens.set(tok.departmentId, []);
      departmentTokens.get(tok.departmentId).push(tok);
    }
  }

  const out = new Map();
  for (const tok of day.tokens) {
    if (day.only && !day.only.has(tok.id)) continue;
    const t = tok.issuedAt;
    const members = queues.get(queueKey(tok)).filter((q) => existedBefore(q, tok));
    const queue = members.map((q) => {
      const s = stateAt(q, t);
      return {
        id: q.id,
        status: s.status,
        priorityLevel: s.priorityLevel,
        issuedAt: q.issuedAt,
        calledAt: s.calledAt,
        completedAt: s.completedAt,
      };
    });
    const self = queue.find((q) => q.id === tok.id);

    const from = t.getTime() - HOUR_MS;
    const recentEvents = [];
    for (const q of members) {
      for (const e of day.events.get(q.id) || []) {
        const et = e.at.getTime();
        if (et > from && et <= t.getTime()) recentEvents.push({ eventType: e.type, eventTime: e.at });
      }
    }

    let ctx;
    if (tok.doctorId) {
      const doctor = day.doctors.get(tok.doctorId);
      const deptMembers = (departmentTokens.get(doctor.departmentId) || []).filter((q) => existedBefore(q, tok));
      const departmentWaiting = deptMembers.filter((q) => stateAt(q, t).status === 'WAITING').length;
      const booked = (day.appointments.get(tok.doctorId) || [])
        .filter(
          (a) =>
            (!a.bookedFrom || a.bookedFrom.getTime() <= t.getTime()) &&
            (!a.bookedUntil || t.getTime() < a.bookedUntil.getTime())
        )
        .map((a) => a.slot);
      ctx = {
        queue,
        recentEvents,
        doctor: {
          id: doctor.id,
          departmentId: doctor.departmentId,
          branchId: doctor.branchId,
          avgConsultMinutes: doctor.avgConsultMinutes,
        },
        session: doctor.session,
        bookedAppointments: booked,
        departmentWaiting,
        departmentActiveDoctors: fb.activeDoctorCount(day.departmentSessions.get(doctor.departmentId) || [], t),
      };
    } else {
      ctx = {
        queue,
        recentEvents,
        doctor: {
          id: 0,
          departmentId: 0,
          branchId: tok.branchId,
          avgConsultMinutes: day.counterAverages.get(tok.servicePointId),
        },
        session: null,
        bookedAppointments: [],
        departmentWaiting: queue.filter((q) => q.status === 'WAITING').length,
        departmentActiveDoctors: 1,
      };
    }
    const features = fb.computeFeatures(ctx, self, t);
    const minutes = fb.boundMinutes(fb.baselineMinutes(features), t, ctx.session);
    out.set(tok.id, { features, minutes });
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so a seed run is reproducible relative to "today". */
function createRng(seed = 42) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    normal() {
      let u = 0;
      while (u === 0) u = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    /** Log-normal with the given mean and log-sd. */
    logNormal(mean, sigma) {
      const mu = Math.log(mean) - (sigma * sigma) / 2;
      return Math.exp(mu + sigma * rng.normal());
    },
    weighted(pairs) {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [value, w] of pairs) {
        r -= w;
        if (r <= 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
  };
  return rng;
}

module.exports = { stateAt, existedBefore, replayFirstPredictions, createRng };
