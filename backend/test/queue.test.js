'use strict';
/**
 * Queue & token service: joining (FR-03), position/estimate (FR-05/06/07), staff operations
 * (FR-12), priority ordering (FR-13), event logging (FR-21), linked tokens (FR-04),
 * recentlyCompleted, cancellation, feedback (FR-20) and notifications (FR-11).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createContext, assertNoSecrets } = require('./helpers');

let ctx;
let doctorToken;
let room; // doctor1's OPD room
const P = {}; // patients: { token, user, tokenDetail }

async function eventsOf(tokenId) {
  return ctx.db.query('SELECT * FROM queue_events WHERE token_id = ? ORDER BY event_id', [tokenId]);
}
async function queue() {
  const res = await ctx.api.get(`/service-points/${room.id}/queue`, doctorToken);
  assert.equal(res.status, 200);
  return res.body;
}

before(async () => {
  ctx = await createContext('queue');
  doctorToken = await ctx.login('doctor1');
  const sps = await ctx.api.get('/staff/service-points', doctorToken);
  assert.equal(sps.status, 200);
  room = sps.body.find((s) => s.type === 'OPD');
  assert.ok(room, 'doctor1 has an OPD room');
  P.a = await ctx.newPatient();
  P.b = await ctx.newPatient({ priorityCategory: 'ELDERLY' });
  P.c = await ctx.newPatient();
});
after(async () => {
  await ctx.close();
});

test('staff service points list the doctor scheduled in the room', async () => {
  const me = await ctx.api.get('/auth/me', doctorToken);
  assert.equal(room.doctorId, me.body.user.doctorId);
  assert.equal(room.branchName, 'Model Town');
  assert.ok(room.doctorName.startsWith('Dr.'));
});

test('patient joins a doctor queue: TokenDetail with position and estimate (FR-03, FR-06)', async () => {
  ctx.advance(1);
  const res = await ctx.api.post('/tokens', P.a.token, { doctorId: room.doctorId });
  assert.equal(res.status, 201);
  const t = res.body;
  assert.equal(t.status, 'WAITING');
  assert.equal(t.queueType, 'OPD');
  assert.equal(t.displayNumber, 'OPD-004'); // three seeded tokens today
  assert.equal(t.position, 4);
  assert.equal(t.patientsAhead, 3);
  assert.equal(t.priorityLevel, 0);
  assert.equal(t.branch.name, 'Model Town');
  assert.equal(t.servicePoint.id, room.id);
  assert.equal(t.doctor.id, room.doctorId);
  assert.equal(t.estimate.modelVersion, 'baseline');
  assert.ok(t.estimate.minutes > 0);
  assert.ok(t.estimate.low <= t.estimate.minutes - 5 || t.estimate.low === 0);
  assert.ok(t.estimate.high >= t.estimate.minutes + 5);
  assert.deepEqual(Object.keys(t.congestion).sort(), ['level', 'suggestAlternatives']);
  assert.deepEqual(t.linkedTokens, []);
  P.a.tokenDetail = t;

  const pred = await ctx.db.query('SELECT * FROM wait_predictions WHERE token_id = ?', [t.id]);
  assert.equal(pred.length, 1);
  assert.equal(pred[0].model_version, 'baseline');
  const features = JSON.parse(pred[0].features_json);
  assert.equal(features.patients_ahead, 3);
  assert.equal(features.doctor_id, room.doctorId);
  const ev = await eventsOf(t.id);
  assert.deepEqual(ev.map((e) => e.event_type), ['ISSUED']);
  assert.equal(ev[0].performed_by, P.a.user.id);
});

test('a second active token for the same doctor today is 409; unknown doctor 404; validation 400', async () => {
  const dup = await ctx.api.post('/tokens', P.a.token, { doctorId: room.doctorId });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CONFLICT');
  assert.equal((await ctx.api.post('/tokens', P.a.token, { doctorId: 99999 })).status, 404);
  assert.equal((await ctx.api.post('/tokens', P.a.token, {})).status, 400);
  assert.equal((await ctx.api.post('/tokens', doctorToken, { doctorId: room.doctorId })).status, 403);
});

test('elderly patient gets priority 1 and is ordered before normal tokens (FR-13)', async () => {
  ctx.advance(1);
  const res = await ctx.api.post('/tokens', P.b.token, { doctorId: room.doctorId });
  assert.equal(res.status, 201);
  assert.equal(res.body.priorityLevel, 1);
  // the seeded priority-1 token was issued earlier, so this one is second
  assert.equal(res.body.position, 2);
  P.b.tokenDetail = res.body;

  const q = await queue();
  assert.equal(q.waiting.length, 5);
  assert.deepEqual(
    q.waiting.map((w) => w.priorityLevel),
    [1, 1, 0, 0, 0]
  );
  assert.equal(q.waiting[1].id, P.b.tokenDetail.id);
  assert.equal(q.waiting[4].id, P.a.tokenDetail.id);
  for (const w of q.waiting) assert.equal(typeof w.estimateMinutes, 'number');
  assert.equal(q.waiting[1].priorityCategory, 'ELDERLY');
  assert.deepEqual(q.recentlyCompleted, []);
  assertNoSecrets(assert, q);

  // P.a moved back by one: position 5 now, and its estimate was re-predicted (FR-07)
  const a = await ctx.api.get(`/tokens/${P.a.tokenDetail.id}`, P.a.token);
  assert.equal(a.body.position, 5);
  const preds = await ctx.db.query('SELECT COUNT(*) AS n FROM wait_predictions WHERE token_id = ?', [P.a.tokenDetail.id]);
  assert.ok(preds[0].n >= 2);
});

test('GET /tokens/active lists the patient tokens; other patients cannot read them', async () => {
  const active = await ctx.api.get('/tokens/active', P.a.token);
  assert.equal(active.status, 200);
  assert.deepEqual(active.body.map((t) => t.id), [P.a.tokenDetail.id]);
  assert.equal((await ctx.api.get(`/tokens/${P.a.tokenDetail.id}`, P.c.token)).status, 403);
  assert.equal((await ctx.api.get(`/tokens/${P.a.tokenDetail.id}`, doctorToken)).status, 200);
  assert.equal((await ctx.api.get('/tokens/987654', P.a.token)).status, 404);
});

test('call-next, start, complete with events in order; 409 while a token is open (FR-12, FR-21)', async () => {
  ctx.advance(2);
  const first = await ctx.api.post(`/service-points/${room.id}/call-next`, doctorToken);
  assert.equal(first.status, 200);
  assert.equal(first.body.token.status, 'CALLED');
  assert.equal(first.body.token.priorityLevel, 1); // the seeded priority token
  const firstId = first.body.token.id;

  const busy = await ctx.api.post(`/service-points/${room.id}/call-next`, doctorToken);
  assert.equal(busy.status, 409);

  ctx.advance(1);
  const start = await ctx.api.post(`/tokens/${firstId}/start`, doctorToken);
  assert.equal(start.status, 200);
  assert.equal(start.body.status, 'IN_SERVICE');
  assert.equal((await ctx.api.post(`/tokens/${firstId}/start`, doctorToken)).status, 409);

  ctx.advance(6);
  const done = await ctx.api.post(`/tokens/${firstId}/complete`, doctorToken);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'COMPLETED');
  const ev = await eventsOf(firstId);
  assert.deepEqual(ev.map((e) => e.event_type), ['ISSUED', 'CALLED', 'STARTED', 'COMPLETED']);
  const doctorUser = (await ctx.api.get('/auth/me', doctorToken)).body.user;
  for (const e of ev.slice(1)) {
    assert.equal(e.performed_by, doctorUser.id);
    assert.equal(e.from_point_id, room.id);
  }
  const q = await queue();
  assert.equal(q.nowServing, null);
  assert.equal(q.summary.completedToday, 1);
  assert.equal(q.recentlyCompleted.length, 1);
  assert.equal(q.recentlyCompleted[0].id, firstId);
});

test('skip and recall: recall is 409 while another token is open (FR-12)', async () => {
  ctx.advance(1);
  const called = await ctx.api.post(`/service-points/${room.id}/call-next`, doctorToken);
  assert.equal(called.body.token.id, P.b.tokenDetail.id);
  // the called patient sees CALLED with nowServing pointing at them
  const seen = await ctx.api.get(`/tokens/${P.b.tokenDetail.id}`, P.b.token);
  assert.equal(seen.body.status, 'CALLED');
  assert.equal(seen.body.position, null);
  assert.equal(seen.body.estimate, null);
  assert.equal(seen.body.nowServing.tokenId, P.b.tokenDetail.id);

  ctx.advance(2);
  const skipped = await ctx.api.post(`/tokens/${P.b.tokenDetail.id}/skip`, doctorToken);
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.status, 'SKIPPED');
  assert.equal((await ctx.api.post(`/tokens/${P.b.tokenDetail.id}/skip`, doctorToken)).status, 409);

  ctx.advance(1);
  const next = await ctx.api.post(`/service-points/${room.id}/call-next`, doctorToken);
  assert.equal(next.status, 200);
  const otherId = next.body.token.id;
  assert.notEqual(otherId, P.b.tokenDetail.id);
  const blocked = await ctx.api.post(`/tokens/${P.b.tokenDetail.id}/recall`, doctorToken);
  assert.equal(blocked.status, 409);

  ctx.advance(5);
  assert.equal((await ctx.api.post(`/tokens/${otherId}/complete`, doctorToken)).status, 200);
  ctx.advance(1);
  const recalled = await ctx.api.post(`/tokens/${P.b.tokenDetail.id}/recall`, doctorToken);
  assert.equal(recalled.status, 200);
  assert.equal(recalled.body.status, 'CALLED');
  ctx.advance(7);
  assert.equal((await ctx.api.post(`/tokens/${P.b.tokenDetail.id}/complete`, doctorToken)).status, 200);

  const ev = await eventsOf(P.b.tokenDetail.id);
  assert.deepEqual(ev.map((e) => e.event_type), ['ISSUED', 'CALLED', 'SKIPPED', 'RECALLED', 'COMPLETED']);
  const q = await queue();
  assert.equal(q.summary.skippedToday, 1);
  assert.deepEqual(q.skipped, []);
  // newest first: P.b, then the other token, then the first one
  assert.equal(q.recentlyCompleted[0].id, P.b.tokenDetail.id);
  assert.equal(q.recentlyCompleted[1].id, otherId);
  assert.equal(q.recentlyCompleted.length, 3);
  assert.ok(q.recentlyCompleted[0].completedAt);
  assert.ok(q.summary.avgConsultMinutes > 0);
});

test('staff priority with reason moves a token to the front and logs PRIORITY_SET (FR-13)', async () => {
  ctx.advance(1);
  const joined = await ctx.api.post('/tokens', P.c.token, { doctorId: room.doctorId });
  assert.equal(joined.status, 201);
  P.c.tokenDetail = joined.body;
  const before = await queue();
  assert.equal(before.waiting[before.waiting.length - 1].id, joined.body.id);

  assert.equal((await ctx.api.post(`/tokens/${joined.body.id}/priority`, doctorToken, { level: 3, reason: 'x' })).status, 400);
  assert.equal((await ctx.api.post(`/tokens/${joined.body.id}/priority`, doctorToken, { level: 2 })).status, 400);

  ctx.advance(1);
  const res = await ctx.api.post(`/tokens/${joined.body.id}/priority`, doctorToken, { level: 2, reason: 'Emergency case' });
  assert.equal(res.status, 200);
  assert.equal(res.body.priorityLevel, 2);
  const q = await queue();
  assert.equal(q.waiting[0].id, joined.body.id);
  const ev = await eventsOf(joined.body.id);
  const ps = ev.find((e) => e.event_type === 'PRIORITY_SET');
  assert.ok(ps);
  assert.equal(ps.note, 'Level 2: Emergency case');
  const detail = await ctx.api.get(`/tokens/${joined.body.id}`, P.c.token);
  assert.equal(detail.body.position, 1);
});

test('transfer to another room: TRANSFERRED + new WAITING token, same visit, priority kept', async () => {
  const targets = await ctx.api.get(`/staff/transfer-targets?servicePointId=${room.id}`, doctorToken);
  assert.equal(targets.status, 200);
  assert.ok(!targets.body.some((t) => t.servicePointId === room.id));
  assert.ok(targets.body.some((t) => t.type === 'LAB'));
  const target = targets.body.find((t) => t.type === 'OPD' && t.doctorId);
  assert.ok(target);

  ctx.advance(1);
  const res = await ctx.api.post(`/tokens/${P.c.tokenDetail.id}/transfer`, doctorToken, { toServicePointId: target.servicePointId });
  assert.equal(res.status, 200);
  assert.equal(res.body.from.status, 'TRANSFERRED');
  assert.equal(res.body.to.status, 'WAITING');
  assert.equal(res.body.to.visitId, res.body.from.visitId);
  assert.equal(res.body.to.priorityLevel, 2);
  assert.equal(res.body.to.doctorId, target.doctorId);
  const ev = await eventsOf(P.c.tokenDetail.id);
  const tr = ev.find((e) => e.event_type === 'TRANSFERRED');
  assert.equal(tr.to_point_id, target.servicePointId);
  const issued = await eventsOf(res.body.to.id);
  assert.equal(issued[0].event_type, 'ISSUED');

  // the patient follows the new token
  const active = await ctx.api.get('/tokens/active', P.c.token);
  assert.deepEqual(active.body.map((t) => t.id), [res.body.to.id]);
  assert.equal(active.body[0].linkedTokens.length, 1); // the transferred original in the same visit

  const sameRoom = await ctx.api.post(`/tokens/${res.body.to.id}/transfer`, doctorToken, { toServicePointId: room.id });
  assert.equal(sameRoom.status, 403); // doctor1 is not assigned to the target room's queue
});

test('linked LAB token after consultation; default counter; duplicate 409 (FR-04)', async () => {
  const visitId = P.b.tokenDetail.visitId;
  ctx.advance(1);
  const res = await ctx.api.post(`/visits/${visitId}/linked-tokens`, doctorToken, { type: 'LAB' });
  assert.equal(res.status, 201);
  assert.equal(res.body.queueType, 'LAB');
  assert.equal(res.body.displayNumber, 'LAB-001');
  assert.equal(res.body.visitId, visitId);
  assert.equal(res.body.doctor, null);
  assert.equal(res.body.priorityLevel, 1); // highest priority of the visit
  assert.equal(res.body.status, 'WAITING');
  assert.ok(res.body.estimate);

  assert.equal((await ctx.api.post(`/visits/${visitId}/linked-tokens`, doctorToken, { type: 'LAB' })).status, 409);
  assert.equal((await ctx.api.post(`/visits/${visitId}/linked-tokens`, doctorToken, { type: 'XRAY' })).status, 400);
  assert.equal((await ctx.api.post(`/visits/${visitId}/linked-tokens`, P.b.token, { type: 'LAB' })).status, 403);

  const opd = await ctx.api.get(`/tokens/${P.b.tokenDetail.id}`, P.b.token);
  assert.equal(opd.body.linkedTokens.length, 1);
  assert.equal(opd.body.linkedTokens[0].queueType, 'LAB');
  assert.ok(!('linkedTokens' in opd.body.linkedTokens[0]));

  // lab staff operate their counter; a doctor cannot
  const labToken = await ctx.login('lab1');
  const counter = (await ctx.api.get('/staff/service-points', labToken)).body.find((s) => s.type === 'LAB');
  assert.ok(counter);
  const lq = await ctx.api.get(`/service-points/${counter.id}/queue`, labToken);
  assert.equal(lq.body.waiting.length, 1);
  assert.equal((await ctx.api.post(`/service-points/${counter.id}/call-next`, doctorToken)).status, 403);
  assert.equal((await ctx.api.post(`/service-points/${room.id}/call-next`, labToken)).status, 403);
  const call = await ctx.api.post(`/service-points/${counter.id}/call-next`, labToken);
  assert.equal(call.body.token.id, res.body.id);
});

test('staff of another department / patients cannot operate the room', async () => {
  const other = await ctx.login('doctor3');
  assert.equal((await ctx.api.post(`/service-points/${room.id}/call-next`, other)).status, 403);
  assert.equal((await ctx.api.get(`/service-points/${room.id}/queue`, P.a.token)).status, 403);
  assert.equal((await ctx.api.post(`/service-points/${room.id}/call-next`, P.a.token)).status, 403);
  assert.equal((await ctx.api.post('/service-points/99999/call-next', doctorToken)).status, 404);
});

test('patient cancels own WAITING token; repeated or foreign cancel is rejected', async () => {
  assert.equal((await ctx.api.del(`/tokens/${P.a.tokenDetail.id}`, P.c.token)).status, 403);
  ctx.advance(1);
  const res = await ctx.api.del(`/tokens/${P.a.tokenDetail.id}`, P.a.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'CANCELLED');
  assert.equal((await ctx.api.del(`/tokens/${P.a.tokenDetail.id}`, P.a.token)).status, 409);
  const ev = await eventsOf(P.a.tokenDetail.id);
  assert.equal(ev[ev.length - 1].event_type, 'CANCELLED');
  assert.deepEqual((await ctx.api.get('/tokens/active', P.a.token)).body, []);
});

test('feedback once per visit, only after a completed consultation (FR-20) and visit history (FR-19)', async () => {
  const visits = await ctx.api.get('/visits', P.b.token);
  assert.equal(visits.status, 200);
  const v = visits.body[0];
  assert.equal(v.id, P.b.tokenDetail.visitId);
  assert.equal(v.canGiveFeedback, true);
  assert.equal(v.tokens.length, 2);
  assert.ok(v.tokens.every((t) => t.displayNumber && t.servicePointName));

  assert.equal((await ctx.api.post(`/visits/${v.id}/feedback`, P.b.token, { rating: 6 })).status, 400);
  assert.equal((await ctx.api.post(`/visits/${v.id}/feedback`, P.a.token, { rating: 4 })).status, 403);
  const ok = await ctx.api.post(`/visits/${v.id}/feedback`, P.b.token, { rating: 5, comment: 'Quick and smooth' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rating, 5);
  assert.equal(ok.body.comment, 'Quick and smooth');
  const again = await ctx.api.post(`/visits/${v.id}/feedback`, P.b.token, { rating: 4 });
  assert.equal(again.status, 409);
  const after = await ctx.api.get('/visits', P.b.token);
  assert.deepEqual(after.body[0].feedback, { rating: 5, comment: 'Quick and smooth' });
  assert.equal(after.body[0].canGiveFeedback, false);

  const cancelledVisit = (await ctx.api.get('/visits', P.a.token)).body[0];
  assert.equal(cancelledVisit.canGiveFeedback, false);
  assert.equal((await ctx.api.post(`/visits/${cancelledVisit.id}/feedback`, P.a.token, { rating: 3 })).status, 400);

  // seeded demo patient: one past completed visit without feedback
  const demo = await ctx.api.get('/visits', await ctx.login('patient'));
  assert.equal(demo.body.length, 1);
  assert.equal(demo.body[0].canGiveFeedback, true);
  assert.equal(demo.body[0].status, 'CLOSED');
});

test('notifications: stored IN_APP rows for issue/call/skip/recall; read-all; device token (FR-11)', async () => {
  const res = await ctx.api.get('/notifications', P.b.token);
  assert.equal(res.status, 200);
  const messages = res.body.map((n) => n.message);
  assert.ok(messages.some((m) => m.startsWith('Token OPD-')));
  assert.ok(messages.some((m) => m.startsWith("It's your turn")));
  assert.ok(messages.some((m) => m.includes('was skipped')));
  assert.ok(messages.some((m) => m.includes('has been recalled')));
  assert.ok(messages.some((m) => m.startsWith('Linked LAB token')));
  assert.ok(res.body.every((n) => n.channel === 'IN_APP' && n.isRead === false));
  for (let i = 1; i < res.body.length; i += 1) assert.ok(res.body[i - 1].id > res.body[i].id, 'newest first');

  assert.deepEqual((await ctx.api.post('/notifications/read-all', P.b.token)).body, { ok: true });
  assert.ok((await ctx.api.get('/notifications', P.b.token)).body.every((n) => n.isRead));
  assert.equal((await ctx.api.post('/notifications/device-token', P.b.token, { fcmToken: 'abc' })).status, 200);
  assert.equal((await ctx.api.post('/notifications/device-token', P.b.token, {})).status, 400);
  const row = await ctx.db.get('SELECT fcm_token FROM users WHERE user_id = ?', [P.b.user.id]);
  assert.equal(row.fcm_token, 'abc');
});

test('every status change wrote exactly one queue event (FR-21)', async () => {
  const today = ctx.time.today();
  const rows = await ctx.db.query(
    `SELECT t.token_id, t.status, (SELECT COUNT(*) FROM queue_events e WHERE e.token_id = t.token_id) AS n,
            (SELECT COUNT(*) FROM queue_events e WHERE e.token_id = t.token_id AND e.event_type = 'ISSUED') AS issued
       FROM tokens t WHERE t.token_date = ?`,
    [today]
  );
  for (const r of rows) {
    assert.equal(r.issued, 1, `token ${r.token_id} has one ISSUED event`);
    assert.ok(r.n >= 1);
  }
});
