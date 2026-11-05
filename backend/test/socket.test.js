'use strict';
/**
 * Real-time channel (FR-05, NFR-01): JWT handshake, automatic user:<id> room, subscribe /
 * unsubscribe authorisation per contract, and delivery of queue:updated, token:updated and
 * notification events after REST changes. Runs the real HTTP + Socket.IO server on a free port.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { configureEnv } = require('./helpers');

let server;
let baseUrl;
let time;
let tmpDir;
const sockets = [];
const tokens = {};

async function http(method, path, token, body) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(identifier, password) {
  const res = await http('POST', '/auth/login', null, { identifier, password });
  assert.equal(res.status, 200);
  return res.body;
}

function open(token) {
  const socket = connect(baseUrl, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
  sockets.push(socket);
  return socket;
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

function subscribe(socket, room) {
  return new Promise((resolve) => socket.emit('subscribe', { room }, resolve));
}

/** Resolve with the first `event` payload matching `predicate`, or reject after `ms`. */
function waitFor(socket, event, predicate = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, ms);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Resolve true if `event` arrives within ms, false otherwise. */
function arrives(socket, event, ms = 600) {
  return waitFor(socket, event, () => true, ms).then(
    () => true,
    () => false
  );
}

before(async () => {
  tmpDir = configureEnv('socket');
  time = require('../src/utils/time');
  const now = new Date();
  time.clock.set(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0));
  const { getDb, createSchema } = require('../src/db');
  const { seed } = require('../src/db/seed');
  const db = getDb();
  await createSchema(db);
  await seed(db, { historyDays: 2, logger: null });
  const { startServer } = require('../src/server');
  server = await startServer({ port: 0, host: '127.0.0.1', jobsEnabled: false, logger: { log() {}, error() {} } });
  baseUrl = `http://127.0.0.1:${server.port}`;
  for (const [key, id, pw] of [
    ['doctor1', 'doctor1@opd.test', 'Staff@123'],
    ['admin', 'admin@opd.test', 'Admin@123'],
    ['branchAdmin', 'branchadmin@opd.test', 'Admin@123'],
  ]) {
    tokens[key] = await login(id, pw);
  }
  const reg = await http('POST', '/auth/register', null, { fullName: 'Socket Patient', email: 'socket.p@example.com', password: 'secret1' });
  tokens.patient = reg.body;
  const reg2 = await http('POST', '/auth/register', null, { fullName: 'Other Patient', email: 'socket.q@example.com', password: 'secret1' });
  tokens.other = reg2.body;
});

after(async () => {
  for (const s of sockets) s.close();
  if (server) await server.stop();
  time.clock.reset();
  try {
    require('node:fs').rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }
});

test('handshake requires a valid JWT', async () => {
  await assert.rejects(connected(open(null)), /Authentication required/);
  await assert.rejects(connected(open('garbage')), /Invalid or expired token/);
});

