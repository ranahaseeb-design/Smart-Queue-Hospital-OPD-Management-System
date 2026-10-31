'use strict';
/**
 * `npm run db:init` — create the schema for the configured driver if it does not exist.
 * (Use `npm run seed` to drop, recreate and fill the database with demo data.)
 */
const config = require('../config');
const { getDb, closeDb, hasSchema, createSchema } = require('./index');
const settingsService = require('../services/settingsService');

async function main() {
  const db = getDb();
  if (await hasSchema(db)) {
    console.log(`[db:init] Schema already present (${config.db.client}). Nothing to do.`);
  } else {
    await createSchema(db);
    await settingsService.writeDefaults(db);
    console.log(
      `[db:init] Schema created (${config.db.client}${
        config.db.client === 'sqlite' ? `: ${config.db.sqlitePath}` : `: ${config.db.database}`
      }).`
    );
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error('[db:init] Failed:', err.message);
  await closeDb().catch(() => {});
  process.exitCode = 1;
});
