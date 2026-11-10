import Icon from './Icon.jsx';

/** Icon in a soft circle, one-line title, one sentence and an optional action (design system "Empty state"). */
export default function EmptyState({ icon = 'inbox', title, children, action = null, compact = false }) {
  return (
    <div className={`empty-state${compact ? ' empty-state--compact' : ''}`}>
      <span className="empty-state-icon">
        <Icon name={icon} />
      </span>
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-text">{children}</p>}
      {action}
    </div>
  );
}
