// Small presentational building blocks shared by all pages ("Clinical Calm" design system).
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

export function Card({ title, subtitle, overline, actions, children, className = '', bodyClassName = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions || overline) && (
        <header className="card-head">
          <div className="card-head-text">
            {overline && <span className="overline">{overline}</span>}
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

/** Shimmer block. `w` is a width class suffix (25 | 40 | 60 | 80 | 100). */
export function Skeleton({ w = 100, h = 'line', className = '' }) {
  return <span className={`skeleton skeleton-${h} skeleton-w${w} ${className}`} aria-hidden="true" />;
}

/** Skeleton card with a few text lines (replaces bare "Loading…" text). */
export function Loading({ text = 'Loading…', lines = 4 }) {
  return (
    <div className="state state-loading" role="status" aria-live="polite">
      <span className="sr-only">{text}</span>
      <Skeleton w={40} h="title" />
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} w={[100, 80, 60, 100, 40][i % 5]} />)}
    </div>
  );
}

/** Page-level skeleton: optional KPI row, then cards (chart / table placeholders). */
export function PageSkeleton({ text = 'Loading…', kpis = 0, cards = 1, chart = false }) {
  return (
    <div className="page-skeleton" role="status" aria-live="polite">
      <span className="sr-only">{text}</span>
      {kpis > 0 && (
        <div className="kpi-grid">
          {Array.from({ length: kpis }, (_, i) => (
            <div className="kpi" key={i} aria-hidden="true">
              <Skeleton w={60} />
              <Skeleton w={40} h="value" />
            </div>
          ))}
        </div>
      )}
      {chart && (
        <div className="card" aria-hidden="true">
          <Skeleton w={40} h="title" />
          <Skeleton h="chart" />
        </div>
      )}
      {Array.from({ length: cards }, (_, i) => (
        <div className="card" key={i} aria-hidden="true">
          <Skeleton w={25} h="title" />
          {Array.from({ length: 5 }, (_, j) => <Skeleton key={j} w={[100, 80, 100, 60, 80][j]} h="row" />)}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title = 'Nothing to show', children, icon = 'inbox', action }) {
  return (
    <div className="state state-empty">
      <span className="state-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
      <strong className="state-title">{title}</strong>
      {children && <p className="state-text">{children}</p>}
      {action && <div className="state-action">{action}</div>}
    </div>
  );
}

/** Inline banner for errors, warnings and notes. */
export function Banner({ kind = 'info', title, children, action }) {
  const icon = kind === 'error' || kind === 'warning' ? 'alert' : kind === 'success' ? 'check' : 'info';
  return (
    <div className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'note'}>
      <Icon name={icon} size={18} className="banner-icon" />
      <div className="banner-body">
        {title && <strong className="banner-title">{title}</strong>}
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

/** Tones: neutral | primary | success | warning | danger | info | danger-solid. */
export function Badge({ tone = 'neutral', children, title, icon, dot = false }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

const CONGESTION_TONE = { NORMAL: 'success', HIGH: 'warning', CRITICAL: 'danger-solid' };
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
    ? <Badge tone="success" dot>{activeText}</Badge>
    : <Badge tone="neutral" dot>{inactiveText}</Badge>;
}

/** KPI tile: overline label, tabular value, optional hint and an icon in a soft circle. */
export function KpiTile({ label, value, unit, hint, tone = 'default', icon }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon && <span className="kpi-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>}
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
    <span className="last-updated">
      {refreshing ? <Spinner size="xs" /> : null} Updated {timeAgo(at)}
    </span>
  );
}

/** Underline tabs for page sections. */
export function Tabs({ tabs, value, onChange, label }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
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

/** Segmented control for small filters (report type, date shortcuts). */
export function Segmented({ options, value, onChange, label, size = 'md' }) {
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`segment ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
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
