// Sign-in (FR-01) — the four-card login screen.
// All four login types show together; the two administrator cards open their form here, Doctor
// and Staff open the Staff Dashboard's login with that card preselected. The chosen card is sent
// as `portal`, so the backend refuses accounts of another type; this app also keeps only
// BRANCH_ADMIN / HOSPITAL_ADMIN tokens (AuthContext).
import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Banner, Spinner } from '../components/ui.jsx';
import { errorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { safeReturnPath } from '../utils/navigation.js';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LoginPortalPicker, { PortalIcon } from '../components/LoginPortalPicker.jsx';
import { STAFF_APP_URL } from '../config.js';
import { portalById, portalHref } from '../utils/loginPortals.js';
import '../styles/portal.css';

const LOCAL_APP = 'admin';
const OTHER_APP_NAME = 'Staff Dashboard';

// Development-only quick fill with the seed accounts from docs/API_CONTRACT.md.
// `import.meta.env.DEV` is false in production builds, so these are removed from the bundle.
const DEV_ACCOUNTS = import.meta.env.DEV
  ? {
    'hospital-admin': { identifier: 'admin@opd.test', password: 'Admin@123' },
    'branch-admin': { identifier: 'branchadmin@opd.test', password: 'Admin@123' },
  }
  : {};

function LoginForm({ portal, onBack, from }) {
  const { login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef(null);
  const headingId = useId();
  const devAccount = DEV_ACCOUNTS[portal.id];

  useEffect(() => {
    idRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your username, e-mail or phone and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(identifier, password, portal.apiPortal);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err?.status === 401 ? 'Incorrect e-mail/phone or password.' : errorMessage(err));
      setPassword('');
      setBusy(false);
    }
  };

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

      {sessionExpired && !error && (
        <Banner kind="warning">Your session has ended. Please sign in again.</Banner>
      )}
      {error && <Banner kind="error">{error}</Banner>}

      <form onSubmit={submit} className="login-form portal-login-form" noValidate>
        <div className="field">
          <label className="field-label" htmlFor="login-id">Username, e-mail or phone</label>
          <input
            ref={idRef}
            id="login-id"
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="login-pw">Password</label>
          <div className="portal-password">
            <input
              id="login-pw"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
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
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy} aria-busy={busy || undefined}>
          {busy && <Spinner size="xs" />} {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {devAccount && (
        <div className="dev-accounts">
          <span className="muted small">Development seed account:</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => { setIdentifier(devAccount.identifier); setPassword(devAccount.password); setError(null); }}
          >
            Fill {devAccount.identifier}
          </button>
        </div>
      )}
    </section>
  );
}

export default function LoginPage() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const from = safeReturnPath(location.state?.from);
  const selected = portalById(params.get('portal'));
  // A Doctor/Staff card in the URL belongs to the Staff Dashboard: hand over to its login.
  const elsewhere = selected ? portalHref(selected, LOCAL_APP, STAFF_APP_URL) : null;

  useEffect(() => {
    if (elsewhere) window.location.assign(elsewhere);
  }, [elsewhere]);

  if (isAuthenticated) return <Navigate to={from} replace />;
  if (elsewhere) return null;

  // Keep the return path (location.state) when switching between the cards and a form.
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
          <LoginForm key={selected.id} portal={selected} onBack={back} from={from} />
        ) : (
          <LoginPortalPicker
            localApp={LOCAL_APP}
            otherAppUrl={STAFF_APP_URL}
            otherAppName={OTHER_APP_NAME}
            onSelect={choose}
          />
        )}

        <p className="portal-footnote">
          Patients use the Smart OPD patient app. Your role is verified when you sign in.
        </p>
      </div>
    </main>
  );
}
