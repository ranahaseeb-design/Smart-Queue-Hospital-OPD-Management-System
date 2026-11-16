// Patient profile (FR-01): name, e-mail, phone, date of birth, priority category and password.
// Same rules as registration: ELDERLY comes from the date of birth (60+), DIFFERENTLY_ABLED may be
// declared and is confirmed by staff at the counter.
import { useState } from 'react';
import { usePatient } from './PatientContext.jsx';
import { errorText, papi } from './patientApi.js';

const PRIORITY_TEXT = {
  NONE: 'Normal',
  ELDERLY: 'Senior citizen (60+) — automatic priority',
  DIFFERENTLY_ABLED: 'Differently-abled — confirmed by staff at the counter',
};

export default function ProfilePage() {
  const { user, setUser } = usePatient();
  const [form, setForm] = useState(() => ({
    fullName: user?.fullName || '',
    email: user?.email || '',
    phone: user?.phone || '',
    dateOfBirth: user?.dateOfBirth || '',
    disabled: user?.priorityCategory === 'DIFFERENTLY_ABLED',
    password: '',
    confirm: '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const set = (key) => (e) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  };

  async function submit(e) {
    e.preventDefault();
    if (!form.fullName.trim()) return setError('Enter your full name.');
    if (!form.email.trim() && !form.phone.trim()) return setError('Keep at least an e-mail address or a phone number.');
    if (form.password && form.password.length < 6) return setError('The new password needs at least 6 characters.');
    if (form.password !== form.confirm) return setError('The two new passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      // Only what changed is sent (same rules as registration on the server).
      const changes = {};
      const differs = (value, current) => (value || null) !== (current || null);
      if (form.fullName.trim() !== (user?.fullName || '')) changes.fullName = form.fullName.trim();
      if (differs(form.email.trim(), user?.email)) changes.email = form.email.trim() || null;
      if (differs(form.phone.trim(), user?.phone)) changes.phone = form.phone.trim() || null;
      if (differs(form.dateOfBirth, user?.dateOfBirth)) changes.dateOfBirth = form.dateOfBirth || null;
      // ELDERLY is derived by the server from the date of birth; the checkbox only declares a disability.
      if (form.disabled !== (user?.priorityCategory === 'DIFFERENTLY_ABLED')) {
        changes.priorityCategory = form.disabled ? 'DIFFERENTLY_ABLED' : 'NONE';
      }
      if (form.password) changes.password = form.password;
      if (!Object.keys(changes).length) {
        setSaved(true);
        setBusy(false);
        return undefined;
      }
      const res = await papi.updateMe(changes);
      setUser(res.user);
      setForm((f) => ({ ...f, password: '', confirm: '' }));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pt-page">
      <section className="pt-card" aria-label="My profile">
        <h2 className="pt-step-title">My profile</h2>
        <p className="pt-muted pt-small">
          Priority: <strong>{PRIORITY_TEXT[user?.priorityCategory] || 'Normal'}</strong>
        </p>
        <form className="pt-profile" onSubmit={submit} noValidate>
          <label className="pt-label">
            Full name
            <input className="pt-input" autoComplete="name" maxLength={100} value={form.fullName} onChange={set('fullName')} disabled={busy} />
          </label>
          <div className="pt-form-row">
            <label className="pt-label">
              E-mail
              <input className="pt-input" type="email" autoComplete="email" value={form.email} onChange={set('email')} disabled={busy} />
            </label>
            <label className="pt-label">
              Phone
              <input className="pt-input" type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} disabled={busy} />
            </label>
          </div>
          <label className="pt-label">
            Date of birth (patients 60+ get priority automatically)
            <input className="pt-input" type="date" max={new Date().toISOString().slice(0, 10)} value={form.dateOfBirth} onChange={set('dateOfBirth')} disabled={busy} />
          </label>
          <label className="pt-check">
            <input type="checkbox" checked={form.disabled} onChange={set('disabled')} disabled={busy} />
            I am differently-abled (staff confirm priority at the counter)
          </label>
          <fieldset className="pt-fieldset" disabled={busy}>
            <legend className="pt-label">Change password (optional)</legend>
            <div className="pt-form-row">
              <input className="pt-input" type="password" autoComplete="new-password" placeholder="New password" aria-label="New password" value={form.password} onChange={set('password')} />
              <input className="pt-input" type="password" autoComplete="new-password" placeholder="Repeat new password" aria-label="Repeat new password" value={form.confirm} onChange={set('confirm')} />
            </div>
          </fieldset>
          {error && <p className="pt-error" role="alert">{error}</p>}
          {saved && <div className="pt-banner pt-banner--success" role="status">Profile saved.</div>}
          <button type="submit" className="pt-btn pt-btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
        </form>
      </section>
    </div>
  );
}
