// Smart OPD Dashboard — one web app for every login type.
// /login is the shared role-card sign-in. Everything else renders the section of the session THIS
// TAB uses (utils/unifiedSession.js): the admin screens (BRANCH_ADMIN / HOSPITAL_ADMIN), the
// doctor/staff screens (STAFF; doctors and other staff keep separate sessions) or the Patient
// Portal & token kiosk (PATIENT, incl. walk-in guests). Each section is loaded on demand with its
// own stylesheet; sign-in and sign-out do a full page load, so a page only holds one section.
// Several tabs can be signed in as different roles at the same time.
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { setKeyPrefix } from '@staff/utils/storage.js';
import UnifiedLoginPage from './pages/UnifiedLoginPage.jsx';
import {
  SESSION_KEYS,
  activeSession,
  landingPath,
  markTabSignedOut,
  sectionForKind,
  showSessionInThisTab,
} from './utils/unifiedSession.js';

const AdminSection = lazy(() => import('./sections/AdminSection.jsx'));
const StaffSection = lazy(() => import('./sections/StaffSection.jsx'));
const PatientSection = lazy(() => import('./patient/PatientSection.jsx'));
const SECTIONS = { admin: AdminSection, staff: StaffSection, patient: PatientSection };

// A tab opened with ?session=<kind> (e.g. "Open live queue" from Admin > Doctors) shows that
// role's session; the parameter is removed from the address bar straight away.
(function adoptSessionFromUrl() {
  try {
    const url = new URL(window.location.href);
    const kind = url.searchParams.get('session');
    if (!kind) return;
    showSessionInThisTab(kind);
    url.searchParams.delete('session');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
})();

function SectionLoading() {
  return (
    <div className="portal-loading" role="status" aria-live="polite">
      <span className="portal-loading-dot" aria-hidden="true" />
      Loading your dashboard…
    </div>
  );
}

export default function RootApp() {
  const location = useLocation();
  const loadedSection = useRef(null);
  const onLogin = location.pathname === '/login';

  // A section sent us to /login (its sign-out, or an expired session): this tab is now signed
  // out; reload so the section's styles and state go. The history state is cleared first (a
  // reload keeps it) so the previous account's page does not carry over to the next sign-in.
  useEffect(() => {
    if (onLogin && loadedSection.current) {
      markTabSignedOut();
      window.history.replaceState(null, '', '/login');
      window.location.reload();
    }
  }, [onLogin]);

  const kind = onLogin ? null : activeSession();

  // Another tab changed THIS tab's role session (signed in as another doctor, signed out, token
  // refreshed): reload, so this tab never sends one account's token from another account's screen.
  useEffect(() => {
    if (!kind) return undefined;
    const { token, user } = SESSION_KEYS[kind];
    const userId = (raw) => {
      try {
        return JSON.parse(raw || 'null')?.id ?? null;
      } catch {
        return null;
      }
    };
    const onStorage = (e) => {
      // A profile refresh rewrites the user record with the same account: not a reason to reload
      // (it would ping-pong between two tabs of the same role).
      const accountChanged =
        e.key === null || e.key === token || (e.key === user && (e.newValue === null || userId(e.newValue) !== userId(e.oldValue)));
      // Start from the section's home: the previous account's page (e.g. another doctor's room)
      // is not this account's.
      if (accountChanged) window.location.assign(landingPath(sectionForKind(kind)));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [kind]);

  if (onLogin) return loadedSection.current ? null : <UnifiedLoginPage />;
  const section = sectionForKind(kind);
  if (!section) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // Doctors and lab/pharmacy/OPD staff use the same screens with separate session keys.
  if (section === 'staff') setKeyPrefix(`smartopd.${kind}`);
  loadedSection.current = section;
  const Section = SECTIONS[section];
  return (
    <Suspense fallback={<SectionLoading />}>
      <Section />
    </Suspense>
  );
}
