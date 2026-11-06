'use strict';
/**
 * Token numbering / visit creation under concurrency (review item: MySQL REPEATABLE READ race).
 *
 * MySQL is not available in the test environment, so this file checks the adapter helpers and
 * records the statements each queue transaction runs: the service point lock(s) must be the
 * FIRST statements (ascending id, before any plain SELECT that would fix the InnoDB snapshot
 * and before any token row lock), the patient row is locked before a visit is created and
 * MAX(token_number) is read with a locking read.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers');
const { withForUpdate, MysqlAdapter } = require('../src/db/mysql');

let ctx;
let doctorToken;
let room;
let doctor2Id;
let log = null; // statements of the transactions run while recording

function recordingTx(tx, txLog) {
  const wrapped = { ...tx };
  for (const m of ['query', 'get', 'run', 'getForUpdate']) {
    wrapped[m] = async (sql, params) => {
      txLog.push({ m, sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return tx[m](sql, params);
    };
  }
  wrapped.lockRow = async (table, col, id) => {
    txLog.push({ m: 'lockRow', table, id: Number(id) });
    return tx.lockRow(table, col, id);
  };
  wrapped.transaction = async (fn) => fn(wrapped);
  return wrapped;
}

async function recordTransactions(fn) {
  const original = ctx.db.transaction;
  log = [];
  ctx.db.transaction = (body) =>
    original.call(ctx.db, (tx) => {
      const txLog = [];
      log.push(txLog);
      return body(recordingTx(tx, txLog));
    });
  try {
    return await fn();
  } finally {
    ctx.db.transaction = original;
  }
}

/** The transaction (statement list) that inserted a token. */
function tokenInsertingTx() {
  const found = log.find((t) => t.some((s) => s.m === 'run' && /^INSERT INTO tokens/.test(s.sql)));
  assert.ok(found, 'a transaction inserted a token');
  return found;
}

function assertServicePointLocksFirst(txLog, expectedIds) {
  const leading = [];
  for (const s of txLog) {
    if (s.m === 'lockRow' && s.table === 'service_points') leading.push(s.id);
    else break;
  }
  assert.deepEqual(leading, expectedIds, 'service point locks are the first statements, ascending');
  const maxRead = txLog.find((s) => /MAX\(token_number\)/.test(s.sql || ''));
  assert.ok(maxRead, 'token number computed');
  assert.equal(maxRead.m, 'getForUpdate', 'MAX(token_number) is a locking read');
}

before(async () => {
  ctx = await createContext('locking');
  doctorToken = await ctx.login('doctor1');
  room = (await ctx.api.get('/staff/service-points', doctorToken)).body.find((s) => s.type === 'OPD');
  const d2 = await ctx.db.get(
    `SELECT d.doctor_id FROM doctors d JOIN users u ON u.user_id = d.user_id WHERE u.email = 'doctor2@opd.test'`
  );
  doctor2Id = d2.doctor_id;
});
after(async () => {
  await ctx.close();
});

test('withForUpdate appends FOR UPDATE once; SQLite getForUpdate leaves SQL unchanged', async () => {
  assert.equal(withForUpdate('SELECT 1 AS n'), 'SELECT 1 AS n FOR UPDATE');
  assert.equal(withForUpdate('  SELECT 1 AS n;  '), 'SELECT 1 AS n FOR UPDATE');
  assert.equal(withForUpdate('SELECT 1 FOR UPDATE'), 'SELECT 1 FOR UPDATE');
  const row = await ctx.db.getForUpdate('SELECT 7 AS n', []);
  assert.equal(row.n, 7);
  const inTx = await ctx.db.transaction((tx) => tx.getForUpdate('SELECT 8 AS n', []));
  assert.equal(inTx.n, 8);
});

test('MySQL adapter getForUpdate sends a locking read (pool never connects)', async () => {
  const adapter = new MysqlAdapter({ host: '127.0.0.1', port: 9, user: 'x', password: 'x', database: 'x' });
  const seen = [];
  adapter.query = async (sql) => {
    seen.push(sql);
    return [{ n: 3 }];
  };
  const row = await adapter.getForUpdate('SELECT MAX(token_number) AS n FROM tokens WHERE service_point_id = ?', [1]);
  assert.equal(row.n, 3);
  assert.match(seen[0], /FOR UPDATE$/);
  await adapter.close();
});

