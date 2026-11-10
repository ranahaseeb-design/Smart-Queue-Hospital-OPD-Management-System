// Login (FR-01). Only BRANCH_ADMIN and HOSPITAL_ADMIN accounts are accepted by this app.
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Banner, Spinner } from '../components/ui.jsx';
import { errorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { safeReturnPath } from '../utils/navigation.js';
import ThemeToggle from '../components/ThemeToggle.jsx';

// Development-only shortcuts using the seed accounts from docs/API_CONTRACT.md.
// `import.meta.env.DEV` is false in production builds, so these are removed from the bundle.
const DEV_ACCOUNTS = import.meta.env.DEV
  ? [
    { label: 'Hospital admin', identifier: 'admin@opd.test', password: 'Admin@123' },
    { label: 'Branch admin', identifier: 'branchadmin@opd.test', password: 'Admin@123' },
  ]
  : [];

export default function LoginPage() {
  const { isAuthenticated, login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const from = safeReturnPath(location.state?.from);
  if (isAuthenticated) return <Navigate to={from} replace />;

  const submit = async (e) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError('Enter your e-mail or phone and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(identifier, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err?.status === 401 ? 'Incorrect e-mail/phone or password.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <ThemeToggle className="login-theme" />
      <main className="login-panel">
        <div className="login-brand">
          <span className="brand-mark brand-mark-lg" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <div>
            <h1>Smart OPD</h1>
            <p>Admin Dashboard</p>
          </div>
        </div>
        <p className="login-intro">
          Sign in as a Branch or Hospital Administrator to monitor OPD queues, manage master data,
          review reports and forecasts.
        </p>

        {sessionExpired && !error && (
          <Banner kind="warning">Your session has ended. Please sign in again.</Banner>
        )}
        {error && <Banner kind="error">{error}</Banner>}

        <form onSubmit={submit} className="login-form" noValidate>
          <div className="field">
            <label className="field-label" htmlFor="login-id">E-mail or phone</label>
            <input
              id="login-id"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="admin@hospital.pk"
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="login-pw">Password</label>
            <input
              id="login-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy} aria-busy={busy || undefined}>
            {busy && <Spinner size="xs" />} Sign in
          </button>
        </form>

        {DEV_ACCOUNTS.length > 0 && (
          <div className="dev-accounts">
            <span className="muted small">Development seed accounts:</span>
            {DEV_ACCOUNTS.map((a) => (
              <button
                key={a.identifier}
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => { setIdentifier(a.identifier); setPassword(a.password); setError(null); }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <p className="muted small login-foot">
          Doctors and OPD, lab or pharmacy staff use the Staff Dashboard. Patients use the mobile app.
        </p>
      </main>
      <div className="login-side" aria-hidden="true">
        <div className="login-side-inner">
          <h2>Live OPD monitoring, forecasting and resource planning</h2>
          <ul>
            <li>Live queue KPIs and congestion alerts per branch and department</li>
            <li>Peak-hour forecasts and resource-allocation recommendations</li>
            <li>Reports, feedback review and waiting-time model management</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
