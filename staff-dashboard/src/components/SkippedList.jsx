// Skipped tokens with Recall (FR-12: recall a skipped token) and Priority (FR-11: the backend
// accepts priority changes for WAITING and SKIPPED tokens only).
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock } from '../utils/format.js';

export default function SkippedList({ tokens, busy, hasOpenToken, onRecall, onPriority, canOperate = () => true }) {
  const list = Array.isArray(tokens) ? tokens : [];
  return (
    <section className="card" aria-labelledby="skipped-heading">
      <div className="card-head">
        <h2 id="skipped-heading" className="section-title">
          Skipped
        </h2>
        <span className="count-pill count-pill--muted" aria-label={`${list.length} skipped tokens`}>
          {list.length}
        </span>
      </div>
      {hasOpenToken && list.length > 0 && (
        <p className="hint">Finish the current patient to recall a skipped token.</p>
      )}
      {list.length === 0 ? (
        <p className="empty">No skipped tokens.</p>
      ) : (
        <ul className="token-list token-list--compact">
          {list.map((t) => {
            const operable = canOperate(t);
            return (
            <li key={t.id} className="token-row token-row--skipped">
              <div className="token-main">
                <div className="token-line">
                  <span className="token-number">{t.displayNumber}</span>
                  <span className="token-name">{t.patientName || 'Unnamed patient'}</span>
                </div>
                <div className="token-sub">
                  <PriorityBadge level={t.priorityLevel} category={t.priorityCategory} />
                  <span className="muted">Called {formatClock(t.calledAt)}</span>
                  {!operable && <span className="chip">Another doctor’s patient</span>}
                </div>
              </div>
              <div className="token-actions">
                {onPriority && (
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => onPriority(t)}
                    disabled={Boolean(busy) || !operable}
                    aria-label={`Change priority of ${t.displayNumber}`}
                  >
                    Priority
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={() => onRecall(t)}
                  disabled={Boolean(busy) || hasOpenToken || !operable}
                  aria-label={`Recall ${t.displayNumber}`}
                >
                  {busy === `recall:${t.id}` ? 'Recalling…' : 'Recall'}
                </button>
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
