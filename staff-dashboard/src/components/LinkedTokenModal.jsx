// Issue a linked laboratory or pharmacy token for the same visit (FR-04).
// POST /api/visits/:visitId/linked-tokens { type, servicePointId? } — when no counter is chosen the
// backend picks the branch's active LAB/PHARMACY point with the shortest queue.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { LINKED_TOKEN_TYPES, targetsOfType } from '../utils/servicePoints.js';

const AUTO = '';

export default function LinkedTokenModal({ token, servicePointId, onClose, onDone }) {
  const [type, setType] = useState('LAB');
  const [pointId, setPointId] = useState(AUTO);
  const [targets, setTargets] = useState(null);
  const [targetsError, setTargetsError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const groupName = useId();
  const formId = useId();
  const selectId = useId();
  const selectHintId = useId();

  // Same-branch points come from the transfer-targets endpoint; only LAB / PHARMACY ones are used here.
  const loadTargets = useCallback(async () => {
    setTargetsError(null);
    try {
      const list = await api.transferTargets(servicePointId);
      setTargets(Array.isArray(list) ? list : []);
    } catch (e) {
      setTargets([]);
      setTargetsError(e);
    }
  }, [servicePointId]);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  const options = useMemo(() => targetsOfType(targets, type), [targets, type]);
  const typeInfo = LINKED_TOKEN_TYPES.find((t) => t.type === type);

  async function submit(e) {
    e.preventDefault();
    if (token.visitId == null) {
      setError('This token is not linked to a visit, so a linked token cannot be issued.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const issued = await api.issueLinkedToken(token.visitId, type, pointId === AUTO ? undefined : Number(pointId));
      onDone(issued, type);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Issue linked token"
      description={`For ${token.patientName || 'this patient'} (${token.displayNumber}). The patient can track it in the mobile app.`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn--primary" disabled={busy}>
            {busy ? 'Issuing…' : `Issue ${typeInfo ? typeInfo.label.toLowerCase() : ''} token`}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <fieldset className="choice-group">
          <legend className="field-label">Token type</legend>
          <div className="choice-grid choice-grid--two">
            {LINKED_TOKEN_TYPES.map((t, idx) => (
              <label key={t.type} className={`choice${type === t.type ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={groupName}
                  value={t.type}
                  checked={type === t.type}
                  onChange={() => {
                    setType(t.type);
                    setPointId(AUTO);
                    setError(null);
                  }}
                  disabled={busy}
                  data-autofocus={idx === 0 ? true : undefined}
                />
                <span className="choice-text">
                  <span className="choice-title">{t.label}</span>
                  <span className="choice-desc">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field">
          <label className="field-label" htmlFor={selectId}>
            {typeInfo ? typeInfo.label : 'Service'} counter <span className="muted">(optional)</span>
          </label>
          <select
            id={selectId}
            className="input"
            value={pointId}
            onChange={(e) => setPointId(e.target.value)}
            disabled={busy || targets === null}
            aria-describedby={selectHintId}
          >
            <option value={AUTO}>Automatic — shortest queue (recommended)</option>
            {options.map((o) => (
              <option key={o.servicePointId} value={String(o.servicePointId)}>
                {o.name} — {o.waiting ?? 0} waiting
              </option>
            ))}
          </select>
          <p id={selectHintId} className="field-hint">
            {targets === null
              ? 'Loading counters…'
              : targetsError
                ? 'Counter list unavailable; the server will choose the shortest queue.'
                : options.length === 0
                  ? 'No counter of this type is listed; the server will choose one if available.'
                  : 'Leave on automatic unless the patient must go to a specific counter.'}
          </p>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
