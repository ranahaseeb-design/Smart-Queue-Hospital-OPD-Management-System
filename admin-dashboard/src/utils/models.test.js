// Model Management helpers: RF vs baseline scorecard and feature-importance rows.
import { describe, expect, it } from 'vitest';
import { importanceRows, scorecardRows } from './models.js';

describe('model scorecard', () => {
  it('marks the winner per metric (lower errors, higher R² and ±10 min win)', () => {
    const rows = scorecardRows({ mae: 4.1, baselineMae: 6.2, rmse: 6, baselineRmse: 5, r2: 0.8, baselineR2: 0.5, within10: 90, baselineWithin10: 90 });
    expect(Object.fromEntries(rows.map((r) => [r.key, r.better]))).toEqual({ mae: 'model', rmse: 'baseline', r2: 'model', within10: null });
  });

  it('leaves the winner empty when the baseline side is missing (older versions)', () => {
    const rows = scorecardRows({ mae: 4.1, baselineMae: 6.2, rmse: 6, r2: 0.8, within10: 90 });
    expect(rows.find((r) => r.key === 'rmse').better).toBeNull();
    expect(scorecardRows(null)).toEqual([]);
  });
});

describe('feature importances', () => {
  it('sorts, labels and converts shares to percent', () => {
    const rows = importanceRows({ hour_of_day: 0.05, patients_ahead: 0.6123, unknown_x: 0.1 }, 2);
    expect(rows).toEqual([
      { key: 'patients_ahead', label: 'Patients ahead in the queue', percent: 61.2 },
      { key: 'unknown_x', label: 'unknown_x', percent: 10 },
    ]);
    expect(importanceRows(undefined)).toEqual([]);
  });
});
