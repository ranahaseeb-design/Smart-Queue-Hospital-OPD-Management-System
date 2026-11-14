// Sliding congestion alert strip for the Live Overview (FR-17, Upgrade 2026 "Live Overview").
// Shows one entry per department that is HIGH (amber) or CRITICAL (crimson, pulsing) — live or
// forecast — straight from GET /admin/alerts. Each entry can be dismissed (kept for this browser
// session; it comes back if the department escalates) and links to the Workload what-if
// ("Simulate staffing fix →" = /workload?departmentId=…).
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon.jsx';
import { stripAlerts } from '../utils/overview.js';
import { formatHour, timeAgo } from '../utils/format.js';

const STORAGE_KEY = 'smartopd.admin.dismissedAlerts';
const VISIBLE = 3;

function readDismissed() {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(set) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set].slice(-200)));
  } catch {
    /* storage blocked: dismissals last for this page view */
  }
}

export default function AlertStrip({ alerts, moreHref = '#alerts' }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => stripAlerts(alerts, dismissed), [alerts, dismissed]);

  const dismiss = useCallback((key) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(key);
      writeDismissed(next);
      return next;
    });
  }, []);

  const shown = expanded ? items : items.slice(0, VISIBLE);
  const hidden = items.length - shown.length;

  return (
    <section className="alert-strip" aria-label="Congestion alerts" aria-live="polite" aria-relevant="additions">
      {shown.map((a) => {
        const lvl = String(a.level).toLowerCase();
        const where = [a.departmentName, a.branchName].filter(Boolean).join(' · ');
        const when = a.source === 'FORECAST' ? `Forecast ${formatHour(a.at)}` : `Live · ${timeAgo(a.at)}`;
        return (
          <article key={a.key} className={`strip-alert strip-${lvl}`} data-level={a.level}>
            <span className="strip-pulse" aria-hidden="true" />
            <Icon name="alert" size={18} className="strip-icon" />
            <div className="strip-text">
              <div className="strip-head">
                <strong className="strip-level">{a.level}</strong>
                <span className="strip-where">{where || 'Department'}</span>
                <span className="strip-when">{when}{a.count > 1 ? ` · ${a.count} alerts` : ''}</span>
              </div>
              {a.message && <p className="strip-msg">{a.message}</p>}
            </div>
            <div className="strip-actions">
              {a.departmentId !== undefined && a.departmentId !== null && (
                <Link className="btn btn-sm strip-cta" to={`/workload?departmentId=${encodeURIComponent(a.departmentId)}`}>
                  Simulate staffing fix <span aria-hidden="true">→</span>
                </Link>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm strip-dismiss"
                onClick={() => dismiss(a.key)}
                aria-label={`Dismiss ${a.level} alert for ${where || 'this department'}`}
                title="Dismiss"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          </article>
        );
      })}
      {(hidden > 0 || expanded) && items.length > VISIBLE && (
        <div className="strip-more">
          <button type="button" className="link-btn" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? 'Show fewer' : `+${hidden} more congested department${hidden === 1 ? '' : 's'}`}
          </button>
          <a className="link-btn" href={moreHref}>All alerts</a>
        </div>
      )}
    </section>
  );
}
