'use strict';
/**
 * Data layer checks that need no MongoDB server: model schemas (integer ids, enums, nullable
 * fields), the indexes of database/MONGODB_DESIGN.md, URI handling and time helpers.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureEnv, withDbName } = require('./helpers');

configureEnv('datalayer');
const models = require('../src/db/models');
const { dbNameOf } = require('../src/db/connection');
const time = require('../src/utils/time');

const indexesOf = (Model) => Model.schema.indexes().map(([fields, opts]) => ({ fields, opts }));
const findIndex = (Model, fields) =>
  indexesOf(Model).find((i) => JSON.stringify(i.fields) === JSON.stringify(fields) && i.opts.unique);

test('every collection of the design has a model with the snake_case collection name', () => {
  const names = models.ALL_MODELS.map((m) => m.collection.collectionName).sort();
  assert.deepEqual(names, [
    'appointments', 'branches', 'counters', 'departments', 'doctor_schedules', 'doctors', 'feedback', 'forecasts',
    'model_versions', 'notifications', 'queue_events', 'service_points', 'settings', 'staff_assignments', 'tokens',
    'users', 'visits', 'wait_predictions',
  ]);
  assert.equal(models.Token.pk, 'token_id');
  assert.equal(models.User.pk, 'user_id');
});

test('integer _id, enums and Date fields are validated by the schemas', () => {
  const ok = new models.Token({
    _id: 1,
    visit_id: 1,
    service_point_id: 1,
    token_number: 1,
    token_date: '2026-11-10',
    queue_type: 'OPD',
    issued_at: new Date(),
  });
  assert.equal(ok.validateSync(), undefined);
  assert.equal(ok.status, 'WAITING');
  assert.equal(ok.priority_level, 0);
  assert.equal(ok.is_synthetic, false);
  assert.equal(ok.doctor_id, null);
  assert.equal(ok.appointment_id, null);

  const badId = new models.Token({ ...ok.toObject(), _id: 1.5 });
  assert.ok(badId.validateSync().errors._id);
  const badStatus = new models.Token({ ...ok.toObject(), status: 'LOST' });
  assert.ok(badStatus.validateSync().errors.status);
  const badEvent = new models.QueueEvent({ _id: 1, token_id: 1, event_type: 'TELEPORTED', event_time: new Date() });
  assert.ok(badEvent.validateSync().errors.event_type);
  const badRating = new models.Feedback({ _id: 1, visit_id: 1, rating: 6, created_at: new Date() });
  assert.ok(badRating.validateSync().errors.rating);
  const version = new models.ModelVersion({
    _id: 'rf-20261029-1210',
    trained_at: new Date(),
    training_rows: 10,
    data_source: 'synthetic',
    status: 'ACTIVE',
  });
  assert.equal(version.validateSync(), undefined);
});

test('unique and partial unique indexes back the concurrency rules', () => {
  const tokenNo = findIndex(models.Token, { service_point_id: 1, token_date: 1, token_number: 1 });
  assert.ok(tokenNo, 'unique token number per queue day');
  const appt = findIndex(models.Token, { appointment_id: 1 });
  assert.deepEqual(appt.opts.partialFilterExpression, { appointment_id: { $type: 'number' } });
  const openVisit = findIndex(models.Visit, { patient_id: 1, branch_id: 1, visit_date: 1 });
  assert.deepEqual(openVisit.opts.partialFilterExpression, { status: 'OPEN' });
  const slot = findIndex(models.Appointment, { doctor_id: 1, slot_start: 1 });
  assert.deepEqual(slot.opts.partialFilterExpression, { status: { $in: ['BOOKED', 'CHECKED_IN'] } });
  assert.ok(findIndex(models.User, { email: 1 }).opts.partialFilterExpression);
  assert.ok(findIndex(models.User, { phone: 1 }).opts.partialFilterExpression);
  assert.ok(findIndex(models.Doctor, { user_id: 1 }));
  assert.ok(findIndex(models.StaffAssignment, { user_id: 1, service_point_id: 1 }));
  assert.ok(findIndex(models.Feedback, { visit_id: 1 }));
});

test('test databases get a unique name inside the configured URI', () => {
  assert.equal(withDbName('mongodb://127.0.0.1:27017/?replicaSet=rs0', 'x1'), 'mongodb://127.0.0.1:27017/x1?replicaSet=rs0');
  assert.equal(withDbName('mongodb://h:1/smart_opd?replicaSet=rs0', 'x2'), 'mongodb://h:1/x2?replicaSet=rs0');
  assert.equal(withDbName('mongodb+srv://u:p@c.example.net/db', 'x3'), 'mongodb+srv://u:p@c.example.net/x3');
  assert.match(process.env.MONGODB_URI, /\/smart_opd_test_datalayer_\d+_[0-9a-f]{6}/);
  assert.equal(dbNameOf('mongodb://127.0.0.1:27017/smart_opd?replicaSet=rs0'), 'smart_opd');
  assert.equal(dbNameOf('mongodb://127.0.0.1:27017/?replicaSet=rs0'), null);
});

test('stored datetimes have whole-second precision; day ranges are hospital-local', () => {
  const d = new Date(2026, 10, 10, 9, 12, 34, 567);
  assert.equal(time.dbDate(d).getMilliseconds(), 0);
  assert.equal(time.toApi(time.dbDate(d)), '2026-11-10T09:12:34');
  const range = time.dayRange('2026-11-10');
  assert.equal(time.toApi(range.$gte), '2026-11-10T00:00:00');
  assert.equal(time.toApi(range.$lt), '2026-11-11T00:00:00');
  assert.equal(time.tzName(), 'Asia/Karachi');
});
