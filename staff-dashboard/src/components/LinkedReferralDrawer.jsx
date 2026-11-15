// Linked referral drawer (FR-04, Upgrade 2026 "Staff Dashboard"): a slide-over with LABORATORY and
// PHARMACY toggles for the same visit. Submitting creates one token per selected type with
// POST /api/visits/:visitId/linked-tokens, one request after the other, and shows each created display
// number — or, per type, why it was not issued (409 already active, 403 not this doctor's visit).
// Opened from the consultation stage and from Recently completed.
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import Modal from './Modal.jsx';
import { api } from '../api.js';
import { issueLinkedTokens, linkedTypeLabel } from '../utils/linked.js';
import { LINKED_TOKEN_TYPES, targetsOfType } from '../utils/servicePoints.js';

const AUTO = '';
const ICONS = { LAB: 'flask', PHARMACY: 'pill' };

/**
 * The two toggle cards with their per-type state (presentational, rendered statically in tests).
 * @param {{ selected: Record<string, boolean>, results: Record<string, object>, busy: boolean,
 *           onToggle: (type: string) => void, counters?: React.ReactNode|Record<string, React.ReactNode> }} props
 */
export function ReferralChoices({ selected, results, busy, onToggle, counters = {} }) {
  return (
    <div className="referral-grid" role="group" aria-label="Linked tokens to issue">
      {LINKED_TOKEN_TYPES.map((t) => {
        const r = results[t.type];
        const issued = r && r.ok;
        const pending = r && r.pending;
        const failed = r && r.ok === false;
        const on = Boolean(selected[t.type]) && !issued;
        return (
          <div
            key={t.type}
            className={`referral${on ? ' is-on' : ''}${issued ? ' is-issued' : ''}${failed ? ' is-failed' : ''}`}
          >
            <button
              type="button"
              className="referral-toggle"
              aria-pressed={on ? 'true' : 'false'}
              onClick={() => onToggle(t.type)}
              disabled={busy || issued}
              aria-label={issued ? `${t.label} token issued` : `${on ? 'Do not issue' : 'Issue'} a ${t.label.toLowerCase()} token`}
            >
              <span className="referral-icon" aria-hidden="true">
                <Icon name={ICONS[t.type]} />
              </span>
              <span className="referral-text">
                <span className="referral-title">{t.label}</span>
                <span className="referral-desc">{t.description}</span>
              </span>
              <span className="referral-switch" aria-hidden="true">
                {issued ? <Icon name="check" /> : <span className="referral-knob" />}
              </span>
            </button>

            {pending && (
              <p className="referral-status" role="status">
                <span className="btn-spinner" aria-hidden="true" /> Issuing {t.label.toLowerCase()} token…
              </p>
            )}
            {issued && (
              <p className="referral-status referral-status--ok">
                <span className="referral-number">{(r.token && r.token.displayNumber) || 'Issued'}</span>
                {r.token && r.token.servicePoint && r.token.servicePoint.name && (
                  <span className="muted"> at {r.token.servicePoint.name}</span>
                )}
              </p>
            )}
            {failed && (
              <div className="referral-status referral-status--error" role="alert">
                <p>
                  <Icon name="alert" /> {r.message}
                </p>
                {r.hint && <p className="referral-hint">{r.hint}</p>}
              </div>
            )}
            {on && !pending && counters[t.type]}
          </div>
        );
      })}
    </div>
  );
}

