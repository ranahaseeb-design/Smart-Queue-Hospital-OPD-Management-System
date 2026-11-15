// Shared sign-in of the Smart OPD Dashboard (FR-01): all four login types on one screen.
// Every card opens its form here. The card is sent as `portal`, so the backend refuses an account
// of another type before issuing a token (roles matrix, Section 3.2). After sign-in the page
// reloads into the account's section: admin screens or doctor/staff screens.
// Styled only by tokens.css + portal.css (no section stylesheet is loaded on this page).
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api/client.js';
import LoginPortalPicker, { PortalIcon } from '@staff/components/LoginPortalPicker.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { portalById } from '@staff/utils/loginPortals.js';
import { destinationAfterLogin, saveSession } from '../utils/unifiedSession.js';
import { safeReturnPath } from '../utils/navigation.js';
import { useDemoTools } from '@staff/utils/demoMode.js';
import '@staff/styles/portal.css';

// Development-only quick fill with the seed accounts (docs/API_CONTRACT.md). Removed from
// production builds because import.meta.env.DEV is false there.
const DEV_ACCOUNTS = import.meta.env.DEV
  ? {
    patient: { identifier: 'patient@opd.test', password: 'Patient@123' },
    doctor: { identifier: 'doctor1@opd.test', password: 'Staff@123' },
    staff: { identifier: 'lab1@opd.test', password: 'Staff@123' },
    'branch-admin': { identifier: 'branchadmin@opd.test', password: 'Admin@123' },
    'hospital-admin': { identifier: 'admin@opd.test', password: 'Admin@123' },
  }
  : {};

/**
 * Kiosk walk-in: one click creates a guest patient session (POST /auth/guest) and opens the
 * patient portal — no credentials. The optional name is shown to staff in the queue.
 */
function WalkInCheckIn({ disabled }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [birthYear, setBirthYear] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameId = useId();
  const phoneId = useId();
  const yearId = useId();
  const senior = priority === 'URGENT_SENIOR';

  async function checkIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.guestCheckIn({
        fullName: name.trim() || undefined,
        phone: phone.trim() || undefined,
        priority,
        birthYear: senior && birthYear ? Number(birthYear) : undefined,
      });
      saveSession(res.token, res.user);
      window.location.assign('/');
    } catch (err) {
      setError(err?.status === 404 ? 'Walk-in check-in is turned off on this server.' : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="portal-walkin">
      <div className="portal-divider" role="separator"><span>or walk in</span></div>
      <div className="portal-walkin-grid">
        <div className="portal-field">
          <label className="portal-label" htmlFor={nameId}>Name (optional)</label>
          <input id={nameId} className="portal-input" type="text" autoComplete="name" maxLength={100} placeholder="e.g. Ayesha Bibi"
            value={name} onChange={(e) => setName(e.target.value)} disabled={busy || disabled} />
        </div>
        <div className="portal-field">
          <label className="portal-label" htmlFor={phoneId}>Phone (optional)</label>
          <input id={phoneId} className="portal-input" type="tel" autoComplete="tel" inputMode="tel" maxLength={20} placeholder="03xx xxxxxxx"
            value={phone} onChange={(e) => setPhone(e.target.value)} disabled={busy || disabled} />
        </div>
      </div>
      <fieldset className="portal-priority" disabled={busy || disabled}>
        <legend className="portal-label">Priority</legend>
        <div className="portal-priority-options" role="radiogroup">
          {[['NORMAL', 'Normal'], ['URGENT_SENIOR', 'Urgent / Senior']].map(([value, label]) => (
            <label key={value} className={priority === value ? 'portal-radio is-on' : 'portal-radio'}>
              <input type="radio" name="walkin-priority" value={value} checked={priority === value} onChange={() => setPriority(value)} />
              {label}
            </label>
          ))}
        </div>
        {senior && (
          <div className="portal-field">
            <label className="portal-label" htmlFor={yearId}>Year of birth (seniors 60+ are prioritised)</label>
            <input id={yearId} className="portal-input" type="number" inputMode="numeric" min="1900" max={new Date().getFullYear()}
              placeholder="e.g. 1955" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
            <p className="portal-dev">For an urgent medical need, please also tell the reception desk — staff set emergency priority.</p>
          </div>
        )}
      </fieldset>
      {error && <p className="portal-error" role="alert">{error}</p>}
      <button type="button" className="portal-submit portal-submit--walkin" onClick={checkIn} disabled={busy || disabled}>
        {busy && <span className="portal-submit-spinner" aria-hidden="true" />}
        {busy ? 'Checking in…' : '1-click walk-in / guest check-in'}
      </button>
      <p className="portal-dev">No account needed — get a token at the kiosk in one tap.</p>
    </div>
  );
}

