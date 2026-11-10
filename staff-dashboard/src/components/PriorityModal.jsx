// Apply / change a token's priority level with a mandatory reason (FR-13:
// "record who applied priority and why" — the backend logs PRIORITY_SET with note = reason).
import { useId, useState } from 'react';
import Modal from './Modal.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { api } from '../api.js';
import { PRIORITY_LEVELS } from '../utils/format.js';

// Matches the backend validation of POST /api/tokens/:id/priority (reason max 200 characters).
export const REASON_MAX_LENGTH = 200;
const REASON_MIN_LENGTH = 3;

const QUICK_REASONS = {
  0: ['Priority no longer applies', 'Applied by mistake'],
  1: ['Elderly patient', 'Differently-abled patient', 'Category confirmed at counter'],
  2: ['Emergency case', 'Severe pain / distress', 'Referred as urgent'],
};

export default function PriorityModal({ token, onClose, onDone }) {
  const [level, setLevel] = useState(() => Number(token.priorityLevel) || 0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const reasonId = useId();
  const reasonHintId = useId();
  const groupName = useId();
  const formId = useId();

  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= REASON_MIN_LENGTH;

  async function submit(e) {
    e.preventDefault();
    if (!reasonValid) {
      setError(`Please give a reason (at least ${REASON_MIN_LENGTH} characters).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setPriority(token.id, level, trimmed);
      onDone(updated || { ...token, priorityLevel: level });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Priority for ${token.displayNumber}`}
      description={`${token.patientName || 'Unnamed patient'} — priority tokens are served ahead of normal tokens.`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn--primary" disabled={busy || !reasonValid}>
            {busy ? 'Saving…' : 'Save priority'}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <p className="field-note">
          Current: <PriorityBadge level={token.priorityLevel} category={token.priorityCategory} showNormal />
        </p>
        <fieldset className="choice-group">
          <legend className="field-label">Priority level</legend>
          {PRIORITY_LEVELS.map((p, idx) => (
            <label key={p.level} className={`choice choice--level-${p.level}${level === p.level ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name={groupName}
                value={p.level}
                checked={level === p.level}
                onChange={() => setLevel(p.level)}
                disabled={busy}
                data-autofocus={idx === (Number(token.priorityLevel) || 0) ? true : undefined}
              />
              <span className="choice-text">
                <span className="choice-title">
                  {p.level} — {p.label}
                </span>
                <span className="choice-desc">{p.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="field-label" htmlFor={reasonId}>
          Reason <span className="required">(required)</span>
        </label>
        <div className="quick-reasons" role="group" aria-label="Quick reasons">
          {(QUICK_REASONS[level] || []).map((r) => (
            <button key={r} type="button" className="chip chip--button" onClick={() => setReason(r)} disabled={busy}>
              {r}
            </button>
          ))}
        </div>
        <textarea
          id={reasonId}
          className="input textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX_LENGTH))}
          maxLength={REASON_MAX_LENGTH}
          rows={3}
          required
          aria-required="true"
          aria-describedby={reasonHintId}
          aria-invalid={error && !reasonValid ? 'true' : undefined}
          disabled={busy}
          placeholder="Why is this priority being applied or changed?"
        />
        <p id={reasonHintId} className="field-hint">
          Recorded in the queue audit log with your name. {trimmed.length}/{REASON_MAX_LENGTH}
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
