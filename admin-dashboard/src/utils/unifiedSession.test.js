// One dashboard, one session per role: kinds, per-tab choice, no cross-role clearing,
// post-login destinations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_KEY,
  SESSION_KEYS,
  TAB_KEY,
  activeSection,
  activeSession,
  clearSession,
  clearSessions,
  destinationAfterLogin,
  landingPath,
  saveSession,
  sectionForKind,
  sessionKindFor,
  showSessionInThisTab,
} from './unifiedSession.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

// One shared localStorage (same origin) and one sessionStorage per tab.
let local;
let tabs;
function useTab(name) {
  tabs[name] ??= fakeStorage();
  vi.stubGlobal('window', { localStorage: local, sessionStorage: tabs[name] });
}

const doctor = { id: 3, role: 'STAFF', doctorId: 1, fullName: 'Dr. Ahmed Raza' };
const labStaff = { id: 30, role: 'STAFF', doctorId: null };
const admin = { id: 1, role: 'HOSPITAL_ADMIN' };
const guest = { id: 900, role: 'PATIENT' };

beforeEach(() => {
  local = fakeStorage();
  tabs = {};
  useTab('A');
});
afterEach(() => vi.unstubAllGlobals());

describe('session kinds', () => {
  it('doctors and other staff get separate kinds; both use the staff screens', () => {
    expect(sessionKindFor(admin)).toBe('admin');
    expect(sessionKindFor({ role: 'BRANCH_ADMIN' })).toBe('admin');
    expect(sessionKindFor(doctor)).toBe('doctor');
    expect(sessionKindFor(labStaff)).toBe('staff');
    expect(sessionKindFor(guest)).toBe('patient');
    expect(sessionKindFor({ role: 'SUPERUSER' })).toBeNull();
    expect(sectionForKind('doctor')).toBe('staff');
    expect(sectionForKind('staff')).toBe('staff');
    expect(sectionForKind('admin')).toBe('admin');
    expect(sectionForKind('patient')).toBe('patient');
  });

  it('each role writes its own keys', () => {
    expect(SESSION_KEYS.doctor).toEqual({ token: 'smartopd.doctor.token', user: 'smartopd.doctor.user' });
    expect(saveSession('jwt-doc', doctor)).toBe('staff');
    expect(local.getItem('smartopd.doctor.token')).toBe('jwt-doc');
    expect(local.getItem('smartopd.staff.token')).toBeNull();
    expect(activeSession()).toBe('doctor');
    expect(activeSection()).toBe('staff');
  });
});

describe('several tabs, several roles', () => {
  it('a walk-in check-in in another tab never signs the doctor out', () => {
    saveSession('jwt-doc', doctor); // tab A: doctor
    useTab('B');
    expect(activeSession()).toBe('doctor'); // a fresh tab opens the latest sign-in
    saveSession('jwt-guest', guest); // tab B: walk-in
    expect(activeSession()).toBe('patient');
    useTab('A');
    expect(activeSession()).toBe('doctor'); // tab A still the doctor
    expect(local.getItem('smartopd.doctor.token')).toBe('jwt-doc');
  });

  it('doctor, lab staff, admin and patient can be signed in at the same time in four tabs', () => {
    const cast = { A: ['jwt-doc', doctor], B: ['jwt-lab', labStaff], C: ['jwt-adm', admin], D: ['jwt-pt', guest] };
    for (const [tab, [token, user]] of Object.entries(cast)) {
      useTab(tab);
      saveSession(token, user);
    }
    const expected = { A: 'doctor', B: 'staff', C: 'admin', D: 'patient' };
    for (const [tab, kind] of Object.entries(expected)) {
      useTab(tab);
      expect(activeSession()).toBe(kind);
    }
  });

  it('signing out one role keeps the others; that tab shows the login', () => {
    saveSession('jwt-doc', doctor);
    useTab('B');
    saveSession('jwt-pt', guest);
    clearSession('patient'); // tab B signs out
    expect(activeSession()).toBeNull();
    expect(local.getItem('smartopd.doctor.token')).toBe('jwt-doc');
    useTab('A');
    expect(activeSession()).toBe('doctor');
  });

  it('a tab whose role was signed out elsewhere shows the login, not another role', () => {
    saveSession('jwt-doc', doctor); // tab A
    useTab('B');
    saveSession('jwt-adm', admin); // tab B
    useTab('C');
    showSessionInThisTab('doctor');
    clearSession('doctor'); // tab C signs the doctor out
    useTab('A');
    expect(activeSession()).toBeNull();
    useTab('B');
    expect(activeSession()).toBe('admin');
  });

  it('an admin can store a doctor session for a new tab without leaving the admin view', () => {
    saveSession('jwt-adm', admin); // tab A
    saveSession('jwt-doc', doctor, { inThisTab: false });
    expect(activeSession()).toBe('admin');
    useTab('NEW');
    showSessionInThisTab('doctor'); // the new tab was opened with ?session=doctor
    expect(activeSession()).toBe('doctor');
    expect(local.getItem(LAST_KEY)).toBe('doctor');
  });

  it('refuses unknown roles and empty tokens; clearSessions removes everything', () => {
    expect(() => saveSession('jwt', { role: 'SUPERUSER' })).toThrow();
    expect(() => saveSession('', doctor)).toThrow();
    saveSession('jwt-doc', doctor);
    clearSessions();
    expect(local.map.size).toBe(0);
    expect(tabs.A.getItem(TAB_KEY)).toBeNull();
    expect(activeSession()).toBeNull();
  });

  it('a stored user that does not match its keys is ignored', () => {
    local.setItem('smartopd.doctor.token', 't');
    local.setItem('smartopd.doctor.user', JSON.stringify(labStaff));
    expect(activeSession()).toBeNull();
    local.setItem('smartopd.doctor.user', '{not json');
    expect(activeSession()).toBeNull();
  });
});

describe('destinations', () => {
  it('sends each section to its own screens only (a previous account’s page never carries over)', () => {
    expect(landingPath('admin')).toBe('/overview');
    expect(landingPath('staff')).toBe('/');
    expect(destinationAfterLogin('admin', '/reports?type=feedback')).toBe('/reports?type=feedback');
    expect(destinationAfterLogin('admin', '/queue/1')).toBe('/overview');
    expect(destinationAfterLogin('staff', '/queue/11')).toBe('/queue/11');
    expect(destinationAfterLogin('staff', '/overview')).toBe('/');
    expect(destinationAfterLogin('patient', '/token/42')).toBe('/token/42');
    expect(destinationAfterLogin('staff', '//evil.example')).toBe('/');
    expect(destinationAfterLogin('admin', null)).toBe('/overview');
  });
});
