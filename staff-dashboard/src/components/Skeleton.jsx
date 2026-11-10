// Shimmer placeholders shown while data loads (design system "Skeleton"), instead of bare "Loading…" text.
// The visible blocks are hidden from assistive tech; a visually hidden label is announced instead.

export function Skeleton({ variant = 'line', width = 'full' }) {
  return <span className={`skeleton skeleton--${variant} skeleton--w-${width}`} aria-hidden="true" />;
}

/** A few placeholder rows, e.g. for a list or a set of choices. */
export function ListSkeleton({ rows = 3, label = 'Loading…' }) {
  return (
    <div className="skeleton-list" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden="true">
          <Skeleton variant="block" width="token" />
          <div className="skeleton-stack">
            <Skeleton width={i % 2 ? 'half' : 'wide'} />
            <Skeleton variant="sm" width="third" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder in the shape of the queue screen: hero card on the left, tiles and lists on the right. */
export function QueueSkeleton() {
  return (
    <div className="queue-layout" role="status" aria-live="polite">
      <span className="sr-only">Loading queue…</span>
      <div className="queue-main" aria-hidden="true">
        <div className="card card--hero skeleton-hero">
          <Skeleton variant="sm" width="third" />
          <Skeleton variant="display" width="half" />
          <Skeleton width="wide" />
          <div className="skeleton-actions">
            <Skeleton variant="button" width="full" />
            <Skeleton variant="button" width="full" />
            <Skeleton variant="button" width="full" />
          </div>
          <Skeleton variant="button-lg" width="full" />
        </div>
      </div>
      <div className="queue-side" aria-hidden="true">
        <div className="kpi-grid">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="kpi">
              <Skeleton variant="sm" width="half" />
              <Skeleton variant="kpi" width="third" />
            </div>
          ))}
        </div>
        <div className="card">
          <ListSkeleton rows={4} label="" />
        </div>
      </div>
    </div>
  );
}