test('JWT in the query string is not accepted (handshake auth only)', async () => {
  const socket = connect(baseUrl, {
    query: { token: tokens.patient.token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  await assert.rejects(connected(socket), /Authentication required/);
});

test('subscribe re-checks the account: a deactivated user is refused and disconnected', async () => {
  const reg = await http('POST', '/auth/register', null, {
    fullName: 'Soon Inactive',
    email: 'socket.r@example.com',
    password: 'secret1',
  });
  const socket = open(reg.body.token);
  await connected(socket);
  const { getDb } = require('../src/db');
  await getDb().run('UPDATE users SET is_active = 0 WHERE user_id = ?', [reg.body.user.id]);
  const gone = new Promise((resolve) => socket.once('disconnect', resolve));
  const ack = await subscribe(socket, 'token:1');
  assert.equal(ack.ok, false);
  assert.match(ack.error, /deactivated/);
  await gone;
});

test('subscribe authorisation follows the contract rooms', async () => {
  const doctorRoom = tokens.doctor1.user.assignments[0].servicePointId;
  const patient = open(tokens.patient.token);
  await connected(patient);
  assert.equal((await subscribe(patient, `sp:${doctorRoom}`)).ok, false);
  assert.equal((await subscribe(patient, 'admin')).ok, false);
  assert.equal((await subscribe(patient, 'bogus')).ok, false);

  const doctor = open(tokens.doctor1.token);
  await connected(doctor);
  assert.deepEqual(await subscribe(doctor, `sp:${doctorRoom}`), { ok: true, room: `sp:${doctorRoom}` });
  assert.equal((await subscribe(doctor, `sp:${doctorRoom + 1}`)).ok, false); // another doctor's room
  assert.equal((await subscribe(doctor, 'admin')).ok, false);

  const branchAdmin = open(tokens.branchAdmin.token);
  await connected(branchAdmin);
  assert.equal((await subscribe(branchAdmin, 'admin')).ok, true);
  assert.equal((await subscribe(branchAdmin, `sp:${doctorRoom}`)).ok, true);
  assert.equal((await subscribe(branchAdmin, 'sp:13')).ok, false); // Gulberg room
});

test('REST changes are pushed: queue:updated, notification, token:updated', async () => {
  const doctorRoom = tokens.doctor1.user.assignments[0].servicePointId;
  const doctorId = tokens.doctor1.user.doctorId;

  const staff = open(tokens.doctor1.token);
  await connected(staff);
  assert.equal((await subscribe(staff, `sp:${doctorRoom}`)).ok, true);
  const admin = open(tokens.admin.token);
  await connected(admin);
  assert.equal((await subscribe(admin, 'admin')).ok, true);
  const patient = open(tokens.patient.token);
  await connected(patient);
  const other = open(tokens.other.token);
  await connected(other);

  const staffUpdate = waitFor(staff, 'queue:updated', (p) => p.servicePointId === doctorRoom);
  const adminUpdate = waitFor(admin, 'queue:updated', (p) => p.servicePointId === doctorRoom);
  const notification = waitFor(patient, 'notification', (n) => n.message.startsWith('Token OPD-'));
  const res = await http('POST', '/tokens', tokens.patient.token, { doctorId });
  assert.equal(res.status, 201);
  assert.deepEqual(await staffUpdate, { servicePointId: doctorRoom, branchId: 1 });
  assert.deepEqual(await adminUpdate, { servicePointId: doctorRoom, branchId: 1 });
  const n = await notification;
  assert.equal(n.tokenId, res.body.id);
  assert.ok(n.id > 0);

  // the patient follows their own token; another patient may not
  assert.equal((await subscribe(patient, `token:${res.body.id}`)).ok, true);
  assert.equal((await subscribe(other, `token:${res.body.id}`)).ok, false);

  // calling the first three patients moves this patient up: token:updated reaches them
  const moved = waitFor(patient, 'token:updated', (p) => p.tokenId === res.body.id);
  time.clock.advance(60 * 1000);
  const called = await http('POST', `/service-points/${doctorRoom}/call-next`, tokens.doctor1.token);
  assert.equal(called.status, 200);
  assert.deepEqual(await moved, { tokenId: res.body.id, status: 'WAITING' });
  assert.equal(await arrives(other, 'token:updated'), false);
});

test('unsubscribe stops room events', async () => {
  const doctorRoom = tokens.doctor1.user.assignments[0].servicePointId;
  const staff = open(tokens.doctor1.token);
  await connected(staff);
  await subscribe(staff, `sp:${doctorRoom}`);
  await new Promise((resolve) => staff.emit('unsubscribe', { room: `sp:${doctorRoom}` }, resolve));
  const p = await http('POST', '/auth/register', null, { fullName: 'Late Patient', email: 'late@example.com', password: 'secret1' });
  const pending = arrives(staff, 'queue:updated');
  const res = await http('POST', '/tokens', p.body.token, { doctorId: tokens.doctor1.user.doctorId });
  assert.equal(res.status, 201);
  assert.equal(await pending, false);
});
