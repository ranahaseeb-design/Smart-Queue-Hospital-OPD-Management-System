// One dashboard for every role: section choice, session storage and post-login destination.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SECTION_KEY,
  activeSection,
  clearSessions,
  destinationAfterLogin,
  landingPath,
  saveSession,
  sectionForRole,
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

let storage;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => vi.unstubAllGlobals());

describe('unified session', () => {
  it('maps roles to sections (admin, staff, patient portal)', () => {
    expect(sectionForRole('HOSPITAL_ADMIN')).toBe('admin');
    expect(sectionForRole('BRANCH_ADMIN')).toBe('admin');
    expect(sectionForRole('STAFF')).toBe('staff');
    expect(sectionForRole('PATIENT')).toBe('patient');
    expect(sectionForRole('SUPERUSER')).toBeNull();
    expect(sectionForRole(undefined)).toBeNull();
  });

  it('saves a patient (or walk-in guest) login under the patient keys', () => {
    expect(saveSession('jwt-patient', { id: 9, role: 'PATIENT' })).toBe('patient');
    expect(storage.getItem('smartopd.patient.token')).toBe('jwt-patient');
    expect(activeSection()).toBe('patient');
    expect(destinationAfterLogin('patient', '/token/42')).toBe('/token/42');
    expect(destinationAfterLogin('patient', '/overview')).toBe('/');
  });

  it('saves a staff login under the staff keys and clears any admin session', () => {
    storage.setItem('smartopd.admin.token', 'old');
    storage.setItem('smartopd.admin.user', JSON.stringify({ role: 'HOSPITAL_ADMIN' }));
    expect(saveSession('jwt-staff', { id: 3, role: 'STAFF' })).toBe('staff');
    expect(storage.getItem('smartopd.staff.token')).toBe('jwt-staff');
    expect(JSON.parse(storage.getItem('smartopd.staff.user')).id).toBe(3);
    expect(storage.getItem('smartopd.admin.token')).toBeNull();
    expect(storage.getItem(SECTION_KEY)).toBe('staff');
    expect(activeSection()).toBe('staff');
  });

  it('saves an admin login under the admin keys', () => {
    expect(saveSession('jwt-admin', { id: 1, role: 'BRANCH_ADMIN' })).toBe('admin');
    expect(storage.getItem('smartopd.admin.token')).toBe('jwt-admin');
    expect(storage.getItem('smartopd.staff.token')).toBeNull();
    expect(activeSection()).toBe('admin');
  });

  it('refuses unknown roles and empty tokens', () => {
    expect(() => saveSession('jwt', { role: 'SUPERUSER' })).toThrow();
    expect(() => saveSession('', { role: 'STAFF' })).toThrow();
    expect(activeSection()).toBeNull();
  });

  it('has no section without a token, or when the stored role does not fit the keys', () => {
    expect(activeSection()).toBeNull();
    storage.setItem('smartopd.staff.token', 't');
    storage.setItem('smartopd.staff.user', JSON.stringify({ role: 'HOSPITAL_ADMIN' }));
    expect(activeSection()).toBeNull();
    storage.setItem('smartopd.staff.user', '{not json');
    expect(activeSection()).toBeNull();
  });

  it('clears every session key', () => {
    saveSession('jwt', { role: 'STAFF' });
    clearSessions();
    expect(storage.map.size).toBe(0);
    expect(activeSection()).toBeNull();
  });

  it('sends each section to its own screens only (a previous account’s page never carries over)', () => {
    expect(landingPath('admin')).toBe('/overview');
    expect(landingPath('staff')).toBe('/');
    expect(destinationAfterLogin('admin', '/reports?type=feedback')).toBe('/reports?type=feedback');
    expect(destinationAfterLogin('admin', '/queue/1')).toBe('/overview');
    expect(destinationAfterLogin('staff', '/queue/11')).toBe('/queue/11');
    expect(destinationAfterLogin('staff', '/overview')).toBe('/');
    expect(destinationAfterLogin('staff', '//evil.example')).toBe('/');
    expect(destinationAfterLogin('admin', null)).toBe('/overview');
  });
});
