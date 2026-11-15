// Patient booking (FR-02, FR-03, FR-06, FR-08, FR-09): area → department → branch → doctor/room,
// the AI estimated wait for that doctor, and — when that queue is busy — the haversine +
// load-balancing recommendation from GET /recommendations with a one-click switch. "Get token"
// issues a real OPD token (POST /tokens), which appears at once in the doctor's "My queue".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePatient } from './PatientContext.jsx';
import { errorText, papi } from './patientApi.js';
import { AREAS, CONGESTION_RULE, estimateSource, haversineKm, isCongested, pickRecommendation } from './geo.js';
import { unavailableText } from './explain.js';

const REFRESH_MS = 10000;

function waitLabel(min) {
  if (min === null || min === undefined || !Number.isFinite(Number(min))) return '—';
  return Number(min) < 1 ? 'under 1 min' : `${Math.round(min)} min`;
}

function rateLabel(avgConsult) {
  const avg = Number(avgConsult);
  if (!Number.isFinite(avg) || avg <= 0) return '—';
  return `${(60 / avg).toFixed(1)} patients/hour`;
}

function StepHeader({ n, title, hint }) {
  return (
    <div className="pt-step-head">
      <span className="pt-step-num" aria-hidden="true">{n}</span>
      <div>
        <h2 className="pt-step-title">{title}</h2>
        {hint && <p className="pt-muted">{hint}</p>}
      </div>
    </div>
  );
}

