// Live Overview & Alerts (FR-15 live monitoring, FR-17 congestion alerts, NFR-01 real-time refresh).
// Data: GET /admin/dashboard (kpis, trend, branches, departments[].doctors, servicePoints) and
// GET /admin/alerts, scoped by ?branchId=. The page re-fetches on socket events 'queue:updated' /
// 'alert' (debounced) and polls every 15 s while the socket is down (Decision 8).
// Upgrade 2026: sliding congestion alert strip, animated KPI tiles with sparklines from `trend`
// and a "● Live" indicator, and a department load matrix with expandable doctor rows.
// Every number comes from the API; missing new fields (trend, doctors) simply hide those extras.
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import AlertStrip from '../components/AlertStrip.jsx';
import DepartmentMatrix from '../components/DepartmentMatrix.jsx';
import LiveIndicator from '../components/LiveIndicator.jsx';
import LiveKpiTile from '../components/LiveKpiTile.jsx';
import LoadBalancerCard from '../components/LoadBalancerCard.jsx';
import {
  Badge, Card, CongestionBadge, EmptyState, ErrorBanner, LastUpdated, Loading, PageHeader, PageSkeleton,
} from '../components/ui.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useLiveRefresh, LIVE_POLL_MS } from '../hooks/useLiveRefresh.js';
import { fmtMinutes, formatDateTime, timeAgo } from '../utils/format.js';
import { congestionColor } from '../utils/chartTheme.js';
import { useChartTheme } from '../hooks/useChartTheme.js';
import { filterDepartments, kpiAnnouncement, trendSeries } from '../utils/overview.js';
import { ServicePointType } from './ServicePointsPage.jsx';

const LEVEL_RANK = { CRITICAL: 2, HIGH: 1, NORMAL: 0 };

/** `nowServing` may be a display number string or a { displayNumber } object. */
function nowServingText(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.displayNumber || (v.tokenNumber ? `#${v.tokenNumber}` : null);
}

