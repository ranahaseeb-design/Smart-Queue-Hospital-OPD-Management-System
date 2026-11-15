// "Switch doctor / room (demo)" — committee demos can show several doctors' live queues without
// signing out. Lists the active doctors with today's room (GET /demo/doctors) and swaps this
// doctor session for the chosen doctor (POST /demo/switch-doctor). Shown only to doctors, and
// only while the server's DEMO_TOOLS is on (otherwise the list request fails and nothing renders).
import { useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { KEYS, setItem, setJSON } from '../utils/storage.js';

export default function DemoDoctorSwitch() {
  const { user } = useAuth();
  const [doctors, setDoctors] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const id = useId();
  const isDoctor = Boolean(user && user.doctorId);

  useEffect(() => {
    if (!isDoctor) return undefined;
    let alive = true;
    api
      .demoDoctors()
      .then((rows) => alive && setDoctors(Array.isArray(rows) ? rows : []))
      .catch(() => alive && setDoctors([])); // demo tools off or not allowed: hide the switcher
    return () => {
      alive = false;
    };
  }, [isDoctor]);

  if (!isDoctor || !doctors || doctors.length < 2) return null;

  async function switchTo(doctorId) {
    if (!doctorId || doctorId === user.doctorId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.switchDoctor(doctorId);
      setItem(KEYS.token, res.token);
      setJSON(KEYS.user, res.user);
      // Full reload: the new doctor's rooms, queue and live channel start fresh.
      window.location.assign('/');
    } catch (err) {
      setError(err.message || 'Could not switch doctor.');
      setBusy(false);
    }
  }

  return (
    <div className="demo-switch">
      <label htmlFor={id} className="demo-switch-label">
        Switch doctor / room (demo)
      </label>
      <select
        id={id}
        className="demo-switch-select"
        value={user.doctorId}
        disabled={busy}
        onChange={(e) => switchTo(Number(e.target.value))}
        title={error || 'Open another doctor’s live queue without signing out'}
        aria-invalid={error ? 'true' : undefined}
      >
        {doctors.map((d) => (
          <option key={d.doctorId} value={d.doctorId}>
            {d.branchName} · {d.servicePointName || 'no room today'} · {d.fullName} ({d.specialty})
            {d.acceptingNow ? ` · ${d.queueLength} waiting` : ''}
          </option>
        ))}
      </select>
      {error && (
        <span className="demo-switch-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
