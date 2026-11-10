// Landing route after sign-in: opens the only / remembered service point, otherwise the picker.
import { Navigate } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import { useServicePoints } from '../auth/ServicePointsContext.jsx';
import { pickInitialServicePoint } from '../utils/servicePoints.js';
import { NoAssignments, PointsLoadError, PointsSkeleton } from './SelectServicePointPage.jsx';

export default function StartPage() {
  const { points, loaded, error, reload, rememberedId } = useServicePoints();

  if (!loaded) {
    return (
      <div className="app-shell">
        <AppHeader />
        <main id="main" className="page page--narrow">
          {error ? <PointsLoadError error={error} onRetry={reload} /> : <PointsSkeleton />}
        </main>
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="app-shell">
        <AppHeader />
        <main id="main" className="page page--narrow">
          <NoAssignments onRetry={reload} />
        </main>
      </div>
    );
  }

  const initial = pickInitialServicePoint(points, rememberedId());
  if (initial != null) return <Navigate to={`/queue/${initial}`} replace />;
  return <Navigate to="/select" replace />;
}
