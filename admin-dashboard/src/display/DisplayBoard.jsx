// Waiting-room display board (/display) — full-screen TV view for the waiting area:
//  - OPD room cards: NOW SERVING (emerald pulse when a new token is called), UP NEXT (next 3, in a
//    fixed 3-column grid that never overflows the card) and the Random Forest estimated wait for a
//    patient joining that room now ("Est. wait ~X min"; Eq. 6.2 baseline when the AI is down);
//  - a "Service counters (Pharmacy & Lab)" bar, so patients referred out of the OPD rooms see their
//    LAB / PHARMACY tokens called on the same screen;
//  - an optional chime on each new call (Sound on / Mute, remembered on this screen).
// Token numbers only, never patient names. Public: a TV opens it without signing in (GET /display,
// refreshed every 3 s: NFR-01). The FYP keeps physical display hardware out of scope; any screen
// can show this page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../api/client.js';
import { playChime } from '../patient/chime.js';
import './display.css';

const REFRESH_MS = 3000;
const FLASH_MS = 6000;
const SOUND_KEY = 'smartopd.display.sound';

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

function readSound() {
  try {
    return window.localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return false;
  }
}

function saveSound(on) {
  try {
    window.localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked: the toggle still works on this page */
  }
}

/** "~12 min" / "< 5 min" / null for an estimate in minutes. */
export function waitText(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return null;
  return Number(minutes) < 5 ? '< 5 min' : `~${Math.round(minutes)} min`;
}

/** Service points whose now-serving number changed since the previous refresh. */
export function newlyCalled(previous, servicePoints) {
  const changed = [];
  for (const sp of servicePoints) {
    const num = sp.nowServing?.displayNumber || null;
    if (num && previous[sp.id] !== undefined && previous[sp.id] !== num) changed.push({ id: sp.id, number: num, name: sp.name });
  }
  return changed;
}

export default function DisplayBoard() {
  const [branchId, setBranchId] = useState(null);
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState({});
  const [announce, setAnnounce] = useState('');
  const [sound, setSound] = useState(readSound);
  const previous = useRef({});
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const clock = useClock();

  const load = useCallback(async () => {
    try {
      const data = await getJson(`/display${branchId ? `?branchId=${branchId}` : ''}`);
      const calls = newlyCalled(previous.current, data.servicePoints);
      for (const sp of data.servicePoints) previous.current[sp.id] = sp.nowServing?.displayNumber || null;
      if (calls.length) {
        setFlash(Object.fromEntries(calls.map((c) => [c.id, true])));
        setAnnounce(`Now serving ${calls.map((c) => `${c.number} at ${c.name}`).join(', ')}`);
        if (soundRef.current) playChime();
        setTimeout(() => setFlash({}), FLASH_MS);
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

  function toggleSound() {
    const next = !sound;
    setSound(next);
    saveSound(next);
    // The click is the user gesture browsers require before audio may play; a test chime confirms it.
    if (next) playChime();
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
          <button
            type="button"
            className={`dp-btn dp-sound${sound ? ' is-on' : ''}`}
            onClick={toggleSound}
            aria-pressed={sound}
            title={sound ? 'Mute the call chime' : 'Play a chime when a new token is called'}
          >
            <span aria-hidden="true">{sound ? '🔔' : '🔕'}</span> {sound ? 'Sound on' : 'Muted'}
          </button>
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
            {opd.map((sp) => <RoomCard key={sp.id} sp={sp} flash={flash[sp.id]} />)}
          </section>

          {counters.length > 0 && (
            <section className="dp-counters" aria-labelledby="dp-counters-title">
              <h2 id="dp-counters-title" className="dp-section-title">Service counters (Pharmacy &amp; Lab)</h2>
              <div className="dp-counter-list">
                {counters.map((sp) => <CounterRow key={sp.id} sp={sp} flash={flash[sp.id]} />)}
              </div>
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
              <span>{waitText(d.estimatedWaitMinutes) ?? '—'}</span>
              <span className="dp-dept-waiting">{d.waiting} waiting</span>
            </span>
          ))}
        </footer>
      )}
    </div>
  );
}

function NextChips({ next, waiting }) {
  if (!next.length) return <span className="dp-next-empty">No one waiting</span>;
  return (
    <>
      <ol className="dp-chips">
        {next.map((n) => (
          <li key={n.displayNumber} className={`dp-chip${n.priorityLevel >= 2 ? ' is-emergency' : n.priorityLevel === 1 ? ' is-priority' : ''}`}>
            {n.displayNumber}
          </li>
        ))}
      </ol>
      {waiting > next.length && <span className="dp-more">+{waiting - next.length} more waiting</span>}
    </>
  );
}

function NowServing({ serving, flash, compact = false }) {
  return (
    <div className={`dp-now${compact ? ' dp-now--compact' : ''}${flash ? ' is-flash' : ''}`}>
      <span className="dp-now-label">Now serving</span>
      <span className="dp-now-number">{serving ? serving.displayNumber : '—'}</span>
      {serving && !compact && <span className="dp-now-state">{serving.status === 'IN_SERVICE' ? 'In consultation' : 'Please come in'}</span>}
    </div>
  );
}

function RoomCard({ sp, flash }) {
  const serving = sp.nowServing;
  const wait = waitText(sp.estimatedWaitMinutes);
  const ai = sp.estimateModelVersion && sp.estimateModelVersion !== 'baseline';
  return (
    <article className={`dp-card${serving ? ' has-serving' : ''}${flash ? ' is-flash' : ''}`}>
      <header className="dp-card-head">
        <span className="dp-room">{sp.name}</span>
        <span className="dp-type">{sp.departmentName || 'OPD room'}</span>
      </header>
      {sp.doctorName && <p className="dp-doctor">{sp.doctorName}</p>}
      <NowServing serving={serving} flash={flash} />
      <div className="dp-next">
        <span className="dp-next-label">Up next</span>
        <NextChips next={sp.next} waiting={sp.waiting} />
      </div>
      {wait && (
        <span className="dp-wait" title={ai ? `Random Forest ${sp.estimateModelVersion}` : 'Queue formula (AI service unavailable)'}>
          Est. wait: {wait}
          <small>{ai ? 'AI' : 'est.'}</small>
        </span>
      )}
    </article>
  );
}

function CounterRow({ sp, flash }) {
  return (
    <article className={`dp-counter${sp.nowServing ? ' has-serving' : ''}${flash ? ' is-flash' : ''}`}>
      <div className="dp-counter-name">
        <span className="dp-room">{sp.name}</span>
        <span className="dp-type">{sp.type === 'PHARMACY' ? 'Pharmacy' : 'Laboratory'}</span>
      </div>
      <NowServing serving={sp.nowServing} flash={flash} compact />
      <div className="dp-next dp-next--row">
        <span className="dp-next-label">Up next</span>
        <NextChips next={sp.next} waiting={sp.waiting} />
      </div>
    </article>
  );
}