export default function LinkedReferralDrawer({ token, servicePointId, onClose, onIssued, defaultTypes = ['LAB'] }) {
  const [selected, setSelected] = useState(() => Object.fromEntries(defaultTypes.map((t) => [t, true])));
  const [pointIds, setPointIds] = useState({});
  const [targets, setTargets] = useState(null);
  const [targetsError, setTargetsError] = useState(null);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const baseId = useId();

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

  const issuedTokens = useMemo(
    () =>
      Object.values(results)
        .filter((r) => r && r.ok)
        .map((r) => r.token),
    [results],
  );
  const toIssue = LINKED_TOKEN_TYPES.map((t) => t.type).filter((type) => selected[type] && !(results[type] && results[type].ok));
  const allDone = LINKED_TOKEN_TYPES.every((t) => !selected[t.type] || (results[t.type] && results[t.type].ok));
  const anyIssued = issuedTokens.length > 0;

  const close = () => {
    if (busy) return;
    if (anyIssued && onIssued) onIssued(issuedTokens);
    onClose();
  };

  function toggle(type) {
    setError(null);
    setSelected((s) => ({ ...s, [type]: !s[type] }));
    // A failed type that is switched off forgets its error.
    setResults((r) => (r[type] && r[type].ok === false ? { ...r, [type]: undefined } : r));
  }

  async function submit(e) {
    e.preventDefault();
    if (token.visitId == null) {
      setError('This token is not linked to a visit, so linked tokens cannot be issued.');
      return;
    }
    if (toIssue.length === 0) {
      setError('Choose Laboratory, Pharmacy or both.');
      return;
    }
    setBusy(true);
    setError(null);
    const ids = Object.fromEntries(toIssue.map((type) => [type, pointIds[type] ? Number(pointIds[type]) : undefined]));
    await issueLinkedTokens({
      issue: api.issueLinkedToken,
      visitId: token.visitId,
      types: toIssue,
      servicePointIds: ids,
      onProgress: (r) => setResults((prev) => ({ ...prev, [r.type]: r })),
    });
    setBusy(false);
  }

  const counters = Object.fromEntries(
    LINKED_TOKEN_TYPES.map((t) => {
      const options = targetsOfType(targets, t.type);
      const id = `${baseId}-${t.type}`;
      return [
        t.type,
        <div key={t.type} className="field referral-counter">
          <label className="field-label" htmlFor={id}>
            {t.label} counter <span className="muted">(optional)</span>
          </label>
          <select
            id={id}
            className="input"
            value={pointIds[t.type] || AUTO}
            onChange={(e) => setPointIds((p) => ({ ...p, [t.type]: e.target.value }))}
            disabled={busy || targets === null}
          >
            <option value={AUTO}>Automatic — shortest queue (recommended)</option>
            {options.map((o) => (
              <option key={o.servicePointId} value={String(o.servicePointId)}>
                {o.name} — {o.waiting ?? 0} waiting
              </option>
            ))}
          </select>
          <p className="field-hint">
            {targets === null
              ? 'Loading counters…'
              : targetsError
                ? 'Counter list unavailable; the server will choose the shortest queue.'
                : options.length === 0
                  ? 'No counter of this type is listed; the server will choose one if available.'
                  : 'Leave on automatic unless the patient must go to a specific counter.'}
          </p>
        </div>,
      ];
    }),
  );

  const submitLabel = busy
    ? 'Issuing…'
    : toIssue.length === 2
      ? 'Issue 2 tokens'
      : toIssue.length === 1
        ? `Issue ${linkedTypeLabel(toIssue[0]).toLowerCase()} token`
        : 'Issue tokens';

  return (
    <Modal
      variant="drawer"
      title="Linked referral"
      description={`Same visit as ${token.displayNumber}${token.patientName ? ` (${token.patientName})` : ''}. The patient sees the new tokens in the app.`}
      onClose={close}
      busy={busy}
      footer={
        allDone && anyIssued ? (
          <button type="button" className="btn btn--primary btn--lg" onClick={close} data-autofocus>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--secondary btn--lg" onClick={close} disabled={busy}>
              {anyIssued ? 'Close' : 'Cancel'}
            </button>
            <button
              type="submit"
              form={`${baseId}-form`}
              className="btn btn--primary btn--lg"
              disabled={busy || toIssue.length === 0}
              aria-busy={busy ? 'true' : undefined}
            >
              {busy && <span className="btn-spinner" aria-hidden="true" />}
              {submitLabel}
            </button>
          </>
        )
      }
    >
      <form id={`${baseId}-form`} onSubmit={submit} noValidate>
        <p className="field-note">Choose what the patient needs next. One token is created per selected type.</p>
        <ReferralChoices selected={selected} results={results} busy={busy} onToggle={toggle} counters={counters} />
        {error && (
          <p className="form-error" role="alert">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <p className="sr-only" aria-live="polite">
          {issuedTokens.map((t) => (t && t.displayNumber) || '').filter(Boolean).join(', ')}
          {issuedTokens.length > 0 ? ' issued.' : ''}
        </p>
      </form>
    </Modal>
  );
}
