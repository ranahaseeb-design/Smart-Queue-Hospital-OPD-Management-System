// Tiny inline-SVG sparkline for KPI tiles (today's hourly `trend` from /admin/dashboard).
// Colours come from CSS (tokens), so it follows the theme. Null hours break the line.
import { useId } from 'react';
import { sparkPath } from '../utils/overview.js';

export default function Sparkline({ values, labels = [], label, width = 120, height = 32, tone = 'primary' }) {
  const gradId = useId();
  const p = sparkPath(values, width, height);
  if (!p) return null;
  const firstIdx = values.findIndex((v) => v !== null && v !== undefined);
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null && v !== undefined);
  const summary = `${label ? `${label} today` : 'Today'}: ${Math.round(values[firstIdx])}${labels[firstIdx] ? ` at ${labels[firstIdx]}` : ''}`
    + ` to ${Math.round(values[lastIdx])}${labels[lastIdx] ? ` at ${labels[lastIdx]}` : ''}`
    + ` (low ${Math.round(p.min)}, high ${Math.round(p.max)})`;
  return (
    <svg
      className={`sparkline sparkline-${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={summary}
    >
      <title>{summary}</title>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="sparkline-stop-top" />
          <stop offset="100%" className="sparkline-stop-bottom" />
        </linearGradient>
      </defs>
      {p.area && <path d={p.area} fill={`url(#${gradId})`} className="sparkline-area" />}
      <path d={p.line} className="sparkline-line" fill="none" vectorEffect="non-scaling-stroke" />
      <circle cx={p.last.x} cy={p.last.y} r="2.5" className="sparkline-dot" />
    </svg>
  );
}
