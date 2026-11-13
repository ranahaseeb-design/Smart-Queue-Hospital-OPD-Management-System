'use strict';
/**
 * Accounts (FR-01): registration, login, profile and the User shape from the contract.
 * Passwords are stored as salted bcrypt hashes; password_hash is never serialised.
 */
const bcrypt = require('bcryptjs');
const config = require('../config');
const time = require('../utils/time');
const v = require('../utils/validate');
const { badRequest, conflict, unauthorized, forbidden } = require('../utils/errors');
const { models, sess, asRow, insertOne, byIds } = require('../db');

const { User, Doctor, StaffAssignment, ServicePoint, Branch } = models;

const PRIORITY_CATEGORIES = ['NONE', 'ELDERLY', 'DIFFERENTLY_ABLED'];

async function hashPassword(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}

/** Contract User shape (with doctorId and service point assignments). */
async function serializeUser(db, row) {
  const doctor = await Doctor.findOne({ user_id: row.user_id }, { _id: 1 }).session(sess(db)).lean();
  const assignments = await assignmentRows(db, [row.user_id]);
  return {
    id: row.user_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    dateOfBirth: time.toApiDate(row.date_of_birth),
    priorityCategory: row.priority_category,
    adminBranchId: row.admin_branch_id || null,
    isActive: Boolean(row.is_active),
    doctorId: doctor ? doctor._id : null,
    assignments: assignments.map((a) => ({
      servicePointId: a.service_point_id,
      servicePointName: a.name,
      type: a.type,
      branchId: a.branch_id,
      branchName: a.branch_name,
    })),
    createdAt: time.toApi(row.created_at),
  };
}

/**
 * Service-point assignments of users with service point and branch names, ordered by assignment
 * id: [{ user_id, service_point_id, name, type, branch_id, branch_name }].
 */
async function assignmentRows(db, userIds) {
  const list = await StaffAssignment.find({ user_id: { $in: userIds } }).sort({ _id: 1 }).session(sess(db)).lean();
  const sps = await byIds(db, ServicePoint, list.map((a) => a.service_point_id));
  const branches = await byIds(db, Branch, [...sps.values()].map((s) => s.branch_id));
  return list
    .filter((a) => sps.has(a.service_point_id))
    .map((a) => {
      const sp = sps.get(a.service_point_id);
      const b = branches.get(sp.branch_id);
      return {
        assignment_id: a._id,
        user_id: a.user_id,
        service_point_id: a.service_point_id,
        name: sp.name,
        type: sp.type,
        branch_id: sp.branch_id,
        branch_name: b ? b.name : null,
      };
    });
}

async function getUserRow(db, userId) {
  return asRow(User, await User.findById(userId).session(sess(db)).lean());
}

async function assertUnique(db, { email, phone }, excludeUserId = 0) {
  if (email) {
    const e = await User.exists({ email, _id: { $ne: excludeUserId } }).session(sess(db));
    if (e) throw conflict('An account with this e-mail already exists');
  }
  if (phone) {
    const p = await User.exists({ phone, _id: { $ne: excludeUserId } }).session(sess(db));
    if (p) throw conflict('An account with this phone number already exists');
  }
}

function validateDob(dob) {
  if (dob && dob > time.today()) throw badRequest('dateOfBirth cannot be in the future');
  return dob;
}

/**
 * Priority categories (FR-13). ELDERLY is derived from date_of_birth (age >= ELDERLY_MIN_AGE): it
 * cannot be self-declared without a qualifying date of birth, and a qualifying date of birth
 * sets it automatically. DIFFERENTLY_ABLED is self-declared; it pre-sets priority 1 on new tokens
 * and staff confirm or override it (QueueToken.priorityDeclared, POST /tokens/:id/priority).
 */
const ELDERLY_MIN_AGE = 60;

/** Completed years between a 'YYYY-MM-DD' date of birth and dateStr; null without a DOB. */
function ageOn(dob, dateStr = time.today()) {
  const d = dob ? time.toApiDate(dob) : null;
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  const [Y, M, D] = String(dateStr).slice(0, 10).split('-').map(Number);
  return Y - y - (M < m || (M === m && D < day) ? 1 : 0);
}

function isElderly(dob, dateStr = time.today()) {
  const age = ageOn(dob, dateStr);
  return age !== null && age >= ELDERLY_MIN_AGE;
}

