'use strict';
/**
 * Mongoose models, one per collection of database/MONGODB_DESIGN.md (the binding data design).
 *
 *  - Collection and field names are the former SQL table / column names (snake_case).
 *  - Every document has an integer `_id` allocated from the `counters` collection (see
 *    counters.js); exceptions: model_versions._id = version string, settings._id = key,
 *    counters._id = sequence name.
 *  - Datetimes are BSON Date (UTC on the wire); token_date / visit_date stay "YYYY-MM-DD" strings
 *    and schedule times "HH:mm:ss" strings (hospital-local calendar values).
 *  - Optional values are stored as null (like SQL NULL). The "unique sparse" constraints of the
 *    design are partial unique indexes on documents where the field holds a value, so null and a
 *    missing field behave the same way.
 *
 * Each model carries `pk`: the former primary-key column name. Services read documents with
 * .lean() and expose that name next to `_id` (db/index.js asRow), so the row shapes the services
 * and routes work with are the same as in the SQL version.
 */
const { Schema } = require('mongoose');
const { mongoose } = require('./connection');

const OPTS = { versionKey: false, id: false, strict: true };
const intId = { type: Number, required: true, validate: { validator: Number.isInteger, message: '_id must be an integer' } };
const ref = { type: Number, default: null };
const reqNum = { type: Number, required: true };
const reqStr = { type: String, required: true };
const nullableStr = { type: String, default: null };
const nullableDate = { type: Date, default: null };
const bool = (def) => ({ type: Boolean, required: true, default: def });
const oneOf = (values, def) => ({ type: String, enum: values, required: true, ...(def ? { default: def } : {}) });

