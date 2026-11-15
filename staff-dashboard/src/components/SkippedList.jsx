// Skipped tokens with Recall (FR-12: recall a skipped token) and Priority (FR-13: the backend
// accepts priority changes for WAITING and SKIPPED tokens only). Rows animate in and out.
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { useListTransition } from '../hooks/useListTransition.js';
import { formatClock } from '../utils/format.js';

const keyOf = (t) => t.id;

export default function SkippedList({
  tokens,
  busy,
  hasOpenToken,
  onRecall,
  onPriority,
  canOperate = () => true,
  embedded = false,
}) {
  const list = Array.isArray(tokens) ? tokens : [];
  const rows = useListTransition(list, keyOf);

  const body = (
    <>
      {hasOpenToken && list.length > 0 && (
        <p className="hint list-hint">Complete the current patient first to recall a skipped token.</p>
      )}
      {list.length === 0 && rows.length === 0 ? (
        <EmptyState icon="skip" title="Nothing skipped" compact>
          No skipped tokens.
        </EmptyState>
      ) : (
        <ul className="token-list token-list--compact" aria-label="Skipped tokens that can be recalled">
          {rows.map(({ key, item: t, phase }) => {
            const leaving = phase === 'exit';
            const operable = canOperate(t) && !leaving;
            return (
              <li key={key} className={`token-row token-row--skipped row--${phase}`} aria-hidden={leaving ? 'true' : undefined}>
                <div className="token-main">
                  <div className="token-line">
                    <span className="token-number">{t.displayNumber}</span>
                    <span className="token-name">{t.patientName || 'Unnamed patient'}</span>
                  </div>
                  <div className="token-sub">
                    <PriorityBadge
                      level={t.priorityLevel}
                      category={t.priorityCategory}
                      fromAppointment={t.fromAppointment}
                    />
                    <span className="token-meta">Called {formatClock(t.calledAt)}</span>
                    {!canOperate(t) && <span className="chip">Another doctor’s patient</span>}
                  </div>
                </div>
                <div className="token-actions">
                  {onPriority && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--touch"
                      onClick={() => onPriority(t)}
                      disabled={Boolean(busy) || !operable}
                      aria-label={`Change priority of ${t.displayNumber}`}
                    >
                      Priority
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--soft btn--touch"
                    onClick={() => onRecall(t)}
                    disabled={Boolean(busy) || hasOpenToken || !operable}
                    aria-label={`Recall ${t.displayNumber}`}
                    title={hasOpenToken ? 'Complete the current patient first' : undefined}
                  >
                    {busy === `recall:${t.id}` ? <span className="btn-spinner" aria-hidden="true" /> : <Icon name="refresh" />}
                    {busy === `recall:${t.id}` ? 'Recalling…' : 'Recall'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <section className="card" aria-labelledby="skipped-heading">
      <div className="card-head">
        <h2 id="skipped-heading" className="card-title">
          Skipped (recallable)
        </h2>
        <span className="count-pill count-pill--warning" aria-label={`${list.length} skipped tokens`}>
          {list.length}
        </span>
      </div>
      {body}
    </section>
  );
}
