// Consultations completed here today, newest first (GET /service-points/:id/queue → recentlyCompleted).
// FR-04: a doctor usually decides on tests or medicine at the end of the consultation, so linked
// laboratory / pharmacy tokens can still be issued for these visits after "Complete".
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock } from '../utils/format.js';

export default function RecentlyCompletedList({ tokens, servicePointType, busy, canIssueLinked, onIssueLinked }) {
  const list = Array.isArray(tokens) ? tokens : [];
  const emptyText =
    servicePointType && servicePointType !== 'OPD'
      ? 'No patients completed here yet today.'
      : 'No consultations completed yet today.';
  return (
    <section className="card" aria-labelledby="completed-heading">
      <div className="card-head">
        <h2 id="completed-heading" className="card-title">
          Recently completed
        </h2>
        <span className="count-pill count-pill--success" aria-label={`${list.length} recently completed tokens`}>
          {list.length}
        </span>
      </div>
      {canIssueLinked && list.length > 0 && (
        <p className="hint">Issue a laboratory or pharmacy token for a patient who has finished the consultation.</p>
      )}
      {list.length === 0 ? (
        <EmptyState icon="checkCircle" title="Nothing completed yet" compact>
          {emptyText}
        </EmptyState>
      ) : (
        <ul className="token-list token-list--compact">
          {list.map((t) => (
            <li key={t.id} className="token-row token-row--completed">
              <div className="token-main">
                <div className="token-line">
                  <span className="token-number">{t.displayNumber}</span>
                  <span className="token-name">{t.patientName || 'Unnamed patient'}</span>
                </div>
                <div className="token-sub">
                  <PriorityBadge level={t.priorityLevel} category={t.priorityCategory} />
                  <span className="token-meta">Completed {formatClock(t.completedAt)}</span>
                </div>
              </div>
              {canIssueLinked && (
                <div className="token-actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => onIssueLinked(t)}
                    disabled={Boolean(busy) || t.visitId == null}
                    title={t.visitId == null ? 'This token is not linked to a visit' : undefined}
                    aria-label={`Issue a linked laboratory or pharmacy token for ${t.displayNumber}`}
                  >
                    <Icon name="flask" />
                    Issue linked token
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
