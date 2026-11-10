// Forecasts (FR-17, Section 6.6): expected hourly arrivals vs. scheduled capacity, congestion level
// per hour (Eq. 6.5) and peak hours, per branch and department. "Run forecast now" triggers the
// forecasting job (AI model, or the seasonal baseline when the AI service is unavailable).
import { useEffect, useMemo, useState } from 'react';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
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
import { addDays, fmtNum, fmtPercent, formatDate, formatHour, today } from '../utils/format.js';
import { aggregateForecastByHour } from '../utils/forecast.js';
import { DEFAULT_THRESHOLDS } from '../utils/settings.js';
import { congestionColor, peakRanges } from '../utils/chartTheme.js';
import { useChartTheme } from '../hooks/useChartTheme.js';

function sourceLabel(src) {
  if (!src) return '—';
  return src === 'baseline' ? 'Seasonal baseline' : `AI model ${src}`;
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
  const peakBands = useMemo(() => peakRanges(points), [points]);
  const totalArrivals = points.reduce((s, p) => s + p.expectedArrivals, 0);
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
    { key: 'isPeak', label: 'Peak', render: (r) => (r.isPeak ? <Badge tone="warning" icon="alert">Peak</Badge> : <span className="muted">—</span>) },
    { key: 'source', label: 'Source', render: (r) => <span className="muted small">{sourceLabel(r.source)}</span> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Forecasts"
        subtitle="Expected hourly arrivals against scheduled capacity, congestion level and peak hours (FR-17)."
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

      {forecasts.loading && !forecasts.data ? <PageSkeleton text="Loading forecasts…" kpis={4} chart /> : points.length === 0 ? (
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
          <div className="kpi-grid kpi-grid-4">
            <KpiTile label="Expected arrivals" value={fmtNum(totalArrivals)} icon="users" tone="primary" hint={formatDate(date)} />
            <KpiTile
              label="Peak hours"
              value={peakHours.length ? peakHours.length : 'None'}
              icon="alert"
              tone={peakHours.length ? 'warning' : 'default'}
              hint={peakHours.length ? peakHours.map((p) => p.hour).join(', ') : 'No hour above the peak threshold'}
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
            title={`Expected arrivals vs. capacity per hour — ${scopeLabel}`}
            subtitle={`Patients per hour. Bars are coloured by congestion level (HIGH ≥ ${fmtPercent(thresholds.high)}, CRITICAL ≥ ${fmtPercent(thresholds.critical)} of capacity); shaded hours are forecast peaks.`}
          >
            <div className="chart-box chart-h-lg">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={chart.grid} />
                  {peakBands.map((b) => (
                    <ReferenceArea
                      key={b.x1}
                      x1={b.x1}
                      x2={b.x2}
                      fill={chart.peakBand}
                      fillOpacity={1}
                      stroke={chart.high}
                      strokeOpacity={0.5}
                      strokeDasharray="3 3"
                      ifOverflow="extendDomain"
                      label={{ value: 'Peak', position: 'insideTop', fill: chart.peakText, fontSize: chart.fontSize, fontWeight: 600 }}
                    />
                  ))}
                  <XAxis dataKey="hour" tick={chart.tick} stroke={chart.grid} tickLine={false} />
                  <YAxis tick={chart.tick} stroke={chart.grid} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                  <Tooltip
                    cursor={{ fill: chart.cursor }}
                    content={(
                      <ChartTooltip
                        valueFormatter={(v) => fmtNum(v, 1)}
                        labelFormatter={(l, row) => `${l}${row?.isPeak ? ' · Peak hour' : ''}`}
                        extra={(row) => (
                          <div className="chart-tooltip-row">
                            <CongestionBadge level={row?.congestionLevel} ratio={row?.congestionRatio} />
                          </div>
                        )}
                      />
                    )}
                  />
                  <Legend
                    verticalAlign="top"
                    height={28}
                    iconSize={10}
                    payload={[
                      { value: 'Expected arrivals (colour = congestion)', type: 'square', color: chart.series1, id: 'a' },
                      { value: 'Scheduled capacity', type: 'line', color: chart.reference, id: 'c' },
                    ]}
                    formatter={(v) => <span className="chart-legend-text">{v}</span>}
                  />
                  <Bar dataKey="expectedArrivals" name="Expected arrivals" radius={[4, 4, 0, 0]} maxBarSize={36} fill={chart.series1}>
                    {points.map((p) => (
                      <Cell key={p.hour} fill={congestionColor(chart, p.congestionLevel)} />
                    ))}
                  </Bar>
                  <Line dataKey="capacity" name="Capacity" type="step" stroke={chart.reference} strokeWidth={2} strokeDasharray="6 4" dot={false} activeDot={{ r: 4, fill: chart.reference, stroke: chart.surface }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="legend-row" aria-label="Congestion legend">
              <span><i className="legend-swatch swatch-normal" /> Normal</span>
              <span><i className="legend-swatch swatch-high" /> High</span>
              <span><i className="legend-swatch swatch-critical" /> Critical</span>
              <span><i className="legend-swatch legend-peak" /> Peak hour</span>
            </div>
          </Card>

          <Card title="Hourly detail" subtitle={departmentId ? undefined : 'One row per department and hour.'}>
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
