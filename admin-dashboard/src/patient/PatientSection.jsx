// Patient Portal & self-service token kiosk — the PATIENT section of the Smart OPD Dashboard.
// Loaded on demand by RootApp with its own stylesheet. Routes: / (booking), /token/:id (pass),
// /appointments (FR-10), /visits (history + feedback, FR-19/20), /notifications (FR-11) and
// /profile (FR-01).
import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { PatientProvider, usePatient } from './PatientContext.jsx';
import { signOut } from './patientApi.js';
import BookingPage from './BookingPage.jsx';
import TokenPassPage from './TokenPassPage.jsx';
import AppointmentsPage from './AppointmentsPage.jsx';
import VisitsPage from './VisitsPage.jsx';
import NotificationsPage from './NotificationsPage.jsx';
import ProfilePage from './ProfilePage.jsx';
import DemoDrawer from './DemoDrawer.jsx';
import { useDemoTools } from '@staff/utils/demoMode.js';
import './patient.css';

function Header({ onDemo }) {
  const { user, live, unread } = usePatient();
  return (
    <header className="pt-header">
      <div className="pt-brand">
        <span className="pt-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        <div>
          <strong>Smart OPD</strong>
          <span className="pt-muted pt-small">Patient Portal · Get Token</span>
        </div>
      </div>
      <nav className="pt-nav" aria-label="Patient portal">
        <NavLink to="/" end className={({ isActive }) => `pt-nav-link${isActive ? ' is-on' : ''}`}>Get token</NavLink>
        <NavLink to="/appointments" className={({ isActive }) => `pt-nav-link${isActive ? ' is-on' : ''}`}>Appointments</NavLink>
        <NavLink to="/visits" className={({ isActive }) => `pt-nav-link${isActive ? ' is-on' : ''}`}>My visits</NavLink>
        <NavLink to="/notifications" className={({ isActive }) => `pt-nav-link${isActive ? ' is-on' : ''}`} aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}>
          Notifications{unread > 0 && <span className="pt-nav-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
      </nav>
      <div className="pt-header-right">
        <span className={`pt-live${live ? ' is-on' : ''}`} title={live ? 'Live updates connected' : 'Reconnecting…'}>
          <span className="pt-live-dot" aria-hidden="true" /> {live ? 'Live' : 'Offline'}
        </span>
        {onDemo && (
          <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm pt-demo-btn" onClick={onDemo}>
            Demo load simulator
          </button>
        )}
        <ThemeToggle className="pt-theme" />
        <NavLink to="/profile" className="pt-user pt-user-link" title="My profile">{user?.fullName || 'Patient'}</NavLink>
        <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

export default function PatientSection() {
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoOn] = useDemoTools();
  return (
    <PatientProvider>
      <div className="pt-app">
        <Header onDemo={demoOn ? () => setDemoOpen(true) : null} />
        <main className="pt-main">
          <Routes>
            <Route path="/" element={<BookingPage />} />
            <Route path="/token/:id" element={<TokenPassPage />} />
            <Route path="/appointments" element={<AppointmentsPage />} />
            <Route path="/visits" element={<VisitsPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        {demoOn && <DemoDrawer open={demoOpen} onClose={() => setDemoOpen(false)} />}
      </div>
    </PatientProvider>
  );
}
