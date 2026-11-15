// Committee demo: "Demo Load Simulator" drawer. Injects N simulated patient tokens (default 5)
// into the chosen doctor's queue (POST /demo/load-queue), so the doctor's "My queue" fills at once
// and the busy-queue branch recommendation appears. Only works while the server's DEMO_TOOLS is on.
import { useEffect, useRef, useState } from 'react';
import { usePatient } from './PatientContext.jsx';
import { errorText, papi } from './patientApi.js';

export default function DemoDrawer({ open, onClose }) {
  const { selection, bumpRefresh } = usePatient();
  const [doctors, setDoctors] = useState([]);
  const [doctorId, setDoctorId] = useState(null);
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const panelRef = useRef(null);

  // Doctors accepting now in every branch (OPD rooms), for the target picker.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setError(null);
    (async () => {
      const branches = await papi.branches();
      const rows = [];
      for (const b of branches) {
        const deps = await papi.departments(b.id);
        for (const d of deps) {
          const docs = await papi.doctors(d.id);
          for (const doc of docs.filter((x) => x.acceptingNow)) {
            rows.push({ id: doc.id, label: `${b.name} — ${doc.servicePointName} — ${doc.fullName} (${d.specialty})`, queueLength: doc.queueLength });
          }
        }
      }
      if (!alive) return;
      setDoctors(rows);
      const preferred = rows.find((r) => r.id === selection.doctorId) || rows[0];
      setDoctorId((cur) => (rows.some((r) => r.id === cur) ? cur : preferred?.id ?? null));
    })().catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [open, selection.doctorId]);

  useEffect(() => {
    if (!open) return undefined;
    panelRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function inject() {
    if (!doctorId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await papi.loadDemoQueue(doctorId, count);
      setResult(res);
      bumpRefresh();
    } catch (err) {
      setError(err?.status === 404 ? 'Demo tools are turned off on this server (DEMO_TOOLS=false).' : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const target = doctors.find((d) => d.id === doctorId);

  return (
    <div className="pt-drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="pt-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pt-demo-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pt-drawer-head">
          <div>
            <span className="pt-eyebrow pt-eyebrow--amber">Committee demo</span>
            <h2 id="pt-demo-title">Demo load simulator</h2>
          </div>
          <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm" onClick={onClose} aria-label="Close demo simulator">
            ✕
          </button>
        </header>
        <p className="pt-muted pt-small">
          Adds simulated patients to a doctor&apos;s live queue through the normal token path. They appear in that doctor&apos;s
          &ldquo;My queue&rdquo; immediately and raise the predicted wait, so the branch recommendation can be shown.
          The tokens are flagged as synthetic.
        </p>

        <label className="pt-label" htmlFor="pt-demo-doctor">Target doctor / OPD room</label>
        <select id="pt-demo-doctor" className="pt-input" value={doctorId ?? ''} onChange={(e) => setDoctorId(Number(e.target.value))} disabled={busy || !doctors.length}>
          {!doctors.length && <option value="">Loading doctors on duty…</option>}
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} · {d.queueLength} waiting
            </option>
          ))}
        </select>

        <label className="pt-label" htmlFor="pt-demo-count">Simulated patients</label>
        <div className="pt-stepper">
          <button type="button" className="pt-btn pt-btn--ghost" onClick={() => setCount((c) => Math.max(1, c - 1))} disabled={busy || count <= 1} aria-label="Fewer">−</button>
          <output id="pt-demo-count" aria-live="polite">{count}</output>
          <button type="button" className="pt-btn pt-btn--ghost" onClick={() => setCount((c) => Math.min(10, c + 1))} disabled={busy || count >= 10} aria-label="More">+</button>
        </div>

        <button type="button" className="pt-btn pt-btn--amber pt-btn--block" onClick={inject} disabled={busy || !doctorId}>
          {busy ? 'Injecting…' : `Inject ${count} simulated token${count === 1 ? '' : 's'}`}
        </button>

        {error && <p className="pt-error" role="alert">{error}</p>}
        {result && (
          <div className="pt-banner pt-banner--success" role="status">
            Added {result.issued.length} tokens to {result.servicePoint?.name} at {result.branch?.name}
            {target ? ` (${target.label.split(' — ').pop()})` : ''}: {result.issued.map((t) => t.displayNumber).join(', ')}. Now{' '}
            {result.waitingNow} waiting.
          </div>
        )}
      </aside>
    </div>
  );
}
