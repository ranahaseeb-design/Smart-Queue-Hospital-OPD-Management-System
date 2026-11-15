// One dashboard for every role: which section the signed-in account uses (admin screens, doctor/
// staff screens or the patient portal), and saving / clearing the session for it. Each section
// keeps its own storage keys (smartopd.admin.*, smartopd.staff.*, smartopd.patient.*), so their
// auth code stays independent; signing in through the shared login writes exactly one of them and
// clears the others.

export const SECTION_KEY = 'smartopd.section';
export const SESSION_KEYS = {
  admin: { token: 'smartopd.admin.token', user: 'smartopd.admin.user' },
  staff: { token: 'smartopd.staff.token', user: 'smartopd.staff.user' },
  patient: { token: 'smartopd.patient.token', user: 'smartopd.patient.user' },
};
const SECTIONS = Object.keys(SESSION_KEYS);

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

/** The section for a role: 'admin', 'staff' or 'patient' (null for anything else). */
export function sectionForRole(role) {
  if (role === 'BRANCH_ADMIN' || role === 'HOSPITAL_ADMIN') return 'admin';
  if (role === 'STAFF') return 'staff';
  if (role === 'PATIENT') return 'patient';
  return null;
}

function hasSession(section) {
  const keys = SESSION_KEYS[section];
  return Boolean(read(keys.token)) && sectionForRole(readUser(keys.user)?.role) === section;
}

/** Section of the stored session, or null when nobody is signed in. */
export function activeSection() {
  const present = SECTIONS.filter(hasSession);
  const chosen = read(SECTION_KEY);
  if (present.includes(chosen)) return chosen;
  return present.length === 1 ? present[0] : null;
}

/** Store a successful login for its section (and drop any other section's session). */
export function saveSession(token, user) {
  const section = sectionForRole(user?.role);
  if (!section || !token) throw new Error('This account cannot use the dashboard.');
  clearSessions();
  const keys = SESSION_KEYS[section];
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
  const keys = [SECTION_KEY, ...SECTIONS.flatMap((k) => [SESSION_KEYS[k].token, SESSION_KEYS[k].user])];
  for (const key of keys) {
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

// First path segment of each section's screens (admin: App.jsx; staff: staff App.jsx; patient:
// patient/PatientSection.jsx).
const ROOTS = {
  staff: ['select', 'queue', 'display'],
  patient: ['token'],
  admin: [
    'overview', 'branches', 'departments', 'doctors', 'schedules', 'service-points', 'users',
    'reports', 'forecasts', 'workload', 'feedback', 'models', 'settings',
  ],
};

/**
 * After sign-in: the requested page (`from`, already a safe same-app path) when it belongs to the
 * account's section, otherwise that section's landing page.
 */
export function destinationAfterLogin(section, from) {
  const fallback = landingPath(section);
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return fallback;
  const root = from.slice(1).split(/[/?#]/)[0];
  return (ROOTS[section] || []).includes(root) ? from : fallback;
}
