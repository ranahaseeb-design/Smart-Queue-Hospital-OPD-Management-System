// Small presentational building blocks shared by all pages.
import Icon from './Icon.jsx';
import { errorMessage } from '../api/client.js';
import { timeAgo } from '../utils/format.js';

export function PageHeader({ title, subtitle, actions, children }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className = '', bodyClassName = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Spinner({ size = 'md', label = 'Loading' }) {
  return <span className={`spinner spinner-${size}`} role="status" aria-label={label} />;
}

export function Loading({ text = 'Loading…' }) {
  return (
    <div className="state state-loading">
      <Spinner /> <span>{text}</span>
    </div>
  );
}

export function EmptyState({ title = 'Nothing to show', children, icon = 'info' }) {
  return (
    <div className="state state-empty">
      <Icon name={icon} size={22} />
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}

/** Inline banner for errors, warnings and notes. */
export function Banner({ kind = 'info', title, children, action }) {
  const icon = kind === 'error' || kind === 'warning' ? 'alert' : kind === 'success' ? 'check' : 'info';
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'note'}>
      <Icon name={icon} size={18} />
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="banner-action">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ error, onRetry, title = 'Could not load data' }) {
  if (!error) return null;
  return (
    <Banner
      kind="error"
      title={title}
      action={onRetry && (
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => onRetry()}>
          <Icon name="refresh" size={14} /> Retry
        </button>
      )}
    >
      {errorMessage(error)}
    </Banner>
  );
}

export function Badge({ tone = 'neutral', children, title, icon }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

const CONGESTION_TONE = { NORMAL: 'good', HIGH: 'warning', CRITICAL: 'critical' };
const CONGESTION_ICON = { NORMAL: 'check', HIGH: 'alert', CRITICAL: 'alert' };

/** Congestion level badge (Eq. 6.5) - colour is always paired with an icon and a label. */
export function CongestionBadge({ level, ratio }) {
  const lvl = level || 'NORMAL';
  const pct = ratio !== null && ratio !== undefined && Number.isFinite(Number(ratio))
    ? ` · ${Math.round(Number(ratio) * 100)}%` : '';
  return (
    <Badge tone={CONGESTION_TONE[lvl] || 'neutral'} icon={CONGESTION_ICON[lvl]} title={`Congestion ${lvl}${pct}`}>
      {lvl}{pct}
    </Badge>
  );
}

export function ActiveBadge({ active, activeText = 'Active', inactiveText = 'Inactive' }) {
  return active
    ? <Badge tone="good">{activeText}</Badge>
    : <Badge tone="muted">{inactiveText}</Badge>;
}

export function KpiTile({ label, value, unit, hint, tone = 'default', icon }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-label">
        {icon && <Icon name={icon} size={15} />}
        <span>{label}</span>
      </div>
      <div className="kpi-value">
        {value ?? '—'}
        {unit && value !== null && value !== undefined && value !== '—' && <span className="kpi-unit">{unit}</span>}
      </div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export function LastUpdated({ at, refreshing }) {
  if (!at) return null;
  return (
    <span className="muted small last-updated">
      {refreshing ? <Spinner size="xs" /> : null} Updated {timeAgo(at)}
    </span>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          className={`tab ${value === t.value ? 'active' : ''}`}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Star rating display (FR-20). */
export function Stars({ value, max = 5 }) {
  const v = Math.round(Number(value) || 0);
  return (
    <span className="stars" aria-label={`${value} out of ${max}`} title={`${value} / ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <Icon key={i} name="star" size={14} filled={i < v} className={i < v ? 'star-on' : 'star-off'} />
      ))}
    </span>
  );
}
