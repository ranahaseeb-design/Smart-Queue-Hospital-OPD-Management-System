// Chart colours. Series colours come from a CVD-validated categorical order; congestion uses the
// reserved status colours and is always paired with a text label / badge (never colour alone).
export const CHART = {
  series1: '#2a78d6',   // blue - primary single series
  series2: '#eb6834',   // orange - second series
  ink: '#1f2a37',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  peakBand: 'rgba(208, 59, 59, 0.08)',
};

export const STATUS_COLORS = {
  NORMAL: '#0ca30c',
  HIGH: '#fab219',
  CRITICAL: '#d03b3b',
};

export const AXIS_TICK = { fill: CHART.muted, fontSize: 12 };

export function congestionColor(level) {
  return STATUS_COLORS[level] || CHART.series1;
}
