// Animated KPI tile for the Live Overview: count-up value (skipped under reduced motion), an
// optional sparkline from today's hourly trend, and the usual label / icon / hint.
import Icon from './Icon.jsx';
import Sparkline from './Sparkline.jsx';
import { useCountUp } from '../hooks/useMotion.js';
import { fmtNum } from '../utils/format.js';

export default function LiveKpiTile({
  label, value, unit, hint, tone = 'default', icon, decimals = 0, trend, trendLabels, sparkTone,
}) {
  const display = useCountUp(value);
  const hasValue = value !== null && value !== undefined && Number.isFinite(Number(value));
  const shown = hasValue ? fmtNum(display, decimals) : '—';
  return (
    <div className={`kpi kpi-live kpi-${tone}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon && <span className="kpi-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>}
      </div>
      <div className="kpi-value">
        {/* The final value is what assistive tech reads; the animated digits are decorative. */}
        <span aria-hidden="true">{shown}</span>
        <span className="sr-only">{hasValue ? fmtNum(value, decimals) : 'not available'}</span>
        {unit && hasValue && <span className="kpi-unit">{unit}</span>}
      </div>
      {trend && trend.length > 1 && (
        <div className="kpi-spark">
          <Sparkline values={trend} labels={trendLabels} label={label} tone={sparkTone || (tone === 'default' ? 'primary' : tone)} />
        </div>
      )}
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}