function AlertList({ alerts, loading }) {
  if (loading && !alerts.length) return <Loading text="Loading alerts…" lines={3} />;
  if (!alerts.length) {
    return (
      <EmptyState icon="check" title="No active congestion alerts">
        All departments are within the configured thresholds.
      </EmptyState>
    );
  }
  return (
    <ul className="alert-list">
      {alerts.map((a) => (
        <li key={a.id ?? `${a.departmentId}-${a.at}-${a.level}`} className={`alert-item alert-${String(a.level).toLowerCase()}`}>
          <div className="alert-item-head">
            <CongestionBadge level={a.level} />
            <Badge tone={a.source === 'FORECAST' ? 'primary' : 'info'}>{a.source === 'FORECAST' ? 'Forecast' : 'Live'}</Badge>
            <span className="muted small" title={formatDateTime(a.at)}>{timeAgo(a.at)}</span>
          </div>
          <p className="alert-msg">{a.message}</p>
          <div className="alert-item-foot">
            <span className="muted small">{[a.branchName, a.departmentName].filter(Boolean).join(' · ')}</span>
            {a.departmentId !== undefined && a.departmentId !== null && (
              <Link className="link-btn" to={`/workload?departmentId=${encodeURIComponent(a.departmentId)}`}>
                Simulate staffing fix <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewPage() {
  const { scopeQuery, branchName, branchId, branch } = useScope();
  const dash = useResource('/admin/dashboard', scopeQuery);
  const alerts = useResource('/admin/alerts', scopeQuery);
  const [deptFilter, setDeptFilter] = useState('');
  const chart = useChartTheme();

  const refresh = useCallback(() => {
    dash.reload({ silent: true });
    alerts.reload({ silent: true });
  }, [dash.reload, alerts.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ignore queue events from other branches when a branch is selected.
  useLiveRefresh(refresh, {
    filter: (p) => !branchId || !p?.branchId || Number(p.branchId) === Number(branchId),
  });

  const data = dash.data || {};
  const kpis = data.kpis || {};
  const trend = useMemo(() => (Array.isArray(data.trend) ? data.trend : []), [data.trend]);
  const trendLabels = trend.map((p) => p?.hour);
  // The branch scope filters immediately on the client while the re-fetch for the new scope runs.
  const departments = useMemo(
    () => filterDepartments(Array.isArray(data.departments) ? data.departments : [], { branchId }),
    [data.departments, branchId],
  );
  const branches = Array.isArray(data.branches) ? data.branches : [];
  const servicePoints = (Array.isArray(data.servicePoints) ? data.servicePoints : [])
    .filter((sp) => !branchId || !branch?.name || !sp.branchName || sp.branchName === branch.name);

  // FR-15 input: department filter (client side, applied to the matrix, chart and alerts).
  const deptOptions = useMemo(() => departments
    .map((d) => ({ value: String(d.departmentId), label: `${d.name || d.specialty}${branchId ? '' : ` — ${d.branchName}`}` }))
    .sort((a, b) => a.label.localeCompare(b.label)), [departments, branchId]);
  const selectedDept = departments.find((d) => String(d.departmentId) === deptFilter);
  const deptRows = useMemo(
    () => filterDepartments(departments, { departmentId: selectedDept ? deptFilter : '' }),
    [departments, deptFilter, selectedDept],
  );
  const scopedAlerts = (Array.isArray(alerts.data) ? alerts.data : [])
    .filter((a) => !branchId || a.branchId === undefined || Number(a.branchId) === Number(branchId))
    .filter((a) => !selectedDept || String(a.departmentId) === deptFilter);
  // Order: CRITICAL before HIGH, live before forecast; live alerts newest first, forecast alerts
  // by forecast hour (soonest first) so the next expected peak is on top.
  const alertRows = [...scopedAlerts]
    .sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0)
      || (a.source === 'FORECAST') - (b.source === 'FORECAST')
      || (a.source === 'FORECAST'
        ? String(a.at).localeCompare(String(b.at))
        : String(b.at).localeCompare(String(a.at))));
  const spRows = selectedDept
    ? servicePoints.filter((sp) => !sp.branchName || sp.branchName === selectedDept.branchName)
    : servicePoints;

  const congested = departments.filter((d) => d.congestionLevel === 'HIGH' || d.congestionLevel === 'CRITICAL').length;
  const chartRows = [...deptRows]
    .sort((a, b) => (b.waiting || 0) - (a.waiting || 0))
    .slice(0, 12)
    .map((d) => ({
      name: branchId ? (d.name || d.specialty) : `${d.name || d.specialty} (${d.branchName})`,
      waiting: d.waiting || 0,
      level: d.congestionLevel || 'NORMAL',
      ratio: d.congestionRatio,
    }));

  const levelTone = (lvl) => (lvl === 'CRITICAL' ? 'danger' : lvl === 'HIGH' ? 'warning' : 'default');
  const tiles = selectedDept ? [
    { key: 'waiting', label: 'Waiting', value: selectedDept.waiting, icon: 'users', tone: 'primary', hint: selectedDept.name || selectedDept.specialty },
    { key: 'avg', label: 'Avg current wait', value: selectedDept.avgWaitMinutes, unit: 'min', icon: 'schedules' },
    { key: 'max', label: 'Max current wait', value: selectedDept.maxWaitMinutes, unit: 'min', icon: 'alert', tone: levelTone(selectedDept.congestionLevel) },
    { key: 'doctors', label: 'Active doctors', value: selectedDept.activeDoctors, icon: 'doctors' },
    {
      key: 'load', label: 'Load (Eq. 6.5)',
      value: Number.isFinite(Number(selectedDept.congestionRatio)) && selectedDept.congestionRatio !== null ? Number(selectedDept.congestionRatio) * 100 : null,
      unit: '%', icon: 'workload', hint: <CongestionBadge level={selectedDept.congestionLevel} />,
    },
  ] : [
    { key: 'waiting', label: 'Waiting now', value: kpis.waiting, icon: 'users', tone: 'primary', trend: trendSeries(trend, 'waiting') },
    { key: 'inService', label: 'In service', value: kpis.inService, icon: 'doctors', trend: trendSeries(trend, 'inService') },
    { key: 'completed', label: 'Completed today', value: kpis.completedToday, icon: 'check', tone: 'success', trend: trendSeries(trend, 'completed') },
    { key: 'avg', label: 'Avg current wait', value: kpis.avgWaitMinutes, unit: 'min', icon: 'schedules', trend: trendSeries(trend, 'avgWaitMinutes') },
    {
      key: 'max', label: 'Max current wait', value: kpis.maxWaitMinutes, unit: 'min', icon: 'alert',
      tone: Number(kpis.maxWaitMinutes) >= 60 ? 'warning' : 'default', trend: trendSeries(trend, 'maxWaitMinutes'),
    },
    { key: 'doctors', label: 'Active doctors', value: kpis.activeDoctors, icon: 'doctors' },
    {
      key: 'sp', label: 'Active service points', value: kpis.activeServicePoints, icon: 'servicePoints',
      hint: congested ? `${congested} congested department${congested === 1 ? '' : 's'}` : 'No congestion',
    },
  ];
  const announcement = kpiAnnouncement(tiles);

  const branchColumns = [
    { key: 'name', label: 'Branch', render: (r) => <strong>{r.name}</strong> },
    { key: 'waiting', label: 'Waiting', align: 'right' },
    { key: 'avgWaitMinutes', label: 'Avg wait', align: 'right', render: (r) => fmtMinutes(r.avgWaitMinutes) },
    {
      key: 'congestionLevel', label: 'Congestion', sortValue: (r) => LEVEL_RANK[r.congestionLevel] ?? 0,
      render: (r) => <CongestionBadge level={r.congestionLevel} />,
    },
  ];

  const spColumns = [
    { key: 'name', label: 'Service point', render: (r) => <strong>{r.name}</strong> },
    { key: 'type', label: 'Type', render: (r) => <ServicePointType type={r.type} /> },
    ...(branchId ? [] : [{ key: 'branchName', label: 'Branch' }]),
    { key: 'waiting', label: 'Waiting', align: 'right' },
    {
      key: 'nowServing', label: 'Now serving', sortValue: (r) => nowServingText(r.nowServing) || '',
      searchValue: (r) => nowServingText(r.nowServing),
      render: (r) => {
        const t = nowServingText(r.nowServing);
        return t ? <span className="token-pill">{t}</span> : <span className="muted">Idle</span>;
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Live Overview & Alerts"
        subtitle={`Today's OPD, lab and pharmacy queues — ${branchName}.`}
        actions={(
          <>
            <LastUpdated at={dash.updatedAt} refreshing={dash.refreshing} />
            <label className="inline-field">
              <span>Department</span>
              <select value={selectedDept ? deptFilter : ''} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Department filter">
                <option value="">All departments</option>
                {deptOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-icon" onClick={refresh} title="Refresh now" aria-label="Refresh now">
              <Icon name="refresh" size={16} />
            </button>
          </>
        )}
      />

      <AlertStrip alerts={scopedAlerts} />

      <ErrorBanner error={dash.error} onRetry={() => dash.reload()} />

      {dash.loading && !dash.data ? <PageSkeleton text="Loading live overview…" kpis={7} cards={2} /> : (
        <>
          <section className="kpi-section" aria-labelledby="kpi-heading">
            <div className="section-head">
              <h2 className="overline" id="kpi-heading">
                {selectedDept ? `${selectedDept.name || selectedDept.specialty} — right now` : 'Today at a glance'}
              </h2>
              <LiveIndicator refreshing={dash.refreshing} pollSeconds={LIVE_POLL_MS / 1000} />
              {!selectedDept && trend.length > 1 && <span className="muted small section-note">Sparklines: hourly trend today</span>}
            </div>
            <div className="kpi-grid">
              {tiles.map(({ key, ...t }) => (
                <LiveKpiTile key={`${selectedDept ? 'd' : 'k'}-${key}`} {...t} trendLabels={trendLabels} />
              ))}
            </div>
            <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
          </section>

          {!selectedDept && <LoadBalancerCard />}

          <div className="grid-main-side">
            <Card
              title="Department load"
              subtitle="Live queue, waits and utilisation of the remaining session capacity (Eq. 6.5). Expand a row to see its doctors."
              actions={(
                <div className="legend-row" aria-label="Utilisation legend">
                  <span><i className="legend-swatch util-swatch-low" /> &lt; 70 %</span>
                  <span><i className="legend-swatch util-swatch-mid" /> 70–85 %</span>
                  <span><i className="legend-swatch util-swatch-high" /> &gt; 85 %</span>
                </div>
              )}
            >
              <DepartmentMatrix
                rows={deptRows}
                showBranch={!branchId}
                emptyText={branchId ? 'This branch has no active departments.' : 'No departments are configured yet.'}
              />
            </Card>
            <Card
              title={`Alerts${alertRows.length ? ` (${alertRows.length})` : ''}`}
              subtitle="Live and forecast congestion above the configured thresholds (FR-17)."
              actions={<LastUpdated at={alerts.updatedAt} refreshing={alerts.refreshing} />}
              className="alerts-card"
              id="alerts"
            >
              <ErrorBanner error={alerts.error} onRetry={() => alerts.reload()} title="Could not load alerts" />
              <AlertList alerts={alertRows} loading={alerts.loading} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Waiting patients by department" subtitle="Bar colour shows the congestion level; see the matrix for exact values.">
              {chartRows.length === 0 ? (
                <EmptyState title="No queue data yet">No department in scope has patients waiting today.</EmptyState>
              ) : (
                <div className="chart-box" style={{ height: Math.max(220, chartRows.length * 34 + 40) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                      <CartesianGrid horizontal={false} stroke={chart.grid} />
                      <XAxis type="number" allowDecimals={false} tick={chart.tick} stroke={chart.grid} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={150} tick={chart.tick} stroke={chart.grid} tickLine={false} />
                      <Tooltip
                        cursor={{ fill: chart.cursor }}
                        content={(
                          <ChartTooltip
                            extra={(row) => (
                              <div className="chart-tooltip-row"><CongestionBadge level={row?.level} ratio={row?.ratio} /></div>
                            )}
                          />
                        )}
                      />
                      <Bar dataKey="waiting" name="Waiting" radius={[0, 4, 4, 0]} maxBarSize={22} fill={chart.series1}>
                        {chartRows.map((r) => <Cell key={r.name} fill={congestionColor(chart, r.level)} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="legend-row" aria-label="Legend">
                <span><i className="legend-swatch swatch-normal" /> Normal</span>
                <span><i className="legend-swatch swatch-high" /> High</span>
                <span><i className="legend-swatch swatch-critical" /> Critical</span>
              </div>
            </Card>

            {!branchId ? (
              <Card title="Branches" subtitle="Hospital-wide comparison.">
                <DataTable
                  columns={branchColumns}
                  rows={branches}
                  rowKey="branchId"
                  searchable={false}
                  initialSort={{ key: 'waiting', dir: 'desc' }}
                  emptyTitle="No branch data"
                  dense
                />
              </Card>
            ) : (
              <Card title="Service points" subtitle="Who is being served at each room and counter.">
                <DataTable columns={spColumns} rows={spRows} searchable={spRows.length > 8} dense pageSize={12}
                  emptyTitle="No service points" initialSort={{ key: 'waiting', dir: 'desc' }} />
              </Card>
            )}
          </div>

          {!branchId && (
            <Card title="Service points" subtitle="Who is being served at each room and counter.">
              <DataTable columns={spColumns} rows={spRows} dense pageSize={15} emptyTitle="No service points"
                initialSort={{ key: 'waiting', dir: 'desc' }} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
