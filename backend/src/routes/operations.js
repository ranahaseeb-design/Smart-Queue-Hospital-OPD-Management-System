'use strict';
/**
 * Waiting-room board data (GET /display?branchId=) for the /display page: staff of that branch,
 * its branch admin, hospital admins. Token numbers only, never patient names.
 */
const { createRouter } = require('../utils/errors');
const { getDb } = require('../db');
const v = require('../utils/validate');
const operationsService = require('../services/operationsService');

const router = createRouter();

router.get('/display', async (req, res) => {
  const branchId = v.int(req.query.branchId, 'branchId', { min: 1 });
  res.json(await operationsService.displayBoard(getDb(), req.user, branchId));
});

module.exports = router;