export default function BookingPage() {
  const navigate = useNavigate();
  const { selection, setSelection, refreshTick } = usePatient();
  const [specialties, setSpecialties] = useState([]);
  const [branches, setBranches] = useState([]);
  const [byBranch, setByBranch] = useState({}); // branchId -> { department, doctors }
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [active, setActive] = useState([]);
  const [rec, setRec] = useState({ state: 'idle', best: null, otherBranch: null });
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState(null);
  const [geoNote, setGeoNote] = useState(null);
  const [customArea, setCustomArea] = useState(null);

  const area = selection.areaId === 'my-location' ? customArea : AREAS.find((a) => a.id === selection.areaId) || AREAS[0];
  const update = useCallback((patch) => setSelection((s) => ({ ...s, ...patch })), [setSelection]);

  // Static lists + the patient's active tokens.
  useEffect(() => {
    let alive = true;
    Promise.all([papi.specialties(), papi.branches(), papi.activeTokens()])
      .then(([sp, br, act]) => {
        if (!alive) return;
        setSpecialties(sp);
        setBranches(br);
        setActive(act.filter((t) => t.queueType === 'OPD'));
        if (!selection.specialty && sp.length) {
          update({ specialty: sp.includes('General Medicine') ? 'General Medicine' : sp[0] });
        }
      })
      .catch((err) => alive && setLoadError(errorText(err)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live doctors of the chosen specialty in every branch (refreshed every 10 s and after demo load).
  const loadDoctors = useCallback(async () => {
    if (!selection.specialty || !branches.length) return;
    const entries = await Promise.all(
      branches.map(async (b) => {
        const deps = await papi.departments(b.id);
        const dept = deps.find((d) => d.specialty === selection.specialty);
        if (!dept) return [b.id, null];
        const doctors = await papi.doctors(dept.id);
        return [b.id, { department: dept, doctors }];
      }),
    );
    setByBranch(Object.fromEntries(entries.filter(([, v]) => v)));
  }, [branches, selection.specialty]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadDoctors()
      .then(() => alive && setLoadError(null))
      .catch((err) => alive && setLoadError(errorText(err)))
      .finally(() => alive && setLoading(false));
    const timer = setInterval(() => loadDoctors().catch(() => {}), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [loadDoctors, refreshTick]);

  // Branch cards: distance from the chosen area + live load of that department.
  const branchCards = useMemo(
    () =>
      branches
        .filter((b) => byBranch[b.id])
        .map((b) => {
          const { doctors } = byBranch[b.id];
          const accepting = doctors.filter((d) => d.acceptingNow);
          const best = [...accepting].sort((x, y) => (x.estimatedWaitMinutes ?? 1e9) - (y.estimatedWaitMinutes ?? 1e9))[0] || null;
          return {
            branch: b,
            distanceKm: haversineKm(area, { lat: b.latitude, lng: b.longitude }),
            waiting: doctors.reduce((sum, d) => sum + (d.queueLength || 0), 0),
            accepting: accepting.length,
            best,
            loadPercent: byBranch[b.id].department?.loadPercent ?? null,
            busy: best ? isCongested(best, byBranch[b.id].department) : false,
          };
        })
        .sort((x, y) => (x.distanceKm ?? 1e9) - (y.distanceKm ?? 1e9)),
    [branches, byBranch, area],
  );

  // Default branch = nearest offering the specialty; default doctor = shortest wait there.
  useEffect(() => {
    if (!branchCards.length) return;
    const branchOk = branchCards.some((c) => c.branch.id === selection.branchId);
    const branchId = branchOk ? selection.branchId : branchCards[0].branch.id;
    const doctors = byBranch[branchId]?.doctors || [];
    const doctorOk = doctors.some((d) => d.id === selection.doctorId);
    const doctorId = doctorOk
      ? selection.doctorId
      : ([...doctors].filter((d) => d.acceptingNow).sort((x, y) => (x.estimatedWaitMinutes ?? 1e9) - (y.estimatedWaitMinutes ?? 1e9))[0] || doctors[0])?.id ?? null;
    if (branchId !== selection.branchId || doctorId !== selection.doctorId) update({ branchId, doctorId });
  }, [branchCards, byBranch, selection.branchId, selection.doctorId, update]);

  const doctors = byBranch[selection.branchId]?.doctors || [];
  const doctor = doctors.find((d) => d.id === selection.doctorId) || null;
  const branch = branches.find((b) => b.id === selection.branchId) || null;
  const department = byBranch[selection.branchId]?.department || null;
  const congested = isCongested(doctor, department);
  const source = estimateSource(doctor?.estimateModelVersion);
  const activeHere = doctor ? active.find((t) => t.doctor?.id === doctor.id) : null;

  // Smart branch recommendation when the chosen queue is busy (haversine + load balancing).
  useEffect(() => {
    if (!doctor || !congested || !selection.specialty) {
      setRec({ state: 'idle', best: null, otherBranch: null });
      return undefined;
    }
    let alive = true;
    setRec((r) => ({ ...r, state: 'loading' }));
    papi
      .recommendations({ specialty: selection.specialty, lat: area?.lat, lng: area?.lng, excludeDoctorId: doctor.id })
      .then((res) => alive && setRec({ state: 'ready', ...pickRecommendation(res.items, doctor) }))
      .catch(() => alive && setRec({ state: 'error', best: null, otherBranch: null }));
    return () => {
      alive = false;
    };
    // Re-run when the estimate or queue length of the chosen doctor changes.
  }, [doctor?.id, doctor?.estimatedWaitMinutes, doctor?.queueLength, congested, selection.specialty, area?.lat, area?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  function useMyLocation() {
    if (!navigator.geolocation) {
      setGeoNote('This browser cannot share a location. Choose an area instead.');
      return;
    }
    setGeoNote('Asking the browser for your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustomArea({ id: 'my-location', name: 'My location', lat: pos.coords.latitude, lng: pos.coords.longitude });
        update({ areaId: 'my-location' });
        setGeoNote('Using your current location for this page only — it is never stored.');
      },
      () => setGeoNote('Location was not shared. Choose an area instead.'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }

  // One click from the recommendation: move the booking there and issue the token at once.
  async function switchAndBook(option) {
    update({ branchId: option.branchId, doctorId: option.doctorId });
    setBooking(true);
    setBookError(null);
    try {
      const token = await papi.joinQueue(option.doctorId);
      navigate(`/token/${token.id}`);
    } catch (err) {
      setBookError(errorText(err));
      setBooking(false);
    }
  }

  async function getToken() {
    if (!doctor) return;
    setBooking(true);
    setBookError(null);
    try {
      const token = await papi.joinQueue(doctor.id);
      navigate(`/token/${token.id}`);
    } catch (err) {
      setBookError(errorText(err));
      setBooking(false);
    }
  }

  return (
    <div className="pt-booking">
      {active.length > 0 && (
        <div className="pt-banner pt-banner--info" role="status">
          <span>
            You have {active.length === 1 ? 'an active token' : `${active.length} active tokens`}:{' '}
            {active.map((t) => (
              <Link key={t.id} className="pt-link" to={`/token/${t.id}`}>
                {t.displayNumber} · {t.branch?.name}
              </Link>
            )).reduce((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}
          </span>
        </div>
      )}
      {loadError && (
        <div className="pt-banner pt-banner--error" role="alert">
          {loadError}
          <button type="button" className="pt-btn pt-btn--ghost" onClick={() => loadDoctors().then(() => setLoadError(null)).catch((e) => setLoadError(errorText(e)))}>
            Retry
          </button>
        </div>
      )}

      <div className="pt-grid">
        <div className="pt-steps">
          <section className="pt-card">
            <StepHeader n={1} title="Your location" hint="Used only to measure distance (haversine) to each branch." />
            <div className="pt-chips" role="radiogroup" aria-label="Simulated area">
              {AREAS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={selection.areaId === a.id}
                  className={`pt-chip${selection.areaId === a.id ? ' is-on' : ''}`}
                  onClick={() => update({ areaId: a.id })}
                >
                  {a.name}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={selection.areaId === 'my-location'}
                className={`pt-chip${selection.areaId === 'my-location' ? ' is-on' : ''}`}
                onClick={useMyLocation}
              >
                📍 My location
              </button>
            </div>
            {geoNote && <p className="pt-muted pt-small" aria-live="polite">{geoNote}</p>}
          </section>

          <section className="pt-card">
            <StepHeader n={2} title="Department" />
            <div className="pt-chips" role="radiogroup" aria-label="Department">
              {specialties.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={selection.specialty === s}
                  className={`pt-chip${selection.specialty === s ? ' is-on' : ''}`}
                  onClick={() => update({ specialty: s, branchId: null, doctorId: null })}
                >
                  {s}
                </button>
              ))}
              {!specialties.length && <span className="pt-skeleton pt-skeleton--chips" aria-hidden="true" />}
            </div>
          </section>

          <section className="pt-card">
            <StepHeader n={3} title="Branch" hint={area ? `Distances from ${area.name}` : undefined} />
            {loading && !branchCards.length ? (
              <div className="pt-skeleton pt-skeleton--cards" aria-label="Loading branches" />
            ) : branchCards.length === 0 ? (
              <p className="pt-muted">No branch offers {selection.specialty} today.</p>
            ) : (
              <div className="pt-branch-grid" role="radiogroup" aria-label="Branch">
                {branchCards.map((c) => (
                  <button
                    key={c.branch.id}
                    type="button"
                    role="radio"
                    aria-checked={selection.branchId === c.branch.id}
                    className={`pt-branch${selection.branchId === c.branch.id ? ' is-on' : ''}`}
                    onClick={() => update({ branchId: c.branch.id, doctorId: null })}
                  >
                    <span className="pt-branch-name">{c.branch.name}</span>
                    <span className={`pt-badge ${c.busy ? 'pt-badge--amber' : 'pt-badge--green'}`}>
                      {c.busy ? 'Busy' : 'Normal'} · ~{waitLabel(c.best?.estimatedWaitMinutes)}
                    </span>
                    <span className="pt-muted pt-small">
                      {c.distanceKm != null ? `${c.distanceKm} km away · ` : ''}
                      {c.waiting} waiting · {c.accepting} doctor{c.accepting === 1 ? '' : 's'} on duty
                      {c.loadPercent != null ? ` · ${c.loadPercent}% load` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="pt-card">
            <StepHeader n={4} title="Doctor / OPD room" />
            {doctors.length === 0 ? (
              <p className="pt-muted">Choose a branch to see its doctors.</p>
            ) : (
              <div className="pt-doctor-list" role="radiogroup" aria-label="Doctor">
                {doctors.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={selection.doctorId === d.id}
                    disabled={!d.acceptingNow}
                    className={`pt-doctor${selection.doctorId === d.id ? ' is-on' : ''}`}
                    onClick={() => update({ doctorId: d.id })}
                  >
                    <span className="pt-doctor-main">
                      <strong>{branch?.name} — {d.servicePointName || 'OPD'} — {d.fullName}</strong>
                      <span className="pt-muted pt-small">
                        {d.acceptingNow
                          ? `${d.queueLength} waiting · avg ${d.avgConsultMinutes} min per patient`
                          : unavailableText(d)}
                      </span>
                    </span>
                    {d.acceptingNow && <span className="pt-doctor-wait">~{waitLabel(d.estimatedWaitMinutes)}</span>}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="pt-side" aria-label="Your estimate">
          <section className={`pt-card pt-estimate${congested ? ' is-busy' : ''}`} aria-live="polite">
            <div className="pt-estimate-head">
              <span className="pt-eyebrow">AI estimated wait time</span>
              <span className={`pt-badge ${source.ai ? 'pt-badge--green' : 'pt-badge--slate'}`}>{source.label}</span>
            </div>
            {doctor ? (
              <>
                <p className="pt-estimate-value">
                  {doctor.estimatedWaitMinutes ?? '—'}
                  <span> min</span>
                </p>
                <p className="pt-muted">
                  {doctor.fullName} · {doctor.servicePointName} · {branch?.name}
                </p>
                <dl className="pt-stats">
                  <div>
                    <dt>Department load</dt>
                    <dd>{department?.loadPercent != null ? `${department.loadPercent}%` : '—'}</dd>
                  </div>
                  <div>
                    <dt>Patients waiting</dt>
                    <dd>{doctor.queueLength}</dd>
                  </div>
                  <div>
                    <dt>Consultation rate</dt>
                    <dd>{rateLabel(doctor.avgConsultMinutes)}</dd>
                  </div>
                  <div>
                    <dt>Avg consultation</dt>
                    <dd>{Number(doctor.avgConsultMinutes).toFixed(1)} min</dd>
                  </div>
                  <div>
                    <dt>Session</dt>
                    <dd>{doctor.session ? `${doctor.session.startTime}–${doctor.session.endTime}` : '—'}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="pt-muted">Pick a doctor to see the predicted wait.</p>
            )}
          </section>

          {congested && rec.state === 'ready' && rec.best && (
            <section className="pt-card pt-rec" aria-live="polite">
              <span className="pt-eyebrow pt-eyebrow--amber">
                {rec.best.sameBranch ? 'Busy here — a faster doctor is free in this branch' : 'Busy here — faster branch nearby'}
              </span>
              <h3 className="pt-rec-title">{rec.best.branchName}</h3>
              <p className="pt-muted">{rec.best.doctorName}</p>
              <div className="pt-rec-pills">
                <span className="pt-pill pt-pill--green">Save {rec.best.minutesSaved} min</span>
                {rec.best.distanceKm != null && <span className="pt-pill">{rec.best.distanceKm} km away (haversine)</span>}
                <span className="pt-pill">~{waitLabel(rec.best.predictedWaitMinutes)} wait</span>
              </div>
              <p className="pt-small pt-muted">{rec.best.reason}</p>
              <button
                type="button"
                className="pt-btn pt-btn--primary pt-btn--block"
                disabled={booking}
                onClick={() => switchAndBook(rec.best)}
              >
                {booking ? 'Booking…' : 'Switch & book here'}
              </button>
              <button
                type="button"
                className="pt-btn pt-btn--ghost pt-btn--sm"
                onClick={() => update({ branchId: rec.best.branchId, doctorId: rec.best.doctorId })}
              >
                {rec.best.sameBranch ? 'Only switch doctor' : 'Only switch branch'}
              </button>
              {rec.otherBranch && (
                <div className="pt-rec-alt">
                  <span className="pt-small">
                    Nearest less-crowded branch: <strong>{rec.otherBranch.branchName}</strong> · {rec.otherBranch.doctorName}
                    {rec.otherBranch.distanceKm != null ? ` · ${rec.otherBranch.distanceKm} km` : ''} · ~
                    {waitLabel(rec.otherBranch.predictedWaitMinutes)} · save {rec.otherBranch.minutesSaved} min
                  </span>
                  <button
                    type="button"
                    className="pt-btn pt-btn--ghost pt-btn--sm"
                    onClick={() => update({ branchId: rec.otherBranch.branchId, doctorId: rec.otherBranch.doctorId })}
                  >
                    Switch to recommended branch
                  </button>
                </div>
              )}
            </section>
          )}
          {congested && rec.state === 'ready' && !rec.best && (
            <section className="pt-card pt-rec pt-rec--none" role="status">
              <span className="pt-eyebrow pt-eyebrow--amber">Busy here</span>
              <p className="pt-muted">
                This queue is above {CONGESTION_RULE.waitMinutes} min, {CONGESTION_RULE.waiting} waiting or {CONGESTION_RULE.loadPercent}% load,
                but no other branch is at least 5 minutes faster right now.
              </p>
            </section>
          )}
          {congested && rec.state === 'loading' && <div className="pt-card pt-skeleton pt-skeleton--rec" aria-label="Checking other branches" />}

          {activeHere ? (
            <Link className="pt-btn pt-btn--primary pt-btn--block pt-btn--lg" to={`/token/${activeHere.id}`}>
              View my token {activeHere.displayNumber}
            </Link>
          ) : (
            <button
              type="button"
              className="pt-btn pt-btn--primary pt-btn--block pt-btn--lg"
              disabled={!doctor || !doctor.acceptingNow || booking}
              onClick={getToken}
            >
              {booking ? 'Issuing your token…' : 'Get token'}
            </button>
          )}
          {bookError && <p className="pt-error" role="alert">{bookError}</p>}
        </aside>
      </div>
    </div>
  );
}
