// Hero "Now serving" card: the patient being served, large one-click actions and "Call next" as the
// single dominant primary button (Section 4.12, FR-12; design system "Staff queue screen").
import Icon from './Icon.jsx';
import PriorityBadge, { StatusChip } from './PriorityBadge.jsx';
import { formatClock, formatMinutes, minutesSince, priorityTone } from '../utils/format.js';

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
  roomName = null,
}) {
  const serviceWord = servicePointType === 'OPD' ? 'consultation' : 'service';
  const anyBusy = Boolean(busy);
  const hasOpenToken = Boolean(token);
  const isCalled = token && token.status === 'CALLED';
  const isInService = token && token.status === 'IN_SERVICE';
  const callDisabled = anyBusy || hasOpenToken;
  const tone = token ? priorityTone(token.priorityLevel) : 'normal';
  const elapsed = token && token.calledAt ? minutesSince(token.calledAt, now) : null;

  let callHint = null;
  if (hasOpenToken) callHint = 'Complete or skip the current patient before calling the next one.';
  else if (waitingCount === 0) callHint = 'No patients are waiting right now.';

  const spin = <span className="btn-spinner" aria-hidden="true" />;

  return (
    <section className={`card card--hero serving serving--${tone}`} aria-labelledby="serving-heading">
      <div className="serving-head">
        <h2 id="serving-heading" className="overline">
          Now serving
        </h2>
        {token && <StatusChip status={token.status} label={isInService ? `In ${serviceWord}` : undefined} />}
      </div>

      {!token ? (
        <div className="serving-empty">
          <span className="empty-state-icon empty-state-icon--lg" aria-hidden="true">
            <Icon name="users" />
          </span>
          <p className="serving-empty-title">No patient is being served</p>
          <p className="muted">Press “Call next” to call the next token in the queue.</p>
        </div>
      ) : (
        <>
          <div className="serving-body">
            <div className="serving-token" aria-label={`Token ${token.displayNumber}`}>
              {token.displayNumber}
            </div>
            <p className="serving-name">{token.patientName || 'Unnamed patient'}</p>
            <div className="serving-meta">
              <PriorityBadge level={token.priorityLevel} category={token.priorityCategory} large />
              {token.fromAppointment && <span className="chip">Appointment</span>}
            </div>
          </div>

          <dl className="serving-facts">
            {roomName && (
              <div className="fact">
                <dt>
                  <Icon name="door" /> Room
                </dt>
                <dd>{roomName}</dd>
              </div>
            )}
            <div className="fact">
              <dt>
                <Icon name="clock" /> Issued
              </dt>
              <dd>{formatClock(token.issuedAt)}</dd>
            </div>
            {token.calledAt && (
              <div className="fact">
                <dt>
                  <Icon name="megaphone" /> Called
                </dt>
                <dd>{formatClock(token.calledAt)}</dd>
              </div>
            )}
            {elapsed != null && (
              <div className="fact">
                <dt>
                  <Icon name="timer" /> Elapsed
                </dt>
                <dd>{formatMinutes(elapsed)}</dd>
              </div>
            )}
          </dl>

          <div className="serving-actions" role="group" aria-label={`Actions for token ${token.displayNumber}`}>
            {isCalled && (
              <button
                type="button"
                className="btn btn--soft btn--lg"
                onClick={onStart}
                disabled={anyBusy}
                aria-busy={busy === 'start' ? 'true' : undefined}
                aria-label={`Start ${serviceWord} for ${token.displayNumber}`}
              >
                {busy === 'start' ? spin : <Icon name="play" />}
                {busy === 'start' ? 'Starting…' : 'Start'}
              </button>
            )}
            <button
              type="button"
              className={`btn ${isInService ? 'btn--soft' : 'btn--secondary'} btn--lg`}
              onClick={onComplete}
              disabled={anyBusy}
              aria-busy={busy === 'complete' ? 'true' : undefined}
              aria-label={`Mark ${token.displayNumber} as completed`}
            >
              {busy === 'complete' ? spin : <Icon name="check" />}
              {busy === 'complete' ? 'Completing…' : 'Complete'}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--lg"
              onClick={onSkip}
              disabled={anyBusy || !isCalled}
              title={isCalled ? undefined : 'Only a called patient who has not started can be skipped'}
              aria-label={`Skip ${token.displayNumber} (patient did not respond)`}
            >
              <Icon name="skip" />
              Skip
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--lg"
              onClick={onTransfer}
              disabled={anyBusy || !isCalled}
              title={isCalled ? undefined : `A token in ${serviceWord} cannot be transferred`}
              aria-label={`Transfer ${token.displayNumber} to another doctor or service point`}
            >
              <Icon name="transfer" />
              Transfer
            </button>
            {/* No Priority here: the backend only re-prioritises WAITING or SKIPPED tokens (FR-11). */}
            {canIssueLinked && (
              <button
                type="button"
                className="btn btn--secondary btn--lg serving-linked"
                onClick={onIssueLinked}
                disabled={anyBusy}
                aria-label={`Issue a linked laboratory or pharmacy token for ${token.displayNumber}`}
              >
                <Icon name="flask" />
                Issue linked token
              </button>
            )}
          </div>
        </>
      )}

      <div className="call-next">
        <button
          type="button"
          className="btn btn--primary btn--lg btn--block btn--call"
          onClick={onCallNext}
          disabled={callDisabled}
          aria-busy={busy === 'call-next' ? 'true' : undefined}
          aria-describedby={callHint ? 'call-next-hint' : undefined}
          aria-label="Call next patient"
        >
          {busy === 'call-next' ? spin : <Icon name="megaphone" />}
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
    </section>
  );
}
