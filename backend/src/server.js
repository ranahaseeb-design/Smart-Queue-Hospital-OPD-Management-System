'use strict';
/**
 * Entry point: HTTP server with the Express REST API and the Socket.IO real-time channel on the
 * same port (default 4000), plus the scheduled background jobs.
 *
 *   npm start          (or: node src/server.js)
 *
 * On first start against an empty database the schema is created (and, with AUTO_SEED=true,
 * the demo data is generated). Use `npm run seed` to (re)build the demo database explicitly.
 */
const http = require('node:http');
const config = require('./config');
const { getDb, closeDb, hasSchema, createSchema } = require('./db');
const { createApp } = require('./app');
const realtime = require('./services/realtime');
const settingsService = require('./services/settingsService');
const jobs = require('./jobs');

async function ensureDatabase(db, { logger = console } = {}) {
  if (!(await hasSchema(db))) {
    logger.log(`[server] Creating schema (${config.db.client})`);
    await createSchema(db);
    await settingsService.writeDefaults(db);
  }
  if (config.autoSeed) {
    const row = await db.get('SELECT COUNT(*) AS n FROM users', []);
    if (Number(row.n) === 0) {
      logger.log('[server] AUTO_SEED=true and the database is empty: generating demo data');
      const { seed } = require('./db/seed');
      await seed(db, { logger, historyDays: config.seedHistoryDays });
    }
  }
}

/**
 * Start the API + Socket.IO server.
 * @param {{ port?: number, host?: string, jobsEnabled?: boolean, logger?: Console }} [options]
 * @returns {Promise<{ app, server, io, port: number, stop: () => Promise<void> }>}
 */
async function startServer({ port = config.port, host, jobsEnabled = config.jobsEnabled, logger = console } = {}) {
  const db = getDb();
  await ensureDatabase(db, { logger });

  const app = createApp();
  const server = http.createServer(app);
  const io = realtime.init(server, db);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  const jobHandle = jobsEnabled ? jobs.start(db, { logger }) : null;

  let stopping = null;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (jobHandle) jobHandle.stop();
      await realtime.close(); // also closes the attached HTTP server
      if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
      await closeDb();
    })();
    return stopping;
  }

  return { app, server, io, port: actualPort, stop };
}

if (require.main === module) {
  startServer()
    .then(({ port, stop }) => {
      console.log(
        `[server] Smart OPD API listening on http://localhost:${port}/api (db: ${config.db.client}, ` +
          `AI: ${config.ai.url || 'disabled'}, TZ: ${config.tz}, demo always open: ${config.demoAlwaysOpen})`
      );
      const shutdown = (signal) => {
        console.log(`[server] ${signal} received, shutting down`);
        stop()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error('[server] Shutdown failed:', err);
            process.exit(1);
          });
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch(async (err) => {
      console.error('[server] Failed to start:', err && err.stack ? err.stack : err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}

module.exports = { startServer, ensureDatabase };
