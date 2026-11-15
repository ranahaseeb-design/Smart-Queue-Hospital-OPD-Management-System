// Workload & Recommendations (FR-18, Section 6.6.3): branch workload indicators and
// resource-allocation recommendations for forecast peaks. These are decision support only;
// the system never changes schedules automatically.
// Upgrade 2026: each recommendation card has a "+1 extra doctor session" what-if — a client-side
// ESTIMATE (Decision 6) that adds 60 / avgConsultMinutes capacity per hour across the
// recommendation's time range, re-animates its forecast mini-chart and estimates the wait
// reduction with a simple hourly backlog model (utils/whatIf.js). Nothing is saved.
// `?departmentId=` (from the Overview alert strip) scrolls to and highlights that department.
import { useEffect, useId, useMemo, useState } from 'react';
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Link, useSearchParams } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import {
  Badge, Banner, Card, EmptyState, ErrorBanner, LastUpdated, PageHeader, PageSkeleton, Skeleton,
} from '../components/ui.jsx';
import { api } from '../api/client.js';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useCountUp, usePrefersReducedMotion } from '../hooks/useMotion.js';
import { fmtMinutes, fmtNum, fmtPercent, formatDate } from '../utils/format.js';
import { resolveAvgConsult, simulateExtraSession, WHAT_IF_REASONS } from '../utils/whatIf.js';
import { useChartTheme } from '../hooks/useChartTheme.js';

function utilTone(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return 'neutral';
  if (n >= 1) return 'danger';
  if (n >= 0.85) return 'warning';
  return 'success';
}

const safeId = (v) => String(v ?? '').replace(/[^\w-]/g, '');

