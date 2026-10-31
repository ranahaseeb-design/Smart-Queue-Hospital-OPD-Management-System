'use strict';
/**
 * JWT authentication and role guards (FR-01, NFR-04).
 * The token carries { sub: userId, role }; the user row is re-loaded on every request so
 * deactivated accounts and role changes take effect immediately.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db');
const { unauthorized, forbidden } = require('../utils/errors');

function signToken(user) {
  return jwt.sign({ sub: user.user_id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Verify a JWT and load the active user row, or throw 401. */
async function userFromToken(db, token) {
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch (_) {
    throw unauthorized('Invalid or expired token');
  }
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', [Number(payload.sub)]);
  if (!user) throw unauthorized('User no longer exists');
  if (!user.is_active) throw unauthorized('Account is deactivated');
  return user;
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  userFromToken(getDb(), match ? match[1].trim() : null)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    return next();
  };
}

module.exports = { signToken, userFromToken, authenticate, requireRole };
