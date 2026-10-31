// Feedback review (FR-20): average rating, rating distribution and the list of patient comments.
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import { Card, EmptyState, ErrorBanner, KpiTile, LastUpdated, Loading, PageHeader, Stars } from '../components/ui.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { fmtNum, formatDate, formatDateTime } from '../utils/format.js';
import { AXIS_TICK, CHART } from '../utils/chartTheme.js';

export default function FeedbackPage() {
  const { scopeQuery, branchName, branchId } = useScope();
  const res = useResource('/admin/feedback', scopeQuery);
  const [ratingFilter, setRatingFilter] = useState('');

  const summary = res.data?.summary || {};
  const items = useMemo(() => (Array.isArray(res.data?.items) ? res.data.items : []), [res.data]);
  const dist = summary.distribution || {};
  const count = Number(summary.count) || 0;

  const chartData = [5, 4, 3, 2, 1].map((star) => {
    const n = Number(dist[String(star)]) || 0;
    return { name: `${star}★`, star, count: n, share: count ? Math.round((n / count) * 100) : 0 };
  });
  const positive = (Number(dist['4']) || 0) + (Number(dist['5']) || 0);
  const negative = (Number(dist['1']) || 0) + (Number(dist['2']) || 0);
  const withComments = items.filter((i) => i.comment && String(i.comment).trim()).length;

  const rows = ratingFilter ? items.filter((i) => String(i.rating) === ratingFilter) : items;

  const columns = [
    { key: 'rating', label: 'Rating', render: (r) => <Stars value={r.rating} /> },
    {
      key: 'comment', label: 'Comment', className: 'cell-wrap',
      render: (r) => (r.comment ? <span className="comment">{r.comment}</span> : <span className="muted">No comment</span>),
    },
    { key: 'patientName', label: 'Patient', render: (r) => r.patientName || '—' },
    ...(branchId ? [] : [{ key: 'branchName', label: 'Branch' }]),
    { key: 'visitDate', label: 'Visit', render: (r) => formatDate(r.visitDate) },
    { key: 'createdAt', label: 'Submitted', render: (r) => formatDateTime(r.createdAt) },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Feedback"
        subtitle={`Patient ratings of consultation and waiting experience — ${branchName}.`}
        actions={(
          <>
            <LastUpdated at={res.updatedAt} refreshing={res.refreshing} />
            <button type="button" className="btn btn-secondary" onClick={() => res.reload({ silent: true })} title="Refresh">
              <Icon name="refresh" size={16} />
            </button>
          </>
        )}
      />
      <ErrorBanner error={res.error} onRetry={() => res.reload()} />

      {res.loading && !res.data ? <Loading /> : res.data && (
        <>
          <div className="kpi-grid kpi-grid-4">
            <KpiTile
              label="Average rating"
              value={count ? fmtNum(summary.average, 2) : '—'}
              unit="/ 5"
              icon="star"
              tone="primary"
              hint={count ? <Stars value={summary.average} /> : 'No feedback yet'}
            />
            <KpiTile label="Responses" value={fmtNum(count)} icon="feedback" hint={`${fmtNum(withComments)} of ${fmtNum(items.length)} listed have a comment`} />
            <KpiTile label="Positive (4–5★)" value={count ? `${Math.round((positive / count) * 100)}%` : '—'} icon="check" tone="good" hint={`${fmtNum(positive)} responses`} />
            <KpiTile label="Negative (1–2★)" value={count ? `${Math.round((negative / count) * 100)}%` : '—'} icon="alert"
              tone={count && negative / count > 0.2 ? 'warning' : 'default'} hint={`${fmtNum(negative)} responses`} />
          </div>

          <div className="grid-side-main">
            <Card title="Rating distribution">
              {count === 0 ? <EmptyState title="No ratings yet" /> : (
                <div className="chart-box" style={{ height: 240 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
                      <CartesianGrid horizontal={false} stroke={CHART.grid} />
                      <XAxis type="number" allowDecimals={false} tick={AXIS_TICK} stroke={CHART.axis} />
                      <YAxis type="category" dataKey="name" width={40} tick={AXIS_TICK} stroke={CHART.axis} />
                      <Tooltip
                        cursor={{ fill: 'rgba(15, 110, 116, 0.06)' }}
                        content={<ChartTooltip valueFormatter={(v, k, row) => `${fmtNum(v)} (${row?.share ?? 0}%)`} />}
                      />
                      <Bar dataKey="count" name="Responses" fill={CHART.series1} radius={[0, 4, 4, 0]} maxBarSize={26}>
                        <LabelList dataKey="share" position="right" formatter={(v) => `${v}%`} fill={CHART.inkSecondary} fontSize={12} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card title="Comments">
              <DataTable
                columns={columns}
                rows={rows}
                initialSort={{ key: 'createdAt', dir: 'desc' }}
                emptyTitle="No feedback"
                emptyText={ratingFilter ? 'No feedback with this rating.' : 'Patients can rate a visit after a completed consultation.'}
                searchPlaceholder="Search comments, patients…"
                toolbar={(
                  <label className="inline-field">
                    <span>Rating</span>
                    <select value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value)}>
                      <option value="">All</option>
                      {[5, 4, 3, 2, 1].map((s) => <option key={s} value={String(s)}>{s} star{s === 1 ? '' : 's'}</option>)}
                    </select>
                  </label>
                )}
                pageSize={20}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
