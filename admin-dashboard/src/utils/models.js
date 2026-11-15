// Helpers for model metrics (FR-22, Section 6.7.2).
import { fmtNum } from './format.js';

/**
 * Formats the "within ±10 minutes" share. The AI service may report it as a fraction (0.62)
 * or as a percentage (62); values <= 1 are treated as fractions.
 */
export function fmtShare(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const pct = n <= 1 ? n * 100 : n;
  return `${fmtNum(pct, 1)}%`;
}

/**
 * Relative MAE improvement over the baseline (Eq. 6.2) in percent:
 * positive = the model's MAE is lower (better) than the baseline's. Null when not computable.
 */
export function improvementVsBaseline(metrics) {
  if (metrics?.mae === null || metrics?.mae === undefined || metrics?.baselineMae === null || metrics?.baselineMae === undefined) {
    return null;
  }
  const mae = Number(metrics?.mae);
  const base = Number(metrics?.baselineMae);
  if (!Number.isFinite(mae) || !Number.isFinite(base) || base <= 0) return null;
  return ((base - mae) / base) * 100;
}

/** Plain-language names of the 14 model features (FR-06 / Section 6.4 feature table). */
export const FEATURE_LABELS = {
  patients_ahead: 'Patients ahead in the queue',
  priority_ahead: 'Priority patients ahead',
  doctor_avg_consult: "Doctor's average consult time",
  doctor_recent_consult: "Doctor's recent consult time",
  interruptions_last_hour: 'Skips / recalls in the last hour',
  session_started: 'Session already started',
  minutes_to_start: 'Minutes until the session starts',
  hour_of_day: 'Hour of the day',
  day_of_week: 'Day of the week',
  appointments_ahead: 'Appointments ahead',
  department_load: 'Department load',
  doctor_id: 'Which doctor',
  department_id: 'Which department',
  branch_id: 'Which branch',
};

/** featureImportances { key: share } -> [{ key, label, percent }] sorted high -> low (top `limit`). */
export function importanceRows(importances, limit = 14) {
  if (!importances || typeof importances !== 'object') return [];
  return Object.entries(importances)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([key, v]) => ({ key, label: FEATURE_LABELS[key] || key, percent: Math.round(Number(v) * 1000) / 10 }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, limit);
}

/**
 * Random Forest vs Eq. 6.2 baseline on the same test rows. `better` says which side wins each row
 * ('model' | 'baseline' | null when a side is missing); lower wins for errors, higher for R² / ±10 min.
 */
export function scorecardRows(metrics) {
  if (!metrics) return [];
  const rows = [
    { key: 'mae', label: 'MAE (min)', model: metrics.mae, baseline: metrics.baselineMae, lowerIsBetter: true, digits: 2 },
    { key: 'rmse', label: 'RMSE (min)', model: metrics.rmse, baseline: metrics.baselineRmse, lowerIsBetter: true, digits: 2 },
    { key: 'r2', label: 'R²', model: metrics.r2, baseline: metrics.baselineR2, lowerIsBetter: false, digits: 3 },
    { key: 'within10', label: 'Within ±10 min', model: metrics.within10, baseline: metrics.baselineWithin10, lowerIsBetter: false, share: true },
  ];
  return rows.map((r) => {
    const m = Number(r.model);
    const b = Number(r.baseline);
    const has = r.model !== null && r.model !== undefined && r.baseline !== null && r.baseline !== undefined && Number.isFinite(m) && Number.isFinite(b);
    let better = null;
    if (has && m !== b) better = (r.lowerIsBetter ? m < b : m > b) ? 'model' : 'baseline';
    return { ...r, better };
  });
}
