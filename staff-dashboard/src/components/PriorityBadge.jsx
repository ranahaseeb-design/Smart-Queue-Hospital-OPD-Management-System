import { priorityLabel, priorityTone } from '../utils/format.js';

/** Visual priority marker (FR-13): emergency = red, elderly / differently-abled = amber. */
export default function PriorityBadge({ level, category, showNormal = false, large = false }) {
  const label = priorityLabel(level, category);
  if (!label && !showNormal) return null;
  const tone = priorityTone(level);
  return (
    <span className={`badge badge--${tone}${large ? ' badge--lg' : ''}`} title={`Priority level ${Number(level) || 0}`}>
      {label || 'Normal'}
    </span>
  );
}
