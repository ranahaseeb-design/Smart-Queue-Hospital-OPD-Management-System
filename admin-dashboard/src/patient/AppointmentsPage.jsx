// Appointments (FR-10): book a time slot with a doctor, reschedule or cancel it, and check in on the
// day (from 60 min before the slot) — check-in issues a normal OPD token and opens the live pass.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { errorText, papi } from './patientApi.js';
import { appointmentStatus, canCheckIn, dateKey, slotText, timeText } from './explain.js';

const DAYS = 7;

function dayLabel(key, offset) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Date chips + slot grid for one doctor; calls onPick(slotStart). */
function SlotPicker({ doctorId, onPick, busy, actionLabel }) {
  const [date, setDate] = useState(dateKey(0));
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState(null);
  const [chosen, setChosen] = useState(null);

  useEffect(() => {
    if (!doctorId) return undefined;
    let alive = true;
    setSlots(null);
    setChosen(null);
    setError(null);
    papi
      .slots(doctorId, date)
      .then((r) => alive && setSlots(r.slots || []))
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [doctorId, date]);

  const free = (slots || []).filter((s) => s.available);
  return (
    <div className="pt-slots">
      <div className="pt-chips" role="radiogroup" aria-label="Day">
        {Array.from({ length: DAYS }, (_, i) => {
          const key = dateKey(i);
          return (
            <button key={key} type="button" role="radio" aria-checked={date === key} className={`pt-chip${date === key ? ' is-on' : ''}`} onClick={() => setDate(key)}>
              {dayLabel(key, i)}
            </button>
          );
        })}
      </div>
      {error && <p className="pt-error" role="alert">{error}</p>}
      {!slots && !error && <div className="pt-skeleton pt-skeleton--chips" aria-label="Loading slots" />}
      {slots && free.length === 0 && <p className="pt-muted pt-small">No free slots on this day — try another day.</p>}
      {free.length > 0 && (
        <div className="pt-slot-grid" role="radiogroup" aria-label="Time">
          {free.map((s) => (
            <button key={s.start} type="button" role="radio" aria-checked={chosen === s.start} className={`pt-chip${chosen === s.start ? ' is-on' : ''}`} onClick={() => setChosen(s.start)}>
              {timeText(s.start)}
            </button>
          ))}
        </div>
      )}
      <button type="button" className="pt-btn pt-btn--primary" disabled={!chosen || busy} onClick={() => onPick(chosen)}>
        {busy ? 'Saving…' : actionLabel}
      </button>
    </div>
  );
}

function BookForm({ onBooked }) {
  const [specialties, setSpecialties] = useState([]);
  const [branches, setBranches] = useState([]);
  const [specialty, setSpecialty] = useState('');
  const [branchId, setBranchId] = useState('');
  const [doctors, setDoctors] = useState(null);
  const [doctorId, setDoctorId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([papi.specialties(), papi.branches()])
      .then(([sp, br]) => {
        setSpecialties(sp);
        setBranches(br);
        setSpecialty(sp.includes('General Medicine') ? 'General Medicine' : sp[0] || '');
        setBranchId(br[0] ? String(br[0].id) : '');
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  useEffect(() => {
    if (!specialty || !branchId) return undefined;
    let alive = true;
    setDoctors(null);
    setDoctorId(null);
    papi
      .departments(Number(branchId))
      .then(async (deps) => {
        const dept = deps.find((d) => d.specialty === specialty);
        const list = dept ? await papi.doctors(dept.id) : [];
        if (alive) setDoctors(list);
      })
      .catch((err) => alive && setError(errorText(err)));
    return () => {
      alive = false;
    };
  }, [specialty, branchId]);

  async function book(slotStart) {
    setBusy(true);
    setError(null);
    try {
      const appt = await papi.bookAppointment(doctorId, slotStart);
      onBooked(appt);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pt-card pt-book" aria-label="Book an appointment">
      <h2 className="pt-step-title">Book an appointment</h2>
      <div className="pt-form-row">
        <label className="pt-label">
          Specialty
          <select className="pt-input" value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
            {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="pt-label">
          Branch
          <select className="pt-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </div>
      {doctors === null && <div className="pt-skeleton pt-skeleton--chips" aria-label="Loading doctors" />}
      {doctors && doctors.length === 0 && <p className="pt-muted pt-small">No {specialty} doctors at this branch.</p>}
      {doctors && doctors.length > 0 && (
        <div className="pt-chips" role="radiogroup" aria-label="Doctor">
          {doctors.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={doctorId === d.id} className={`pt-chip${doctorId === d.id ? ' is-on' : ''}`} onClick={() => setDoctorId(d.id)}>
              {d.fullName}
            </button>
          ))}
        </div>
      )}
      {doctorId && <SlotPicker doctorId={doctorId} onPick={book} busy={busy} actionLabel="Book this slot" />}
      {error && <p className="pt-error" role="alert">{error}</p>}
    </section>
  );
}

export default function AppointmentsPage() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setList(await papi.appointments());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function act(id, fn, message) {
    setBusy(id);
    setError(null);
    try {
      const out = await fn();
      if (message) setNotice(message);
      await load();
      return out;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function checkIn(a) {
    const token = await act(a.id, () => papi.checkIn(a.id));
    if (token) navigate(`/token/${token.id}`);
  }

  const upcoming = (list || []).filter((a) => a.status === 'BOOKED');
  const past = (list || []).filter((a) => a.status !== 'BOOKED');

  return (
    <div className="pt-page">
      <BookForm onBooked={(a) => { setNotice(`Booked ${a.doctor?.fullName} on ${slotText(a.slotStart)}.`); load(); }} />

      <section className="pt-card" aria-label="My appointments">
        <h2 className="pt-step-title">My appointments</h2>
        {notice && <div className="pt-banner pt-banner--success" role="status">{notice}</div>}
        {error && <p className="pt-error" role="alert">{error}</p>}
        {!list && !error && <div className="pt-skeleton pt-skeleton--cards" aria-label="Loading appointments" />}
        {list && list.length === 0 && <p className="pt-muted">No appointments yet.</p>}
        {[...upcoming, ...past].map((a) => {
          const st = appointmentStatus(a.status);
          return (
            <article key={a.id} className="pt-list-row">
              <div className="pt-list-main">
                <strong>{slotText(a.slotStart)}</strong>
                <span className="pt-muted pt-small">{a.doctor?.fullName} · {a.doctor?.specialty} · {a.branch?.name}</span>
              </div>
              <span className={`pt-badge pt-badge--${st.tone}`}>{st.label}</span>
              {a.status === 'BOOKED' && (
                <div className="pt-list-actions">
                  <button type="button" className="pt-btn pt-btn--primary pt-btn--sm" disabled={!canCheckIn(a) || busy === a.id} title={canCheckIn(a) ? 'Get your token now' : 'Check-in opens 60 minutes before the slot'} onClick={() => checkIn(a)}>
                    Check in
                  </button>
                  <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm" onClick={() => setRescheduling(rescheduling === a.id ? null : a.id)}>
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="pt-btn pt-btn--danger-ghost pt-btn--sm"
                    disabled={busy === a.id}
                    onClick={() => window.confirm('Cancel this appointment? The slot is released.') && act(a.id, () => papi.cancelAppointment(a.id), 'Appointment cancelled.')}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {a.tokenId && (
                <button type="button" className="pt-btn pt-btn--ghost pt-btn--sm" onClick={() => navigate(`/token/${a.tokenId}`)}>View token</button>
              )}
              {rescheduling === a.id && (
                <div className="pt-list-extra">
                  <SlotPicker
                    doctorId={a.doctor?.id}
                    busy={busy === a.id}
                    actionLabel="Move to this slot"
                    onPick={(slot) => act(a.id, () => papi.rescheduleAppointment(a.id, slot), `Moved to ${slotText(slot)}.`).then(() => setRescheduling(null))}
                  />
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}
