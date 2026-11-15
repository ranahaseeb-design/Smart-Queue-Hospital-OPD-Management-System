// Model health banner for Forecasts (FR-17, FR-22): which engine produced the current forecasts
// (Random Forest in the AI service, the seasonal baseline chosen by the AI backtest, or the
// backend's fallback when the AI service was down), the backtest errors of the run, and the
// active waiting-time Random Forest's training size and validation MAE (GET /admin/forecast-status).
import { useEffect } from 'react';
import { useResource } from '../hooks/useResource.js';
import { fmtNum } from '../utils/format.js';

export default function ForecastStatusBanner({ refreshKey }) {
  const status = useResource('/admin/forecast-status');
  const { reload } = status;
  useEffect(() => {
    if (refreshKey) reload({ silent: true });
  }, [refreshKey, reload]);

  const s = status.data;
  if (!s) return null;
  const f = s.forecast;
  const rf = Boolean(f?.isRandomForest);
  const model = s.waitModel;
  const ev = f?.evaluation;

  return (
    <div className={`model-banner ${rf ? 'model-banner-ok' : 'model-banner-warn'}`} role="status">
      <div className="model-banner-main">
        <span className={`model-dot ${rf ? 'is-on' : ''}`} aria-hidden="true" />
        <strong>
          {f
            ? rf ? 'Forecasts: Random Forest Regressor (Active)' : `Forecasts: ${f.engine}`
            : 'Forecasts: none for today yet'}
        </strong>
        {ev && ev.rfMae != null && (
          <span className="model-facts">
            <span>RF backtest MAE {fmtNum(ev.rfMae, 2)}</span>
            <span>baseline MAE {fmtNum(ev.baselineMae, 2)}</span>
            {ev.trainRows != null && <span>{fmtNum(ev.trainRows, 0)} training hours</span>}
          </span>
        )}
      </div>
      <div className="model-banner-sub small">
        {f && (
          <>
            {fmtNum(f.rows, 0)} hourly rows{f.generatedAt ? ` · generated ${f.generatedAt.replace('T', ' ').slice(0, 16)}` : ''}
            {f.source === 'seasonal-baseline' && ' — the AI backtest found the seasonal baseline clearly more accurate this time.'}
            {f.source === 'baseline' && ' — the AI service was unavailable; run the forecast again once it is up.'}
            {' · '}
          </>
        )}
        {model ? (
          <>
            Waiting-time model: <strong>Random Forest {model.version}</strong> · {fmtNum(model.trainingRows, 0)} training samples
            {model.maeMinutes != null && ` · validation MAE ${fmtNum(model.maeMinutes, 2)} min`}
            {model.baselineMaeMinutes != null && ` (baseline ${fmtNum(model.baselineMaeMinutes, 2)} min)`}
          </>
        ) : s.aiAvailable ? 'No active waiting-time model yet.' : 'AI service unavailable — waits use the Eq. 6.2 baseline.'}
      </div>
    </div>
  );
}
