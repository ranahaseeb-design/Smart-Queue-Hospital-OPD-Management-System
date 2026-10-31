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

const PRIORITY_CATEGORIES = ['NONE', 'ELDERLY', 'DIFFERENTLY_ABLED'];

async function hashPassword(password) {
  return bcrypt.hash(password, config.bcryptRounds);
}

/** Contract User shape (with doctorId and service point assignments). */
async function serializeUser(db, row) {
  const doctor = await db.get('SELECT doctor_id FROM doctors WHERE user_id = ?', [row.user_id]);
  const assignments = await db.query(
    `SELECT sa.service_point_id, sp.name, sp.type, sp.branch_id, b.name AS branch_name
       FROM staff_assignments sa JOIN service_points sp ON sp.service_point_id = sa.service_point_id
       JOIN branches b ON b.branch_id = sp.branch_id
      WHERE sa.user_id = ? ORDER BY sa.assignment_id`,
    [row.user_id]
  );
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
    doctorId: doctor ? doctor.doctor_id : null,
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

async function getUserRow(db, userId) {
  return db.get('SELECT * FROM users WHERE user_id = ?', [userId]);
}

async function assertUnique(db, { email, phone }, excludeUserId = 0) {
  if (email) {
    const e = await db.get('SELECT user_id FROM users WHERE email = ? AND user_id <> ?', [email, excludeUserId]);
    if (e) throw conflict('An account with this e-mail already exists');
  }
  if (phone) {
    const p = await db.get('SELECT user_id FROM users WHERE phone = ? AND user_id <> ?', [phone, excludeUserId]);
    if (p) throw conflict('An account with this phone number already exists');
  }
}

function validateDob(dob) {
  if (dob && dob > time.today()) throw badRequest('dateOfBirth cannot be in the future');
  return dob;
}

/** POST /auth/register — always creates a PATIENT. */
async function register(db, body) {
  const fullName = v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 });
  const email = v.email(body.email);
  const phone = v.phone(body.phone);
  if (!email && !phone) throw badRequest('Provide at least an e-mail address or a phone number');
  const password = v.password(body.password, 'password', { required: true });
  const dateOfBirth = validateDob(v.date(body.dateOfBirth, 'dateOfBirth'));
  const priorityCategory = v.oneOf(body.priorityCategory, 'priorityCategory', PRIORITY_CATEGORIES) || 'NONE';
  await assertUnique(db, { email, phone });
  const hash = await hashPassword(password);
  const { insertId } = await db.run(
    `INSERT INTO users (full_name, email, phone, password_hash, role, date_of_birth, priority_category, admin_branch_id,
                        fcm_token, is_active, created_at)
     VALUES (?, ?, ?, ?, 'PATIENT', ?, ?, NULL, NULL, 1, ?)`,
    [fullName, email, phone, hash, dateOfBirth, priorityCategory, time.nowDb()]
  );
  return getUserRow(db, insertId);
}

/** POST /auth/login — identifier is an e-mail address or a phone number. */
async function login(db, body) {
  const identifier = v.str(body.identifier, 'identifier', { required: true, max: 120 });
  const password = v.str(body.password, 'password', { required: true, trim: false, max: 128 });
  let row;
  if (identifier.includes('@')) {
    row = await db.get('SELECT * FROM users WHERE email = ?', [identifier.toLowerCase()]);
  } else {
    row = await db.get('SELECT * FROM users WHERE phone = ?', [identifier.replace(/[\s-]/g, '')]);
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
  if (body.dateOfBirth !== undefined) {
    fields.push('date_of_birth = ?');
    params.push(validateDob(v.date(body.dateOfBirth, 'dateOfBirth')));
  }
  if (body.priorityCategory !== undefined) {
    fields.push('priority_category = ?');
    params.push(v.oneOf(body.priorityCategory, 'priorityCategory', PRIORITY_CATEGORIES, { required: true }));
  }
  if (body.password !== undefined) {
    fields.push('password_hash = ?');
    params.push(await hashPassword(v.password(body.password, 'password', { required: true })));
  }
  if (fields.length) {
    await db.run(`UPDATE users SET ${fields.join(', ')} WHERE user_id = ?`, [...params, user.user_id]);
  }
  return getUserRow(db, user.user_id);
}

module.exports = { PRIORITY_CATEGORIES, hashPassword, serializeUser, getUserRow, assertUnique, register, login, updateMe };
