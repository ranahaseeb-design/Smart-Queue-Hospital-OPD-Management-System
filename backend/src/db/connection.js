'use strict';
/**
 * MongoDB connection (Mongoose). One connection per process, opened with connect() and closed
 * with close(). The URI comes from MONGODB_URI (config.db.uri); tests pass their own URI so every
 * test file works on its own uniquely named database.
 *
 * Transactions need a replica set: locally a single-node replica set ("rs0"), or MongoDB Atlas.
 */
const mongoose = require('mongoose');
const config = require('../config');

// Filters are passed to the server as written: a mistyped field then matches nothing instead of
// being stripped from the filter (strictQuery: true would silently widen the query).
mongoose.set('strictQuery', false);
// Indexes are created explicitly (syncIndexes in db:init / seed / tests), never lazily on first use.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

let connecting = null;

/** Database name of a MongoDB URI (path segment), or null when the URI names none. */
function dbNameOf(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(String(uri || ''));
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Open the connection (idempotent).
 * @param {{ uri?: string, dbName?: string, serverSelectionTimeoutMS?: number }} [opts]
 */
async function connect({ uri = config.db.uri, dbName, serverSelectionTimeoutMS = config.db.serverSelectionTimeoutMS } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;
  const name = dbName || dbNameOf(uri) || config.db.name;
  connecting = mongoose
    .connect(uri, { dbName: name, serverSelectionTimeoutMS })
    .then(() => mongoose.connection)
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

/** Close the connection (idempotent). */
async function close() {
  if (connecting) await connecting.catch(() => {});
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

function getConnection() {
  return mongoose.connection;
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

/** Round trip to the server (health check). */
async function ping() {
  if (!isConnected()) throw new Error('MongoDB is not connected');
  await mongoose.connection.db.admin().command({ ping: 1 });
  return true;
}

module.exports = { mongoose, connect, close, getConnection, isConnected, ping, dbNameOf };