function LoginForm({ portal, onBack, returnTo }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const idRef = useRef(null);
  const headingId = useId();
  const idId = useId();
  const pwId = useId();
  const errorId = useId();
  const devAccount = DEV_ACCOUNTS[portal.id];

  useEffect(() => {
    idRef.current?.focus();
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your username, email or phone and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(identifier.trim(), password, portal.apiPortal);
      if (!res?.token || !res?.user) throw new Error('Unexpected response from the server.');
      const section = saveSession(res.token, res.user);
      // Full page load into the account's section: the requested page if it is one of that
      // section's screens, else the section's landing page.
      const from = returnTo ? safeReturnPath(returnTo) : null;
      window.location.assign(destinationAfterLogin(section, from));
    } catch (err) {
      setError(err?.status === 401 ? 'Incorrect username/email/phone or password.' : errorMessage(err));
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <section className="portal-form-view" aria-labelledby={headingId}>
      <button type="button" className="portal-back" onClick={onBack}>
        <PortalIcon name="arrowLeft" />
        Back to login options
      </button>

      <div className="portal-form-head">
        <span className="portal-icon portal-icon--lg" aria-hidden="true">
          <PortalIcon name={portal.icon} />
        </span>
        <div>
          <h2 id={headingId} className="portal-form-title">{portal.title}</h2>
          <p className="portal-form-subtitle">{portal.subtitle}</p>
        </div>
      </div>

      <form onSubmit={submit} noValidate aria-describedby={error ? errorId : undefined}>
        <div className="portal-field">
          <label className="portal-label" htmlFor={idId}>
            {portal.id === 'patient' ? 'Phone or email' : 'Username, email or phone'}
          </label>
          <input
            ref={idRef}
            id={idId}
            className="portal-input"
            type="text"
            inputMode="email"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={busy}
            aria-invalid={error && !identifier.trim() ? 'true' : undefined}
          />
        </div>
        <div className="portal-field">
          <label className="portal-label" htmlFor={pwId}>Password</label>
          <div className="portal-password">
            <input
              id={pwId}
              className="portal-input"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-invalid={error && !password ? 'true' : undefined}
            />
            <button
              type="button"
              className="portal-password-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {error && (
          <p id={errorId} className="portal-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="portal-submit" disabled={busy} aria-busy={busy || undefined}>
          {busy && <span className="portal-submit-spinner" aria-hidden="true" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {portal.id === 'patient' && <WalkInCheckIn disabled={busy} />}

      {devAccount && (
        <p className="portal-dev">
          Development seed account:{' '}
          <button
            type="button"
            className="portal-dev-fill"
            onClick={() => { setIdentifier(devAccount.identifier); setPassword(devAccount.password); setError(null); }}
          >
            Fill {devAccount.identifier}
          </button>
        </p>
      )}
    </section>
  );
}

/** Presentation switch for this browser (see @staff/utils/demoMode.js). */
function DemoToolsSwitch() {
  const [on, setOn] = useDemoTools();
  return (
    <label className="portal-demo-switch" title="Shows demo data, peak congestion, the doctor switcher and the patient load simulator">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      <span>Demo tools for presentations: <strong>{on ? 'On' : 'Off'}</strong></span>
    </label>
  );
}

export default function UnifiedLoginPage() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const selected = portalById(params.get('portal'));
  const returnTo = location.state?.from;

  const choose = (portal) => setParams({ portal: portal.id }, { state: location.state });
  const back = () => setParams({}, { state: location.state });

  return (
    <main className="portal-page">
      <ThemeToggle className="portal-theme" />
      <div className={`portal-shell${selected ? ' portal-shell--form' : ''}`}>
        <header className="portal-header">
          <span className="portal-brand" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <h1 className="portal-app-name">Smart OPD</h1>
          {!selected && (
            <>
              <p className="portal-welcome">Welcome back!</p>
              <p className="portal-lead">Select your login type to continue</p>
            </>
          )}
        </header>

        {selected ? (
          <LoginForm key={selected.id} portal={selected} onBack={back} returnTo={returnTo} />
        ) : (
          <LoginPortalPicker localApp="all" onSelect={choose} />
        )}

        <p className="portal-footnote">
          Your role is verified when you sign in.
        </p>
        <DemoToolsSwitch />
      </div>
    </main>
  );
}
