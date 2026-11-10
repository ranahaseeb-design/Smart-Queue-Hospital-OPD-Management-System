// Service-point picker for staff assigned to more than one room/counter (Section 4.2.2:
// the dashboard shows only the queue(s) of the service point the user is assigned to).
import { useNavigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Icon from '../components/Icon.jsx';
import { ListSkeleton } from '../components/Skeleton.jsx';
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
    content = error ? <PointsLoadError error={error} onRetry={reload} /> : <PointsSkeleton />;
  } else if (points.length === 0) {
    content = <NoAssignments onRetry={reload} />;
  } else {
    content = (
      <>
        <div className="page-head">
          <h1 className="page-title">Choose your service point</h1>
          <p className="page-subtitle">
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
                  <span className="point-top">
                    <span className="point-icon" aria-hidden="true">
                      <Icon name={p.type === 'LAB' ? 'flask' : p.type === 'PHARMACY' ? 'plus' : 'stethoscope'} />
                    </span>
                    {isCurrent && <span className="chip chip--primary">Last used</span>}
                  </span>
                  <span className="point-name">{p.name}</span>
                  {p.doctorName && <span className="point-doctor">{p.doctorName}</span>}
                  <span className="point-foot">
                    <span className={`type-tag type-tag--${String(p.type || '').toLowerCase()}`}>
                      {servicePointTypeLabel(p.type)}
                    </span>
                    {p.branchName && <span className="point-branch">{p.branchName}</span>}
                    <Icon name="chevronRight" className="point-arrow" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="page-foot">
          <button type="button" className="btn btn--ghost btn--sm" onClick={reload} disabled={loading}>
            <Icon name="refresh" />
            {loading ? 'Refreshing…' : 'Refresh list'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main id="main" className="page page--narrow">{content}</main>
    </div>
  );
}

export function NoAssignments({ onRetry }) {
  return (
    <div className="card notice-card" role="status">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name="door" />
      </span>
      <h1 className="page-title">No service point assigned</h1>
      <p>
        Your account is not assigned to any consultation room, laboratory or pharmacy counter yet. Please ask your branch
        administrator to assign you in the Admin Dashboard.
      </p>
      <button type="button" className="btn btn--secondary" onClick={onRetry}>
        Check again
      </button>
    </div>
  );
}

export function PointsLoadError({ error, onRetry }) {
  return (
    <div className="card notice-card notice-card--error" role="alert">
      <span className="empty-state-icon empty-state-icon--danger" aria-hidden="true">
        <Icon name="alert" />
      </span>
      <h1 className="page-title">Could not load your service points</h1>
      <p>{error && error.message}</p>
      <button type="button" className="btn btn--primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** Placeholder cards while the assigned service points load. */
export function PointsSkeleton() {
  return (
    <div className="card points-skeleton">
      <ListSkeleton rows={3} label="Loading your service points…" />
    </div>
  );
}
