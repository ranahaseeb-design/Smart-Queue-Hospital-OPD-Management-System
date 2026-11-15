// Consultation stage (right side of the staff console, Upgrade 2026 "Staff Dashboard"): the token in the
// room in oversized type with its priority tag and stage (CALLED / IN_SERVICE), a live pace gauge and the
// tactile action bar (>= 56 px targets): Call next, Start service, Skip (absent), Recall, Transfer,
// Issue linked token, Complete consultation. Disabled buttons say why (FR-12, NFR-03).
import Icon from './Icon.jsx';
import PaceGauge from './PaceGauge.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { formatClock, priorityTone, queueBadge } from '../utils/format.js';
import { ACTION_KEYS, stageActions } from '../utils/stageActions.js';

const ICONS = {
  'call-next': 'megaphone',
  start: 'play',
  skip: 'skip',
  recall: 'refresh',
  transfer: 'transfer',
  linked: 'flask',
  'refer-pharmacy': 'pill',
  'refer-lab': 'flask',
  complete: 'check',
};

const BUSY_LABELS = {
  'call-next': 'Calling…',
  start: 'Starting…',
  skip: 'Skipping…',
  recall: 'Recalling…',
  transfer: 'Transferring…',
  linked: 'Issuing…',
  'refer-pharmacy': 'Referring…',
  'refer-lab': 'Referring…',
  complete: 'Completing…',
};