const ROLES = ['PATIENT', 'STAFF', 'BRANCH_ADMIN', 'HOSPITAL_ADMIN'];
const PRIORITY_CATEGORIES = ['NONE', 'ELDERLY', 'DIFFERENTLY_ABLED'];
const SERVICE_POINT_TYPES = ['OPD', 'LAB', 'PHARMACY'];
const TOKEN_STATUSES = ['WAITING', 'CALLED', 'IN_SERVICE', 'SKIPPED', 'TRANSFERRED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
const APPOINTMENT_STATUSES = ['BOOKED', 'CHECKED_IN', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];
const EVENT_TYPES = [
  'ISSUED', 'CALLED', 'STARTED', 'SKIPPED', 'RECALLED', 'TRANSFERRED', 'COMPLETED', 'CANCELLED', 'PRIORITY_SET', 'NO_SHOW',
];
const CHANNELS = ['PUSH', 'IN_APP', 'EMAIL', 'SMS'];
const CONGESTION_LEVELS = ['NORMAL', 'HIGH', 'CRITICAL'];
const MODEL_STATUSES = ['CANDIDATE', 'ACTIVE', 'REJECTED', 'RETIRED'];

const hasNumber = (field) => ({ [field]: { $type: 'number' } });
const hasString = (field) => ({ [field]: { $type: 'string' } });

function model(name, collection, pk, definition, indexes = [], options = {}) {
  const schema = new Schema(definition, { ...OPTS, collection, ...options });
  for (const [fields, opts] of indexes) schema.index(fields, opts || {});
  const m = mongoose.models[name] || mongoose.model(name, schema);
  m.pk = pk;
  return m;
}

const Branch = model('Branch', 'branches', 'branch_id', {
  _id: intId,
  name: reqStr,
  address: nullableStr,
  latitude: reqNum,
  longitude: reqNum,
  status: oneOf(['ACTIVE', 'INACTIVE'], 'ACTIVE'),
});

const User = model(
  'User',
  'users',
  'user_id',
  {
    _id: intId,
    full_name: reqStr,
    email: nullableStr,
    phone: nullableStr,
    password_hash: reqStr,
    role: oneOf(ROLES),
    date_of_birth: nullableStr, // "YYYY-MM-DD"
    priority_category: oneOf(PRIORITY_CATEGORIES, 'NONE'),
    admin_branch_id: ref,
    fcm_token: nullableStr,
    is_active: bool(true),
    created_at: { type: Date, required: true },
  },
  [
    [{ email: 1 }, { unique: true, partialFilterExpression: hasString('email'), name: 'uq_users_email' }],
    [{ phone: 1 }, { unique: true, partialFilterExpression: hasString('phone'), name: 'uq_users_phone' }],
    [{ role: 1 }],
    [{ admin_branch_id: 1 }],
  ]
);

const Department = model(
  'Department',
  'departments',
  'department_id',
  { _id: intId, branch_id: reqNum, specialty: reqStr, name: nullableStr, is_active: bool(true) },
  [[{ branch_id: 1, specialty: 1 }], [{ specialty: 1 }]]
);

const ServicePoint = model(
  'ServicePoint',
  'service_points',
  'service_point_id',
  { _id: intId, branch_id: reqNum, type: oneOf(SERVICE_POINT_TYPES), name: nullableStr, is_active: bool(true) },
  [[{ branch_id: 1 }]]
);

const Doctor = model(
  'Doctor',
  'doctors',
  'doctor_id',
  { _id: intId, user_id: reqNum, department_id: reqNum, avg_consult_minutes: { type: Number, required: true, default: 10 }, is_active: bool(true) },
  [[{ user_id: 1 }, { unique: true, name: 'uq_doctors_user' }], [{ department_id: 1 }]]
);

const DoctorSchedule = model(
  'DoctorSchedule',
  'doctor_schedules',
  'schedule_id',
  {
    _id: intId,
    doctor_id: reqNum,
    service_point_id: reqNum,
    day_of_week: { type: Number, required: true, min: 1, max: 7 }, // 1 = Monday ... 7 = Sunday (ISO)
    start_time: reqStr, // "HH:mm:ss"
    end_time: reqStr,
    max_patients: { type: Number, default: null },
  },
  [[{ doctor_id: 1, day_of_week: 1 }], [{ service_point_id: 1, day_of_week: 1 }]]
);

const StaffAssignment = model(
  'StaffAssignment',
  'staff_assignments',
  'assignment_id',
  { _id: intId, user_id: reqNum, service_point_id: reqNum },
  [[{ user_id: 1, service_point_id: 1 }, { unique: true, name: 'uq_assignment' }], [{ service_point_id: 1 }]]
);

const Visit = model(
  'Visit',
  'visits',
  'visit_id',
  { _id: intId, patient_id: reqNum, branch_id: reqNum, visit_date: reqStr, status: oneOf(['OPEN', 'CLOSED'], 'OPEN') },
  [
    [{ patient_id: 1, visit_date: 1, branch_id: 1 }],
    // One OPEN visit per patient, branch and day.
    [
      { patient_id: 1, branch_id: 1, visit_date: 1 },
      { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'uq_open_visit' },
    ],
    [{ status: 1, visit_date: 1 }],
  ]
);

const Appointment = model(
  'Appointment',
  'appointments',
  'appointment_id',
  {
    _id: intId,
    patient_id: reqNum,
    doctor_id: reqNum,
    slot_start: { type: Date, required: true },
    status: oneOf(APPOINTMENT_STATUSES, 'BOOKED'),
    updated_at: { type: Date, required: true },
  },
  [
    [{ doctor_id: 1, slot_start: 1 }],
    // No double booking: one BOOKED / CHECKED_IN appointment per doctor and slot.
    [
      { doctor_id: 1, slot_start: 1 },
      { unique: true, partialFilterExpression: { status: { $in: ['BOOKED', 'CHECKED_IN'] } }, name: 'uq_active_slot' },
    ],
    [{ patient_id: 1, slot_start: -1 }],
    [{ status: 1, slot_start: 1 }],
  ]
);

const Token = model(
  'Token',
  'tokens',
  'token_id',
  {
    _id: intId,
    visit_id: reqNum,
    service_point_id: reqNum,
    doctor_id: ref,
    appointment_id: ref,
    token_number: reqNum,
    token_date: reqStr, // "YYYY-MM-DD"
    queue_type: oneOf(SERVICE_POINT_TYPES),
    priority_level: { type: Number, required: true, default: 0 }, // 0 normal, 1 elderly/differently-abled, 2 emergency
    status: oneOf(TOKEN_STATUSES, 'WAITING'),
    issued_at: { type: Date, required: true },
    called_at: nullableDate,
    completed_at: nullableDate,
    is_synthetic: bool(false),
  },
  [
    [{ service_point_id: 1, token_date: 1, token_number: 1 }, { unique: true, name: 'uq_token_number' }],
    [{ appointment_id: 1 }, { unique: true, partialFilterExpression: hasNumber('appointment_id'), name: 'uq_token_appointment' }],
    [{ service_point_id: 1, token_date: 1, status: 1 }],
    [{ doctor_id: 1, token_date: 1 }],
    [{ visit_id: 1 }],
    [{ doctor_id: 1, queue_type: 1, status: 1, completed_at: 1 }],
    [{ token_date: 1, status: 1 }],
  ]
);

const QueueEvent = model(
  'QueueEvent',
  'queue_events',
  'event_id',
  {
    _id: intId,
    token_id: reqNum,
    event_type: oneOf(EVENT_TYPES),
    performed_by: ref,
    from_point_id: ref,
    to_point_id: ref,
    note: nullableStr,
    event_time: { type: Date, required: true },
  },
  [[{ token_id: 1, event_time: 1 }], [{ event_time: 1 }]]
);

const WaitPrediction = model(
  'WaitPrediction',
  'wait_predictions',
  'prediction_id',
  {
    _id: intId,
    token_id: reqNum,
    predicted_minutes: reqNum,
    model_version: reqStr,
    features: { type: Schema.Types.Mixed, default: null }, // the 14 contract feature keys
    created_at: { type: Date, required: true },
  },
  [[{ token_id: 1, created_at: 1 }]],
  { minimize: false }
);

const Notification = model(
  'Notification',
  'notifications',
  'notification_id',
  {
    _id: intId,
    user_id: reqNum,
    token_id: ref,
    channel: oneOf(CHANNELS),
    message: nullableStr,
    sent_at: nullableDate,
    status: oneOf(['SENT', 'FAILED']),
    is_read: bool(false),
  },
  [[{ user_id: 1, sent_at: 1 }], [{ token_id: 1 }]]
);

const Feedback = model(
  'Feedback',
  'feedback',
  'feedback_id',
  { _id: intId, visit_id: reqNum, rating: { type: Number, required: true, min: 1, max: 5 }, comment: nullableStr, created_at: { type: Date, required: true } },
  [[{ visit_id: 1 }, { unique: true, name: 'uq_feedback_visit' }]]
);

const Forecast = model(
  'Forecast',
  'forecasts',
  'forecast_id',
  {
    _id: intId,
    branch_id: reqNum,
    department_id: reqNum,
    forecast_hour: { type: Date, required: true },
    expected_arrivals: { type: Number, default: null },
    capacity: { type: Number, default: null },
    congestion_level: oneOf(CONGESTION_LEVELS),
    is_peak: bool(false),
    source: { type: String, required: true, default: 'baseline' }, // 'baseline' or a model version
    generated_at: { type: Date, required: true },
  },
  [[{ branch_id: 1, department_id: 1, forecast_hour: 1 }], [{ forecast_hour: 1 }]]
);

const ModelVersion = model(
  'ModelVersion',
  'model_versions',
  'version',
  {
    _id: { type: String, required: true }, // version string, e.g. rf-20261029-1210
    trained_at: { type: Date, required: true },
    training_rows: reqNum,
    data_source: reqStr,
    metrics: { type: Schema.Types.Mixed, default: {} },
    status: oneOf(MODEL_STATUSES),
    is_active: bool(false),
  },
  [[{ is_active: 1 }]],
  { minimize: false }
);

const Setting = model(
  'Setting',
  'settings',
  'setting_key',
  { _id: { type: String, required: true }, value: { type: Schema.Types.Mixed, required: true }, updated_at: { type: Date, required: true } },
  [],
  { minimize: false }
);

const Counter = model('Counter', 'counters', 'name', { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } });

/** Every model, in dependency order (masters first). */
const ALL_MODELS = [
  Branch, User, Department, ServicePoint, Doctor, DoctorSchedule, StaffAssignment, Visit, Appointment, Token,
  QueueEvent, WaitPrediction, Notification, Feedback, Forecast, ModelVersion, Setting, Counter,
];
/** Models whose _id comes from the counters collection. */
const COUNTED_MODELS = ALL_MODELS.filter((m) => ![ModelVersion, Setting, Counter].includes(m));

module.exports = {
  Branch,
  User,
  Department,
  ServicePoint,
  Doctor,
  DoctorSchedule,
  StaffAssignment,
  Visit,
  Appointment,
  Token,
  QueueEvent,
  WaitPrediction,
  Notification,
  Feedback,
  Forecast,
  ModelVersion,
  Setting,
  Counter,
  ALL_MODELS,
  COUNTED_MODELS,
  ENUMS: {
    ROLES,
    PRIORITY_CATEGORIES,
    SERVICE_POINT_TYPES,
    TOKEN_STATUSES,
    APPOINTMENT_STATUSES,
    EVENT_TYPES,
    CHANNELS,
    CONGESTION_LEVELS,
    MODEL_STATUSES,
  },
};
