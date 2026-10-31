// Reports and analytics (FR-16): five report types for a branch and date range, shown as a table
// plus a simple chart, with CSV export. The CSV is fetched with the auth header and saved as a blob.
import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import { Banner, Card, EmptyState, ErrorBanner, Loading, PageHeader, Spinner } from '../components/ui.jsx';
import { api } from '../api/client.js';
import { useScope } from '../context/ScopeContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { addDays, fmtNum, today } from '../utils/format.js';
import { categoryLabel, chartCategoryColumns, numericColumns, REPORT_TYPES } from '../utils/reports.js';
import { AXIS_TICK, CHART } from '../utils/chartTheme.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CHART_ROWS = 31;

function formatCell(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return Number.isInteger(v) ? fmtNum(v) : fmtNum(v, 2);
  return String(v);
}

function ReportChart({ report }) {
  const metrics = useMemo(() => numericColumns(report.columns, report.rows), [report]);
  // Category axis: first text column, extended (e.g. branch + department) until labels are unique.
  const categoryCols = useMemo(() => chartCategoryColumns(report.columns, report.rows), [report]);
  const [metricKey, setMetricKey] = useState('');
  const metric = metrics.find((m) => m.key === metricKey) || metrics[0];

  if (!metric || !categoryCols.length || !report.rows?.length) return null;

  const isTimeSeries = categoryCols.length === 1
    && report.rows.every((r) => DATE_RE.test(String(r[categoryCols[0].key] ?? '')));
  const categoryName = categoryCols.map((c) => c.label.toLowerCase()).join(' and ');
  let data = report.rows.map((r) => ({ name: categoryLabel(r, categoryCols), value: Number(r[metric.key]) || 0 }));
  let truncated = false;
  if (isTimeSeries) {
    data.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // Ranked horizontal bars: long category labels ("Model Town · General Medicine") stay readable.
    data = [...data].sort((a, b) => b.value - a.value);
    if (data.length > MAX_CHART_ROWS) {
      data = data.slice(0, MAX_CHART_ROWS);
      truncated = true;
    }
  }
  const longestLabel = data.reduce((m, d) => Math.max(m, d.name.length), 0);
  const categoryWidth = Math.min(240, Math.max(90, Math.round(longestLabel * 6.6) + 12));
  const chartHeight = isTimeSeries ? 300 : Math.max(200, data.length * 30 + 40);

  return (
    <Card
      title={`${metric.label} by ${categoryName}`}
      subtitle={truncated ? `Top ${MAX_CHART_ROWS} of ${report.rows.length} rows; the table lists all rows.` : undefined}
      actions={metrics.length > 1 && (
        <label className="inline-field">
          <span>Metric</span>
          <select value={metric.key} onChange={(e) => setMetricKey(e.target.value)}>
            {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </label>
      )}
    >
      <div className="chart-box" style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          {isTimeSeries ? (
            <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="name" tick={AXIS_TICK} stroke={CHART.axis} minTickGap={16} />
              <YAxis tick={AXIS_TICK} stroke={CHART.axis} width={48} />
              <Tooltip content={<ChartTooltip valueFormatter={(v) => fmtNum(v, Number.isInteger(v) ? 0 : 2)} />} />
              <Line type="monotone" dataKey="value" name={metric.label} stroke={CHART.series1} strokeWidth={2}
                dot={data.length <= 31 ? { r: 3 } : false} activeDot={{ r: 5 }} />
            </LineChart>
          ) : (
            <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid horizontal={false} stroke={CHART.grid} />
              <XAxis type="number" tick={AXIS_TICK} stroke={CHART.axis} />
              <YAxis type="category" dataKey="name" interval={0} width={categoryWidth} tick={AXIS_TICK} stroke={CHART.axis} />
              <Tooltip cursor={{ fill: 'rgba(15, 110, 116, 0.06)' }}
                content={<ChartTooltip valueFormatter={(v) => fmtNum(v, Number.isInteger(v) ? 0 : 2)} />} />
              <Bar dataKey="value" name={metric.label} fill={CHART.series1} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export default function ReportsPage() {
  const { scopeQuery, branchName } = useScope();
  const toast = useToast();
  const [draft, setDraft] = useState({ type: REPORT_TYPES[0].value, from: addDays(today(), -29), to: today() });
  const [params, setParams] = useState(draft);
  const [exporting, setExporting] = useState(false);
  const [formError, setFormError] = useState(null);

  const query = { type: params.type, from: params.from, to: params.to, ...scopeQuery, format: 'json' };
  const report = useResource('/admin/reports', query);
  const data = report.data && Array.isArray(report.data.rows) ? report.data : null;
  const typeInfo = REPORT_TYPES.find((t) => t.value === params.type);

  const validate = (p) => {
    if (!DATE_RE.test(p.from) || !DATE_RE.test(p.to)) return 'Choose both a start and an end date.';
    if (p.from > p.to) return 'The start date must be on or before the end date.';
    return null;
  };

  const run = (e) => {
    e?.preventDefault();
    const err = validate(draft);
    setFormError(err);
    if (err) return;
    if (JSON.stringify(draft) === JSON.stringify(params)) report.reload();
    else setParams(draft);
  };

  const exportCsv = async () => {
    const err = validate(draft);
    setFormError(err);
    if (err) return;
    setExporting(true);
    try {
      const name = await api.download(
        '/admin/reports',
        { type: draft.type, from: draft.from, to: draft.to, ...scopeQuery, format: 'csv' },
        `${draft.type}_${draft.from}_${draft.to}.csv`,
      );
      toast.success(`Exported ${name}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  const columns = (data?.columns || []).map((c) => ({
    key: c.key,
    label: c.label,
    align: data.rows.some((r) => typeof r[c.key] === 'number') ? 'right' : undefined,
    render: (r) => formatCell(r[c.key]),
  }));

  const setPreset = (days) => setDraft((d) => ({ ...d, from: addDays(today(), -(days - 1)), to: today() }));

  return (
    <div className="page">
      <PageHeader
        title="Reports"
        subtitle={`Historical analytics — ${branchName}. Export any report as CSV.`}
      />

      <Card>
        <form className="filter-bar" onSubmit={run}>
          <label className="inline-field grow">
            <span>Report</span>
            <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}>
              {REPORT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={draft.from} max={draft.to || undefined} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={draft.to} min={draft.from || undefined} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
          </label>
          <div className="preset-btns" role="group" aria-label="Date presets">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreset(7)}>7 days</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreset(30)}>30 days</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPreset(90)}>90 days</button>
          </div>
          <div className="filter-actions">
            <button type="submit" className="btn btn-primary" disabled={report.loading}>
              {report.loading ? <Spinner size="xs" /> : <Icon name="play" size={14} />} Generate
            </button>
            <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={exporting}>
              {exporting ? <Spinner size="xs" /> : <Icon name="download" size={16} />} Export CSV
            </button>
          </div>
        </form>
        {formError && <Banner kind="error">{formError}</Banner>}
      </Card>

      <ErrorBanner error={report.error} onRetry={() => report.reload()} title="Could not generate the report" />

      {report.loading && !data ? <Loading text="Generating report…" /> : data && (
        <>
          <ReportChart key={`${params.type}-${params.from}-${params.to}-${data.rows.length}`} report={data} />
          <Card
            title={data.title || typeInfo?.label}
            subtitle={`${params.from} to ${params.to} · ${branchName} · ${data.rows.length} row${data.rows.length === 1 ? '' : 's'}`}
          >
            {columns.length === 0 ? (
              <EmptyState title="The report has no columns" />
            ) : (
              <DataTable
                columns={columns}
                rows={data.rows}
                rowKey={(r, i) => i}
                emptyTitle="No data for this period"
                emptyText="Try a wider date range or another branch."
                pageSize={50}
                dense
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
}
