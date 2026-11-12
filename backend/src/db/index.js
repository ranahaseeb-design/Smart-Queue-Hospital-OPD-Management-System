'use strict';
/**
 * Data layer entry point (MongoDB via Mongoose).
 *
 *   connect(opts) / closeDb()     open / close the connection (connection.js)
 *   models                        the Mongoose models (models.js)
 *   nextId / nextTokenNumber ...  counters (counters.js)
 *   withTransaction(fn)           session.withTransaction with retries (see below)
 *   getDb()                       the root "DB context" passed through the services
 *
 * DB context: every service function still takes a `db` first argument, as in the SQL version.
 * It is a small object { session, inTransaction, transaction(fn) }:
 *   - the root context (getDb()) has session = null;
 *   - db.transaction(fn) runs fn(tx) inside withTransaction, where tx.session is the
 *     ClientSession every query of that transaction passes on (sess(tx)).
 * Services therefore write `Model.find(filter).session(sess(db))`, and the same function works
 * inside and outside a transaction.
 *
 * withTransaction replaces the SQL row locks: session.withTransaction() retries the whole callback
 * on TransientTransactionError (write conflicts with a concurrent transaction) and on
 * UnknownTransactionCommitResult. A duplicate-key error (11000) raised by a concurrent insert that
 * committed after this transaction's snapshot is retried twice as well, so the business checks then
 * see the committed data (e.g. the other request's OPEN visit is reused); if it persists it reaches
 * the error middleware, which answers 409 CONFLICT.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const connection = require('./connection');
const models = require('./models');
const counters = require('./counters');
const { isUniqueViolation: isDuplicateKey } = require('../utils/errors');

const txStore = new AsyncLocalStorage();
const TX_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};
const DUPLICATE_RETRIES = 2;

/**
 * Run fn(session) in a multi-document transaction (requires a replica set). Nested calls join the
 * running transaction. Returns fn's result.
 */
async function withTransaction(fn) {
  const outer = txStore.getStore();
  if (outer && outer.session && outer.session.inTransaction()) return fn(outer.session);
  const conn = connection.getConnection();
  for (let attempt = 0; ; attempt += 1) {
    const session = await conn.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await txStore.run({ session }, () => fn(session));
      }, TX_OPTIONS);
      return result;
    } catch (err) {
      if (isDuplicateKey(err) && attempt < DUPLICATE_RETRIES) continue;
      throw err;
    } finally {
      await session.endSession().catch(() => {});
    }
  }
}

function makeContext(session) {
  const ctx = {
    client: 'mongodb',
    session,
    inTransaction: Boolean(session),
    transaction(fn) {
      if (ctx.session) return fn(ctx); // nested: join the outer transaction
      return withTransaction((s) => fn(makeContext(s)));
    },
  };
  return Object.freeze(ctx);
}

const ROOT = makeContext(null);

/** Root DB context (no session). */
function getDb() {
  return ROOT;
}

/** Session of a DB context (null outside a transaction). */
function sess(db) {
  return (db && db.session) || null;
}

/** Lean document -> row object that also carries the former primary-key column name. */
function asRow(Model, doc) {
  if (!doc) return doc === undefined ? undefined : null;
  return { ...doc, [Model.pk]: doc._id };
}

function asRows(Model, docs) {
  return docs.map((d) => asRow(Model, d));
}

/** Insert one document with a new integer _id; returns the new _id. */
async function insertOne(db, Model, data) {
  const _id = await counters.nextId(Model.collection.collectionName);
  await Model.create([{ ...data, _id }], { session: sess(db) });
  return _id;
}

/** Insert many documents with new integer ids (one counter round trip); returns the ids. */
async function insertManyWithIds(db, Model, docs) {
  if (!docs.length) return [];
  const ids = await counters.nextIds(Model.collection.collectionName, docs.length);
  await Model.insertMany(
    docs.map((d, i) => ({ ...d, _id: ids[i] })),
    { session: sess(db), ordered: true }
  );
  return ids;
}

/** Map of documents by _id for a list of ids (one query; missing ids are absent). */
async function byIds(db, Model, ids, projection = null) {
  const unique = [...new Set(ids.filter((x) => x !== null && x !== undefined))];
  if (!unique.length) return new Map();
  const docs = await Model.find({ _id: { $in: unique } }, projection).session(sess(db)).lean();
  return new Map(docs.map((d) => [d._id, d]));
}

/** Create the collections and synchronise every model's indexes with models.js. */
async function syncIndexes() {
  for (const Model of models.ALL_MODELS) {
    await Model.createCollection().catch((err) => {
      if (err && err.codeName !== 'NamespaceExists' && err.code !== 48) throw err;
    });
    await Model.syncIndexes();
  }
}

/** Drop the whole configured database (seed / tests only). */
async function dropDatabase() {
  await connection.getConnection().dropDatabase();
}

/** True when the database holds the application collections (settings exist). */
async function hasData() {
  return (await models.Setting.estimatedDocumentCount()) > 0;
}

async function closeDb() {
  await connection.close();
}

module.exports = {
  ...connection,
  models,
  ...counters,
  withTransaction,
  isDuplicateKey,
  getDb,
  sess,
  asRow,
  asRows,
  insertOne,
  insertManyWithIds,
  byIds,
  syncIndexes,
  dropDatabase,
  hasData,
  closeDb,
};
