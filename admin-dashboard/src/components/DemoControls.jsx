// Header controls for live presentations: open the waiting-room display board (always), and — only
// while this browser's "Demo tools" switch is on and the server's DEMO_TOOLS is on (GET /demo/peak
// answers 200) — load the committee demo data (POST /demo/seed), toggle peak congestion at Model
// Town (/demo/peak) and remove all demo data again (POST /demo/reset).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import Icon from './Icon.jsx';
import { useDemoTools } from '@staff/utils/demoMode.js';

export default function DemoControls() {
  const toast = useToast();
  const [available, setAvailable] = useState(false);
  const [peak, setPeak] = useState(false);
  const [mtLoad, setMtLoad] = useState(null);
  const [busy, setBusy] = useState(null);
  const [demoOn] = useDemoTools();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const refreshPeak = useCallback(async () => {
    try {
      const res = await api.get('/demo/peak');
      setAvailable(true);
      setPeak(Boolean(res.peakActive));
      const mt = (res.branches || []).find((b) => b.name === 'Model Town') || (res.branches || [])[0];
      setMtLoad(mt ? mt.loadPercent : null);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (demoOn) refreshPeak();
  }, [demoOn, refreshPeak]);

  async function resetDemo() {
    if (!window.confirm('Remove all demo data? Every demo, peak and walk-in kiosk patient is deleted with their tokens and visits. Seeded accounts and history stay.')) return;
    setBusy('reset');
    try {
      const r = await api.post('/demo/reset', {});
      toast.success(`Demo data removed: ${r.removed.patients} demo patients, ${r.removed.tokens} tokens.`, { duration: 7000 });
      await refreshPeak();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function loadDemo() {
    if (!window.confirm('Load committee demo data? This adds today’s completed visits and waiting tokens to the live database (flagged as synthetic).')) return;
    setBusy('seed');
    try {
      const r = await api.post('/demo/seed', {});
      const doc = r.waiting?.doctor;
      const ph = r.waiting?.pharmacy;
      toast.success(
        `Demo data loaded: ${r.completedVisits} completed visits today`
        + `${doc ? `, ${doc.tokens.length} waiting for ${doc.doctorName} (${doc.servicePointName})` : ''}`
        + `${ph ? `, ${ph.tokens.length} at ${ph.servicePointName}` : ''}`
        + `${r.forecast?.source ? ` · forecast: ${r.forecast.source === 'ai' ? 'Random Forest' : 'baseline'}` : ''}.`,
        { duration: 9000 },
      );
      await refreshPeak();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function togglePeak() {
    const next = !peak;
    setBusy('peak');
    try {
      const r = await api.post('/demo/peak', { enabled: next });
      setPeak(r.peakActive);
      setMtLoad(r.load?.percent ?? null);
      toast[next ? 'warning' : 'success'](
        next
          ? `Peak congestion simulated: ${r.added} waiting tokens added — ${r.branch.name} load ${r.load.percent}%.`
          : `Peak congestion cleared: ${r.cancelled} tokens cancelled — ${r.branch.name} load ${r.load.percent}%.`,
        { duration: 8000 },
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="demo-controls" role="group" aria-label="Presentation tools">
      <a className="btn btn-ghost btn-sm" href="/display" target="_blank" rel="noopener" title="Open the waiting-room display board in a new tab">
        <Icon name="monitor" size={16} /> <span className="demo-hide-sm">Waiting room display</span>
      </a>
      {demoOn && available && (
        <div className="demo-menu" ref={menuRef}>
          <button
            type="button"
            className={`btn btn-sm demo-menu-btn${peak ? ' is-peak' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title="Demo tools for presentations"
          >
            <Icon name="play" size={14} /> Demo
            {peak && mtLoad !== null && <span className="demo-peak-load">{mtLoad}%</span>}
            <Icon name="chevronDown" size={14} />
          </button>
          {open && (
            <div className="menu demo-menu-panel" role="menu">
              <button type="button" role="menuitem" className="menu-item" onClick={loadDemo} disabled={Boolean(busy)} aria-busy={busy === 'seed' || undefined}>
                <Icon name="play" size={16} /> {busy === 'seed' ? 'Loading…' : 'Load committee demo data'}
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={peak}
                className={`menu-item demo-peak-item${peak ? ' is-on' : ''}`}
                onClick={togglePeak}
                disabled={Boolean(busy)}
                title="Push Model Town above 85 % load to trigger congestion alerts and branch recommendations"
              >
                <span className="demo-peak-track" aria-hidden="true"><span className="demo-peak-thumb" /></span>
                {busy === 'peak' ? 'Working…' : 'Simulate peak congestion'}
                {mtLoad !== null && <span className="demo-peak-load">{mtLoad}%</span>}
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={resetDemo} disabled={Boolean(busy)}>
                <Icon name="trash" size={16} /> {busy === 'reset' ? 'Removing…' : 'Reset demo data'}
              </button>
              <p className="demo-menu-note">Hide these tools from the user menu (Demo tools: Off).</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
