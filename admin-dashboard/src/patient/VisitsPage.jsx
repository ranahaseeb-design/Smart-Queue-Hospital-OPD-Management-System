// Visit history (FR-19) with one-time feedback per completed visit (FR-20).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorText, papi } from './patientApi.js';
import { timeText, visitSummary } from './explain.js';

function Stars({ value, onChange, readOnly = false }) {
  return (
    <span className="pt-stars" role={readOnly ? 'img' : 'radiogroup'} aria-label={readOnly ? `${value} of 5 stars` : 'Rating'}>
      {[1, 2, 3, 4, 5].map((n) => (readOnly ? (
        <span key={n} className={n <= value ? 'is-on' : ''} aria-hidden="true">★</span>
      ) : (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} className={n <= value ? 'is-on' : ''} onClick={() => onChange(n)}>
          ★
        </button>
      )))}
    </span>
  );
}

function FeedbackForm({ visit, onSaved }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await papi.feedback(visit.id, rating, comment.trim());
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="pt-feedback" onSubmit={submit}>
      <span className="pt-small">How was this visit?</span>
      <Stars value={rating} onChange={setRating} />
      <input className="pt-input" maxLength={500} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button type="submit" className="pt-btn pt-btn--primary pt-btn--sm" disabled={!rating || busy}>{busy ? 'Sending…' : 'Send feedback'}</button>
      {error && <p className="pt-error" role="alert">{error}</p>}
    </form>
  );
}

export default function VisitsPage() {
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setVisits(await papi.visits());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="pt-page">
      <section className="pt-card" aria-label="My visits">
        <h2 className="pt-step-title">My visits</h2>
        <p className="pt-muted pt-small">Your visits, newest first. You can rate each completed visit once.</p>
        {error && <p className="pt-error" role="alert">{error}</p>}
        {!visits && !error && <div className="pt-skeleton pt-skeleton--cards" aria-label="Loading visits" />}
        {visits && visits.length === 0 && <p className="pt-muted">No visits yet. <Link className="pt-link" to="/">Get a token</Link></p>}
        {(visits || []).map((v) => {
          const opd = (v.tokens || []).find((t) => t.queueType === 'OPD');
          return (
            <article key={v.id} className="pt-list-row">
              <div className="pt-list-main">
                <strong>{v.visitDate} · {v.branch?.name}</strong>
                <span className="pt-muted pt-small">
                  {opd?.doctorName ? `${opd.doctorName} · ` : ''}{visitSummary(v)}
                  {opd?.completedAt ? ` · finished ${timeText(opd.completedAt)}` : ''}
                </span>
              </div>
              <span className={`pt-badge pt-badge--${v.status === 'OPEN' ? 'blue' : 'slate'}`}>{v.status === 'OPEN' ? 'Open' : 'Closed'}</span>
              {v.feedback && (
                <div className="pt-list-extra pt-small">
                  Your rating: <Stars value={v.feedback.rating} readOnly />{v.feedback.comment ? ` — “${v.feedback.comment}”` : ''}
                </div>
              )}
              {!v.feedback && v.canGiveFeedback && (
                <div className="pt-list-extra"><FeedbackForm visit={v} onSaved={load} /></div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
