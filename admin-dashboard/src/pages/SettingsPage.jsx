// System settings (Section 3.2: hospital admin only may change them; branch admins can view).
// recommendationWeights -> FR-08 / Eq. 6.3, congestionThresholds -> FR-17 / Eq. 6.5,
// alternativeSuggestionWaitMinutes -> FR-09, notifyPositionsAhead -> FR-11, slotMinutes -> FR-10.
import { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Banner, Card, ErrorBanner, Loading, PageHeader, Spinner } from '../components/ui.jsx';
import { api, errorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { normaliseSettings, validateSettings, WEIGHT_KEYS } from '../utils/settings.js';

const WEIGHT_INFO = {
  wait: { label: 'Predicted waiting time', help: 'w₁ — shorter predicted wait ranks higher.' },
  distance: { label: 'Distance', help: 'w₂ — closer branches rank higher (only when the patient shares location).' },
  congestion: { label: 'Congestion', help: 'w₃ — less congested departments rank higher.' },
};

function toFormValues(s) {
  const w = s?.recommendationWeights || {};
  const t = s?.congestionThresholds || {};
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  return {
    recommendationWeights: { wait: str(w.wait), distance: str(w.distance), congestion: str(w.congestion) },
    congestionThresholds: { high: str(t.high), critical: str(t.critical) },
    alternativeSuggestionWaitMinutes: str(s?.alternativeSuggestionWaitMinutes),
    notifyPositionsAhead: str(s?.notifyPositionsAhead),
    slotMinutes: str(s?.slotMinutes),
  };
}

function NumberField({ label, help, value, onChange, error, step = 'any', min, max, suffix, disabled }) {
  const id = `set-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="input-suffix">
        <input id={id} type="number" value={value} step={step} min={min} max={max} disabled={disabled}
          aria-invalid={error ? 'true' : undefined} onChange={(e) => onChange(e.target.value)} />
        {suffix && <span>{suffix}</span>}
      </div>
      {error ? <span className="field-error">{error}</span> : help && <span className="field-help">{help}</span>}
    </div>
  );
}

export default function SettingsPage() {
  const { permissions } = useAuth();
  const toast = useToast();
  const res = useResource('/admin/settings');
  const [values, setValues] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const canEdit = permissions.manageSettings;

  useEffect(() => {
    if (res.data) setValues(toFormValues(res.data));
  }, [res.data]);

  const original = useMemo(() => (res.data ? JSON.stringify(toFormValues(res.data)) : ''), [res.data]);
  const dirty = values && JSON.stringify(values) !== original;

  const weightSum = values
    ? WEIGHT_KEYS.reduce((s, k) => s + (Number(values.recommendationWeights[k]) || 0), 0)
    : 0;
  const sumOk = Math.abs(weightSum - 1) <= 0.001;

  const set = (path, v) => {
    setValues((prev) => {
      const next = structuredClone(prev);
      const keys = path.split('.');
      let obj = next;
      keys.slice(0, -1).forEach((k) => { obj = obj[k]; });
      obj[keys[keys.length - 1]] = v;
      return next;
    });
    setErrors((e) => {
      const n = { ...e };
      delete n[path];
      delete n[path.split('.')[0]];
      return n;
    });
  };

  /** Rescales the three weights so that they sum to exactly 1 (rounded to 2 decimals). */
  const normaliseWeights = () => {
    const raw = WEIGHT_KEYS.map((k) => Math.max(0, Number(values.recommendationWeights[k]) || 0));
    const total = raw.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    const scaled = raw.map((v) => Math.round((v / total) * 100) / 100);
    const drift = Math.round((1 - scaled.reduce((a, b) => a + b, 0)) * 100) / 100;
    scaled[0] = Math.round((scaled[0] + drift) * 100) / 100; // keep the exact sum on the wait weight
    setValues((prev) => ({
      ...prev,
      recommendationWeights: Object.fromEntries(WEIGHT_KEYS.map((k, i) => [k, String(scaled[i])])),
    }));
    setErrors((e) => { const n = { ...e }; delete n.recommendationWeights; return n; });
  };

  const save = async (e) => {
    e.preventDefault();
    const errs = validateSettings(values);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setSaveError('Please correct the highlighted settings.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.put('/admin/settings', normaliseSettings(values));
      if (saved && typeof saved === 'object' && saved.recommendationWeights) res.setData(saved);
      else await res.reload({ silent: true });
      toast.success('Settings saved');
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle="Parameters of the recommendation engine, congestion alerts, notifications and appointments."
      />
      {!canEdit && <Banner kind="info">System settings are managed by the Hospital Administrator. You have read-only access.</Banner>}
      <ErrorBanner error={res.error} onRetry={() => res.reload()} />

      {res.loading && !values ? <Loading /> : values && (
        <form onSubmit={save} noValidate>
          <fieldset className="settings-fieldset" disabled={!canEdit || saving}>
            <Card
              title="Branch recommendation weights"
              subtitle="score = w₁·wait + w₂·distance + w₃·congestion on min-max normalised values; lower score ranks first (FR-08, Eq. 6.3)."
            >
              <div className="form-grid form-grid-3">
                {WEIGHT_KEYS.map((k) => (
                  <NumberField
                    key={k}
                    label={WEIGHT_INFO[k].label}
                    help={WEIGHT_INFO[k].help}
                    value={values.recommendationWeights[k]}
                    step="0.05"
                    min={0}
                    max={1}
                    error={errors[`recommendationWeights.${k}`]}
                    onChange={(v) => set(`recommendationWeights.${k}`, v)}
                  />
                ))}
              </div>
              <div className={`weight-sum ${sumOk ? 'ok' : 'bad'}`}>
                <div className="weight-bar" aria-hidden="true">
                  {WEIGHT_KEYS.map((k, i) => (
                    <span key={k} className={`weight-seg seg-${i}`} style={{ flexGrow: Math.max(0, Number(values.recommendationWeights[k]) || 0) }} />
                  ))}
                </div>
                <span>
                  <Icon name={sumOk ? 'check' : 'alert'} size={14} /> Sum: <strong>{weightSum.toFixed(2)}</strong>
                  {sumOk ? ' — valid' : ' — must equal 1.00'}
                </span>
                {!sumOk && canEdit && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={normaliseWeights}>Normalise to 1</button>
                )}
              </div>
              {errors.recommendationWeights && <span className="field-error">{errors.recommendationWeights}</span>}
              <p className="muted small">Without patient location, the distance weight is redistributed proportionally to the other two.</p>
            </Card>

            <Card
              title="Congestion thresholds"
              subtitle="Load ratio ρ = arrivals ÷ capacity. NORMAL below HIGH; HIGH from θ₁; CRITICAL from θ₂ (FR-17, Eq. 6.5)."
            >
              <div className="form-grid">
                <NumberField label="HIGH threshold (θ₁)" value={values.congestionThresholds.high} step="0.05" min={0}
                  help="e.g. 0.85 = 85% of capacity" error={errors['congestionThresholds.high']}
                  onChange={(v) => set('congestionThresholds.high', v)} />
                <NumberField label="CRITICAL threshold (θ₂)" value={values.congestionThresholds.critical} step="0.05" min={0}
                  help="e.g. 1.0 = demand equals capacity" error={errors['congestionThresholds.critical']}
                  onChange={(v) => set('congestionThresholds.critical', v)} />
              </div>
              {errors.congestionThresholds && <span className="field-error">{errors.congestionThresholds}</span>}
            </Card>

            <Card title="Patient experience" subtitle="Alternative suggestions, early notifications and appointment slots.">
              <div className="form-grid form-grid-3">
                <NumberField label="Suggest alternatives from" suffix="min" step="1" min={1}
                  value={values.alternativeSuggestionWaitMinutes} error={errors.alternativeSuggestionWaitMinutes}
                  help="Patients see other branches when the estimate reaches this wait (FR-09)."
                  onChange={(v) => set('alternativeSuggestionWaitMinutes', v)} />
                <NumberField label="Notify positions ahead" suffix="tokens" step="1" min={0}
                  value={values.notifyPositionsAhead} error={errors.notifyPositionsAhead}
                  help="Patients are alerted when this many tokens are ahead of them (FR-11)."
                  onChange={(v) => set('notifyPositionsAhead', v)} />
                <NumberField label="Appointment slot length" suffix="min" step="1" min={5}
                  value={values.slotMinutes} error={errors.slotMinutes}
                  help="Length of bookable appointment slots (FR-10)."
                  onChange={(v) => set('slotMinutes', v)} />
              </div>
            </Card>
          </fieldset>

          {saveError && <Banner kind="error">{saveError}</Banner>}
          {canEdit && (
            <div className="form-actions sticky-actions">
              <span className="muted small">{dirty ? 'You have unsaved changes.' : 'No changes.'}</span>
              <button type="button" className="btn btn-secondary" disabled={!dirty || saving}
                onClick={() => { setValues(toFormValues(res.data)); setErrors({}); setSaveError(null); }}>
                Reset
              </button>
              <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
                {saving && <Spinner size="xs" />} Save settings
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
