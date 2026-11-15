'use strict';
/**
 * Demo tools for live presentations (config.demoTools, off in production):
 *   POST /demo/load-queue { doctorId, count? = 5 } — issue `count` (1–10) OPD tokens for freshly
 *   created "Demo Patient" accounts in that doctor's queue, through the normal issue path
 *   (queue events, predictions, notifications and socket updates), so the doctor's "My queue"
 *   fills instantly and congestion / branch-recommendation behaviour can be shown.
 * The tokens are flagged is_synthetic, like the seeded history.
 */
const { createRouter, notFound } = require('../utils/errors');
const config = require('../config');
const { getDb, models } = require('../db');
const v = require('../utils/validate');
const queueService = require('../services/queueService');
const userService = require('../services/userService');

const router = createRouter();

router.post('/demo/load-queue', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  const body = req.body || {};
  const doctorId = v.int(body.doctorId, 'doctorId', { required: true, min: 1 });
  const count = v.int(body.count, 'count', { min: 1, max: 10 }) || 5;
  const db = getDb();

  const patients = await userService.createDemoPatients(db, count);
  const tokens = [];
  for (const patient of patients) {
    // The first refusal (doctor not scheduled / session full) stops the batch with its error;
    // tokens issued before it stay in the queue.
    const detail = await queueService.issueOpdToken(db, patient, doctorId);
    tokens.push(detail);
  }
  await models.Token.updateMany({ _id: { $in: tokens.map((t) => t.id) } }, { $set: { is_synthetic: true } });

  const last = tokens[tokens.length - 1];
  res.status(201).json({
    doctorId,
    servicePoint: last ? last.servicePoint : null,
    branch: last ? last.branch : null,
    issued: tokens.map((t) => ({ id: t.id, displayNumber: t.displayNumber, patientsAhead: t.patientsAhead })),
    waitingNow: last ? last.patientsAhead + 1 : 0,
  });
});

module.exports = router;
