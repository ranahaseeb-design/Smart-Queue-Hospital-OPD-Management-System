'use strict';
/**
 * Real-time update channel (Socket.IO) — FR-05, FR-15, NFR-01.
 *
 * Connect with io(url, { auth: { token: "<jwt>" } }) — the handshake `auth` payload is the only
 * accepted place for the JWT (not the query string). Each socket joins user:<id>. Every
 * `subscribe` re-reads the user: deactivated accounts are refused and disconnected.
 * Clients send `subscribe` / `unsubscribe` with { room } where room is
 *   token:<id>  (token owner, staff of the branch, admins of the branch)
 *   sp:<id>     (staff assigned to the service point, admins of the branch)
 *   admin       (BRANCH_ADMIN / HOSPITAL_ADMIN)
 * Branch administrators subscribed to `admin` only receive events of their own branch
 * (internally they join admin:branch:<id>; hospital administrators join admin:all).
 */
const { Server } = require('socket.io');
const config = require('../config');
const { userFromToken } = require('../middleware/auth');
const access = require('./accessService');
const { models, asRow } = require('../db');

let io = null;
let dbRef = null;

function corsOrigin(origin, callback) {
  if (!origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) return callback(null, true);
  return callback(null, false);
}

async function authorizeRoom(user, room) {
  if (typeof room !== 'string') return { ok: false, error: 'room must be a string' };
  if (room === 'admin') {
    if (user.role === 'HOSPITAL_ADMIN') return { ok: true, join: ['admin:all'] };
    if (user.role === 'BRANCH_ADMIN') return { ok: true, join: [`admin:branch:${user.admin_branch_id}`] };
    return { ok: false, error: 'Only administrators can subscribe to admin' };
  }
  let m = /^token:(\d+)$/.exec(room);
  if (m) {
    const t = await models.Token.findById(Number(m[1]), { visit_id: 1 }).lean();
    const v = t ? await models.Visit.findById(t.visit_id, { patient_id: 1, branch_id: 1 }).lean() : null;
    const token = t && v ? { token_id: t._id, patient_id: v.patient_id, branch_id: v.branch_id } : null;
    if (!token) return { ok: false, error: 'Token not found' };
    return (await access.canViewToken(dbRef, user, token))
      ? { ok: true, join: [room] }
      : { ok: false, error: 'Not allowed to follow this token' };
  }
  m = /^sp:(\d+)$/.exec(room);
  if (m) {
    if (user.role === 'PATIENT') return { ok: false, error: 'Not allowed to follow this service point' };
    return (await access.canAccessServicePoint(dbRef, user, Number(m[1])))
      ? { ok: true, join: [room] }
      : { ok: false, error: 'Not assigned to this service point' };
  }
  return { ok: false, error: `Unknown room "${room}"` };
}

function init(httpServer, db) {
  dbRef = db;
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use((socket, next) => {
    // Contract: io(url, { auth: { token } }) only. Query-string tokens end up in proxy and
    // access logs, so they are not accepted.
    const auth = socket.handshake.auth;
    const token = auth && typeof auth.token === 'string' ? auth.token : null;
    userFromToken(db, token)
      .then((user) => {
        socket.data.user = user;
        next();
      })
      .catch((err) => next(new Error(err.message || 'Unauthorized')));
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.user_id}`);
    socket.data.joined = new Map(); // public room -> internal rooms

    socket.on('subscribe', async (payload, ack) => {
      const room = typeof payload === 'string' ? payload : payload && payload.room;
      let result;
      let deactivated = false;
      try {
        // Re-read the user on every subscribe: a deactivated account, or one whose role /
        // branch / assignments changed since the handshake, must not join new rooms.
        const fresh = asRow(models.User, await models.User.findById(user.user_id).lean());
        if (!fresh || !fresh.is_active) {
          deactivated = true;
          result = { ok: false, error: 'Account is deactivated' };
        } else {
          socket.data.user = fresh;
          result = await authorizeRoom(fresh, room);
        }
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (deactivated) {
        if (typeof ack === 'function') ack({ ok: false, room, error: result.error });
        socket.disconnect(true);
        return;
      }
      if (result.ok) {
        result.join.forEach((r) => socket.join(r));
        socket.data.joined.set(room, result.join);
      }
      if (typeof ack === 'function') ack(result.ok ? { ok: true, room } : { ok: false, room, error: result.error });
    });

    socket.on('unsubscribe', (payload, ack) => {
      const room = typeof payload === 'string' ? payload : payload && payload.room;
      const internal = socket.data.joined.get(room) || [room];
      internal.forEach((r) => {
        if (r !== `user:${user.user_id}`) socket.leave(r);
      });
      socket.data.joined.delete(room);
      if (typeof ack === 'function') ack({ ok: true, room });
    });
  });
  return io;
}

function adminRooms(branchId) {
  const rooms = ['admin:all'];
  if (branchId) rooms.push(`admin:branch:${branchId}`);
  return rooms;
}

/** queue:updated -> sp:<id>, admin */
function emitQueueUpdated(servicePointId, branchId) {
  if (!io) return;
  io.to([`sp:${servicePointId}`, ...adminRooms(branchId)]).emit('queue:updated', { servicePointId, branchId });
}

/** token:updated -> token:<id>, user:<ownerId> */
function emitTokenUpdated(tokenId, status, ownerId) {
  if (!io) return;
  const rooms = [`token:${tokenId}`];
  if (ownerId) rooms.push(`user:${ownerId}`);
  io.to(rooms).emit('token:updated', { tokenId, status });
}

/** notification -> user:<id> */
function emitNotification(userId, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit('notification', payload);
}

/** alert -> admin */
function emitAlert(alert) {
  if (!io) return;
  io.to(adminRooms(alert.branchId)).emit('alert', alert);
}

function getIo() {
  return io;
}

async function close() {
  if (io) {
    await new Promise((resolve) => io.close(() => resolve()));
    io = null;
  }
}

module.exports = { init, emitQueueUpdated, emitTokenUpdated, emitNotification, emitAlert, getIo, close, authorizeRoom };
