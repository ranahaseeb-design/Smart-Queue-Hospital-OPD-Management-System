// Today's summary for the service point (Table 4.19 "Today's summary").
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
    { key: 'completed', label: 'Completed', value: s.completedToday ?? 0, tone: 'success' },
    { key: 'waiting', label: 'Waiting', value: s.waiting ?? 0, tone: 'primary' },
    { key: 'skipped', label: 'Skipped', value: s.skippedToday ?? 0, tone: 'warning' },
    { key: 'avgWait', label: 'Avg. wait', value: formatAverage(s.avgWaitMinutes) },
    { key: 'avgConsult', label: serviceLabel, value: formatAverage(s.avgConsultMinutes) },
  ];
  return (
    <section className="card" aria-labelledby="summary-heading">
      <h2 id="summary-heading" className="section-title">
        Today’s summary
      </h2>
      <dl className="tiles">
        {tiles.map((t) => (
          <div key={t.key} className={`tile${t.tone ? ` tile--${t.tone}` : ''}`}>
            <dt className="tile-label">{t.label}</dt>
            <dd className="tile-value">{t.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
