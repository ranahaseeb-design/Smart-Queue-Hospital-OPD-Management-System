'use strict';
/** Staff module (FR-04, FR-12, FR-13): assigned service points, live queue, call next, transfer targets. */
const { createRouter } = require('../utils/errors');
const { getDb } = require('../db');
const v = require('../utils/validate');
const { requireRole } = require('../middleware/auth');
const queueService = require('../services/queueService');

const router = createRouter();
const staffOnly = requireRole('STAFF');

router.get('/staff/service-points', staffOnly, async (req, res) => {
  res.json(await queueService.staffServicePoints(getDb(), req.user));
});

router.get('/staff/transfer-targets', requireRole('STAFF', 'BRANCH_ADMIN', 'HOSPITAL_ADMIN'), async (req, res) => {
  const servicePointId = v.int(req.query.servicePointId, 'servicePointId', { required: true, min: 1 });
  res.json(await queueService.transferTargets(getDb(), req.user, servicePointId));
});

// Live queue: assigned staff, and admins of the branch (read-only monitoring).
router.get(
  '/service-points/:id/queue',
  requireRole('STAFF', 'BRANCH_ADMIN', 'HOSPITAL_ADMIN'),
  async (req, res) => {
    res.json(await queueService.servicePointQueue(getDb(), req.user, v.id(req.params.id)));
  }
);

router.post('/service-points/:id/call-next', staffOnly, async (req, res) => {
  res.json(await queueService.callNext(getDb(), req.user, v.id(req.params.id)));
});

module.exports = router;
