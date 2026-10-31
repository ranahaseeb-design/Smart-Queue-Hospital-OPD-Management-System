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
