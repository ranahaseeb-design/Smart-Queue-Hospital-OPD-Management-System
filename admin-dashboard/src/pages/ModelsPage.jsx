// Model Management (FR-22, Section 6.7) - Hospital Administrator only.
// Lists waiting-time model versions with their evaluation metrics, triggers retraining and
// activates a version. The backend proxies these calls to the AI service; when it is down the
// API answers 503 AI_UNAVAILABLE and waiting times keep using the baseline (Eq. 6.2).
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import ChartTooltip from '../components/ChartTooltip.jsx';
import { ConfirmDialog } from '../components/Modal.jsx';
import { Badge, Banner, Card, EmptyState, LastUpdated, PageHeader, PageSkeleton, Spinner } from '../components/ui.jsx';
import { api, ApiError, errorMessage } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { fmtNum, formatDateTime } from '../utils/format.js';
import { useChartTheme } from '../hooks/useChartTheme.js';
import { fmtShare, improvementVsBaseline } from '../utils/models.js';

const STATUS_TONE = { ACTIVE: 'success', CANDIDATE: 'info', REJECTED: 'danger', RETIRED: 'neutral' };

/** '32.7% lower' when the model's MAE beats the baseline, '4.0% higher' otherwise. */
function improvementText(imp) {
  return `${fmtNum(Math.abs(imp), 1)}% ${imp > 0 ? 'lower' : 'higher'}`;
}

function isAiUnavailable(err) {
  return err instanceof ApiError && (err.code === 'AI_UNAVAILABLE' || err.status === 503);
}

/**
 * Friendly AI_UNAVAILABLE notice. The backend's own message names the technical cause
 * (e.g. "fetch failed"); it is kept as a tooltip for administrators who need it.
 */
function AiUnavailableBanner({ error, retrainFailed, onRetry }) {
  return (
    <Banner
      kind="warning"
      title="AI service unavailable"
      action={onRetry && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={onRetry}>
          <Icon name="refresh" size={14} /> Retry
        </button>
      )}
    >
      <span title={errorMessage(error)}>
        {retrainFailed
          ? 'The model could not be retrained because the AI service is not reachable right now.'
          : 'Model versions cannot be loaded because the AI service is not reachable right now.'}
      </span>{' '}
      Patients still get waiting-time estimates: the backend uses the active model when it is loaded,
      otherwise the baseline formula (Eq. 6.2). Start the AI service (port 8000) and try again.
    </Banner>
  );
}

function MetricsList({ metrics }) {
  if (!metrics) return null;
  const imp = improvementVsBaseline(metrics);
  return (
    <dl className="metric-list">
      <div><dt>MAE</dt><dd>{fmtNum(metrics.mae, 2)} min</dd></div>
      <div><dt>RMSE</dt><dd>{fmtNum(metrics.rmse, 2)} min</dd></div>
      <div><dt>R²</dt><dd>{fmtNum(metrics.r2, 3)}</dd></div>
      <div><dt>Within ±10 min</dt><dd>{fmtShare(metrics.within10)}</dd></div>
      <div><dt>Baseline MAE</dt><dd>{fmtNum(metrics.baselineMae, 2)} min</dd></div>
      <div><dt>MAE vs. baseline</dt><dd className={imp !== null && imp > 0 ? 'text-good' : 'text-bad'}>{imp === null ? '—' : improvementText(imp)}</dd></div>
      <div><dt>Test rows</dt><dd>{fmtNum(metrics.testRows)}</dd></div>
    </dl>
  );
}

