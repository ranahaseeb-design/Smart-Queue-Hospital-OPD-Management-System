// Waiting tokens in the order returned by the backend (FR-13, Decision 2: priority level DESC, then
// checked-in appointments, then issue time). The dashboard never re-orders the list. Each row has the
// queue badge, a quick priority-escalation selector (the change still needs the reason the API requires,
// asked in the priority dialog) and Transfer. Rows animate in and out (reduced-motion aware).
import EmptyState from './EmptyState.jsx';
import Icon from './Icon.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { useListTransition } from '../hooks/useListTransition.js';
import { PRIORITY_LEVELS, formatClock, formatMinutes, minutesSince, queueBadge } from '../utils/format.js';

const keyOf = (t) => t.id;

const LEVEL_OPTION_LABELS = { 0: 'Normal', 1: 'Elderly / diff.-abled', 2: 'Emergency' };

export default function WaitingList({ tokens, busy, now, onPriority, onTransfer, canOperate = () => true, embedded = false }) {
  const list = Array.isArray(tokens) ? tokens : [];
  const rows = useListTransition(list, keyOf);
  let position = 0;

  const body =
    list.length === 0 && rows.length === 0 ? (
      <EmptyState icon="checkCircle" title="Queue is clear">
        No patients are waiting.
      </EmptyState>
    ) : (
      <ol className="token-list" aria-label="Waiting patients in queue order">
        {rows.map(({ key, item: t, phase }) => {
          const leaving = phase === 'exit';
          if (!leaving) position += 1;
          const badge = queueBadge(t);
          const waited = minutesSince(t.issuedAt, now);
          const operable = canOperate(t) && !leaving;
          const level = Number(t.priorityLevel) || 0;
          return (
            <li
              key={key}
              className={`token-row token-row--${badge.tone === 'elevated' ? 'priority' : badge.tone} row--${phase}`}
              aria-hidden={leaving ? 'true' : undefined}
              data-kind={badge.kind}
            >
              <span className="token-pos" aria-label={leaving ? undefined : `Position ${position}`}>
                {leaving ? '' : position}
              </span>
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
                    showNormal
                  />
                  {level > 0 && t.fromAppointment && <span className="badge badge--appointment">Appointment</span>}
                  {t.priorityDeclared && (
                    <span className="chip" title="Priority rests on a self-declared category; confirm at the counter">
                      Declared — please confirm
                    </span>
                  )}
                  {!canOperate(t) && <span className="chip">Another doctor’s patient</span>}
                  <span className="token-meta">
                    Issued {formatClock(t.issuedAt)} · waiting {formatMinutes(waited)}
                    {t.estimateMinutes != null && <> · est. {formatMinutes(t.estimateMinutes)}</>}
                  </span>
                </div>
              </div>
              <div className="token-actions">
                <label className="escalate">
                  <span className="sr-only">Set priority of {t.displayNumber}</span>
                  <Icon name="arrowUp" />
                  <select
                    className="escalate-select"
                    value={String(level)}
                    onChange={(e) => onPriority(t, Number(e.target.value))}
                    disabled={Boolean(busy) || !operable}
                    aria-label={`Set priority of ${t.displayNumber}`}
                    title="Change priority (a reason is required)"
                  >
                    {PRIORITY_LEVELS.map((p) => (
                      <option key={p.level} value={String(p.level)}>
                        {LEVEL_OPTION_LABELS[p.level]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn btn--secondary btn--touch"
                  onClick={() => onTransfer(t)}
                  disabled={Boolean(busy) || !operable}
                  aria-label={`Transfer ${t.displayNumber}`}
                >
                  <Icon name="transfer" />
                  <span className="hide-xs">Transfer</span>
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    );

  if (embedded) return body;

  return (
    <section className="card" aria-labelledby="waiting-heading">
      <div className="card-head">
        <h2 id="waiting-heading" className="card-title">
          Waiting queue
        </h2>
        <span className="count-pill" aria-label={`${list.length} patients waiting`}>
          {list.length}
        </span>
      </div>
      {body}
    </section>
  );
}
