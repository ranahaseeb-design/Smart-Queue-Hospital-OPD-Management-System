// Workload & Recommendations (FR-18, Section 6.6.3): branch workload indicators and
// resource-allocation recommendations for forecast peaks. These are decision support only;
// the system never changes schedules automatically.
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import { Badge, Banner, Card, EmptyState, ErrorBanner, LastUpdated, PageHeader, PageSkeleton } from '../components/ui.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { fmtMinutes, fmtNum, fmtPercent, formatDate } from '../utils/format.js';
import { useChartTheme } from '../hooks/useChartTheme.js';

function utilTone(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return 'neutral';
  if (n >= 1) return 'danger';
  if (n >= 0.85) return 'warning';
  return 'success';
}

function RecommendationCard({ rec }) {
  const sessions = Number(rec.shortfallSessions);
  return (
    <article className="rec-card">
      <header className="rec-card-head">
        <Icon name="lightbulb" size={18} />
        <div>
          <strong>{rec.departmentName}</strong>
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
      <footer className="rec-foot">
        <Link to="/schedules" className="btn btn-sm btn-ghost"><Icon name="schedules" size={14} /> Review schedules</Link>
        <Link to="/forecasts" className="btn btn-sm btn-ghost"><Icon name="forecast" size={14} /> View forecast</Link>
      </footer>
    </article>
  );
}

export default function WorkloadPage() {
  const { scopeQuery, branchName } = useScope();
  const res = useResource('/admin/recommendations', scopeQuery);
  const chart = useChartTheme();
  const workload = Array.isArray(res.data?.workload) ? res.data.workload : [];
  const recommendations = Array.isArray(res.data?.recommendations) ? res.data.recommendations : [];

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

      {res.loading && !res.data ? <PageSkeleton text="Loading workload…" cards={2} /> : (
        <>
          <div className="grid-2">
            <Card title="Workload by branch" subtitle="Utilisation = demand ÷ scheduled capacity.">
              <DataTable columns={columns} rows={workload} rowKey="branchId" searchable={false}
                initialSort={{ key: 'utilization', dir: 'desc' }} emptyTitle="No workload data" dense />
            </Card>
            <Card title="Utilisation" subtitle="Dashed line marks 100% of scheduled capacity.">
              {chartData.length === 0 ? <EmptyState title="No workload data" /> : (
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
              add sessions or open rooms under Schedules and Service Points if you agree.
            </Banner>
            {recommendations.length === 0 ? (
              <EmptyState icon="check" title="No resource shortfalls forecast">
                Scheduled capacity covers the forecast demand for the coming days.
              </EmptyState>
            ) : (
              <div className="rec-grid">
                {recommendations.map((r, i) => (
                  <RecommendationCard key={`${r.departmentId}-${r.date}-${r.timeRange}-${i}`} rec={r} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