export default function ModelsPage() {
  const toast = useToast();
  const models = useResource('/admin/models');
  const chart = useChartTheme();
  const [retraining, setRetraining] = useState(false);
  const [retrainResult, setRetrainResult] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [activating, setActivating] = useState(null);
  const [activateBusy, setActivateBusy] = useState(false);

  const list = Array.isArray(models.data) ? models.data : [];
  const active = list.find((m) => m.isActive);
  const anySynthetic = list.some((m) => String(m.dataSource).toLowerCase() === 'synthetic');

  const retrain = async () => {
    setRetraining(true);
    setActionError(null);
    setRetrainResult(null);
    try {
      const res = await api.post('/admin/models/retrain');
      setRetrainResult(res);
      toast.success(`Training finished: ${res?.version || 'new version'} ${res?.activated ? 'activated' : res?.accepted ? 'accepted' : 'not accepted'}`);
      models.reload({ silent: true });
    } catch (err) {
      setActionError(err);
      if (!isAiUnavailable(err)) toast.error(err);
    } finally {
      setRetraining(false);
    }
  };

  const activate = async () => {
    if (!activating) return;
    setActivateBusy(true);
    setActionError(null);
    try {
      await api.post(`/admin/models/${encodeURIComponent(activating.version)}/activate`);
      toast.success(`Model ${activating.version} is now active`);
      setActivating(null);
      // The last training result ("... is now used for predictions") no longer describes the active model.
      setRetrainResult(null);
      models.reload({ silent: true });
    } catch (err) {
      setActivating(null);
      setActionError(err);
      if (!isAiUnavailable(err)) toast.error(err);
    } finally {
      setActivateBusy(false);
    }
  };

  const chartData = [...list]
    .sort((a, b) => String(a.trainedAt).localeCompare(String(b.trainedAt)))
    .slice(-10)
    .map((m) => ({ name: m.version, model: Number(m.metrics?.mae) || 0, baseline: Number(m.metrics?.baselineMae) || 0 }));

  const columns = [
    {
      key: 'version', label: 'Version', className: 'nowrap',
      render: (m) => (
        <div className="cell-stack">
          <strong className="mono">{m.version}</strong>
          {m.isActive && <Badge tone="success" icon="check">Active</Badge>}
        </div>
      ),
    },
    { key: 'trainedAt', label: 'Trained', className: 'nowrap', render: (m) => formatDateTime(m.trainedAt) },
    { key: 'trainingRows', label: 'Training rows', align: 'right', render: (m) => fmtNum(m.trainingRows) },
    {
      key: 'dataSource', label: 'Data',
      render: (m) => <Badge tone={String(m.dataSource).toLowerCase() === 'synthetic' ? 'warning' : 'neutral'}>{m.dataSource || '—'}</Badge>,
    },
    { key: 'status', label: 'Status', render: (m) => <Badge tone={STATUS_TONE[m.status] || 'neutral'}>{m.status}</Badge> },
    { key: 'mae', label: 'MAE', align: 'right', sortValue: (m) => Number(m.metrics?.mae), render: (m) => fmtNum(m.metrics?.mae, 2) },
    { key: 'rmse', label: 'RMSE', align: 'right', sortValue: (m) => Number(m.metrics?.rmse), render: (m) => fmtNum(m.metrics?.rmse, 2) },
    { key: 'r2', label: 'R²', align: 'right', sortValue: (m) => Number(m.metrics?.r2), render: (m) => fmtNum(m.metrics?.r2, 3) },
    { key: 'within10', label: '±10 min', align: 'right', sortValue: (m) => Number(m.metrics?.within10), render: (m) => fmtShare(m.metrics?.within10) },
    { key: 'baselineMae', label: 'Baseline MAE', align: 'right', sortValue: (m) => Number(m.metrics?.baselineMae), render: (m) => fmtNum(m.metrics?.baselineMae, 2) },
    {
      key: 'improvement', label: 'MAE vs. baseline', align: 'right',
      sortValue: (m) => improvementVsBaseline(m.metrics),
      render: (m) => {
        const imp = improvementVsBaseline(m.metrics);
        if (imp === null) return '—';
        return <span className={imp > 0 ? 'text-good' : 'text-bad'}>{improvementText(imp)}</span>;
      },
    },
    { key: 'testRows', label: 'Test rows', align: 'right', sortValue: (m) => Number(m.metrics?.testRows), render: (m) => fmtNum(m.metrics?.testRows) },
  ];

  const activateWarning = (m) => {
    const notes = [];
    const imp = improvementVsBaseline(m.metrics);
    if (imp !== null && imp <= 0) notes.push('Its MAE is not better than the baseline formula.');
    if (active?.metrics && Number(m.metrics?.mae) >= Number(active.metrics.mae)) {
      notes.push(`Its MAE (${fmtNum(m.metrics?.mae, 2)}) is not lower than the active model ${active.version} (${fmtNum(active.metrics.mae, 2)}).`);
    }
    return notes;
  };

  return (
    <div className="page">
      <PageHeader
        title="Model Management"
        subtitle="Waiting-time prediction models: evaluation metrics, retraining and activation (FR-22)."
        actions={(
          <>
            <LastUpdated at={models.updatedAt} refreshing={models.refreshing} />
            <button type="button" className="btn btn-secondary btn-icon" onClick={() => models.reload({ silent: true })} title="Refresh" aria-label="Refresh">
              <Icon name="refresh" size={16} />
            </button>
            <button type="button" className="btn btn-primary" onClick={retrain} disabled={retraining} aria-busy={retraining || undefined}>
              {retraining ? <Spinner size="xs" /> : <Icon name="play" size={14} />} {retraining ? 'Training…' : 'Retrain model'}
            </button>
          </>
        )}
      />

      <Banner kind="info" title="About these metrics">
        Metrics are computed on a chronological hold-out test period (the most recent 20% of completed tokens) and compared
        with the baseline formula (Eq. 6.2). A new version is only activated if it beats the baseline and the active model.
        {anySynthetic && ' Versions trained on synthetic data validate the pipeline only — their metrics are not real-world accuracy.'}
      </Banner>

      {retraining && (
        <Banner kind="info" title="Retraining in progress">
          Building the dataset, training the Random Forest model and evaluating it. This can take a little while.
        </Banner>
      )}

      {/* One AI notice for both the list and the last action, so the page never shows it twice. */}
      {(isAiUnavailable(actionError) || isAiUnavailable(models.error)) && (
        <AiUnavailableBanner
          error={isAiUnavailable(actionError) ? actionError : models.error}
          retrainFailed={isAiUnavailable(actionError)}
          onRetry={() => { setActionError(null); models.reload(); }}
        />
      )}
      {actionError && !isAiUnavailable(actionError) && (
        <Banner kind="error" title="Action failed">{errorMessage(actionError)}</Banner>
      )}

      {retrainResult && (
        <Card
          title={`Training result — ${retrainResult.version || 'new version'}`}
          actions={(
            <span className="badge-row">
              <Badge tone={retrainResult.accepted ? 'success' : 'danger'} icon={retrainResult.accepted ? 'check' : 'alert'}>
                {retrainResult.accepted ? 'Accepted' : 'Rejected'}
              </Badge>
              {retrainResult.activated && <Badge tone="success">Activated</Badge>}
            </span>
          )}
        >
          <p className="muted">
            {retrainResult.activated
              ? 'The new model performed better than the baseline and the previously active model, so it is now used for waiting-time predictions.'
              : retrainResult.accepted
                ? 'The new model beat the baseline but was not activated automatically. You can activate it from the table below.'
                : 'The new model did not perform better than the baseline / active model, so the active model stays in use.'}
          </p>
          <MetricsList metrics={retrainResult.metrics} />
        </Card>
      )}

      {models.error && !isAiUnavailable(models.error) && (
        <Banner kind="error" title="Could not load model versions">{errorMessage(models.error)}</Banner>
      )}

      {models.error && isAiUnavailable(models.error) && (
        <Card title="Model versions">
          <EmptyState icon="models" title="Model versions are not available while the AI service is offline">
            The list, metrics and activation come from the AI service. They appear here as soon as it is running again.
          </EmptyState>
        </Card>
      )}

      {models.loading && !models.data ? <PageSkeleton text="Loading model versions…" chart /> : !models.error && (
        <>
          {active ? (
            <Card title={`Active model — ${active.version}`} subtitle={`Trained ${formatDateTime(active.trainedAt)} on ${fmtNum(active.trainingRows)} rows (${active.dataSource}).`}>
              <MetricsList metrics={active.metrics} />
            </Card>
          ) : (
            <Banner kind="warning" title="No active model">
              Waiting times are currently estimated with the baseline formula (Eq. 6.2). Retrain to create a model version.
            </Banner>
          )}

          {chartData.length > 0 && (
            <Card title="MAE: model vs. baseline" subtitle="Lower is better. Mean absolute error in minutes on each version's test period.">
              <div className="chart-box chart-h-md">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barGap={2}>
                    <CartesianGrid vertical={false} stroke={chart.grid} />
                    <XAxis dataKey="name" tick={chart.tick} stroke={chart.grid} tickLine={false} />
                    <YAxis tick={chart.tick} stroke={chart.grid} tickLine={false} width={44} unit=" m" />
                    <Tooltip cursor={{ fill: chart.cursor }} content={<ChartTooltip valueFormatter={(v) => `${fmtNum(v, 2)} min`} />} />
                    <Legend verticalAlign="top" height={28} iconSize={10}
                      formatter={(v) => <span className="chart-legend-text">{v}</span>} />
                    <Bar dataKey="model" name="Model MAE" fill={chart.series1} radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="baseline" name="Baseline MAE" fill={chart.series2} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <Card title="Model versions">
            {list.length === 0 ? (
              <EmptyState icon="models" title="No model versions yet">Use “Retrain model” to train the first version.</EmptyState>
            ) : (
              <DataTable
                columns={columns}
                rows={list}
                rowKey="version"
                searchable={list.length > 10}
                initialSort={{ key: 'trainedAt', dir: 'desc' }}
                rowClassName={(m) => (m.isActive ? 'row-highlight' : undefined)}
                dense
                actions={(m) => (m.isActive ? <span className="muted small">In use</span> : (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    disabled={m.status === 'REJECTED'}
                    title={m.status === 'REJECTED' ? 'Rejected versions did not beat the baseline / active model' : 'Use this version for predictions'}
                    onClick={() => setActivating(m)}
                  >
                    <Icon name="check" size={14} /> Activate
                  </button>
                ))}
              />
            )}
          </Card>
        </>
      )}

      <ConfirmDialog
        open={Boolean(activating)}
        title="Activate model version"
        confirmLabel="Activate"
        tone="primary"
        busy={activateBusy}
        onCancel={() => !activateBusy && setActivating(null)}
        onConfirm={activate}
        message={activating && (
          <>
            <p>Use <strong className="mono">{activating.version}</strong> for all new waiting-time predictions?</p>
            {activateWarning(activating).map((n) => <Banner key={n} kind="warning">{n}</Banner>)}
          </>
        )}
      />
    </div>
  );
}
