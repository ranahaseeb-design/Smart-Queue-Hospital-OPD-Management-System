// Forecasts (FR-17, Section 6.6): expected hourly arrivals vs. scheduled capacity, congestion level
// per hour (Eq. 6.5), peak hours and staffing shortfalls, per branch and department. "Run forecast
// now" triggers the forecasting job (AI model, or the seasonal baseline when the AI is unavailable).
// Upgrade 2026: dual-series chart — forecast arrivals (Âh) vs dashed scheduled capacity (Ch) —
// with crimson-shaded peak / shortfall hours and the exact `shortfallDoctorHours` in the tooltip.
import { useEffect, useId, useMemo, useState } from 'react';
import {
  Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import {
  Badge, Banner, Card, CongestionBadge, EmptyState, ErrorBanner, KpiTile, LastUpdated, PageHeader, PageSkeleton, Segmented, Spinner,
} from '../components/ui.jsx';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useDepartments } from '../hooks/useLookups.js';
import { usePrefersReducedMotion } from '../hooks/useMotion.js';
import { addDays, fmtNum, fmtPercent, formatDate, formatHour, today } from '../utils/format.js';
import { aggregateForecastByHour, forecastTotals, rowShortfallDoctorHours } from '../utils/forecast.js';
import { DEFAULT_THRESHOLDS } from '../utils/settings.js';
import { congestionColor, peakRanges } from '../utils/chartTheme.js';
import { useChartTheme } from '../hooks/useChartTheme.js';

function sourceLabel(src) {
  if (!src) return '—';
  return src === 'baseline' ? 'Seasonal baseline' : `AI model ${src}`;
}

const markHour = (p) => p.isPeak || p.isShortfall;

/** Tooltip extra rows: congestion, then the exact staffing shortfall for the hour. */
export function ShortfallLine({ row }) {
  if (!row) return null;
  let text;
  if (!row.isShortfall) text = 'Capacity covers the forecast';
  else if (row.shortfallDoctorHours !== null && row.shortfallDoctorHours !== undefined) {
    text = `Shortfall ${fmtNum(row.shortfallDoctorHours, 1)} doctor-hours (${fmtNum(row.excessPatients, 1)} patients over capacity)`;
  } else text = `${fmtNum(row.excessPatients, 1)} patients over capacity (doctor-hours not reported)`;
  return (
    <>
      <div className="chart-tooltip-row"><CongestionBadge level={row.congestionLevel} ratio={row.congestionRatio} /></div>
      <div className={`chart-tooltip-row tooltip-shortfall ${row.isShortfall ? 'is-short' : ''}`}>
        <Icon name={row.isShortfall ? 'alert' : 'check'} size={14} />
        <span>{text}</span>
      </div>
    </>
  );
}

