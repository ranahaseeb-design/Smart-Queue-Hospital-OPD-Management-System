// Service-point picker for staff assigned to more than one room/counter (Section 4.2.2:
// the dashboard shows only the queue(s) of the service point the user is assigned to).
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import Spinner from '../components/Spinner.jsx';
import { useServicePoints } from '../auth/ServicePointsContext.jsx';
import { servicePointTypeLabel } from '../utils/format.js';

export default function SelectServicePointPage() {
  const { points, loaded, loading, error, reload, rememberedId, remember } = useServicePoints();
  const navigate = useNavigate();
  const current = rememberedId();

  function choose(point) {
    remember(point.id);
    navigate(`/queue/${point.id}`);
  }

  let content;
  if (!loaded) {
    content = error ? <PointsLoadError error={error} onRetry={reload} /> : <Spinner label="Loading your service points…" />;
  } else if (points.length === 0) {
    content = <NoAssignments onRetry={reload} />;
  } else {
    content = (
      <>
        <div className="page-head">
          <h1 className="page-title">Choose your service point</h1>
          <p className="muted">
            You are assigned to {points.length} service point{points.length === 1 ? '' : 's'}. Your choice is remembered on
            this computer.
          </p>
        </div>
        <ul className="point-grid">
          {points.map((p) => {
            const isCurrent = current != null && String(current) === String(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`point-card${isCurrent ? ' is-current' : ''}`}
                  onClick={() => choose(p)}
                  aria-label={`Open queue for ${p.name}, ${servicePointTypeLabel(p.type)}, ${p.branchName || ''}${
                    isCurrent ? ' (last used)' : ''
                  }`}
                >
                  <span className={`type-tag type-tag--${String(p.type || '').toLowerCase()}`}>
                    {servicePointTypeLabel(p.type)}
                  </span>
                  <span className="point-name">{p.name}</span>
                  {p.doctorName && <span className="point-doctor">{p.doctorName}</span>}
                  <span className="point-branch muted">{p.branchName}</span>
                  {isCurrent && <span className="chip">Last used</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="page-foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={reload} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh list'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="page page--narrow">{content}</main>
    </div>
  );
}

export function NoAssignments({ onRetry }) {
  return (
    <div className="card notice-card" role="status">
      <h1 className="page-title">No service point assigned</h1>
      <p>
        Your account is not assigned to any consultation room, laboratory or pharmacy counter yet. Please ask your branch
        administrator to assign you in the Admin Dashboard.
      </p>
      <button type="button" className="btn btn--outline" onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}

export function PointsLoadError({ error, onRetry }) {
  return (
    <div className="card notice-card notice-card--error" role="alert">
      <h1 className="page-title">Could not load your service points</h1>
      <p>{error && error.message}</p>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
