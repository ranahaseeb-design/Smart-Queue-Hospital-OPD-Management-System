// Transfer a token to another doctor or service point in the same branch (FR-12).
// Targets: GET /api/staff/transfer-targets?servicePointId=<current point>.
// The backend marks the token TRANSFERRED and creates a new WAITING token (same visit, priority kept).
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import EmptyState from './EmptyState.jsx';
import { ListSkeleton } from './Skeleton.jsx';
import PriorityBadge from './PriorityBadge.jsx';
import { api } from '../api.js';
import { servicePointTypeLabel } from '../utils/format.js';
import { describeTarget, groupTransferTargets, transferTargetUnavailableReason } from '../utils/servicePoints.js';

const keyOf = (t) => `${t.servicePointId}:${t.doctorId ?? ''}`;

export default function TransferModal({ token, servicePointId, onClose, onDone }) {
  const [targets, setTargets] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const groupName = useId();
  const formId = useId();
  const searchId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    setTargets(null);
    try {
      const list = await api.transferTargets(servicePointId);
      setTargets(Array.isArray(list) ? list : []);
    } catch (e) {
      setLoadError(e);
    }
  }, [servicePointId]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => groupTransferTargets(targets, query), [targets, query]);
  const selected = useMemo(
    () => (targets || []).find((t) => keyOf(t) === selectedKey) || null,
    [targets, selectedKey],
  );

  async function submit(e) {
    e.preventDefault();
    if (!selected) {
      setError('Choose where to transfer the patient.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.transfer(token.id, selected.servicePointId, selected.doctorId);
      onDone(result, selected);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const showSearch = Array.isArray(targets) && targets.length > 6;

  return (
    <Modal
      title={`Transfer ${token.displayNumber}`}
      description={`${token.patientName || 'Unnamed patient'} will join the end of the chosen queue (priority is kept).`}
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn--primary" disabled={busy || !selected}>
            {busy ? 'Transferring…' : selected ? `Transfer to ${selected.name}` : 'Transfer'}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <p className="field-note">
          <PriorityBadge level={token.priorityLevel} category={token.priorityCategory} showNormal />
        </p>

        {loadError && (
          <div className="inline-error" role="alert">
            <span>Could not load transfer targets: {loadError.message}</span>
            <button type="button" className="btn btn--secondary btn--sm" onClick={load}>
              Retry
            </button>
          </div>
        )}

        {!loadError && targets === null && <ListSkeleton rows={3} label="Loading service points…" />}

        {Array.isArray(targets) && targets.length === 0 && (
          <EmptyState icon="door" title="Nowhere to transfer" compact>
            There are no other active service points in this branch.
          </EmptyState>
        )}

        {Array.isArray(targets) && targets.length > 0 && (
          <>
            {showSearch && (
              <div className="field">
                <label className="field-label" htmlFor={searchId}>
                  Find a room, doctor or specialty
                </label>
                <input
                  id={searchId}
                  type="search"
                  className="input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. Cardiology, Room 4, Dr. Sara"
                  disabled={busy}
                />
              </div>
            )}
            {groups.length === 0 && <p className="empty">No service point matches “{query}”.</p>}
            {groups.map((group) => (
              <fieldset key={group.type} className="choice-group">
                <legend className="field-label">{servicePointTypeLabel(group.type)}</legend>
                <div className="choice-grid">
                  {group.items.map((t) => {
                    const k = keyOf(t);
                    const checked = k === selectedKey;
                    const unavailable = transferTargetUnavailableReason(t);
                    return (
                      <label
                        key={k}
                        className={`choice choice--target${checked ? ' is-selected' : ''}${unavailable ? ' is-disabled' : ''}`}
                        title={unavailable || undefined}
                      >
                        <input
                          type="radio"
                          name={groupName}
                          value={k}
                          checked={checked}
                          onChange={() => {
                            setSelectedKey(k);
                            setError(null);
                          }}
                          disabled={busy || Boolean(unavailable)}
                          aria-label={`${describeTarget(t)}, ${unavailable ? unavailable : `${t.waiting ?? 0} waiting`}`}
                        />
                        <span className="choice-text">
                          <span className="choice-title">{t.name}</span>
                          {unavailable && <span className="choice-desc">{unavailable}</span>}
                          {t.doctorName && <span className="choice-desc">{t.doctorName}</span>}
                          {t.specialty && <span className="choice-desc">{t.specialty}</span>}
                        </span>
                        <span className="choice-count" aria-hidden="true">
                          {t.waiting ?? 0}
                          <small>waiting</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
