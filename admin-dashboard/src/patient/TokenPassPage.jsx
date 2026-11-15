// Live digital token pass (FR-04, FR-05, FR-06, FR-07). Live via the socket room token:<id> and
// the patient's user room, with a 4 s polling fallback, so "Call next" in the doctor's room shows
// here at once: "NOW SERVING — Proceed to Room 1" with a pulse and an optional chime.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePatient } from './PatientContext.jsx';
import { errorText, papi } from './patientApi.js';
import { estimateSource } from './geo.js';
import { chimeEnabled, playChime, setChimeEnabled } from './chime.js';

const POLL_MS = 4000;
const ACTIVE = ['WAITING', 'CALLED', 'IN_SERVICE'];

export function priorityTag(token) {
  if (!token) return { label: 'Standard', tone: 'slate' };
  if (token.priorityLevel >= 2) return { label: 'Urgent', tone: 'red' };
  if (token.priorityLevel === 1) return { label: 'Senior / Priority', tone: 'amber' };
  if (token.appointmentId) return { label: 'Appointment', tone: 'blue' };
  return { label: 'Standard', tone: 'slate' };
}

/** Status banner text for each token status. */
export function statusBanner(token) {
  const room = token?.servicePoint?.name || 'the consultation room';
  switch (token?.status) {
    case 'WAITING':
      return { tone: 'wait', title: 'Waiting', text: token.patientsAhead === 0 ? 'You are next' : `${token.patientsAhead} patient${token.patientsAhead === 1 ? '' : 's'} ahead of you` };
    case 'CALLED':
      return { tone: 'called', title: `NOW SERVING — Proceed to ${room}`, text: 'Please go to the room now.' };
    case 'IN_SERVICE':
      return { tone: 'service', title: 'In consultation', text: `With ${token.doctor?.fullName || 'the doctor'} in ${room}` };
    case 'COMPLETED':
      return { tone: 'done', title: 'Consultation completed', text: 'Thank you for visiting.' };
    case 'SKIPPED':
      return { tone: 'skipped', title: 'Missed your turn', text: 'You were called but not present. Please tell the reception desk — staff can recall your token.' };
    case 'CANCELLED':
      return { tone: 'muted', title: 'Token cancelled', text: 'This token is no longer in the queue.' };
    case 'TRANSFERRED':
      return { tone: 'muted', title: 'Token transferred', text: 'Staff moved you to another queue — see your active tokens.' };
    case 'NO_SHOW':
      return { tone: 'muted', title: 'Marked as no-show', text: 'Please contact the reception desk.' };
    default:
      return { tone: 'muted', title: token?.status || '', text: '' };
  }
}

/** Journey: 1 Registration → 2 OPD consultation → 3 Lab / Pharmacy → 4 Completed. */
export function journeySteps(token) {
  const linked = token?.linkedTokens || [];
  const opdDone = token?.status === 'COMPLETED';
  const opdActive = ACTIVE.includes(token?.status);
  const linkedOpen = linked.filter((t) => ACTIVE.includes(t.status));
  const linkedDone = linked.length > 0 && linkedOpen.length === 0;
  const lab = linked.length
    ? {
      state: linkedOpen.length ? 'active' : 'done',
      detail: linked
        .map((t) => `${t.queueType === 'LAB' ? 'Lab' : 'Pharmacy'} ${t.displayNumber} — ${t.status === 'WAITING' ? `${t.patientsAhead} ahead${t.estimate ? ` · ~${t.estimate.minutes} min` : ''}` : t.status.replace('_', ' ').toLowerCase()}`)
        .join(' · '),
    }
    : { state: opdDone ? 'skipped' : 'pending', detail: opdDone ? 'Not required' : 'If the doctor orders tests or medicines' };
  const finished = opdDone && (linked.length === 0 || linkedDone);
  return [
    { key: 'reg', label: 'Registration', state: 'done', detail: `Token ${token?.displayNumber || ''}` },
    { key: 'opd', label: 'OPD consultation', state: opdDone ? 'done' : opdActive ? 'active' : 'pending', detail: token?.doctor?.fullName || '' },
    { key: 'lab', label: 'Lab / Pharmacy', ...lab },
    { key: 'done', label: 'Completed', state: finished ? 'done' : 'pending', detail: finished ? 'Visit finished' : '' },
  ];
}

