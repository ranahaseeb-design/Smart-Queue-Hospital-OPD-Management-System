'use strict';
/**
 * Integer id sequences and per-queue-day token numbers in the `counters` collection
 * ({ _id: '<name>', seq: n }), incremented atomically with findOneAndUpdate + $inc + upsert.
 *
 *  - nextId('tokens')                 -> next integer _id of a collection. Allocated OUTSIDE the
 *    business transaction by default (no session): a rolled-back or retried transaction only leaves
 *    a harmless gap, and concurrent transactions never conflict on the global id counter.
 *  - nextTokenNumber(spId, date, s)   -> next token number of a queue day, counter
 *    'token:<service_point_id>:<YYYY-MM-DD>'. Always INSIDE the transaction (session required for
 *    concurrency safety): an aborted transaction gives its number back, and two transactions
 *    numbering the same queue conflict on this document, so one of them is retried
 *    (session.withTransaction) after the other commits. The unique index
 *    { service_point_id, token_date, token_number } is the backstop.
 *  - lockServicePoints(ids, s)        -> write to 'lock:service_point:<id>' inside the transaction.
 *    Replaces the SQL "SELECT ... FOR UPDATE" on service_points: every transaction that changes a
 *    queue (call next, recall, transfer, issue) writes this document first, so two of them on the
 *    same service point can never both commit from the same snapshot (write-skew protection for
 *    rules like "at most one CALLED/IN_SERVICE token per service point").
 *
 * Self-healing: when a counter document does not exist yet (fresh database, data inserted by the
 * seed or by hand), the first allocation starts after the highest existing value.
 */
const models = require('./models');

const { Counter } = models;
const AFTER = { upsert: true, new: true, projection: { seq: 1 } };

function modelForCollection(collection) {
  const m = models.COUNTED_MODELS.find((x) => x.collection.collectionName === collection);
  if (!m) throw new Error(`No integer-id collection named "${collection}"`);
  return m;
}

async function maxExistingId(Model, session) {
  const top = await Model.findOne({}, { _id: 1 }).sort({ _id: -1 }).session(session || null).lean();
  return top ? Number(top._id) || 0 : 0;
}

/**
 * Reserve `count` consecutive ids of a collection; returns the first one.
 * @param {string} collection e.g. 'tokens'
 * @param {number} [count=1]
 * @param {import('mongoose').ClientSession|null} [session]
 */
async function reserveIds(collection, count = 1, session = null) {
  const Model = modelForCollection(collection);
  const n = Math.max(1, Math.floor(count));
  let doc = await Counter.findOneAndUpdate({ _id: collection }, { $inc: { seq: n } }, { ...AFTER, session });
  if (doc.seq === n) {
    // First allocation for this collection: start after the highest existing _id.
    const max = await maxExistingId(Model, session);
    if (max > 0) {
      doc = await Counter.findOneAndUpdate({ _id: collection }, { $inc: { seq: max } }, { ...AFTER, session });
    }
  }
  return doc.seq - n + 1;
}

/** Next integer _id of a collection. */
async function nextId(collection, session = null) {
  return reserveIds(collection, 1, session);
}

/** `count` consecutive integer ids of a collection (array). */
async function nextIds(collection, count, session = null) {
  if (!count) return [];
  const first = await reserveIds(collection, count, session);
  return Array.from({ length: count }, (_, i) => first + i);
}

/** Next token number of a queue day (service point + "YYYY-MM-DD"). Call inside the transaction. */
async function nextTokenNumber(servicePointId, date, session) {
  const name = `token:${servicePointId}:${date}`;
  let doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { ...AFTER, session });
  if (doc.seq === 1) {
    const top = await models.Token.findOne({ service_point_id: servicePointId, token_date: date }, { token_number: 1 })
      .sort({ token_number: -1 })
      .session(session || null)
      .lean();
    const max = top ? Number(top.token_number) || 0 : 0;
    if (max > 0) {
      doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: max } }, { ...AFTER, session });
    }
  }
  return doc.seq;
}

/** Write the lock documents of service points (ascending id, inside the transaction). */
async function lockServicePoints(ids, session) {
  const unique = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  for (const id of unique) await lockKey(`service_point:${id}`, session);
}

/**
 * Write the lock document 'lock:<key>' inside the transaction (e.g. 'doctor:7' serialises the
 * bookings of one doctor, like the former SELECT ... FOR UPDATE on the doctors row).
 */
async function lockKey(key, session) {
  await Counter.updateOne({ _id: `lock:${key}` }, { $inc: { seq: 1 } }, { upsert: true, session });
}

/** Set every id counter to the highest existing _id (after bulk inserts with explicit ids). */
async function syncIdCounters() {
  for (const Model of models.COUNTED_MODELS) {
    const name = Model.collection.collectionName;
    const max = await maxExistingId(Model);
    await Counter.updateOne({ _id: name }, { $max: { seq: max } }, { upsert: true });
  }
}

module.exports = { nextId, nextIds, reserveIds, nextTokenNumber, lockServicePoints, lockKey, syncIdCounters };
