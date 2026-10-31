'use strict';
/**
 * Authorisation helpers shared by REST routes and the Socket.IO channel
 * (Section 3.2 roles matrix, NFR-04).
 */
const { forbidden, notFound } = require('../utils/errors');

const ADMIN_ROLES = ['BRANCH_ADMIN', 'HOSPITAL_ADMIN'];

function isAdmin(user) {
  return ADMIN_ROLES.includes(user.role);
}

async function getDoctorForUser(db, userId) {
  return db.get('SELECT doctor_id, department_id, is_active FROM doctors WHERE user_id = ?', [userId]);
}

/** Service points a staff member works at: explicit assignments + rooms where the doctor is scheduled. */
async function staffServicePointIds(db, userId) {
  const rows = await db.query(
    `SELECT sa.service_point_id AS id FROM staff_assignments sa WHERE sa.user_id = ?
     UNION
     SELECT ds.service_point_id AS id FROM doctor_schedules ds
       JOIN doctors d ON d.doctor_id = ds.doctor_id
      WHERE d.user_id = ?`,
    [userId, userId]
  );
  return new Set(rows.map((r) => r.id));
}

/** Branches a staff member belongs to (home branch, assignments, doctor's department). */
async function staffBranchIds(db, user) {
  const rows = await db.query(
    `SELECT sp.branch_id AS id FROM staff_assignments sa
       JOIN service_points sp ON sp.service_point_id = sa.service_point_id
      WHERE sa.user_id = ?
     UNION
     SELECT dp.branch_id AS id FROM doctors d
       JOIN departments dp ON dp.department_id = d.department_id
      WHERE d.user_id = ?`,
    [user.user_id, user.user_id]
  );
  const set = new Set(rows.map((r) => r.id));
  if (user.admin_branch_id) set.add(user.admin_branch_id);
  return set;
}

async function canAccessServicePoint(db, user, servicePointId) {
  if (user.role === 'HOSPITAL_ADMIN') return true;
  if (user.role === 'BRANCH_ADMIN') {
    const sp = await db.get('SELECT branch_id FROM service_points WHERE service_point_id = ?', [servicePointId]);
    return Boolean(sp && sp.branch_id === user.admin_branch_id);
  }
  if (user.role === 'STAFF') {
    const ids = await staffServicePointIds(db, user.user_id);
    return ids.has(servicePointId);
  }
  return false;
}

/** Throws 404 if the service point does not exist, 403 if the user may not operate it. */
async function assertServicePointAccess(db, user, servicePointId, { staffOnly = false } = {}) {
  const sp = await db.get(
    `SELECT sp.service_point_id, sp.branch_id, sp.type, sp.name, sp.is_active, b.name AS branch_name
       FROM service_points sp JOIN branches b ON b.branch_id = sp.branch_id
      WHERE sp.service_point_id = ?`,
    [servicePointId]
  );
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
  staffBranchIds,
  canAccessServicePoint,
  assertServicePointAccess,
  canViewToken,
  scopeBranch,
  assertBranchAccess,
};