/** Loads GET /admin/forecasts for each distinct recommendation date (in parallel). */
function useForecastsForDates(dates, scopeQuery) {
  const [state, setState] = useState({ byDate: {}, loading: dates.length > 0, error: null });
  const key = JSON.stringify([dates, scopeQuery]);
  useEffect(() => {
    const [ds, scope] = JSON.parse(key);
    if (!ds.length) {
      setState({ byDate: {}, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.allSettled(ds.map((d) => api.get('/admin/forecasts', { ...scope, date: d }))).then((results) => {
      if (cancelled) return;
      const byDate = {};
      let error = null;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') byDate[ds[i]] = Array.isArray(r.value) ? r.value : [];
        else error = r.reason;
      });
      setState({ byDate, loading: false, error });
    });
    return () => { cancelled = true; };
  }, [key]);
  return state;
}

/** Mini forecast chart for one recommendation: arrivals, current and simulated capacity. */
function WhatIfChart({ sim, on }) {
  const chart = useChartTheme();
  const reduced = usePrefersReducedMotion();
  const gradId = useId().replace(/:/g, '');
  const first = sim.points.findIndex((p) => p.inRange);
  const lastInRange = sim.points.map((p) => p.inRange).lastIndexOf(true);
  const windowEnd = Math.max(lastInRange, sim.points.findIndex((p) => p.hour === sim.window.to));
  const data = sim.points.slice(Math.max(0, first - 2), Math.min(sim.points.length, windowEnd + 2));
  const rangeFrom = sim.points[first]?.hour;
  const rangeTo = sim.points[lastInRange]?.hour;
  return (
    <div className="whatif-chart" role="img"
      aria-label={`Forecast arrivals and capacity from ${data[0]?.hour} to ${data[data.length - 1]?.hour}${on ? ', with one extra doctor session' : ''}.`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={`wi-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chart.series2} stopOpacity={0.3} />
              <stop offset="100%" stopColor={chart.series2} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={chart.grid} />
          {rangeFrom && <ReferenceArea x1={rangeFrom} x2={rangeTo} fill={chart.peak} fillOpacity={1} ifOverflow="extendDomain" />}
          <XAxis dataKey="hour" tick={chart.tick} stroke={chart.grid} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={chart.tick} stroke={chart.grid} tickLine={false} axisLine={false} allowDecimals={false} width={44} />
          <Tooltip
            cursor={{ stroke: chart.axis, strokeDasharray: '3 3' }}
            content={(
              <ChartTooltip
                valueFormatter={(v) => fmtNum(v, 1)}
                extra={(row) => (row ? (
                  <div className="chart-tooltip-row">
                    <span>Backlog (est.)</span>
                    <strong>{fmtNum(row.backlogBefore, 1)}{on ? ` → ${fmtNum(row.backlogAfter, 1)}` : ''}</strong>
                  </div>
                ) : null)}
              />
            )}
          />
          <Area dataKey="expectedArrivals" name="Forecast arrivals" type="monotone" stroke={chart.series2} strokeWidth={2}
            fill={`url(#wi-${gradId})`} isAnimationActive={!reduced} dot={false} />
          <Line dataKey="capacity" name="Scheduled capacity" type="step" stroke={chart.reference} strokeWidth={2}
            strokeDasharray="6 4" dot={false} isAnimationActive={!reduced} />
          {on && (
            <Line key="sim" dataKey="simulatedCapacity" name="With +1 session" type="step" stroke={chart.series1} strokeWidth={2.5}
              dot={false} isAnimationActive={!reduced} animationDuration={600} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecommendationCard({ rec, forecastRows, forecastLoading, avgConsult, highlighted }) {
  const [on, setOn] = useState(false);
  const sim = useMemo(() => simulateExtraSession(
    (forecastRows || []).filter((r) => String(r.departmentId) === String(rec.departmentId)),
    { avgConsultMinutes: avgConsult.value, timeRange: rec.timeRange },
  ), [forecastRows, rec.departmentId, rec.timeRange, avgConsult.value]);
  const reduction = useCountUp(on && sim.available ? sim.waitReduction : 0, { duration: 600 });
  const sessions = Number(rec.shortfallSessions);
  const titleId = `rec-${safeId(rec.departmentId)}-${safeId(rec.date)}-${safeId(rec.timeRange)}`;
  const reason = forecastLoading ? null : !sim.available ? WHAT_IF_REASONS[sim.reason] : null;

  return (
    <article
      className={`rec-card ${highlighted ? 'rec-highlight' : ''} ${on ? 'is-sim' : ''}`}
      data-department-id={rec.departmentId}
      tabIndex={-1}
      aria-labelledby={titleId}
    >
      <header className="rec-card-head">
        <Icon name="lightbulb" size={18} />
        <div>
          <strong id={titleId}>{rec.departmentName}</strong>
          <span className="muted small"> · {rec.branchName}</span>
        </div>
        {Number.isFinite(sessions) && sessions > 0 && (
          <Badge tone={sessions >= 2 ? 'danger' : 'warning'}>
            +{fmtNum(sessions, sessions % 1 ? 1 : 0)} session{sessions === 1 ? '' : 's'}
          </Badge>
        )}
      </header>
      <p className="rec-when">
        <Icon name="schedules" size={14} /> {formatDate(rec.date)}{rec.timeRange ? `, ${rec.timeRange}` : ''}
      </p>
      <p className="rec-msg">{rec.message}</p>

      <section className="whatif" aria-label={`What-if for ${rec.departmentName}`}>
        <div className="whatif-head">
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className="switch"
            onClick={() => setOn((v) => !v)}
            disabled={forecastLoading || !sim.available}
          >
            <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
            <span className="switch-label">+1 extra doctor session</span>
          </button>
          <Badge tone="info" title="Client-side what-if, not saved">Estimate</Badge>
        </div>

        {forecastLoading ? (
          <div className="whatif-loading" aria-hidden="true"><Skeleton h="chart" className="whatif-skeleton" /></div>
        ) : reason ? (
          <p className="whatif-note"><Icon name="info" size={14} /> {reason}</p>
        ) : (
          <>
            <WhatIfChart sim={sim} on={on} />
            <dl className="whatif-stats" aria-live="polite">
              <div>
                <dt>Est. avg wait</dt>
                <dd>
                  {fmtMinutes(sim.avgWaitBefore)}
                  {on && <span className="whatif-after"> → {fmtMinutes(sim.avgWaitAfter)}</span>}
                </dd>
              </div>
              <div className={`whatif-gain ${on ? 'on' : ''}`}>
                <dt>Wait reduction</dt>
                <dd>{on ? `−${fmtNum(reduction, 0)} min` : '—'}</dd>
              </div>
              <div>
                <dt>Peak backlog</dt>
                <dd>
                  {fmtNum(sim.peakBacklogBefore, 1)}
                  {on && <span className="whatif-after"> → {fmtNum(sim.peakBacklogAfter, 1)}</span>}
                  <span className="whatif-unit"> patients</span>
                </dd>
              </div>
            </dl>
            <p className="whatif-foot">
              {on ? 'Adds' : 'Would add'} {fmtNum(sim.extraPerHour, 1)} patients/h (60 ÷ {fmtNum(avgConsult.value, 1)} min average consultation
              {avgConsult.source === 'doctors' ? ', from the doctors’ profiles' : ''}) during {rec.timeRange}; estimated over {sim.window.from}–{sim.window.to}.
              Simple hourly backlog model on the forecast — an estimate, not saved; schedules are not changed.
            </p>
          </>
        )}
      </section>

      <footer className="rec-foot">
        <Link to="/schedules" className="btn btn-sm btn-ghost"><Icon name="schedules" size={14} /> Review schedules</Link>
        <Link to={`/forecasts?departmentId=${encodeURIComponent(rec.departmentId)}&date=${encodeURIComponent(rec.date || '')}`} className="btn btn-sm btn-ghost">
          <Icon name="forecast" size={14} /> View forecast
        </Link>
      </footer>
    </article>
  );
}

export default function WorkloadPage() {
  const { scopeQuery, branchName } = useScope();
  const res = useResource('/admin/recommendations', scopeQuery);
  const doctors = useResource('/admin/doctors', scopeQuery);
  const chart = useChartTheme();
  const reduced = usePrefersReducedMotion();
  const [params, setParams] = useSearchParams();
  const focusDept = params.get('departmentId');

  const workload = Array.isArray(res.data?.workload) ? res.data.workload : [];
  const recommendations = useMemo(
    () => (Array.isArray(res.data?.recommendations) ? res.data.recommendations : []),
    [res.data],
  );
  const dates = useMemo(() => [...new Set(recommendations.map((r) => r.date).filter(Boolean))].sort(), [recommendations]);
  const forecasts = useForecastsForDates(dates, scopeQuery);
  const doctorList = Array.isArray(doctors.data) ? doctors.data : [];

  const focusMatches = focusDept ? recommendations.filter((r) => String(r.departmentId) === String(focusDept)) : [];
  const focusName = focusDept && (
    focusMatches[0]?.departmentName
    || doctorList.find((d) => String(d.departmentId) === String(focusDept))?.departmentName
    || Object.values(forecasts.byDate).flat().find((r) => String(r.departmentId) === String(focusDept))?.departmentName
    || `department #${focusDept}`
  );

  // Deep link from the Overview alert strip: scroll to and focus the first matching card.
  useEffect(() => {
    if (!focusDept || res.loading || !recommendations.length) return;
    const el = document.querySelector(`[data-department-id="${safeId(focusDept)}"]`);
    if (!el) return;
    el.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    el.focus?.({ preventScroll: true });
  }, [focusDept, res.loading, recommendations.length, reduced]);

  const clearFocus = () => {
    const next = new URLSearchParams(params);
    next.delete('departmentId');
    setParams(next, { replace: true });
  };

  // Branches without a utilisation figure (no scheduled capacity in the period, e.g. a new or
  // inactive branch) stay in the table as "—" but are not drawn as a misleading 0% bar.
  const chartData = workload
    .filter((w) => w.utilization !== null && w.utilization !== undefined && Number.isFinite(Number(w.utilization)))
    .map((w) => ({
      name: w.branchName,
      utilization: Math.round(Number(w.utilization) * 1000) / 10,
    }));
  const axisMax = Math.max(120, Math.ceil(Math.max(0, ...chartData.map((d) => d.utilization)) / 20) * 20);
  const axisTicks = Array.from({ length: axisMax / 20 + 1 }, (_, i) => i * 20);

  const columns = [
    { key: 'branchName', label: 'Branch', render: (r) => <strong>{r.branchName}</strong> },
    {
      key: 'patientsPerDoctorHour', label: 'Patients / doctor-hour', align: 'right',
      render: (r) => fmtNum(r.patientsPerDoctorHour, 1),
    },
    {
      key: 'utilization', label: 'Utilisation', align: 'right',
      render: (r) => <Badge tone={utilTone(r.utilization)}>{fmtPercent(r.utilization)}</Badge>,
    },
    { key: 'avgWaitMinutes', label: 'Avg wait', align: 'right', render: (r) => fmtMinutes(r.avgWaitMinutes) },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Workload & Recommendations"
        subtitle={`Branch workload indicators and resource-allocation suggestions for forecast peaks — ${branchName}.`}
        actions={(
          <>
            <LastUpdated at={res.updatedAt} refreshing={res.refreshing} />
            <button type="button" className="btn btn-secondary btn-icon" onClick={() => res.reload({ silent: true })} title="Refresh" aria-label="Refresh">
              <Icon name="refresh" size={16} />
            </button>
          </>
        )}
      />
      <ErrorBanner error={res.error} onRetry={() => res.reload()} />

      {focusDept && !res.loading && (
        focusMatches.length ? (
          <Banner kind="info" title={`Showing ${focusName}`} action={<button type="button" className="btn btn-sm btn-secondary" onClick={clearFocus}>Clear</button>}>
            {focusMatches.length} recommendation{focusMatches.length === 1 ? '' : 's'} for this department {focusMatches.length === 1 ? 'is' : 'are'} highlighted below.
            Toggle “+1 extra doctor session” to estimate the effect of a staffing fix.
          </Banner>
        ) : (
          <Banner kind="info" title={`No staffing recommendation for ${focusName}`} action={<button type="button" className="btn btn-sm btn-secondary" onClick={clearFocus}>Clear</button>}>
            The forecast does not show a capacity shortfall for this department in the coming days (or forecasts have not been generated yet).
            A live congestion alert can still clear on its own; check the <Link to={`/forecasts?departmentId=${encodeURIComponent(focusDept)}`}>department forecast</Link>.
          </Banner>
        )
      )}

      {res.loading && !res.data ? <PageSkeleton text="Loading workload…" cards={2} /> : (
        <>
          <div className="grid-2">
            <Card title="Workload by branch" subtitle="Utilisation = demand ÷ scheduled capacity.">
              <DataTable columns={columns} rows={workload} rowKey="branchId" searchable={false}
                initialSort={{ key: 'utilization', dir: 'desc' }} emptyTitle="No workload data" dense />
            </Card>
            <Card title="Utilisation" subtitle="Dashed line marks 100% of scheduled capacity.">
              {chartData.length === 0 ? <EmptyState title="No workload data">No branch in scope has scheduled capacity in the period.</EmptyState> : (
                <div className="chart-box" style={{ height: Math.max(200, chartData.length * 44 + 50) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ top: 22, right: 32, bottom: 4, left: 8 }}>
                      <CartesianGrid horizontal={false} stroke={chart.grid} />
                      <XAxis type="number" unit="%" tick={chart.tick} stroke={chart.grid} tickLine={false} domain={[0, axisMax]} ticks={axisTicks} />
                      <YAxis type="category" dataKey="name" width={130} tick={chart.tick} stroke={chart.grid} tickLine={false} />
                      <Tooltip cursor={{ fill: chart.cursor }} content={<ChartTooltip valueFormatter={(v) => `${fmtNum(v, 1)}%`} />} />
                      <ReferenceLine x={100} stroke={chart.reference} strokeDasharray="5 4"
                        label={{ value: '100%', position: 'top', fill: chart.textMuted, fontSize: chart.fontSize }} />
                      <Bar dataKey="utilization" name="Utilisation" fill={chart.series1} radius={[0, 4, 4, 0]} maxBarSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>
          </div>

          <Card
            title={`Recommendations${recommendations.length ? ` (${recommendations.length})` : ''}`}
            subtitle="Generated by comparing forecast demand with scheduled doctor capacity (FR-18)."
          >
            <Banner kind="info">
              These are suggestions for administrator review. Schedules are never changed automatically —
              add sessions or open rooms under Schedules and Service Points if you agree. The “+1 extra doctor
              session” switch is a what-if estimate on this screen only.
            </Banner>
            <ErrorBanner error={forecasts.error} title="Some forecasts could not be loaded for the what-if" />
            {recommendations.length === 0 ? (
              <EmptyState icon="check" title="No resource shortfalls forecast">
                Scheduled capacity covers the forecast demand for the coming days.
              </EmptyState>
            ) : (
              <div className="rec-grid">
                {recommendations.map((r, i) => {
                  const rows = forecasts.byDate[r.date];
                  const avgConsult = resolveAvgConsult(rows, doctorList, r.departmentId);
                  return (
                    <RecommendationCard
                      key={`${r.departmentId}-${r.date}-${r.timeRange}-${i}`}
                      rec={r}
                      forecastRows={rows}
                      forecastLoading={(forecasts.loading && !rows) || (avgConsult.value === null && doctors.loading)}
                      avgConsult={avgConsult}
                      highlighted={Boolean(focusDept) && String(r.departmentId) === String(focusDept)}
                    />
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
