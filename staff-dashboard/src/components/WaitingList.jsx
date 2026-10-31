// Waiting tokens in the order returned by the backend (priorityLevel DESC, issuedAt ASC — FR-13).
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock, formatMinutes, minutesSince, priorityTone } from '../utils/format.js';

export default function WaitingList({ tokens, busy, now, onPriority, onTransfer }) {
  const list = Array.isArray(tokens) ? tokens : [];
  return (
    <section className="card" aria-labelledby="waiting-heading">
      <div className="card-head">
        <h2 id="waiting-heading" className="section-title">
          Waiting
        </h2>
        <span className="count-pill" aria-label={`${list.length} patients waiting`}>
          {list.length}
        </span>
      </div>

      {list.length === 0 ? (
        <p className="empty">No patients are waiting.</p>
      ) : (
        <ol className="token-list" aria-label="Waiting patients in queue order">
          {list.map((t, index) => {
            const tone = priorityTone(t.priorityLevel);
            const waited = minutesSince(t.issuedAt, now);
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
                    <span className="muted">
                      Issued {formatClock(t.issuedAt)} · waiting {formatMinutes(waited)}
                      {t.estimateMinutes != null && <> · est. {formatMinutes(t.estimateMinutes)}</>}
                    </span>
                  </div>
                </div>
                <div className="token-actions">
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => onPriority(t)}
                    disabled={Boolean(busy)}
                    aria-label={`Change priority of ${t.displayNumber}`}
                  >
                    Priority
                  </button>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => onTransfer(t)}
                    disabled={Boolean(busy)}
                    aria-label={`Transfer ${t.displayNumber}`}
                  >
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
