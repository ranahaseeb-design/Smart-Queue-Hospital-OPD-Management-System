import Icon from './Icon.jsx';
import { priorityLabel, priorityTone, statusLabel } from '../utils/format.js';

/**
 * Visual priority marker (FR-13): emergency = danger, elderly / differently-abled = elevated (warning).
 * Always shows the word, never colour alone.
 */
export default function PriorityBadge({ level, category, showNormal = false, large = false }) {
  const label = priorityLabel(level, category);
  if (!label && !showNormal) return null;
  const tone = priorityTone(level);
  return (
    <span className={`badge badge--${tone}${large ? ' badge--lg' : ''}`} title={`Priority level ${Number(level) || 0}`}>
      {tone === 'emergency' && <Icon name="alert" />}
      {label || 'Normal'}
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
