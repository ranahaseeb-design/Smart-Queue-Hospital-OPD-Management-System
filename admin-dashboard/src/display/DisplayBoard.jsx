// Waiting-room display board (/display) — full-screen TV view for the waiting area: NOW SERVING per
// OPD room and LAB / PHARMACY counter (a gentle pulse when the number changes), UP NEXT (next 3),
// and live estimated waits per department. Token numbers only, never patient names. Opened from
// the staff and admin headers with the viewer's own session (GET /display, refreshed every 3 s:
// NFR-01). Public: a TV opens it without signing in (the data has no personal information).
// The FYP keeps physical display hardware out of scope; any screen can show this page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../api/client.js';
import './display.css';

const REFRESH_MS = 3000;

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

async function getJson(path) {
  const res = await fetch(`${API_URL}/api${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`);
  return body;
}

const TYPE_LABEL = { OPD: 'OPD room', LAB: 'Laboratory', PHARMACY: 'Pharmacy' };

export default function DisplayBoard() {
  const [branchId, setBranchId] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState({});
  const [announce, setAnnounce] = useState('');
  const previous = useRef({});
  const clock = useClock();

  const load = useCallback(async () => {
    try {
      const data = await getJson(`/display${branchId ? `?branchId=${branchId}` : ''}`);
      // Pulse the cards whose now-serving number changed since the last refresh.
      const changed = {};
      const calls = [];
      for (const sp of data.servicePoints) {
        const num = sp.nowServing?.displayNumber || null;
        if (num && previous.current[sp.id] !== undefined && previous.current[sp.id] !== num) {
          changed[sp.id] = true;
          calls.push(`${num} to ${sp.name}`);
        }
        previous.current[sp.id] = num;
      }
      if (calls.length) {
        setFlash(changed);
        setAnnounce(`Now serving ${calls.join(', ')}`);
        setTimeout(() => setFlash({}), 6000);
      }
      setBoard(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [branchId]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  function fullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  }

  const opd = board?.servicePoints.filter((s) => s.type === 'OPD') || [];
  const counters = board?.servicePoints.filter((s) => s.type !== 'OPD') || [];

  return (
    <div className="dp">
      <header className="dp-head">
        <div className="dp-brand">
          <span className="dp-mark" aria-hidden="true">+</span>
          <div>
            <h1>{board ? board.branch.name : 'Smart OPD'}</h1>
            <p>Waiting room · Please watch for your token number</p>
          </div>
        </div>
        <div className="dp-tools">
          {board && board.branches?.length > 1 && (
            <select
              className="dp-select"
              aria-label="Branch"
              value={branchId ?? board?.branch.id ?? ''}
              onChange={(e) => {
                previous.current = {};
                setBranchId(Number(e.target.value));
              }}
            >
              {board.branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
          <button type="button" className="dp-btn" onClick={fullscreen}>Full screen</button>
          <time className="dp-clock" dateTime={clock.toISOString()}>
            {clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </time>
        </div>
      </header>

      <p className="sr-only" aria-live="polite">{announce}</p>
      {error && <p className="dp-error" role="alert">Connection problem — retrying… ({error})</p>}
      {!board && !error && <p className="dp-loading">Loading the board…</p>}

      {board && (
        <main className="dp-main">
          <section aria-label="OPD rooms" className="dp-grid">
            {opd.map((sp) => <PointCard key={sp.id} sp={sp} flash={flash[sp.id]} />)}
          </section>
          {counters.length > 0 && (
            <section aria-label="Laboratory and pharmacy counters" className="dp-grid dp-grid--counters">
              {counters.map((sp) => <PointCard key={sp.id} sp={sp} flash={flash[sp.id]} />)}
            </section>
          )}
        </main>
      )}

      {board && board.departments.length > 0 && (
        <footer className="dp-foot" aria-label="Estimated waiting time by department">
          <span className="dp-foot-label">Estimated wait (AI)</span>
          {board.departments.map((d) => (
            <span key={d.departmentId} className={`dp-dept dp-dept--${String(d.congestionLevel || 'NORMAL').toLowerCase()}`}>
              <strong>{d.name}</strong>
              <span>{d.estimatedWaitMinutes === null ? '—' : d.estimatedWaitMinutes < 5 ? '< 5 min' : `~${d.estimatedWaitMinutes} min`}</span>
              <span className="dp-dept-waiting">{d.waiting} waiting</span>
            </span>
          ))}
        </footer>
      )}
    </div>
  );
}

function PointCard({ sp, flash }) {
  const serving = sp.nowServing;
  return (
    <article className={`dp-card dp-card--${sp.type.toLowerCase()}${serving ? ' has-serving' : ''}${flash ? ' is-flash' : ''}`}>
      <header className="dp-card-head">
        <span className="dp-room">{sp.name}</span>
        <span className="dp-type">{sp.type === 'OPD' ? sp.departmentName || TYPE_LABEL.OPD : TYPE_LABEL[sp.type]}</span>
      </header>
      {sp.doctorName && <p className="dp-doctor">{sp.doctorName}</p>}
      <div className="dp-now">
        <span className="dp-now-label">Now serving</span>
        <span className="dp-now-number">{serving ? serving.displayNumber : '—'}</span>
        {serving && <span className="dp-now-state">{serving.status === 'IN_SERVICE' ? 'In consultation' : 'Please come in'}</span>}
      </div>
      <div className="dp-next">
        <span className="dp-next-label">Up next</span>
        {sp.next.length ? (
          <ol>
            {sp.next.map((n) => (
              <li key={n.displayNumber} className={n.priorityLevel >= 2 ? 'is-emergency' : n.priorityLevel === 1 ? 'is-priority' : ''}>
                {n.displayNumber}
              </li>
            ))}
          </ol>
        ) : (
          <span className="dp-next-empty">No one waiting</span>
        )}
        {sp.waiting > sp.next.length && <span className="dp-more">+{sp.waiting - sp.next.length} more</span>}
      </div>
    </article>
  );
}
