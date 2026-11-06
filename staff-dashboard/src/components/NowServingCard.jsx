// "Now serving" card with the next patient prominent and one-click actions (Section 4.12, FR-12).
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock, formatMinutes, minutesSince, priorityTone, statusLabel } from '../utils/format.js';

export default function NowServingCard({
  token,
  canIssueLinked, // doctor in an OPD room (canIssueLinkedTokens)
  waitingCount,
  busy,
  now,
  onCallNext,
  onStart,
  onComplete,
  onSkip,
  onTransfer,
  onIssueLinked,
  servicePointType = 'OPD',
}) {
  const serviceWord = servicePointType === 'OPD' ? 'consultation' : 'service';
  const anyBusy = Boolean(busy);
  const hasOpenToken = Boolean(token);
  const isCalled = token && token.status === 'CALLED';
  const isInService = token && token.status === 'IN_SERVICE';
  const callDisabled = anyBusy || hasOpenToken;
  const tone = token ? priorityTone(token.priorityLevel) : 'normal';

  let callHint = null;
  if (hasOpenToken) callHint = 'Complete or skip the current patient before calling the next one.';
  else if (waitingCount === 0) callHint = 'No patients are waiting right now.';

  return (
    <section className={`card serving serving--${tone}`} aria-labelledby="serving-heading">
      <div className="serving-top">
        <h2 id="serving-heading" className="section-title">
          Now serving
        </h2>
        <div className="call-next">
          <button
            type="button"
            className="btn btn--primary btn--xl"
            onClick={onCallNext}
            disabled={callDisabled}
            aria-describedby={callHint ? 'call-next-hint' : undefined}
            aria-label="Call next patient"
          >
            {busy === 'call-next' ? 'Calling…' : 'Call next'}
            <span className="btn-count" aria-hidden="true">
              {waitingCount ?? 0} waiting
            </span>
          </button>
          {callHint && (
            <p id="call-next-hint" className="hint">
              {callHint}
            </p>
          )}
        </div>
      </div>

      {!token ? (
        <div className="serving-empty">
          <p className="serving-empty-title">No patient is being served</p>
          <p className="muted">Press “Call next” to call the next token in the queue.</p>
        </div>
      ) : (
        <>
          <div className="serving-body">
            <div className="serving-token" aria-label={`Token ${token.displayNumber}`}>
              {token.displayNumber}
            </div>
            <div className="serving-info">
              <p className="serving-name">{token.patientName || 'Unnamed patient'}</p>
              <div className="serving-meta">
                <span className={`status status--${String(token.status).toLowerCase()}`}>
                  {isInService ? `In ${serviceWord}` : statusLabel(token.status)}
                </span>
                <PriorityBadge level={token.priorityLevel} category={token.priorityCategory} large />
                {token.fromAppointment && <span className="chip">Appointment</span>}
              </div>
              <p className="muted serving-times">
                Issued {formatClock(token.issuedAt)}
                {token.calledAt && (
                  <>
                    {' · '}Called {formatClock(token.calledAt)} ({formatMinutes(minutesSince(token.calledAt, now))} ago)
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="serving-actions" role="group" aria-label={`Actions for token ${token.displayNumber}`}>
            {isCalled && (
              <button
                type="button"
                className="btn btn--primary btn--lg"
                onClick={onStart}
                disabled={anyBusy}
                aria-label={`Start ${serviceWord} for ${token.displayNumber}`}
              >
                {busy === 'start' ? 'Starting…' : 'Start'}
              </button>
            )}
            <button
              type="button"
              className="btn btn--success btn--lg"
              onClick={onComplete}
              disabled={anyBusy}
              aria-label={`Mark ${token.displayNumber} as completed`}
            >
              {busy === 'complete' ? 'Completing…' : 'Complete'}
            </button>
            <button
              type="button"
              className="btn btn--warning btn--lg"
              onClick={onSkip}
              disabled={anyBusy || !isCalled}
              title={isCalled ? undefined : 'Only a called patient who has not started can be skipped'}
              aria-label={`Skip ${token.displayNumber} (patient did not respond)`}
            >
              Skip
            </button>
            <button
              type="button"
              className="btn btn--outline btn--lg"
              onClick={onTransfer}
              disabled={anyBusy || !isCalled}
              title={isCalled ? undefined : `A token in ${serviceWord} cannot be transferred`}
              aria-label={`Transfer ${token.displayNumber} to another doctor or service point`}
            >
              Transfer
            </button>
            {/* No Priority here: the backend only re-prioritises WAITING or SKIPPED tokens (FR-11). */}
            {canIssueLinked && (
              <button
                type="button"
                className="btn btn--outline btn--lg"
                onClick={onIssueLinked}
                disabled={anyBusy}
                aria-label={`Issue a linked laboratory or pharmacy token for ${token.displayNumber}`}
              >
                Issue linked token
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
