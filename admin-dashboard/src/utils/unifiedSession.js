// One dashboard for every role, with one session PER ROLE so tabs never collide.
//
// All tabs of the dashboard share one origin and therefore one localStorage. Each role keeps its
// own keys — smartopd.admin.*, smartopd.doctor.*, smartopd.staff.* (lab / pharmacy / OPD staff),
// smartopd.patient.* — and signing in or out only touches that role's keys, so a walk-in
// check-in in one tab never signs a doctor out in another. Which role a tab shows is remembered
// per tab (sessionStorage); a new tab opens the most recently signed-in role.

export const SESSION_KINDS = ['admin', 'doctor', 'staff', 'patient'];
export const SESSION_KEYS = Object.fromEntries(
  SESSION_KINDS.map((kind) => [kind, { token: `smartopd.${kind}.token`, user: `smartopd.${kind}.user` }]),
);
export const TAB_KEY = 'smartopd.tabSession'; // sessionStorage: kind shown in this tab ('none' = signed out here)
export const LAST_KEY = 'smartopd.lastSession'; // localStorage: most recent sign-in, for new tabs
const LEGACY_KEYS = ['smartopd.section']; // pre-split shared key, removed on sight

function store(kind) {
  try {
    return typeof window !== 'undefined' ? window[kind] : null;
  } catch {
    return null;
  }
}

function read(storage, key) {
  try {
    return store(storage)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    if (value === null) store(storage)?.removeItem(key);
    else store(storage)?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readUser(key) {
  try {
    return JSON.parse(read('localStorage', key) || 'null');
  } catch {
    return null;
  }
}

/** Session kind of an account: admin, doctor (STAFF with a doctor profile), staff or patient. */
export function sessionKindFor(user) {
  switch (user?.role) {
    case 'BRANCH_ADMIN':
    case 'HOSPITAL_ADMIN':
      return 'admin';
    case 'STAFF':
      return user.doctorId ? 'doctor' : 'staff';
    case 'PATIENT':
      return 'patient';
    default:
      return null;
  }
}

/** UI section for a session kind: doctors and staff share the queue screens. */
export function sectionForKind(kind) {
  if (kind === 'doctor' || kind === 'staff') return 'staff';
  return kind === 'admin' || kind === 'patient' ? kind : null;
}

/** Back-compat helper: section for a bare role (doctors and staff both → 'staff'). */
export function sectionForRole(role) {
  return sectionForKind(sessionKindFor({ role, doctorId: null }));
}

export function hasSession(kind) {
  const keys = SESSION_KEYS[kind];
  if (!keys || !read('localStorage', keys.token)) return false;
  return sessionKindFor(readUser(keys.user)) === kind;
}

/**
 * Kind of session this tab shows, or null (→ login): the tab's own choice when that session is
 * still valid; a tab that signed out stays signed out; a new tab takes the latest sign-in, or
 * the only session present.
 */
export function activeSession() {
  for (const key of LEGACY_KEYS) write('localStorage', key, null);
  const tab = read('sessionStorage', TAB_KEY);
  if (tab === 'none') return null;
  // A tab keeps its own role: if that role was signed out (here or in another tab) the tab shows
  // the login instead of silently switching to another role's session.
  if (tab) return hasSession(tab) ? tab : null;
  const last = read('localStorage', LAST_KEY);
  if (last && hasSession(last)) return last;
  const present = SESSION_KINDS.filter(hasSession);
  return present.length === 1 ? present[0] : null;
}

/** Back-compat: UI section of this tab's session. */
export function activeSection() {
  return sectionForKind(activeSession());
}

/** Make this tab show `kind` (e.g. a tab opened for a doctor's live queue). */
export function showSessionInThisTab(kind) {
  if (SESSION_KINDS.includes(kind)) write('sessionStorage', TAB_KEY, kind);
}

/**
 * Store a successful sign-in under its own role's keys only. Other roles' sessions (other tabs)
 * are left untouched. `inThisTab: false` stores it without switching this tab (used when an admin
 * opens a doctor's queue in a new tab).
 */
export function saveSession(token, user, { inThisTab = true } = {}) {
  const kind = sessionKindFor(user);
  if (!kind || !token) throw new Error('This account cannot use the dashboard.');
  const keys = SESSION_KEYS[kind];
  const ok = write('localStorage', keys.token, token) && write('localStorage', keys.user, JSON.stringify(user));
  if (!ok) throw new Error('Your browser blocked storage, so the session cannot be kept. Allow site data and try again.');
  write('localStorage', LAST_KEY, kind);
  if (inThisTab) write('sessionStorage', TAB_KEY, kind);
  return sectionForKind(kind);
}

/** Sign one role out (its keys only); this tab then shows the login until it signs in again. */
export function clearSession(kind) {
  const keys = SESSION_KEYS[kind];
  if (keys) {
    write('localStorage', keys.token, null);
    write('localStorage', keys.user, null);
  }
  if (read('localStorage', LAST_KEY) === kind) write('localStorage', LAST_KEY, null);
  write('sessionStorage', TAB_KEY, 'none');
}

/** Mark this tab signed out (after a section removed its own keys). */
export function markTabSignedOut() {
  write('sessionStorage', TAB_KEY, 'none');
}

/** Remove every role's session (tests / "sign out everywhere"). */
export function clearSessions() {
  for (const kind of SESSION_KINDS) {
    write('localStorage', SESSION_KEYS[kind].token, null);
    write('localStorage', SESSION_KEYS[kind].user, null);
  }
  write('localStorage', LAST_KEY, null);
  for (const key of LEGACY_KEYS) write('localStorage', key, null);
  write('sessionStorage', TAB_KEY, null);
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
    'reports', 'forecasts', 'workload', 'feedback', 'models', 'settings', 'display',
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
