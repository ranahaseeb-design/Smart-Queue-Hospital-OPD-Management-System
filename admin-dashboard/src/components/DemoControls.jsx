// Header controls for live presentations: open the waiting-room display board, load the
// committee demo data (POST /demo/seed) and toggle peak congestion at Model Town (/demo/peak).
// The demo items render only while the server's DEMO_TOOLS is on (GET /demo/peak answers 200).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import Icon from './Icon.jsx';

export default function DemoControls() {
  const toast = useToast();
  const [available, setAvailable] = useState(false);
  const [peak, setPeak] = useState(false);
  const [mtLoad, setMtLoad] = useState(null);
  const [busy, setBusy] = useState(null);

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
    refreshPeak();
  }, [refreshPeak]);

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
      {available && (
        <>
          <button type="button" className="btn btn-sm btn-ghost demo-seed" onClick={loadDemo} disabled={Boolean(busy)} aria-busy={busy === 'seed' || undefined}>
            <Icon name="play" size={14} /> {busy === 'seed' ? 'Loading…' : <span className="demo-hide-sm">Load committee demo data</span>}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={peak}
            className={`demo-peak${peak ? ' is-on' : ''}`}
            onClick={togglePeak}
            disabled={Boolean(busy)}
            title="Push Model Town above 85 % load to trigger congestion alerts and branch recommendations"
          >
            <span className="demo-peak-track" aria-hidden="true"><span className="demo-peak-thumb" /></span>
            <span className="demo-hide-sm">{busy === 'peak' ? 'Working…' : 'Simulate peak congestion'}</span>
            {mtLoad !== null && <span className="demo-peak-load">{mtLoad}%</span>}
          </button>
        </>
      )}
    </div>
  );
}
