'use strict';
/**
 * Waiting-room board data (GET /display?branchId=) for the public /display page: a TV in the
 * waiting area opens it without signing in. It shows only what a waiting-room screen shows —
 * token numbers, room / counter and doctor names, queue sizes and estimated waits — never patient
 * names or other personal data. Mounted before authentication (src/app.js).
 */
const { createRouter } = require('../utils/errors');
const { getDb } = require('../db');
const v = require('../utils/validate');
const operationsService = require('../services/operationsService');

const router = createRouter();

router.get('/display', async (req, res) => {
  const branchId = v.int(req.query.branchId, 'branchId', { min: 1 });
  res.json(await operationsService.displayBoard(getDb(), branchId));
});

module.exports = router;
