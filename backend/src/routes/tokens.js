'use strict';
/**
 * Token routes: patient operations (FR-03, FR-05, FR-06, FR-07) and staff token actions
 * (FR-12, FR-13). Service-point level actions live in routes/staff.js.
 */
const { createRouter, forbidden, badRequest } = require('../utils/errors');
const { getDb } = require('../db');
const v = require('../utils/validate');
const { requireRole } = require('../middleware/auth');
const access = require('../services/accessService');
const queueService = require('../services/queueService');

const router = createRouter();
const patientOnly = requireRole('PATIENT');
const staffOnly = requireRole('STAFF');

// POST /tokens — join a doctor's OPD queue (FR-03).
router.post('/', patientOnly, async (req, res) => {
  const doctorId = v.int((req.body || {}).doctorId, 'doctorId', { required: true, min: 1 });
  const detail = await queueService.issueOpdToken(getDb(), req.user, doctorId);
  res.status(201).json(detail);
});

// GET /tokens/active — patient's active tokens in all queues (FR-05).
router.get('/active', patientOnly, async (req, res) => {
  res.json(await queueService.activeTokensForPatient(getDb(), req.user.user_id));
});

// GET /tokens/:id — TokenDetail (owner, staff, admins).
router.get('/:id', async (req, res) => {
  const db = getDb();
  const row = await queueService.requireTokenRow(db, v.id(req.params.id));
  if (!(await access.canViewToken(db, req.user, row))) throw forbidden('You cannot view this token');
  res.json(await queueService.buildTokenDetail(db, row));
});

// DELETE /tokens/:id — patient cancels own WAITING token.
router.delete('/:id', patientOnly, async (req, res) => {
  res.json(await queueService.cancelToken(getDb(), req.user, v.id(req.params.id)));
});

// Staff token actions (FR-12).
router.post('/:id/start', staffOnly, async (req, res) => {
  res.json(await queueService.startToken(getDb(), req.user, v.id(req.params.id)));
});

router.post('/:id/skip', staffOnly, async (req, res) => {
  res.json(await queueService.skipToken(getDb(), req.user, v.id(req.params.id)));
});

router.post('/:id/recall', staffOnly, async (req, res) => {
  res.json(await queueService.recallToken(getDb(), req.user, v.id(req.params.id)));
});

router.post('/:id/complete', staffOnly, async (req, res) => {
  res.json(await queueService.completeToken(getDb(), req.user, v.id(req.params.id)));
});

router.post('/:id/transfer', staffOnly, async (req, res) => {
  const body = req.body || {};
  const toServicePointId = v.int(body.toServicePointId, 'toServicePointId', { required: true, min: 1 });
  const toDoctorId = v.int(body.toDoctorId, 'toDoctorId', { min: 1 });
  res.json(await queueService.transferToken(getDb(), req.user, v.id(req.params.id), { toServicePointId, toDoctorId }));
});

// FR-13: staff-applied priority with a recorded reason.
router.post('/:id/priority', staffOnly, async (req, res) => {
  const body = req.body || {};
  const level = v.int(body.level, 'level', { required: true, min: 0, max: 2 });
  const reason = v.str(body.reason, 'reason', { required: true, max: 200 });
  if (!reason) throw badRequest('reason is required');
  res.json(await queueService.setPriority(getDb(), req.user, v.id(req.params.id), level, reason));
});

module.exports = router;
