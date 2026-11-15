// Haversine cross-branch load balancer (FR-08/09, FR-15, FR-18): live load and predicted waits
// of every branch, the great-circle distances between them (Eq. 6.4) and redirect suggestions
// from branches at >= 75 % load. Hospital admins see all redirects; a branch admin sees the
// incoming / outgoing redirects of their own branch (GET /admin/load-balancer).
import { useCallback } from 'react';
import { useResource } from '../hooks/useResource.js';
import { useLiveRefresh } from '../hooks/useLiveRefresh.js';
import { Card } from './ui.jsx';

function loadTone(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 70) return 'mid';
  return 'low';
}

function minutes(m) {
  return m === null || m === undefined ? '—' : `${Math.round(m)} min`;
}

export default function LoadBalancerCard() {
  const lb = useResource('/admin/load-balancer');
  const { reload } = lb;
  const refresh = useCallback(() => reload({ silent: true }), [reload]);
  useLiveRefresh(refresh);

  const data = lb.data;
  const branches = data?.branches || [];
  const recs = data?.recommendations || [];
  const km = (a, b) => (data?.distances || []).find((d) => (d.fromBranchId === a && d.toBranchId === b) || (d.fromBranchId === b && d.toBranchId === a))?.km;
  const scoped = data?.scopeBranchId ?? null;

  return (
    <Card
      title="Haversine cross-branch load balancer"
      subtitle={`Live load (waiting ÷ remaining capacity, Eq. 6.5), Random Forest waits and great-circle distances (Eq. 6.4). Redirects are suggested from branches at ≥ ${data?.redirectThresholdPercent ?? 75}% load.`}
    >
      {lb.error && !data && <p className="muted">Could not load the branch comparison: {lb.error.message}</p>}
      {!data && !lb.error && <div className="skeleton" style={{ height: 160 }} aria-label="Loading branch comparison" />}
      {data && (
        <>
          <div className="lb-grid">
            {branches.map((b) => (
              <div key={b.branchId} className={`lb-branch lb-${loadTone(b.loadPercent)}${scoped === b.branchId ? ' is-own' : ''}`}>
                <div className="lb-head">
                  <strong>{b.name}</strong>
                  {scoped === b.branchId && <span className="badge badge-neutral">Your branch</span>}
                </div>
                <div className="lb-load" aria-label={`${b.name} load ${b.loadPercent} percent`}>
                  <span className="lb-load-value">{b.loadPercent}%</span>
                  <span className="muted small">load</span>
                </div>
                <div className="lb-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, b.loadPercent)} aria-label="Load">
                  <span style={{ width: `${Math.min(100, b.loadPercent)}%` }} />
                </div>
                <dl className="lb-facts">
                  <div><dt>Waiting</dt><dd>{b.waiting}</dd></div>
                  <div><dt>Avg wait</dt><dd>{minutes(b.avgWaitMinutes)}</dd></div>
                  <div><dt>Best wait</dt><dd>{minutes(b.bestWaitMinutes)}</dd></div>
                  <div><dt>Doctors on duty</dt><dd>{b.activeDoctors}</dd></div>
                </dl>
                <div className="lb-dist">
                  {branches.filter((o) => o.branchId !== b.branchId).map((o) => (
                    <span key={o.branchId} className="muted small">{o.name}: {km(b.branchId, o.branchId) ?? '—'} km</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="lb-recs" aria-live="polite">
            <h3 className="overline">Redirect recommendations</h3>
            {recs.length === 0 ? (
              <p className="muted small">No branch is above {data.redirectThresholdPercent}% load — no redirects needed right now.</p>
            ) : (
              <ul>
                {recs.map((r) => (
                  <li key={`${r.fromBranchId}-${r.toBranchId}`} className="lb-rec">
                    {r.direction && <span className={`badge ${r.direction === 'OUTGOING' ? 'badge-warning' : 'badge-success'}`}>{r.direction === 'OUTGOING' ? 'Outgoing' : 'Incoming'}</span>}
                    <span className="lb-rec-route"><strong>{r.fromBranchName}</strong> ({r.fromLoadPercent}%) → <strong>{r.toBranchName}</strong> ({r.toLoadPercent}%)</span>
                    <span className="lb-rec-pills">
                      <span className="lb-pill">{r.distanceKm} km (haversine)</span>
                      {r.waitSavedMinutes !== null && <span className="lb-pill lb-pill-good">Save ~{r.waitSavedMinutes} min</span>}
                    </span>
                    <span className="muted small">{r.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
