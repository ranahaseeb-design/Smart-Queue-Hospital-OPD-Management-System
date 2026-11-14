import Icon from './Icon.jsx';
import { queueBadge, statusLabel } from '../utils/format.js';

/**
 * Queue badge (FR-13, Upgrade 2026 Decision 2): EMERGENCY (pulsing crimson), ELDERLY /
 * DIFFERENTLY_ABLED (amber), APPOINTMENT (blue), NORMAL (slate). Always shows the word, never colour
 * alone. NORMAL is hidden unless `showNormal`; APPOINTMENT needs `fromAppointment`.
 */
export default function PriorityBadge({ level, category, fromAppointment = false, showNormal = false, large = false }) {
  const badge = queueBadge({ priorityLevel: level, priorityCategory: category, fromAppointment });
  if (badge.kind === 'NORMAL' && !showNormal) return null;
  return (
    <span
      className={`badge badge--${badge.tone}${large ? ' badge--lg' : ''}`}
      title={`Priority level ${Number(level) || 0}${badge.kind === 'APPOINTMENT' ? ' · checked-in appointment' : ''}`}
      data-kind={badge.kind}
    >
      {badge.tone === 'emergency' && <Icon name="alert" />}
      {badge.tone === 'appointment' && <Icon name="calendar" />}
      {badge.label}
    </span>
  );
}

const STATUS_TONES = {
  WAITING: 'neutral',
  CALLED: 'info',
  IN_SERVICE: 'primary',
  COMPLETED: 'success',
  SKIPPED: 'warning',
};

/** Token status chip (design system "StatusChip"): soft background, dot and the status word. */
export function StatusChip({ status, label }) {
  const tone = STATUS_TONES[status] || 'neutral';
  return (
    <span className={`chip chip--${tone} chip--dot status--${String(status || '').toLowerCase()}`}>
      {label || statusLabel(status)}
    </span>
  );
}
