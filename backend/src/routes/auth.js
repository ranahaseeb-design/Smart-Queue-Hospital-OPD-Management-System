'use strict';
/** Auth module (FR-01): register, login, profile. */
const { createRouter } = require('../utils/errors');
const { getDb } = require('../db');
const { authenticate, signToken } = require('../middleware/auth');
const userService = require('../services/userService');

const router = createRouter();

router.post('/register', async (req, res) => {
  const db = getDb();
  const row = await userService.register(db, req.body || {});
  res.status(201).json({ token: signToken(row), user: await userService.serializeUser(db, row) });
});

router.post('/login', async (req, res) => {
  const db = getDb();
  const row = await userService.login(db, req.body || {});
  res.json({ token: signToken(row), user: await userService.serializeUser(db, row) });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: await userService.serializeUser(getDb(), req.user) });
});

router.put('/me', authenticate, async (req, res) => {
  const db = getDb();
  const row = await userService.updateMe(db, req.user, req.body || {});
  res.json({ user: await userService.serializeUser(db, row) });
});

module.exports = router;
