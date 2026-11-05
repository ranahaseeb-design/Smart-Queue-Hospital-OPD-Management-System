// Role helpers implementing the permission matrix of Section 3.2 (Table 3.2) for the two
// administrator roles that may use this dashboard.

export const ROLES = {
  PATIENT: 'PATIENT',
  STAFF: 'STAFF',
  BRANCH_ADMIN: 'BRANCH_ADMIN',
  HOSPITAL_ADMIN: 'HOSPITAL_ADMIN',
};

export const ADMIN_ROLES = [ROLES.BRANCH_ADMIN, ROLES.HOSPITAL_ADMIN];

export const ROLE_LABELS = {
  PATIENT: 'Patient',
  STAFF: 'Staff',
  BRANCH_ADMIN: 'Branch Admin',
  HOSPITAL_ADMIN: 'Hospital Admin',
};

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

export function isHospitalAdmin(user) {
  return user?.role === ROLES.HOSPITAL_ADMIN;
}

/**
 * Capabilities derived from Table 3.2:
 *  - Manage branches and system settings: hospital admin only.
 *  - Manage departments, doctors, schedules, service points: branch admin (own branch) + hospital admin.
 *  - Manage staff accounts: branch admin (own branch, STAFF only) + hospital admin.
 *  - Retrain / activate prediction model: hospital admin only (FR-22).
 *  - Monitoring, alerts, reports, forecasts: own branch (branch admin) vs all branches.
 */
export function permissionsFor(user) {
  const hospital = isHospitalAdmin(user);
  const admin = isAdminRole(user?.role);
  return {
    allBranches: hospital,
    manageBranches: hospital,
    manageSettings: hospital,
    manageModels: hospital,
    runForecasts: hospital, // POST /admin/forecasts/run regenerates every branch
    manageMasterData: admin,
    manageUsers: admin,
    manageAdminAccounts: hospital,
    viewMonitoring: admin,
  };
}

/** Roles that the current admin may assign when creating/editing an account (FR-14). */
export function assignableRoles(user) {
  return isHospitalAdmin(user)
    ? [ROLES.STAFF, ROLES.BRANCH_ADMIN, ROLES.HOSPITAL_ADMIN]
    : [ROLES.STAFF];
}
