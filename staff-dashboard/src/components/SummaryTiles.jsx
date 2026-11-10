// Today's summary for the service point (Table 4.19 "Today's summary") as KPI tiles.
import Icon from './Icon.jsx';
import { formatMinutes } from '../utils/format.js';

/** Average durations: "—" when unknown, "< 1 min" for very short averages instead of a misleading "0 min". */
function formatAverage(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = Number(minutes);
  if (m > 0 && m < 0.5) return '< 1 min';
  return formatMinutes(m);
}

export default function SummaryTiles({ summary, servicePointType }) {
  const s = summary || {};
  // OPD rooms hold consultations; laboratory and pharmacy counters serve patients.
  const serviceLabel = servicePointType && servicePointType !== 'OPD' ? 'Avg. service' : 'Avg. consult';
  const tiles = [
    { key: 'completed', label: 'Completed', value: s.completedToday ?? 0, tone: 'success', icon: 'checkCircle' },
    { key: 'waiting', label: 'Waiting', value: s.waiting ?? 0, tone: 'primary', icon: 'users' },
    { key: 'skipped', label: 'Skipped', value: s.skippedToday ?? 0, tone: 'warning', icon: 'skip' },
    { key: 'avgWait', label: 'Avg. wait', value: formatAverage(s.avgWaitMinutes), tone: 'primary', icon: 'clock' },
    { key: 'avgConsult', label: serviceLabel, value: formatAverage(s.avgConsultMinutes), tone: 'primary', icon: 'timer' },
  ];
  return (
    <section className="summary" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="overline">
        Today’s summary
      </h2>
      <dl className="kpi-grid">
        {tiles.map((t) => (
          <div key={t.key} className={`kpi kpi--${t.tone}`}>
            <dt className="kpi-label">
              <span className="kpi-icon" aria-hidden="true">
                <Icon name={t.icon} />
              </span>
              {t.label}
            </dt>
            <dd className="kpi-value">{t.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
