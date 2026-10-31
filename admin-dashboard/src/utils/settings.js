// Validation for system settings (FR-08 weights, FR-17 thresholds, FR-09/FR-10/FR-11 parameters).

export const WEIGHT_KEYS = ['wait', 'distance', 'congestion'];

const isNum = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v));

/** Returns a map of field path -> message. An empty object means the settings are valid. */
export function validateSettings(s) {
  const errors = {};
  const w = s?.recommendationWeights || {};
  let sum = 0;
  for (const k of WEIGHT_KEYS) {
    const v = w[k];
    if (!isNum(v) || Number(v) < 0 || Number(v) > 1) {
      errors[`recommendationWeights.${k}`] = 'Enter a value between 0 and 1';
    } else {
      sum += Number(v);
    }
  }
  if (!Object.keys(errors).length && Math.abs(sum - 1) > 0.001) {
    errors.recommendationWeights = `Weights must sum to 1 (currently ${sum.toFixed(2)})`;
  }

  const t = s?.congestionThresholds || {};
  if (!isNum(t.high) || Number(t.high) <= 0) errors['congestionThresholds.high'] = 'Enter a positive ratio';
  if (!isNum(t.critical) || Number(t.critical) <= 0) errors['congestionThresholds.critical'] = 'Enter a positive ratio';
  if (!errors['congestionThresholds.high'] && !errors['congestionThresholds.critical']
      && Number(t.high) >= Number(t.critical)) {
    errors.congestionThresholds = 'The HIGH threshold must be lower than the CRITICAL threshold';
  }

  const intField = (key, min, max, label) => {
    const v = s?.[key];
    if (!isNum(v) || !Number.isInteger(Number(v)) || Number(v) < min || Number(v) > max) {
      errors[key] = `${label} must be a whole number from ${min} to ${max}`;
    }
  };
  intField('alternativeSuggestionWaitMinutes', 1, 600, 'Wait minutes');
  intField('notifyPositionsAhead', 0, 50, 'Positions ahead');
  intField('slotMinutes', 5, 120, 'Slot length');
  return errors;
}

/** Converts form values (strings) into the numeric payload expected by PUT /admin/settings. */
export function normaliseSettings(s) {
  return {
    recommendationWeights: {
      wait: Number(s.recommendationWeights.wait),
      distance: Number(s.recommendationWeights.distance),
      congestion: Number(s.recommendationWeights.congestion),
    },
    congestionThresholds: {
      high: Number(s.congestionThresholds.high),
      critical: Number(s.congestionThresholds.critical),
    },
    alternativeSuggestionWaitMinutes: Number(s.alternativeSuggestionWaitMinutes),
    notifyPositionsAhead: Number(s.notifyPositionsAhead),
    slotMinutes: Number(s.slotMinutes),
  };
}

export const DEFAULT_THRESHOLDS = { high: 0.85, critical: 1.0 };

/** Congestion level from a ratio (Eq. 6.5): NORMAL < high <= HIGH < critical <= CRITICAL. */
export function congestionLevel(ratio, thresholds = DEFAULT_THRESHOLDS) {
  if (ratio === null || ratio === undefined || Number.isNaN(Number(ratio))) return 'NORMAL';
  const r = Number(ratio);
  if (r >= thresholds.critical) return 'CRITICAL';
  if (r >= thresholds.high) return 'HIGH';
  return 'NORMAL';
}