function StageIndicator({ status, serviceWord }) {
  const steps = [
    { id: 'CALLED', label: 'Called' },
    { id: 'IN_SERVICE', label: `In ${serviceWord}` },
  ];
  const current = steps.findIndex((s) => s.id === status);
  return (
    <ol className="stage-steps" aria-label="Stage">
      {steps.map((s, i) => (
        <li
          key={s.id}
          className={`stage-step${i === current ? ' is-current' : ''}${i < current ? ' is-done' : ''}`}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="stage-step-dot" aria-hidden="true">
            {i < current ? <Icon name="check" /> : i + 1}
          </span>
          <span className="stage-step-label">{s.id === 'CALLED' ? 'CALLED' : 'IN SERVICE'}</span>
          <span className="sr-only">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

export default function NowServingCard({
  token,
  canIssueLinked, // doctor in an OPD room (canIssueLinkedTokens)
  waitingCount,
  skipped = [],
  busy,
  onCallNext,
  onStart,
  onComplete,
  onSkip,
  onTransfer,
  onIssueLinked,
  onReferComplete = () => {},
  onRecall = () => {},
  servicePointType = 'OPD',
  roomName = null,
  avgConsultMinutes = null,
  startedAt = null,
  canOperate = () => true,
  now,
}) {
  const serviceWord = servicePointType === 'OPD' ? 'consultation' : 'service';
  const tone = token ? priorityTone(token.priorityLevel) : 'normal';
  const badge = token ? queueBadge(token) : null;
  const actions = stageActions({
    token,
    waitingCount,
    skipped,
    busy,
    canIssueLinked,
    servicePointType,
    canOperate,
  });
  const dn = token ? token.displayNumber : null;

  const handlers = {
    'call-next': onCallNext,
    start: onStart,
    skip: onSkip,
    recall: (a) => a.target && onRecall(a.target),
    transfer: onTransfer,
    linked: onIssueLinked,
    'refer-pharmacy': () => onReferComplete('PHARMACY'),
    'refer-lab': () => onReferComplete('LAB'),
    complete: onComplete,
  };

  const ariaLabels = {
    'call-next': 'Call next patient',
    start: dn ? `Start ${serviceWord} for ${dn}` : 'Start service',
    skip: dn ? `Skip ${dn} (patient did not respond)` : 'Skip (absent)',
    recall: (a) => (a.target ? `Recall ${a.target.displayNumber}` : 'Recall a skipped token'),
    transfer: dn ? `Transfer ${dn} to another doctor or service point` : 'Transfer',
    linked: dn ? `Issue a linked laboratory or pharmacy token for ${dn}` : 'Issue linked token',
    'refer-pharmacy': dn ? `Complete ${dn} and refer to the pharmacy counter` : 'Complete and refer to pharmacy',
    'refer-lab': dn ? `Complete ${dn} and refer to the laboratory` : 'Complete and refer to lab',
    complete: dn ? `Mark ${dn} as completed` : `Complete ${serviceWord}`,
  };

  const isBusy = (id, a) => (id === 'recall' ? Boolean(a.target) && busy === `recall:${a.target.id}` : busy === id);

  const [callNext, ...rest] = actions;

  function renderAction(a, extraClass = '') {
    const busyHere = isBusy(a.id, a);
    const label = typeof ariaLabels[a.id] === 'function' ? ariaLabels[a.id](a) : ariaLabels[a.id];
    const reasonId = `stage-why-${a.id}`;
    const describedBy = a.reason || a.hint ? reasonId : undefined;
    return (
      <button
        key={a.id}
        type="button"
        className={`action action--${a.id}${a.next ? ' is-next' : ''}${busyHere ? ' is-busy' : ''}${extraClass}`}
        onClick={() => {
          const fn = handlers[a.id];
          if (fn) fn(a);
        }}
        disabled={!a.enabled}
        aria-busy={busyHere ? 'true' : undefined}
        aria-label={label}
        aria-describedby={describedBy}
        aria-keyshortcuts={ACTION_KEYS[a.id]}
      >
        <span className="action-main">
          {busyHere ? <span className="btn-spinner" aria-hidden="true" /> : <Icon name={ICONS[a.id]} />}
          <span className="action-label">{busyHere ? BUSY_LABELS[a.id] : a.label}</span>
          {a.id === 'call-next' && (
            <span className="btn-count" aria-hidden="true">
              {waitingCount ?? 0} waiting
            </span>
          )}
          <kbd className="action-key" aria-hidden="true">
            {ACTION_KEYS[a.id]}
          </kbd>
        </span>
        {(a.reason || a.hint) && (
          <span id={reasonId} className="action-why">
            {a.reason || a.hint}
          </span>
        )}
      </button>
    );
  }

  return (
    <section className={`card stage serving serving--${tone}`} aria-labelledby="serving-heading">
      <div className="stage-head">
        <h2 id="serving-heading" className="overline">
          Now serving{roomName ? ` · ${roomName}` : ''}
        </h2>
        {token && <StageIndicator status={token.status} serviceWord={serviceWord} />}
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
        <div className="stage-body">
          <div className="stage-token-row">
            <div className="serving-token stage-token" aria-label={`Token ${dn}`}>
              {dn}
            </div>
            <div className="serving-meta">
              <PriorityBadge
                level={token.priorityLevel}
                category={token.priorityCategory}
                fromAppointment={token.fromAppointment}
                showNormal
                large
              />
              {badge && badge.kind !== 'APPOINTMENT' && token.fromAppointment && (
                <span className="badge badge--appointment badge--lg">
                  <Icon name="calendar" />
                  Appointment
                </span>
              )}
            </div>
          </div>
          <p className="serving-name">{token.patientName || 'Unnamed patient'}</p>

          <dl className="serving-facts">
            <div className="fact">
              <dt>
                <Icon name="clock" /> Issued
              </dt>
              <dd>{formatClock(token.issuedAt)}</dd>
            </div>
            <div className="fact">
              <dt>
                <Icon name="megaphone" /> Called
              </dt>
              <dd>{formatClock(token.calledAt)}</dd>
            </div>
          </dl>

          <PaceGauge
            calledAt={token.calledAt}
            startedAt={token.status === 'IN_SERVICE' ? startedAt : null}
            avgMinutes={avgConsultMinutes}
            serviceWord={serviceWord}
            now={now}
          />
        </div>
      )}

      <div className="action-bar" role="group" aria-label={dn ? `Actions for token ${dn}` : 'Queue actions'}>
        {renderAction(callNext, ' action--primary')}
        <div className="action-grid">{rest.map((a) => renderAction(a))}</div>
      </div>
    </section>
  );
}
