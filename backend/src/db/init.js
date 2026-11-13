'use strict';
/**
 * `npm run db:init` — connect to MONGODB_URI, create the collections, synchronise the indexes
 * declared in models.js (unique / partial unique constraints included), align the id counters with
 * existing data and write the default settings. Safe to run repeatedly; it never deletes data.
 * (Use `npm run seed` to drop the database and fill it with demo data.)
 */
const config = require('../config');
const { connect, closeDb, getDb, syncIndexes, syncIdCounters } = require('./index');
const settingsService = require('../services/settingsService');

const redact = (uri) => uri.replace(/\/\/[^@/]*@/, '//***@');

async function main() {
  await connect();
  await syncIndexes();
  await syncIdCounters();
  await settingsService.writeDefaults(getDb());
  console.log(`[db:init] Collections and indexes synchronised (${redact(config.db.uri)}).`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('[db:init] Failed:', err.message);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
