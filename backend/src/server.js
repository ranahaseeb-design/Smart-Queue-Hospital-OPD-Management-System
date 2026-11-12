'use strict';
/**
 * Entry point: HTTP server with the Express REST API and the Socket.IO real-time channel on the
 * same port (default 4000), plus the scheduled background jobs.
 *
 *   npm start          (or: node src/server.js)
 *
 * On start it connects to MONGODB_URI, creates missing collections and indexes, writes missing
 * default settings and, with AUTO_SEED=true on an empty database, generates the demo data.
 * Use `npm run seed` to (re)build the demo database explicitly.
 */
const http = require('node:http');
const config = require('./config');
const { connect, getDb, closeDb, getConnection, models } = require('./db');
const { createApp } = require('./app');
const realtime = require('./services/realtime');
const settingsService = require('./services/settingsService');
const jobs = require('./jobs');

async function ensureDatabase(db, { logger = console } = {}) {
  // Non-destructive (db:init and the seed also drop indexes that models.js no longer declares).
  for (const Model of models.ALL_MODELS) {
    await Model.createCollection().catch((err) => {
      if (err && err.codeName !== 'NamespaceExists' && err.code !== 48) throw err;
    });
    await Model.createIndexes();
  }
  await settingsService.writeDefaults(db);
  if (config.autoSeed) {
    if ((await models.User.estimatedDocumentCount()) === 0) {
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
  await connect();
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
        `[server] Smart OPD API listening on http://localhost:${port}/api (db: ${config.db.client}/${getConnection().name}, ` +
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
      if (err && err.name === 'MongooseServerSelectionError') {
        console.error(
          `[server] Failed to start: MongoDB is not reachable at MONGODB_URI (${err.message}). ` +
            'Start MongoDB as a replica set (see backend/README.md, "MongoDB") or point MONGODB_URI at Atlas.'
        );
      } else {
        console.error('[server] Failed to start:', err && err.stack ? err.stack : err);
      }
      await closeDb().catch(() => {});
      process.exit(1);
    });
}

module.exports = { startServer, ensureDatabase };
