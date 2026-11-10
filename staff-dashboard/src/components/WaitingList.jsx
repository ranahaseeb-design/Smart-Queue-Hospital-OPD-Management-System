// Waiting tokens in the order returned by the backend (priorityLevel DESC, issuedAt ASC — FR-13).
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock, formatMinutes, minutesSince, priorityTone } from '../utils/format.js';

export default function WaitingList({ tokens, busy, now, onPriority, onTransfer, canOperate = () => true }) {
  const list = Array.isArray(tokens) ? tokens : [];
  return (
    <section className="card" aria-labelledby="waiting-heading">
      <div className="card-head">
        <h2 id="waiting-heading" className="card-title">
          Waiting
        </h2>
        <span className="count-pill" aria-label={`${list.length} patients waiting`}>
          {list.length}
        </span>
      </div>

      {list.length === 0 ? (
        <EmptyState icon="checkCircle" title="Queue is clear">
          No patients are waiting.
        </EmptyState>
      ) : (
        <ol className="token-list" aria-label="Waiting patients in queue order">
          {list.map((t, index) => {
            const tone = priorityTone(t.priorityLevel);
            const waited = minutesSince(t.issuedAt, now);
            const operable = canOperate(t);
            return (
              <li key={t.id} className={`token-row token-row--${tone}`}>
                <span className="token-pos" aria-label={`Position ${index + 1}`}>
                  {index + 1}
                </span>
                <div className="token-main">
                  <div className="token-line">
                    <span className="token-number">{t.displayNumber}</span>
                    <span className="token-name">{t.patientName || 'Unnamed patient'}</span>
                  </div>
                  <div className="token-sub">
                    <PriorityBadge level={t.priorityLevel} category={t.priorityCategory} />
                    {t.fromAppointment && <span className="chip">Appointment</span>}
                    {!operable && <span className="chip">Another doctor’s patient</span>}
                    <span className="token-meta">
                      Issued {formatClock(t.issuedAt)} · waiting {formatMinutes(waited)}
                      {t.estimateMinutes != null && <> · est. {formatMinutes(t.estimateMinutes)}</>}
                    </span>
                  </div>
                </div>
                <div className="token-actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onPriority(t)}
                    disabled={Boolean(busy) || !operable}
                    aria-label={`Change priority of ${t.displayNumber}`}
                  >
                    Priority
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => onTransfer(t)}
                    disabled={Boolean(busy) || !operable}
                    aria-label={`Transfer ${t.displayNumber}`}
                  >
                    <Icon name="transfer" />
                    Transfer
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
