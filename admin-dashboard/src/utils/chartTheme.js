// Chart colours come from the design tokens (--chart-*, congestion and status tokens), read at
// runtime with getComputedStyle so the dark (default) and light themes both work. Congestion
// colours are always paired with a text label or badge (never colour alone).

const VARS = {
  series1: '--chart-1',
  series2: '--chart-2',
  series3: '--chart-3',
  series4: '--chart-4',
  series5: '--chart-5',
  series6: '--chart-6',
  grid: '--chart-grid',
  axis: '--chart-axis',
  reference: '--chart-reference',
  peak: '--chart-peak',
  normal: '--color-congestion-normal',
  high: '--color-congestion-high',
  critical: '--color-congestion-critical',
  danger: '--color-danger',
  dangerText: '--color-danger-text',
  peakBand: '--color-warning-soft',
  peakText: '--color-warning-text',
  primary: '--color-primary',
  accent: '--color-accent',
  live: '--color-live',
  cursor: '--color-surface-hover',
  textMuted: '--color-text-muted',
  surface: '--color-surface',
  fontSans: '--font-sans',
  textXs: '--text-xs',
};

export const CHART_TOKEN_VARS = VARS;

function remToPx(value, rootPx) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  return String(value).trim().endsWith('rem') ? n * rootPx : n;
}

/** Snapshot of the chart tokens for the current theme. */
export function readChartTheme() {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') {
    return { tick: {}, congestion: {} };
  }
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const t = Object.fromEntries(Object.entries(VARS).map(([k, v]) => [k, cs.getPropertyValue(v).trim()]));
  const rootPx = parseFloat(cs.fontSize) || 16;
  const fontSize = remToPx(t.textXs, rootPx);
  return {
    ...t,
    mode: root.dataset?.theme === 'light' ? 'light' : 'dark',
    fontSize,
    tick: { fill: t.axis, fontSize, fontFamily: t.fontSans },
    congestion: { NORMAL: t.normal, HIGH: t.high, CRITICAL: t.critical },
  };
}

export function congestionColor(theme, level) {
  return theme?.congestion?.[level] || theme?.series1;
}

/** Groups consecutive peak hours into bands, e.g. [{ x1: '10:00', x2: '12:00' }]. */
export function peakRanges(points, isMarked = (p) => p.isPeak) {
  const ranges = [];
  let current = null;
  (points || []).forEach((p, i) => {
    if (isMarked(p)) {
      if (current && current.end === i - 1) {
        current.x2 = p.hour;
        current.end = i;
      } else {
        current = { x1: p.hour, x2: p.hour, end: i };
        ranges.push(current);
      }
    }
  });
  return ranges.map(({ x1, x2 }) => ({ x1, x2 }));
}
