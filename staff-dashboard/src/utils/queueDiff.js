// Screen-reader announcements for live queue changes (Decision 7: aria-live="polite" for queue changes).
// Compares two GET /service-points/:id/queue responses and describes what changed in a short sentence.
import { queueBadge } from './format.js';

const MAX_LISTED = 3;

function listNumbers(tokens) {
  const shown = tokens.slice(0, MAX_LISTED).map((t) => t.displayNumber);
  const more = tokens.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/**
 * @param {object|null} prev previous queue response (null on first load: nothing is announced)
 * @param {object|null} next new queue response
 * @returns {string} announcement, '' when nothing worth announcing changed
 */
export function describeQueueChange(prev, next) {
  if (!prev || !next) return '';
  const parts = [];

  const prevServing = prev.nowServing || null;
  const nextServing = next.nowServing || null;
  if (nextServing && (!prevServing || prevServing.id !== nextServing.id)) {
    parts.push(`Now serving ${nextServing.displayNumber}.`);
  } else if (nextServing && prevServing && prevServing.status !== nextServing.status && nextServing.status === 'IN_SERVICE') {
    parts.push(`${nextServing.displayNumber} is in service.`);
  } else if (!nextServing && prevServing) {
    parts.push(`${prevServing.displayNumber} is no longer being served.`);
  }

  const prevWaiting = Array.isArray(prev.waiting) ? prev.waiting : [];
  const nextWaiting = Array.isArray(next.waiting) ? next.waiting : [];
  const prevById = new Map(prevWaiting.map((t) => [t.id, t]));
  const nextIds = new Set(nextWaiting.map((t) => t.id));

  const joined = nextWaiting.filter((t) => !prevById.has(t.id));
  if (joined.length === 1) parts.push(`${joined[0].displayNumber} joined the queue.`);
  else if (joined.length > 1) parts.push(`${joined.length} patients joined the queue: ${listNumbers(joined)}.`);

  const servingId = nextServing ? nextServing.id : null;
  const left = prevWaiting.filter((t) => !nextIds.has(t.id) && t.id !== servingId);
  if (left.length === 1) parts.push(`${left[0].displayNumber} left the waiting queue.`);
  else if (left.length > 1) parts.push(`${left.length} tokens left the waiting queue.`);

  nextWaiting.forEach((t) => {
    const before = prevById.get(t.id);
    if (before && Number(before.priorityLevel) !== Number(t.priorityLevel)) {
      parts.push(`${t.displayNumber} is now ${queueBadge(t).label}.`);
    }
  });

  return parts.join(' ');
}
