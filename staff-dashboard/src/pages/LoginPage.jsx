// Sign-in (FR-01, Table 4.19 "Login") — the four-card login screen.
// All four login types show together; Doctor and Staff open their form here, the two
// administrator cards open the Admin Dashboard's login with that card preselected. The chosen
// card is sent as `portal`, so the backend refuses accounts of another type (roles matrix,
// Section 3.2); the app also keeps only STAFF tokens (AuthContext).
import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import LoginPortalPicker, { PortalIcon } from '../components/LoginPortalPicker.jsx';
import { BrandGlyph } from '../components/Spinner.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import { ADMIN_APP_URL } from '../config.js';
import { portalById, portalHref } from '../utils/loginPortals.js';
import '../styles/portal.css';

const LOCAL_APP = 'staff';
const OTHER_APP_NAME = 'Admin Dashboard';

function LoginForm({ portal, onBack }) {
  const { login, notice, clearNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const identifierRef = useRef(null);
  const idId = useId();
  const pwId = useId();
  const errorId = useId();
  const headingId = useId();

  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your email or phone number and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    clearNotice();
    try {
      await login(identifier, password, portal.apiPortal);
      const from = location.state && location.state.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(
        err.status === 401
          ? 'Incorrect email/phone or password.'
          : err.message || 'Sign-in failed. Please try again.',
      );
      setPassword('');
      setBusy(false);
    }
  }

  const message = error || notice;

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

      <form onSubmit={submit} noValidate aria-describedby={message ? errorId : undefined}>
        <div className="field">
          <label className="field-label" htmlFor={idId}>
            Username, email or phone
          </label>
          <input
            ref={identifierRef}
            id={idId}
            className="input input--lg"
            type="text"
            inputMode="email"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={busy}
            required
            aria-invalid={error && !identifier.trim() ? 'true' : undefined}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor={pwId}>
            Password
          </label>
          <div className="input-with-button">
            <input
              id={pwId}
              className="input input--lg"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              aria-invalid={error && !password ? 'true' : undefined}
            />
            <button
              type="button"
              className="btn btn--ghost btn--sm input-addon"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <Icon name={showPassword ? 'eyeOff' : 'eye'} />
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {message && (
          <p id={errorId} className={error ? 'form-error' : 'form-notice'} role={error ? 'alert' : 'status'}>
            <Icon name={error ? 'alert' : 'info'} />
            {message}
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy && <span className="btn-spinner" aria-hidden="true" />}
          {busy ? 'Signing in…' : `Sign in to ${portal.subtitle.replace(/^Access /, '')}`}
        </button>
      </form>
    </section>
  );
}

export default function LoginPage() {
  const { token, user } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const selected = portalById(params.get('portal'));
  // An administrator card in the URL belongs to the Admin Dashboard: hand over to its login.
  const elsewhere = selected ? portalHref(selected, LOCAL_APP, ADMIN_APP_URL) : null;

  useEffect(() => {
    if (elsewhere) window.location.assign(elsewhere);
  }, [elsewhere]);

  if (token && user) return <Navigate to="/" replace />;
  if (elsewhere) return null;

  // Keep the return path (location.state) when switching between the cards and a form.
  const choose = (portal) => setParams({ portal: portal.id }, { state: location.state });
  const back = () => setParams({}, { state: location.state });

  return (
    <main className="portal-page">
      <div className="portal-theme">
        <ThemeToggle />
      </div>
      <div className={`portal-shell${selected ? ' portal-shell--form' : ''}`}>
        <header className="portal-header">
          <span className="portal-brand" aria-hidden="true">
            <BrandGlyph />
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
          <LoginForm key={selected.id} portal={selected} onBack={back} />
        ) : (
          <LoginPortalPicker
            localApp={LOCAL_APP}
            otherAppUrl={ADMIN_APP_URL}
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