export default function ForecastsPage() {
  const { scopeQuery, branchName, branchId, branchNameById } = useScope();
  const { permissions } = useAuth();
  const canRun = permissions.runForecasts; // hospital administrators only (hospital-wide job)
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [departmentId, setDepartmentId] = useState('');
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const chart = useChartTheme();
  const reducedMotion = usePrefersReducedMotion();
  const gradId = useId().replace(/:/g, '');

  const departments = useDepartments(scopeQuery);
  const settings = useResource('/admin/settings');
  const thresholds = settings.data?.congestionThresholds || DEFAULT_THRESHOLDS;
  const forecasts = useResource('/admin/forecasts', { ...scopeQuery, departmentId: departmentId || undefined, date });

  const rows = useMemo(() => (Array.isArray(forecasts.data) ? forecasts.data : []), [forecasts.data]);
  const points = useMemo(() => aggregateForecastByHour(rows, thresholds), [rows, thresholds]);

  // Drop a department filter that is not in the newly selected branch.
  const deptList = departments.list.filter((d) => d.isActive !== false);
  useEffect(() => {
    if (!departmentId || !Array.isArray(departments.data)) return;
    if (!departments.data.some((d) => String(d.id) === departmentId && d.isActive !== false)) setDepartmentId('');
  }, [departments.data, departmentId]);

  const selectedDept = deptList.find((d) => String(d.id) === departmentId);
  const scopeLabel = selectedDept
    ? `${selectedDept.name || selectedDept.specialty}${branchId ? '' : ` — ${selectedDept.branchName || ''}`}`
    : `All departments — ${branchName}`;

  const peakHours = points.filter((p) => p.isPeak);
  const bands = useMemo(() => peakRanges(points, markHour), [points]);
  const totals = forecastTotals(points);
  const worst = points.reduce((w, p) => (p.congestionRatio !== null && (!w || p.congestionRatio > w.congestionRatio) ? p : w), null);
  const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))];

  const runForecast = async () => {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await api.post('/admin/forecasts/run');
      setRunResult(res);
      toast.success(`Forecast generated (${fmtNum(res?.generated)} rows, source: ${res?.source === 'ai' ? 'AI model' : 'seasonal baseline'})`);
      forecasts.reload({ silent: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setRunning(false);
    }
  };

  const columns = [
    { key: 'forecastHour', label: 'Hour', render: (r) => <span className="mono">{formatHour(r.forecastHour)}</span> },
    ...(departmentId ? [] : [{
      key: 'departmentName', label: 'Department',
      render: (r) => (
        <div className="cell-stack">
          <span>{r.departmentName}</span>
          {!branchId && <span className="muted small">{r.branchName || branchNameById(r.branchId)}</span>}
        </div>
      ),
    }]),
    { key: 'expectedArrivals', label: 'Expected arrivals', align: 'right', render: (r) => fmtNum(r.expectedArrivals, 1) },
    { key: 'capacity', label: 'Capacity', align: 'right', render: (r) => fmtNum(r.capacity, 1) },
    { key: 'congestionRatio', label: 'Load', align: 'right', render: (r) => fmtPercent(r.congestionRatio) },
    { key: 'congestionLevel', label: 'Congestion', render: (r) => <CongestionBadge level={r.congestionLevel} /> },
    {
      key: 'shortfallDoctorHours', label: 'Shortfall', align: 'right',
      sortValue: (r) => rowShortfallDoctorHours(r),
      render: (r) => {
        const v = rowShortfallDoctorHours(r);
        if (v === null) return <span className="muted">—</span>;
        return v > 0 ? <span className="text-bad">{fmtNum(v, 1)} dr-h</span> : <span className="muted">0</span>;
      },
    },
    { key: 'isPeak', label: 'Peak', render: (r) => (r.isPeak ? <Badge tone="warning" icon="alert">Peak</Badge> : <span className="muted">—</span>) },
    { key: 'source', label: 'Source', render: (r) => <span className="muted small">{sourceLabel(r.source)}</span> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Forecasts"
        subtitle="Expected hourly arrivals against scheduled capacity, congestion level, peak hours and staffing shortfalls (FR-17)."
        actions={(
          <>
            <LastUpdated at={forecasts.updatedAt} refreshing={forecasts.refreshing} />
            {canRun && (
              <button type="button" className="btn btn-primary" onClick={runForecast} disabled={running} aria-busy={running || undefined}>
                {running ? <Spinner size="xs" /> : <Icon name="play" size={14} />} {running ? 'Running…' : 'Run forecast now'}
              </button>
            )}
          </>
        )}
      />

      <Card>
        <div className="filter-bar">
          <label className="inline-field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
          <div className="preset-btns" role="group" aria-label="Date shortcuts">
            <button type="button" className="btn btn-secondary btn-icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day" title="Previous day">
              <Icon name="chevronLeft" size={16} />
            </button>
            <Segmented
              label="Date shortcut"
              value={date === today() ? 'today' : date === addDays(today(), 1) ? 'tomorrow' : ''}
              onChange={(v) => setDate(v === 'today' ? today() : addDays(today(), 1))}
              options={[{ value: 'today', label: 'Today' }, { value: 'tomorrow', label: 'Tomorrow' }]}
            />
            <button type="button" className="btn btn-secondary btn-icon" onClick={() => setDate(addDays(date, 1))} aria-label="Next day" title="Next day">
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <label className="inline-field grow">
            <span>Department</span>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments (combined)</option>
              {deptList
                .map((d) => ({ value: String(d.id), label: `${d.name || d.specialty}${branchId ? '' : ` — ${d.branchName || ''}`}` }))
                .sort((a, b) => a.label.localeCompare(b.label))
                .map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
      </Card>

      {runResult && (
        <Banner kind={runResult.source === 'ai' ? 'success' : 'info'} title="Forecast job finished">
          {fmtNum(runResult.generated)} hourly forecast rows generated using{' '}
          {runResult.source === 'ai'
            ? 'the AI forecasting model.'
            : 'the seasonal baseline (average of the same weekday and hour over the last 4 weeks) because the AI service was unavailable.'}
        </Banner>
      )}

      <ErrorBanner error={forecasts.error} onRetry={() => forecasts.reload()} title="Could not load forecasts" />

      {forecasts.loading && !forecasts.data ? <PageSkeleton text="Loading forecasts…" kpis={5} chart /> : points.length === 0 ? (
        !forecasts.error && (
          <Card>
            <EmptyState icon="forecast" title={`No forecast for ${formatDate(date)}`}>
              Forecasts are generated for the coming days by the forecasting job.
              {canRun ? ' Use “Run forecast now” to generate them.' : ' The hospital administrator can run it on demand.'}
            </EmptyState>
          </Card>
        )
      ) : (
        <>
          <div className="kpi-grid">
            <KpiTile label="Expected arrivals" value={fmtNum(totals.arrivals)} icon="users" tone="primary" hint={formatDate(date)} />
            <KpiTile
              label="Peak hours"
              value={peakHours.length ? peakHours.length : 'None'}
              icon="alert"
              tone={peakHours.length ? 'warning' : 'default'}
              hint={peakHours.length ? peakHours.map((p) => p.hour).join(', ') : 'No hour above the peak threshold'}
            />
            <KpiTile
              label="Staffing shortfall"
              value={totals.shortfallDoctorHours !== null ? fmtNum(totals.shortfallDoctorHours, 1) : totals.shortfallHours ? `${fmtNum(totals.excessPatients, 1)}` : '0'}
              unit={totals.shortfallDoctorHours !== null ? 'doctor-h' : totals.shortfallHours ? 'patients' : undefined}
              icon="doctors"
              tone={totals.shortfallHours ? 'danger' : 'success'}
              hint={totals.shortfallHours
                ? <>{totals.shortfallHours} hour{totals.shortfallHours === 1 ? '' : 's'} above capacity · <Link to="/workload">Workload</Link></>
                : 'Capacity covers every forecast hour'}
            />
            <KpiTile
              label="Highest load"
              value={worst ? fmtPercent(worst.congestionRatio) : '—'}
              icon="workload"
              tone={worst?.congestionLevel === 'CRITICAL' ? 'danger' : worst?.congestionLevel === 'HIGH' ? 'warning' : 'default'}
              hint={worst ? <>at {worst.hour} <CongestionBadge level={worst.congestionLevel} /></> : undefined}
            />
            <KpiTile label="Source" value={sources.length === 1 && sources[0] === 'baseline' ? 'Baseline' : sources.length ? 'AI model' : '—'}
              icon="models" hint={sources.map(sourceLabel).join(', ')} />
          </div>

          <Card
            title={`Forecast arrivals vs. scheduled capacity — ${scopeLabel}`}
            subtitle={`Patients per hour. Shaded hours are forecast peaks or hours where arrivals exceed capacity; dots are coloured by congestion (HIGH ≥ ${fmtPercent(thresholds.high)}, CRITICAL ≥ ${fmtPercent(thresholds.critical)}). Hover an hour for the exact shortfall.`}
          >
            <div className="chart-box chart-h-lg" role="img" aria-label={`Forecast arrivals and scheduled capacity per hour for ${scopeLabel}. ${totals.shortfallHours} hour(s) above capacity. Exact values are in the hourly table below.`}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={points} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id={`arr-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.series1} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={chart.series1} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke={chart.grid} />
                  {bands.map((b) => (
                    <ReferenceArea
                      key={b.x1}
                      x1={b.x1}
                      x2={b.x2}
                      fill={chart.peak}
                      fillOpacity={1}
                      stroke={chart.danger}
                      strokeOpacity={0.45}
                      strokeDasharray="3 3"
                      ifOverflow="extendDomain"
                      label={{ value: 'Shortfall / peak', position: 'insideTop', fill: chart.dangerText, fontSize: chart.fontSize, fontWeight: 600 }}
                    />
                  ))}
                  <XAxis dataKey="hour" tick={chart.tick} stroke={chart.grid} tickLine={false} />
                  <YAxis tick={chart.tick} stroke={chart.grid} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                  <Tooltip
                    cursor={{ stroke: chart.axis, strokeDasharray: '3 3' }}
                    content={(
                      <ChartTooltip
                        valueFormatter={(v) => fmtNum(v, 1)}
                        labelFormatter={(l, row) => `${l}${row?.isPeak ? ' · Peak hour' : ''}`}
                        extra={(row) => <ShortfallLine row={row} />}
                      />
                    )}
                  />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconSize={10}
                    payload={[
                      { value: 'Forecast arrivals (Âh)', type: 'square', color: chart.series1, id: 'a' },
                      { value: 'Scheduled capacity (Ch)', type: 'plainline', color: chart.reference, id: 'c', payload: { strokeDasharray: '6 4' } },
                    ]}
                    formatter={(v) => <span className="chart-legend-text">{v}</span>}
                  />
                  <Area
                    dataKey="expectedArrivals"
                    name="Forecast arrivals"
                    type="monotone"
                    stroke={chart.series1}
                    strokeWidth={2.5}
                    fill={`url(#arr-${gradId})`}
                    isAnimationActive={!reducedMotion}
                    animationDuration={700}
                    dot={(props) => {
                      const { cx, cy, payload, index } = props;
                      if (cx === undefined || cy === undefined) return <g key={`d-${index}`} />;
                      const lvl = payload?.congestionLevel;
                      const hot = lvl === 'HIGH' || lvl === 'CRITICAL';
                      return (
                        <circle key={`d-${index}`} cx={cx} cy={cy} r={hot ? 4.5 : 3}
                          fill={hot ? congestionColor(chart, lvl) : chart.surface} stroke={hot ? chart.surface : chart.series1} strokeWidth={hot ? 1.5 : 2} />
                      );
                    }}
                    activeDot={{ r: 6, fill: chart.series1, stroke: chart.surface, strokeWidth: 2 }}
                  />
                  <Line dataKey="capacity" name="Scheduled capacity" type="step" stroke={chart.reference} strokeWidth={2} strokeDasharray="6 4" dot={false}
                    isAnimationActive={!reducedMotion} activeDot={{ r: 4, fill: chart.reference, stroke: chart.surface }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="legend-row" aria-label="Chart legend">
              <span><i className="legend-swatch legend-arrivals" /> Forecast arrivals</span>
              <span><i className="legend-line-dashed" /> Scheduled capacity</span>
              <span><i className="legend-swatch legend-shortfall" /> Peak / shortfall hour</span>
              <span><i className="legend-swatch swatch-high" /> HIGH hour</span>
              <span><i className="legend-swatch swatch-critical" /> CRITICAL hour</span>
            </div>
          </Card>

          <Card title="Hourly detail" subtitle={departmentId ? 'Shortfall in doctor-hours (dr-h).' : 'One row per department and hour. Shortfall in doctor-hours (dr-h).'}>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r, i) => `${r.departmentId}-${r.forecastHour}-${i}`}
              initialSort={{ key: 'forecastHour', dir: 'asc' }}
              pageSize={48}
              dense
            />
          </Card>
        </>
      )}
    </div>
  );
}
