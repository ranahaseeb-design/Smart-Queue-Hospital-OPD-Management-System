// Top bar shared by the signed-in screens: brand, current service point, switch and sign-out.
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useServicePoints } from '../auth/ServicePointsContext.jsx';
import { servicePointTypeLabel } from '../utils/format.js';

export default function AppHeader({ servicePoint = null }) {
  const { user, logout } = useAuth();
  const { points } = useServicePoints();
  const navigate = useNavigate();
  const canSwitch = points.length > 1;

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link to="/" className="brand" aria-label="Smart OPD Staff Dashboard home">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <span className="brand-text">
            Smart OPD <span className="brand-sub">Staff</span>
          </span>
        </Link>

        {servicePoint && (
          <div className="header-point" aria-label="Current service point">
            <span className={`type-tag type-tag--${String(servicePoint.type || '').toLowerCase()}`}>
              {servicePointTypeLabel(servicePoint.type)}
            </span>
            <span className="header-point-name">{servicePoint.name}</span>
            {servicePoint.branchName && <span className="header-point-branch">{servicePoint.branchName}</span>}
          </div>
        )}

        <div className="header-actions">
          {servicePoint && canSwitch && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => navigate('/select')}
              aria-label="Switch to another service point"
            >
              Switch point
            </button>
          )}
          {user && (
            <span className="header-user" title={user.email || user.phone || ''}>
              <span className="avatar" aria-hidden="true">
                {initials(user.fullName)}
              </span>
              <span className="header-user-name">{user.fullName}</span>
            </span>
          )}
          <button type="button" className="btn btn--outline btn--sm" onClick={() => logout()} aria-label="Sign out">
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

function initials(name) {
  const parts = String(name || '')
    .replace(/^dr\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
