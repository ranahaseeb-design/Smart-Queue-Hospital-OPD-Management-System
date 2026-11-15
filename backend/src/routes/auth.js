'use strict';
/** Auth module (FR-01): register, login, profile. */
const { createRouter, notFound, tooManyRequests } = require('../utils/errors');
const config = require('../config');
const { getDb } = require('../db');
const { authenticate, signToken } = require('../middleware/auth');
const userService = require('../services/userService');

const router = createRouter();

router.post('/register', async (req, res) => {
  const db = getDb();
  const row = await userService.register(db, req.body || {});
  res.status(201).json({ token: signToken(row), user: await userService.serializeUser(db, row) });
});

// POST /auth/guest — kiosk walk-in check-in without credentials (demo tools only).
// Rate-limited per client address so the open endpoint cannot mass-create accounts.
const GUEST_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
const guestHits = new Map();
function allowGuest(ip, now = Date.now()) {
  const recent = (guestHits.get(ip) || []).filter((t) => now - t < GUEST_LIMIT.windowMs);
  if (recent.length >= GUEST_LIMIT.max) {
    guestHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  guestHits.set(ip, recent);
  if (guestHits.size > 5000) guestHits.clear();
  return true;
}

router.post('/guest', async (req, res) => {
  if (!config.demoTools) throw notFound('Walk-in guest check-in is not enabled');
  if (!allowGuest(req.ip || 'unknown')) {
    throw tooManyRequests('Too many walk-in check-ins from this device. Please ask the reception desk.');
  }
  const db = getDb();
  const row = await userService.guestCheckIn(db, req.body || {});
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
