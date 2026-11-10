// Live Overview & Alerts (FR-15 live monitoring, FR-17 congestion alerts, NFR-01 real-time refresh).
// Data: GET /admin/dashboard and GET /admin/alerts (scoped by ?branchId=). The page re-fetches on
// socket events 'queue:updated' / 'alert' (debounced) and polls every 20 s while the socket is down.
import { useCallback, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import {
  Badge, Card, CongestionBadge, EmptyState, ErrorBanner, KpiTile, LastUpdated, Loading, PageHeader, PageSkeleton,
} from '../components/ui.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useLiveRefresh } from '../hooks/useLiveRefresh.js';
import { fmtMinutes, fmtNum, fmtPercent, formatDateTime, timeAgo } from '../utils/format.js';
import { congestionColor } from '../utils/chartTheme.js';
import { useChartTheme } from '../hooks/useChartTheme.js';
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
          <span className="muted small">{[a.branchName, a.departmentName].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

export default function OverviewPage() {
  const { scopeQuery, branchName, branchId } = useScope();
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
  const departments = useMemo(() => (Array.isArray(data.departments) ? data.departments : []), [data.departments]);
  const branches = Array.isArray(data.branches) ? data.branches : [];
  const servicePoints = Array.isArray(data.servicePoints) ? data.servicePoints : [];

  // FR-15 input: department filter (client side, applied to tables, chart and alerts).
  const deptOptions = useMemo(() => departments
    .map((d) => ({ value: String(d.departmentId), label: `${d.name || d.specialty}${branchId ? '' : ` — ${d.branchName}`}` }))
    .sort((a, b) => a.label.localeCompare(b.label)), [departments, branchId]);
  const selectedDept = departments.find((d) => String(d.departmentId) === deptFilter);
  const deptRows = deptFilter ? departments.filter((d) => String(d.departmentId) === deptFilter) : departments;
  // Order: CRITICAL before HIGH, live before forecast; live alerts newest first, forecast alerts
  // by forecast hour (soonest first) so the next expected peak is on top.
  const alertRows = (Array.isArray(alerts.data) ? alerts.data : [])
    .filter((a) => !deptFilter || String(a.departmentId) === deptFilter)
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

  const deptColumns = [
    {
      key: 'name', label: 'Department',
      searchValue: (r) => `${r.name} ${r.specialty} ${r.branchName}`,
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.name || r.specialty}</strong>
          {!branchId && <span className="muted small">{r.branchName}</span>}
        </div>
      ),
    },
    { key: 'waiting', label: 'Waiting', align: 'right' },
    { key: 'activeDoctors', label: 'Doctors', align: 'right' },
    { key: 'avgWaitMinutes', label: 'Avg wait', align: 'right', render: (r) => fmtMinutes(r.avgWaitMinutes) },
    { key: 'maxWaitMinutes', label: 'Max wait', align: 'right', render: (r) => fmtMinutes(r.maxWaitMinutes) },
    {
      key: 'congestionRatio', label: 'Load', align: 'right',
      render: (r) => (
        <span className="ratio-cell" title="Waiting patients ÷ remaining capacity this session (Eq. 6.5)">
          <span className={`ratio-bar ratio-${String(r.congestionLevel || 'NORMAL').toLowerCase()}`}>
            <span style={{ width: `${Math.min(100, (Number(r.congestionRatio) || 0) * 100)}%` }} />
          </span>
          {fmtPercent(r.congestionRatio)}
        </span>
      ),
    },
    {
      key: 'congestionLevel', label: 'Congestion',
      sortValue: (r) => LEVEL_RANK[r.congestionLevel] ?? 0,
      render: (r) => <CongestionBadge level={r.congestionLevel} />,
    },
  ];

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
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Department filter">
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

      <ErrorBanner error={dash.error} onRetry={() => dash.reload()} />

      {dash.loading && !dash.data ? <PageSkeleton text="Loading live overview…" kpis={7} cards={2} /> : (
        <>
          <div className="kpi-grid">
            {selectedDept ? (
              <>
                <KpiTile label="Waiting" value={fmtNum(selectedDept.waiting)} icon="users" tone="primary" hint={selectedDept.name || selectedDept.specialty} />
                <KpiTile label="Avg current wait" value={fmtNum(selectedDept.avgWaitMinutes)} unit="min" icon="schedules" />
                <KpiTile label="Max current wait" value={fmtNum(selectedDept.maxWaitMinutes)} unit="min" icon="alert"
                  tone={selectedDept.congestionLevel === 'CRITICAL' ? 'danger' : selectedDept.congestionLevel === 'HIGH' ? 'warning' : 'default'} />
                <KpiTile label="Active doctors" value={fmtNum(selectedDept.activeDoctors)} icon="doctors" />
                <KpiTile label="Load (Eq. 6.5)" value={fmtPercent(selectedDept.congestionRatio)} icon="workload"
                  hint={<CongestionBadge level={selectedDept.congestionLevel} />} />
              </>
            ) : (
              <>
                <KpiTile label="Waiting now" value={fmtNum(kpis.waiting)} icon="users" tone="primary" />
                <KpiTile label="In service" value={fmtNum(kpis.inService)} icon="doctors" />
                <KpiTile label="Completed today" value={fmtNum(kpis.completedToday)} icon="check" tone="success" />
                <KpiTile label="Avg current wait" value={fmtNum(kpis.avgWaitMinutes)} unit="min" icon="schedules" />
                <KpiTile label="Max current wait" value={fmtNum(kpis.maxWaitMinutes)} unit="min" icon="alert"
                  tone={Number(kpis.maxWaitMinutes) >= 60 ? 'warning' : 'default'} />
                <KpiTile label="Active doctors" value={fmtNum(kpis.activeDoctors)} icon="doctors" />
                <KpiTile label="Active service points" value={fmtNum(kpis.activeServicePoints)} icon="servicePoints"
                  hint={congested ? `${congested} congested department${congested === 1 ? '' : 's'}` : 'No congestion'} />
              </>
            )}
          </div>

          <div className="grid-main-side">
            <Card
              title="Departments"
              subtitle="Live queue length, waits and load against remaining session capacity."
            >
              <DataTable
                columns={deptColumns}
                rows={deptRows}
                rowKey="departmentId"
                searchable={departments.length > 8}
                initialSort={{ key: 'congestionLevel', dir: 'desc' }}
                emptyTitle="No departments in scope"
                pageSize={15}
                dense
              />
            </Card>
            <Card
              title={`Alerts${alertRows.length ? ` (${alertRows.length})` : ''}`}
              subtitle="Live and forecast congestion above the configured thresholds (FR-17)."
              actions={<LastUpdated at={alerts.updatedAt} refreshing={alerts.refreshing} />}
            >
              <ErrorBanner error={alerts.error} onRetry={() => alerts.reload()} title="Could not load alerts" />
              <AlertList alerts={alertRows} loading={alerts.loading} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Waiting patients by department" subtitle="Bar colour shows the congestion level; see the table for exact values.">
              {chartRows.length === 0 ? (
                <EmptyState title="No queue data yet" />
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
