// Patient Portal & self-service token kiosk — the PATIENT section of the Smart OPD Dashboard.
// Loaded on demand by RootApp with its own stylesheet. Routes: / (booking), /token/:id (pass).
import { useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { PatientProvider, usePatient } from './PatientContext.jsx';
import { signOut } from './patientApi.js';
import BookingPage from './BookingPage.jsx';
import TokenPassPage from './TokenPassPage.jsx';
import DemoDrawer from './DemoDrawer.jsx';
import './patient.css';

function Header({ onDemo }) {
  const { user, live } = usePatient();
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
      <div className="pt-header-right">
        <span className={`pt-live${live ? ' is-on' : ''}`} title={live ? 'Live updates connected' : 'Reconnecting…'}>
          <span className="pt-live-dot" aria-hidden="true" /> {live ? 'Live' : 'Offline'}
        </span>
        <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm pt-demo-btn" onClick={onDemo}>
          Demo load simulator
        </button>
        <ThemeToggle className="pt-theme" />
        <span className="pt-user" title={user?.email || user?.phone || ''}>{user?.fullName || 'Patient'}</span>
        <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

export default function PatientSection() {
  const [demoOpen, setDemoOpen] = useState(false);
  return (
    <PatientProvider>
      <div className="pt-app">
        <Header onDemo={() => setDemoOpen(true)} />
        <main className="pt-main">
          <Routes>
            <Route path="/" element={<BookingPage />} />
            <Route path="/token/:id" element={<TokenPassPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <DemoDrawer open={demoOpen} onClose={() => setDemoOpen(false)} />
      </div>
    </PatientProvider>
  );
}
