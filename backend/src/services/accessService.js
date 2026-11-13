'use strict';
/**
 * Authorisation helpers shared by REST routes and the Socket.IO channel
 * (Section 3.2 roles matrix, NFR-04).
 */
const { forbidden, notFound } = require('../utils/errors');
const time = require('../utils/time');
const { models, sess, asRow } = require('../db');

const { Doctor, DoctorSchedule, StaffAssignment, ServicePoint, Department, Branch } = models;

const ADMIN_ROLES = ['BRANCH_ADMIN', 'HOSPITAL_ADMIN'];

function isAdmin(user) {
  return ADMIN_ROLES.includes(user.role);
}

/** { doctor_id, department_id, is_active } of the user's doctor profile, or undefined. */
async function getDoctorForUser(db, userId) {
  const d = await Doctor.findOne({ user_id: userId }, { department_id: 1, is_active: 1 }).session(sess(db)).lean();
  return d ? asRow(Doctor, d) : undefined;
}

/**
 * Service points a staff member works at: explicit assignments (any day) + rooms where the
 * doctor is scheduled TODAY (hospital weekday). A schedule on another weekday grants nothing.
 */
async function staffServicePointIds(db, userId, now = time.clock.now()) {
  const ids = new Set(await StaffAssignment.distinct('service_point_id', { user_id: userId }).session(sess(db)));
  const doctor = await Doctor.findOne({ user_id: userId }, { _id: 1 }).session(sess(db)).lean();
  if (doctor) {
    const scheduled = await DoctorSchedule.distinct('service_point_id', {
      doctor_id: doctor._id,
      day_of_week: time.isoDow(now),
    }).session(sess(db));
    scheduled.forEach((id) => ids.add(id));
  }
  return ids;
}

/**
 * A staff member who is a doctor may only operate OPD tokens of their own doctor_id
 * (call-next / start / skip / recall / complete / transfer / priority). Lab, pharmacy and other
 * non-doctor staff, and non-OPD tokens, are unaffected.
 */
async function assertOwnsOpdToken(db, user, row) {
  if (user.role !== 'STAFF' || row.queue_type !== 'OPD') return;
  const doctor = await getDoctorForUser(db, user.user_id);
  if (!doctor) return;
  if (row.doctor_id !== doctor.doctor_id) {
    throw forbidden("You can only operate your own patients' OPD tokens");
  }
}

/** Branches a staff member belongs to (home branch, assignments, doctor's department). */
async function staffBranchIds(db, user) {
  const spIds = await StaffAssignment.distinct('service_point_id', { user_id: user.user_id }).session(sess(db));
  const set = new Set(
    spIds.length ? await ServicePoint.distinct('branch_id', { _id: { $in: spIds } }).session(sess(db)) : []
  );
  const deptIds = await Doctor.distinct('department_id', { user_id: user.user_id }).session(sess(db));
  if (deptIds.length) {
    (await Department.distinct('branch_id', { _id: { $in: deptIds } }).session(sess(db))).forEach((id) => set.add(id));
  }
  if (user.admin_branch_id) set.add(user.admin_branch_id);
  return set;
}

async function canAccessServicePoint(db, user, servicePointId) {
  if (user.role === 'HOSPITAL_ADMIN') return true;
  if (user.role === 'BRANCH_ADMIN') {
    const sp = await ServicePoint.findById(servicePointId, { branch_id: 1 }).session(sess(db)).lean();
    return Boolean(sp && sp.branch_id === user.admin_branch_id);
  }
  if (user.role === 'STAFF') {
    const ids = await staffServicePointIds(db, user.user_id);
    return ids.has(servicePointId);
  }
  return false;
}

/** Service point row with branch_name (null when missing). */
async function servicePointRow(db, servicePointId) {
  const sp = await ServicePoint.findById(servicePointId).session(sess(db)).lean();
  if (!sp) return null;
  const branch = await Branch.findById(sp.branch_id, { name: 1 }).session(sess(db)).lean();
  return { ...asRow(ServicePoint, sp), branch_name: branch ? branch.name : null };
}

/** Throws 404 if the service point does not exist, 403 if the user may not operate it. */
async function assertServicePointAccess(db, user, servicePointId, { staffOnly = false } = {}) {
  const sp = await servicePointRow(db, servicePointId);
  if (!sp) throw notFound('Service point not found');
  if (staffOnly && user.role !== 'STAFF') throw forbidden('Only staff can perform queue operations');
  if (!(await canAccessServicePoint(db, user, servicePointId))) {
    throw forbidden('You are not assigned to this service point');
  }
  return sp;
}

/** Can the user view this token (owner, staff of the branch, admins of the branch)? */
async function canViewToken(db, user, token) {
  // token: { patient_id, branch_id }
  if (user.role === 'PATIENT') return token.patient_id === user.user_id;
  if (user.role === 'HOSPITAL_ADMIN') return true;
  if (user.role === 'BRANCH_ADMIN') return token.branch_id === user.admin_branch_id;
  if (user.role === 'STAFF') {
    const branches = await staffBranchIds(db, user);
    return branches.has(token.branch_id);
  }
  return false;
}

/**
 * Resolve the branch scope for admin endpoints.
 * HOSPITAL_ADMIN: requested branch (or null = all). BRANCH_ADMIN: own branch; 403 if another is requested.
 */
function scopeBranch(user, requestedBranchId) {
  if (user.role === 'HOSPITAL_ADMIN') return requestedBranchId || null;
  if (user.role === 'BRANCH_ADMIN') {
    if (requestedBranchId && requestedBranchId !== user.admin_branch_id) {
      throw forbidden('Branch administrators can only access their own branch');
    }
    return user.admin_branch_id;
  }
  throw forbidden();
}

function assertBranchAccess(user, branchId) {
  if (user.role === 'HOSPITAL_ADMIN') return;
  if (user.role === 'BRANCH_ADMIN' && branchId === user.admin_branch_id) return;
  throw forbidden('Branch administrators can only manage their own branch');
}

module.exports = {
  ADMIN_ROLES,
  isAdmin,
  getDoctorForUser,
  staffServicePointIds,
  assertOwnsOpdToken,
  staffBranchIds,
  canAccessServicePoint,
  servicePointRow,
  assertServicePointAccess,
  canViewToken,
  scopeBranch,
  assertBranchAccess,
};