test('issuing an OPD token locks service point -> doctor -> patient before any read', async () => {
  const p = await ctx.newPatient();
  const res = await recordTransactions(() => ctx.api.post('/tokens', p.token, { doctorId: room.doctorId }));
  assert.equal(res.status, 201);
  const txLog = tokenInsertingTx();
  assertServicePointLocksFirst(txLog, [room.id]);
  assert.deepEqual(
    txLog.slice(1, 3).map((s) => [s.table, s.id]),
    [
      ['doctors', room.doctorId],
      ['users', p.user.id],
    ]
  );
  const visitRead = txLog.findIndex((s) => /FROM visits/.test(s.sql || ''));
  assert.ok(visitRead > 2, 'visit lookup happens after the patient lock');
});

test('concurrent joins get distinct numbers; one patient gets one OPEN visit for two doctors', async () => {
  const patients = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.newPatient()));
  const results = await Promise.all(patients.map((p) => ctx.api.post('/tokens', p.token, { doctorId: room.doctorId })));
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
  const numbers = results.map((r) => r.body.tokenNumber ?? r.body.displayNumber);
  assert.equal(new Set(numbers).size, numbers.length);

  const p = await ctx.newPatient();
  const [a, b] = await Promise.all([
    ctx.api.post('/tokens', p.token, { doctorId: room.doctorId }),
    ctx.api.post('/tokens', p.token, { doctorId: doctor2Id }),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.visitId, b.body.visitId);
  const open = await ctx.db.get(`SELECT COUNT(*) AS n FROM visits WHERE patient_id = ? AND status = 'OPEN'`, [p.user.id]);
  assert.equal(Number(open.n), 1);
});

test('transfer locks both service points (ascending) before the token row; same-room transfer works', async () => {
  const p = await ctx.newPatient();
  const issued = await ctx.api.post('/tokens', p.token, { doctorId: room.doctorId });
  assert.equal(issued.status, 201);
  ctx.advance(1);
  // A same-room transfer to another doctor needs that doctor to work in the room today.
  const { insertId: shared } = await ctx.db.run(
    `INSERT INTO doctor_schedules (doctor_id, service_point_id, day_of_week, start_time, end_time, max_patients)
     VALUES (?, ?, ?, '06:00:00', '07:00:00', NULL)`,
    [doctor2Id, room.id, ctx.time.isoDow(ctx.time.clock.now())]
  );
  const res = await recordTransactions(() =>
    ctx.api.post(`/tokens/${issued.body.id}/transfer`, doctorToken, { toServicePointId: room.id, toDoctorId: doctor2Id })
  );
  await ctx.db.run('DELETE FROM doctor_schedules WHERE schedule_id = ?', [shared]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const txLog = tokenInsertingTx();
  assertServicePointLocksFirst(txLog, [room.id]);
  const firstTokenWrite = txLog.findIndex((s) => s.m === 'run' && /^UPDATE tokens/.test(s.sql));
  assert.ok(firstTokenWrite > 0);
  assert.ok(!txLog.slice(firstTokenWrite).some((s) => s.m === 'lockRow'), 'no lock taken after the token row lock');

  // Cross-room transfer: both rooms locked, ascending.
  const lab = await ctx.db.get(
    `SELECT service_point_id FROM service_points WHERE branch_id = (SELECT branch_id FROM service_points WHERE service_point_id = ?) AND type = 'LAB'`,
    [room.id]
  );
  const p2 = await ctx.newPatient();
  const issued2 = await ctx.api.post('/tokens', p2.token, { doctorId: room.doctorId });
  ctx.advance(1);
  const res2 = await recordTransactions(() =>
    ctx.api.post(`/tokens/${issued2.body.id}/transfer`, doctorToken, { toServicePointId: lab.service_point_id })
  );
  assert.equal(res2.status, 200, JSON.stringify(res2.body));
  const expected = [room.id, lab.service_point_id].sort((x, y) => x - y);
  assertServicePointLocksFirst(tokenInsertingTx(), expected);
});

test('linked token takes the counter lock before its duplicate check', async () => {
  const p = await ctx.newPatient();
  const issued = await ctx.api.post('/tokens', p.token, { doctorId: room.doctorId });
  const res = await recordTransactions(() =>
    ctx.api.post(`/visits/${issued.body.visitId}/linked-tokens`, doctorToken, { type: 'PHARMACY' })
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assertServicePointLocksFirst(tokenInsertingTx(), [res.body.servicePoint.id]);
});
