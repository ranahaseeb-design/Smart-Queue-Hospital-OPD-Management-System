// One dashboard for every role: which section (admin screens or staff screens) the signed-in
// account uses, and saving / clearing the session for it. Each section keeps its own storage keys
// (admin: smartopd.admin.*, staff: smartopd.staff.*), so their existing auth code is unchanged;
// signing in through the shared login writes exactly one of them and clears the other.

export const SECTION_KEY = 'smartopd.section';
const ADMIN = { token: 'smartopd.admin.token', user: 'smartopd.admin.user' };
const STAFF = { token: 'smartopd.staff.token', user: 'smartopd.staff.user' };

const ADMIN_ROLES = ['BRANCH_ADMIN', 'HOSPITAL_ADMIN'];

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(key) {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readUser(key) {
  try {
    return JSON.parse(read(key) || 'null');
  } catch {
    return null;
  }
}

/** The section for a role: 'admin', 'staff', or null (patients use the patient apps). */
export function sectionForRole(role) {
  if (ADMIN_ROLES.includes(role)) return 'admin';
  if (role === 'STAFF') return 'staff';
  return null;
}

/** Section of the stored session, or null when nobody is signed in. */
export function activeSection() {
  const hasAdmin = Boolean(read(ADMIN.token)) && sectionForRole(readUser(ADMIN.user)?.role) === 'admin';
  const hasStaff = Boolean(read(STAFF.token)) && sectionForRole(readUser(STAFF.user)?.role) === 'staff';
  const chosen = read(SECTION_KEY);
  if (chosen === 'admin' && hasAdmin) return 'admin';
  if (chosen === 'staff' && hasStaff) return 'staff';
  if (hasAdmin && !hasStaff) return 'admin';
  if (hasStaff && !hasAdmin) return 'staff';
  return null;
}

/** Store a successful login for its section (and drop any other section's session). */
export function saveSession(token, user) {
  const section = sectionForRole(user?.role);
  if (!section || !token) throw new Error('This account cannot use the dashboard.');
  clearSessions();
  const keys = section === 'admin' ? ADMIN : STAFF;
  const s = storage();
  try {
    s?.setItem(keys.token, token);
    s?.setItem(keys.user, JSON.stringify(user));
    s?.setItem(SECTION_KEY, section);
  } catch {
    throw new Error('Your browser blocked storage, so the session cannot be kept. Allow site data and try again.');
  }
  return section;
}

export function clearSessions() {
  const s = storage();
  for (const key of [ADMIN.token, ADMIN.user, STAFF.token, STAFF.user, SECTION_KEY]) {
    try {
      s?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Where a freshly signed-in account lands. */
export function landingPath(section) {
  return section === 'admin' ? '/overview' : '/';
}

// First path segment of each section's screens (admin: App.jsx routes; staff: staff App.jsx).
const STAFF_ROOTS = ['select', 'queue', 'display'];
const ADMIN_ROOTS = [
  'overview', 'branches', 'departments', 'doctors', 'schedules', 'service-points', 'users',
  'reports', 'forecasts', 'workload', 'feedback', 'models', 'settings',
];

/**
 * After sign-in: the requested page (`from`, already a safe same-app path) when it belongs to the
 * account's section, otherwise that section's landing page.
 */
export function destinationAfterLogin(section, from) {
  const fallback = landingPath(section);
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return fallback;
  const root = from.slice(1).split(/[/?#]/)[0];
  const roots = section === 'admin' ? ADMIN_ROOTS : STAFF_ROOTS;
  return roots.includes(root) ? from : fallback;
}