export default function TokenPassPage() {
  const { id } = useParams();
  const tokenId = Number(id);
  const { live, onLive, watchRoom } = usePatient();
  const [token, setToken] = useState(null);
  const [error, setError] = useState(null);
  const [chime, setChime] = useState(() => chimeEnabled());
  const [flash, setFlash] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const lastStatus = useRef(null);
  const startAhead = useRef(null); // patients ahead when this page first saw the token

  const load = useCallback(async () => {
    try {
      const t = await papi.token(tokenId);
      if (t.status === 'WAITING' && (startAhead.current === null || t.patientsAhead > startAhead.current)) {
        startAhead.current = t.patientsAhead;
      }
      setToken(t);
      setError(null);
      if (lastStatus.current && lastStatus.current !== t.status && t.status === 'CALLED') {
        setFlash(true);
        if (chimeEnabled()) playChime();
        setTimeout(() => setFlash(false), 6000);
      }
      lastStatus.current = t.status;
    } catch (err) {
      setError(errorText(err));
    }
  }, [tokenId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Live updates: our token room + linked tokens' rooms; any event about them triggers a refetch.
  useEffect(() => watchRoom(`token:${tokenId}`), [tokenId, watchRoom]);
  const linkedIds = (token?.linkedTokens || []).map((t) => t.id).join(',');
  useEffect(() => {
    const leaves = linkedIds ? linkedIds.split(',').map((lid) => watchRoom(`token:${lid}`)) : [];
    return () => leaves.forEach((leave) => leave());
  }, [linkedIds, watchRoom]);
  useEffect(() => onLive(() => load()), [onLive, load]);

  function toggleChime() {
    const next = !chime;
    setChime(next);
    setChimeEnabled(next);
    if (next) playChime();
  }

  async function cancel() {
    if (!window.confirm(`Cancel token ${token.displayNumber}? You will leave the queue.`)) return;
    setCancelling(true);
    try {
      setToken(await papi.cancelToken(tokenId));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCancelling(false);
    }
  }

  if (!token) {
    return (
      <div className="pt-pass-wrap">
        {error ? (
          <div className="pt-banner pt-banner--error" role="alert">
            {error} <Link className="pt-link" to="/">Back to booking</Link>
          </div>
        ) : (
          <div className="pt-pass pt-skeleton pt-skeleton--pass" aria-label="Loading your token" />
        )}
      </div>
    );
  }

  const banner = statusBanner(token);
  const tag = priorityTag(token);
  const est = token.estimate;
  const source = estimateSource(est?.modelVersion);
  const steps = journeySteps(token);
  // Share of the queue already passed since the pass was opened (next in line ≈ almost full).
  const total = (startAhead.current ?? token.patientsAhead ?? 0) + 1;
  const progress = token.status === 'WAITING'
    ? Math.max(6, Math.round(((total - (token.patientsAhead ?? 0)) / total) * 100))
    : 100;

  return (
    <div className="pt-pass-wrap">
      <div className="pt-pass-tools">
        <Link className="pt-link" to="/">← Book another token</Link>
        <div className="pt-pass-tools-right">
          <span className={`pt-live${live ? ' is-on' : ''}`} title={live ? 'Live updates connected' : 'Live channel reconnecting — refreshing every few seconds'}>
            <span className="pt-live-dot" aria-hidden="true" /> {live ? 'Live' : 'Polling'}
          </span>
          <button type="button" className={`pt-btn pt-btn--ghost pt-btn--sm${chime ? ' is-on' : ''}`} aria-pressed={chime} onClick={toggleChime}>
            {chime ? '🔔 Chime on' : '🔕 Chime off'}
          </button>
        </div>
      </div>

      <article className={`pt-pass pt-pass--${banner.tone}${flash ? ' is-flash' : ''}`} aria-labelledby="pt-pass-number">
        <header className="pt-pass-top">
          <div>
            <span className="pt-eyebrow">Smart OPD · Live token pass</span>
            <p className="pt-pass-branch">{token.branch?.name}</p>
          </div>
          <span className={`pt-badge pt-badge--${tag.tone}`}>{tag.label}</span>
        </header>

        <p id="pt-pass-number" className="pt-pass-number">{token.displayNumber}</p>
        <p className="pt-pass-where">
          {token.servicePoint?.name} · {token.doctor?.fullName || token.queueType}
        </p>

        <div className={`pt-status pt-status--${banner.tone}`} role="status" aria-live="assertive">
          <strong>{banner.title}</strong>
          {banner.text && <span>{banner.text}</span>}
        </div>

        <div className="pt-perforation" aria-hidden="true" />

        {token.status === 'WAITING' && (
          <>
            <div className="pt-pass-metrics">
              <div>
                <span className="pt-eyebrow">Patients ahead of you</span>
                <p className="pt-metric">{token.patientsAhead}</p>
              </div>
              <div>
                <span className="pt-eyebrow">Live AI predicted wait</span>
                <p className="pt-metric">
                  {est ? `${est.low}–${est.high}` : '—'}
                  <small> min</small>
                </p>
                <span className={`pt-badge ${source.ai ? 'pt-badge--green' : 'pt-badge--slate'}`}>{source.label}</span>
              </div>
            </div>
            <div className="pt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Queue progress">
              <span style={{ width: `${progress}%` }} />
            </div>
            {token.nowServing && <p className="pt-muted pt-small">Now serving in this room: {token.nowServing.displayNumber}</p>}
          </>
        )}

        <ol className="pt-journey" aria-label="Visit journey">
          {steps.map((s, i) => (
            <li key={s.key} className={`pt-journey-step is-${s.state}`}>
              <span className="pt-journey-dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
              <span className="pt-journey-text">
                <strong>{i + 1}. {s.label}</strong>
                {s.detail && <span className="pt-muted pt-small">{s.detail}</span>}
              </span>
            </li>
          ))}
        </ol>

        {token.status === 'WAITING' && (
          <button type="button" className="pt-btn pt-btn--danger-ghost pt-btn--block" onClick={cancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel token'}
          </button>
        )}
      </article>
      {error && <p className="pt-error" role="alert">{error}</p>}
    </div>
  );
}
