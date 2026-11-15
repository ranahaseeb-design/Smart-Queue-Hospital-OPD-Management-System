// Four-card sign-in: portal definitions, cross-dashboard links and the rendered picker.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LoginPortalPicker from '../components/LoginPortalPicker.jsx';
import { LOGIN_PORTALS, portalById, portalHref } from '../utils/loginPortals.js';

describe('login portals', () => {
  it('defines the four cards in order with the backend portal names', () => {
    expect(LOGIN_PORTALS.map((p) => [p.id, p.apiPortal, p.app])).toEqual([
      ['doctor', 'DOCTOR', 'staff'],
      ['staff', 'STAFF', 'staff'],
      ['branch-admin', 'BRANCH_ADMIN', 'admin'],
      ['hospital-admin', 'HOSPITAL_ADMIN', 'admin'],
    ]);
    expect(LOGIN_PORTALS.map((p) => p.subtitle)).toEqual([
      'Access Doctor Portal',
      'Access Staff Portal',
      'Manage Your Branch',
      'Manage Entire Hospital',
    ]);
  });

  it('finds a portal by its URL id (case-insensitive) and rejects anything else', () => {
    expect(portalById('doctor').apiPortal).toBe('DOCTOR');
    expect(portalById(' Hospital-Admin ').apiPortal).toBe('HOSPITAL_ADMIN');
    for (const bad of [null, undefined, '', 'admin', 42, '../login', 'doctor?x=1']) {
      expect(portalById(bad)).toBeNull();
    }
  });

  it('links only the other dashboard’s cards, with just the portal id in the URL', () => {
    const doctor = portalById('doctor');
    const hospital = portalById('hospital-admin');
    expect(portalHref(doctor, 'staff', 'http://localhost:5174')).toBeNull();
    expect(portalHref(hospital, 'staff', 'http://localhost:5174/')).toBe('http://localhost:5174/login?portal=hospital-admin');
    expect(portalHref(hospital, 'admin', 'http://localhost:5173')).toBeNull();
    expect(portalHref(doctor, 'admin', 'http://localhost:5173')).toBe('http://localhost:5173/login?portal=doctor');
    expect(portalHref(null, 'staff', 'x')).toBeNull();
  });
});

describe('LoginPortalPicker', () => {
  const render = (localApp, otherAppUrl) =>
    renderToStaticMarkup(
      createElement(LoginPortalPicker, { localApp, otherAppUrl, otherAppName: 'Other Dashboard', onSelect: () => {} }),
    );

  it('shows all four cards together: local ones as buttons, the others as links', () => {
    const html = render('staff', 'http://localhost:5174');
    for (const p of LOGIN_PORTALS) {
      expect(html).toContain(p.title);
      expect(html).toContain(p.subtitle);
    }
    expect((html.match(/<button/g) || []).length).toBe(2);
    expect((html.match(/<a /g) || []).length).toBe(2);
    expect(html).toContain('href="http://localhost:5174/login?portal=branch-admin"');
    expect(html).toContain('href="http://localhost:5174/login?portal=hospital-admin"');
    expect(html).toContain('aria-label="Doctor Login — Access Doctor Portal"');
    expect(html).not.toMatch(/password|token/i);
  });

  it('flips which cards are local on the admin dashboard', () => {
    const html = render('admin', 'http://localhost:5173');
    expect(html).toContain('href="http://localhost:5173/login?portal=doctor"');
    expect(html).toContain('href="http://localhost:5173/login?portal=staff"');
    expect(html).not.toContain('portal=hospital-admin');
  });
});