/** Category to store for a patient-requested category + date of birth (400 on unqualified ELDERLY). */
function resolvePriorityCategory(requested, dob) {
  if (requested === 'DIFFERENTLY_ABLED') return requested;
  const elderly = isElderly(dob);
  if (requested === 'ELDERLY' && !elderly) {
    throw badRequest(`priorityCategory ELDERLY requires a dateOfBirth showing an age of ${ELDERLY_MIN_AGE} or over`);
  }
  return elderly ? 'ELDERLY' : 'NONE';
}

/** POST /auth/register — always creates a PATIENT. */
async function register(db, body) {
  const fullName = v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 });
  const email = v.email(body.email);
  const phone = v.phone(body.phone);
  if (!email && !phone) throw badRequest('Provide at least an e-mail address or a phone number');
  const password = v.password(body.password, 'password', { required: true });
  const dateOfBirth = validateDob(v.date(body.dateOfBirth, 'dateOfBirth'));
  const priorityCategory = resolvePriorityCategory(
    v.oneOf(body.priorityCategory, 'priorityCategory', PRIORITY_CATEGORIES) || 'NONE',
    dateOfBirth
  );
  await assertUnique(db, { email, phone });
  const hash = await hashPassword(password);
  const insertId = await insertOne(db, User, {
    full_name: fullName,
    email,
    phone,
    password_hash: hash,
    role: 'PATIENT',
    date_of_birth: dateOfBirth,
    priority_category: priorityCategory,
    admin_branch_id: null,
    fcm_token: null,
    is_active: true,
    created_at: time.nowDb(),
  });
  return getUserRow(db, insertId);
}

/** POST /auth/login — identifier is an e-mail address or a phone number. */
async function login(db, body) {
  const identifier = v.str(body.identifier, 'identifier', { required: true, max: 120 });
  const password = v.str(body.password, 'password', { required: true, trim: false, max: 128 });
  let row;
  if (identifier.includes('@')) {
    row = asRow(User, await User.findOne({ email: identifier.toLowerCase() }).session(sess(db)).lean());
  } else {
    row = asRow(User, await User.findOne({ phone: identifier.replace(/[\s-]/g, '') }).session(sess(db)).lean());
  }
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw unauthorized('Invalid credentials');
  }
  if (!row.is_active) throw forbidden('This account has been deactivated');
  return row;
}

/** PUT /auth/me */
async function updateMe(db, user, body) {
  const fields = [];
  const params = [];
  if (body.fullName !== undefined) {
    fields.push('full_name = ?');
    params.push(v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 }));
  }
  let email = user.email;
  let phone = user.phone;
  if (body.email !== undefined) {
    email = v.email(body.email);
    fields.push('email = ?');
    params.push(email);
  }
  if (body.phone !== undefined) {
    phone = v.phone(body.phone);
    fields.push('phone = ?');
    params.push(phone);
  }
  if (!email && !phone) throw badRequest('An account needs an e-mail address or a phone number');
  await assertUnique(db, { email: body.email !== undefined ? email : null, phone: body.phone !== undefined ? phone : null }, user.user_id);
  let dob = user.date_of_birth;
  if (body.dateOfBirth !== undefined) {
    dob = validateDob(v.date(body.dateOfBirth, 'dateOfBirth'));
    fields.push('date_of_birth = ?');
    params.push(dob);
  }
  if (body.priorityCategory !== undefined || body.dateOfBirth !== undefined) {
    // Re-derive: an explicit category is validated against the (new) date of birth; a DOB change
    // alone re-derives ELDERLY (kept DIFFERENTLY_ABLED stays).
    const requested =
      body.priorityCategory !== undefined
        ? v.oneOf(body.priorityCategory, 'priorityCategory', PRIORITY_CATEGORIES, { required: true })
        : user.priority_category === 'DIFFERENTLY_ABLED'
          ? 'DIFFERENTLY_ABLED'
          : 'NONE';
    fields.push('priority_category = ?');
    params.push(resolvePriorityCategory(requested, dob));
  }
  if (body.password !== undefined) {
    fields.push('password_hash = ?');
    params.push(await hashPassword(v.password(body.password, 'password', { required: true })));
  }
  if (fields.length) {
    const set = {};
    fields.forEach((f, i) => {
      set[f.replace(' = ?', '')] = params[i];
    });
    await User.updateOne({ _id: user.user_id }, { $set: set }, { session: sess(db) });
  }
  return getUserRow(db, user.user_id);
}

module.exports = {
  PRIORITY_CATEGORIES,
  ELDERLY_MIN_AGE,
  ageOn,
  isElderly,
  resolvePriorityCategory,
  hashPassword,
  serializeUser,
  assignmentRows,
  getUserRow,
  assertUnique,
  register,
  login,
  updateMe,
};
