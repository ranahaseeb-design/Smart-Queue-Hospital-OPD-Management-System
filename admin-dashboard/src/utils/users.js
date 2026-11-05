// Helpers for the Staff & Users screen (FR-14).
import { ROLES } from './roles.js';

/** Roles whose accounts carry a branch: STAFF (home branch) and BRANCH_ADMIN (administered branch). */
export const BRANCH_ROLES = [ROLES.STAFF, ROLES.BRANCH_ADMIN];

/**
 * The `adminBranchId` part of a create/update payload. The backend treats a present `null` as
 * "clear the branch", so the key is only sent when it carries information:
 *  - create: the selected branch for STAFF / BRANCH_ADMIN accounts (omitted when none is chosen);
 *  - edit: only when the selection differs from the stored value; `null` only when an existing
 *    branch was explicitly cleared.
 * HOSPITAL_ADMIN accounts never send it (the backend clears it for that role itself).
 */
export function adminBranchIdPatch(values, mode, row) {
  if (!BRANCH_ROLES.includes(values?.role)) return {};
  const next = values.adminBranchId ? Number(values.adminBranchId) : null;
  if (mode === 'create') return next ? { adminBranchId: next } : {};
  const current = row?.adminBranchId ? Number(row.adminBranchId) : null;
  return next === current ? {} : { adminBranchId: next };
}

/** Staff and administrator roles shown under "All roles" on the Staff & Users screen. */
export const MANAGED_ROLES = [ROLES.STAFF, ROLES.BRANCH_ADMIN, ROLES.HOSPITAL_ADMIN];

/**
 * `role` query for GET /admin/users. Patients register themselves in the mobile app and are not
 * managed here, so "All roles" asks for the staff/administrator roles only (comma-separated list)
 * instead of downloading every patient account; PATIENT is requested only when chosen explicitly.
 * Branch administrators may list STAFF accounts only.
 */
export function usersRoleQuery(hospital, roleFilter) {
  if (!hospital) return ROLES.STAFF;
  return roleFilter || MANAGED_ROLES.join(',');
}
