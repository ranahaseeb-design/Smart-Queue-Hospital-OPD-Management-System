'use strict';
/**
 * Express application (Section 4.2.4): REST API under /api.
 *
 *   /api/health                      public
 *   /api/auth/*                      register + login public, profile authenticated   (FR-01)
 *   /api/branches, /specialties ...  browse                                           (FR-02)
 *   /api/tokens/*                    patient token operations + staff token actions   (FR-03..07, FR-12, FR-13)
 *   /api/staff/*, /service-points/*  staff queue operations                           (FR-04, FR-12)
 *   /api/recommendations, /appointments, /visits, /notifications                      (FR-08..11, FR-19, FR-20)
 *   /api/admin/*                     BRANCH_ADMIN / HOSPITAL_ADMIN                     (FR-14..18, FR-20, FR-22)
 *
 * Every error is answered with the contract shape { error: { code, message } }.
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const { getDb } = require('./db');
const { ApiError, isUniqueViolation } = require('./utils/errors');
const { authenticate, requireRole } = require('./middleware/auth');
const ai = require('./services/aiClient');

/** CORS origin check shared with Socket.IO: configured origins, or any origin when "*" is listed. */
function corsOrigin(origin, callback) {
  // Requests without an Origin header (mobile app, curl, server-to-server) are always allowed.
  if (!origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ApiError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is too large' } });
  }
  if (isUniqueViolation(err)) {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'The record conflicts with an existing one' } });
  }
  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // live queue data must never be served as 304 from a stale cache

  app.use(cors({ origin: corsOrigin, credentials: true, exposedHeaders: ['Content-Disposition'] }));
  app.use(express.json({ limit: '100kb' }));
  if (config.logRequests) {
    // NFR-05: the patient's coordinates (recommendations ?lat=&lng=) never reach the logs.
    morgan.token('safe-url', (req) =>
      (req.originalUrl || req.url).replace(/([?&](?:lat|lng|latitude|longitude)=)[^&]*/gi, '$1redacted')
    );
    app.use(
      morgan(
        config.env === 'production'
          ? ':remote-addr - [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"'
          : ':method :safe-url :status :response-time ms - :res[content-length]'
      )
    );
  }
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Health (public): DB reachability and whether the AI service answers.
  app.get('/api/health', async (req, res) => {
    let dbOk = true;
    try {
      await getDb().get('SELECT 1 AS ok', []);
    } catch (_) {
      dbOk = false;
    }
    const aiHealth = await ai.health();
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      db: config.db.client,
      ai: Boolean(aiHealth && aiHealth.status === 'ok'),
      aiActiveModel: aiHealth ? aiHealth.activeModel || null : null,
    });
  });

  app.use('/api/auth', require('./routes/auth'));

  // Everything below requires a valid JWT.
  app.use('/api', authenticate);
  app.use('/api/admin', requireRole('BRANCH_ADMIN', 'HOSPITAL_ADMIN'), require('./routes/admin'));
  app.use('/api/tokens', require('./routes/tokens'));
  app.use('/api', require('./routes/browse'));
  app.use('/api', require('./routes/staff'));
  app.use('/api', require('./routes/patient'));

  app.use('/api', notFoundHandler);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, corsOrigin, errorHandler };
