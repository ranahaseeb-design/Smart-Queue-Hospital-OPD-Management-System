// Smart OPD Dashboard — one web app for every login type.
// /login is the shared role-card sign-in. Everything else renders the section of the signed-in
// account: the admin screens (BRANCH_ADMIN / HOSPITAL_ADMIN), the doctor/staff screens (STAFF) or
// the Patient Portal & token kiosk (PATIENT, incl. walk-in guests), each loaded on demand with its
// own stylesheet. Sign-in and sign-out do a full page load, so a
// page only ever holds one section (and one section's styles).
import { lazy, Suspense, useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import UnifiedLoginPage from './pages/UnifiedLoginPage.jsx';
import { activeSection } from './utils/unifiedSession.js';

const AdminSection = lazy(() => import('./sections/AdminSection.jsx'));
const StaffSection = lazy(() => import('./sections/StaffSection.jsx'));
const PatientSection = lazy(() => import('./patient/PatientSection.jsx'));
const SECTIONS = { admin: AdminSection, staff: StaffSection, patient: PatientSection };

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

  // A section sent us to /login (sign out, expired session): reload so its styles and state go.
  // The history state is cleared first: a reload keeps it, and a return path from the previous
  // account's section must not carry over to the next sign-in.
  useEffect(() => {
    if (onLogin && loadedSection.current) {
      window.history.replaceState(null, '', '/login');
      window.location.reload();
    }
  }, [onLogin]);

  if (onLogin) return loadedSection.current ? null : <UnifiedLoginPage />;

  const section = activeSection();
  if (!section) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  loadedSection.current = section;
  const Section = SECTIONS[section];
  return (
    <Suspense fallback={<SectionLoading />}>
      <Section />
    </Suspense>
  );
}
