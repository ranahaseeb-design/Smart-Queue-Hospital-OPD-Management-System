// Staff sign-in (FR-01, Table 4.19 "Login"). Identifier = email or phone (POST /api/auth/login).
// Accounts that are not STAFF are rejected with a clear explanation (Section 3.2 roles matrix).
import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import Icon from '../components/Icon.jsx';
import { BrandGlyph } from '../components/Spinner.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';

export default function LoginPage() {
  const { token, user, login, notice, clearNotice } = useAuth();
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

  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  if (token && user) return <Navigate to="/" replace />;

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
      await login(identifier, password);
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
    <main className="login-page">
      <div className="login-theme">
        <ThemeToggle />
      </div>
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark brand-mark--lg" aria-hidden="true">
            <BrandGlyph />
          </span>
          <div>
            <h1 className="login-title">Smart OPD</h1>
            <p className="login-subtitle">Staff Dashboard — doctors, OPD, laboratory and pharmacy</p>
          </div>
        </div>

        <form onSubmit={submit} noValidate aria-describedby={message ? errorId : undefined}>
          <div className="field">
            <label className="field-label" htmlFor={idId}>
              Email or phone
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
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-footnote">
          Administrators use the Admin Dashboard. Patients use the Smart OPD mobile app.
        </p>
      </div>
    </main>
  );
}
