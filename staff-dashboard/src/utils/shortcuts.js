// Keyboard shortcuts of the staff console. Single keys without modifiers, ignored while typing in a
// field, inside an open dialog / drawer, or when a modifier (Ctrl, Alt, Meta) is held, so they never
// clash with text entry or browser shortcuts.
import { ACTION_KEYS } from './stageActions.js';

export const SHORTCUTS = [
  { keys: ACTION_KEYS['call-next'], action: 'call-next', label: 'Call next patient' },
  { keys: ACTION_KEYS.start, action: 'start', label: 'Start service' },
  { keys: ACTION_KEYS.skip, action: 'skip', label: 'Skip (absent) — asks for confirmation' },
  { keys: ACTION_KEYS.recall, action: 'recall', label: 'Recall the last skipped token' },
  { keys: ACTION_KEYS.transfer, action: 'transfer', label: 'Transfer (opens the transfer dialog)' },
  { keys: ACTION_KEYS.linked, action: 'linked', label: 'Issue linked lab / pharmacy token' },
  { keys: ACTION_KEYS.complete, action: 'complete', label: 'Complete consultation' },
  { keys: '1', action: 'tab-waiting', label: 'Show the waiting queue' },
  { keys: '2', action: 'tab-skipped', label: 'Show skipped (recallable) tokens' },
  { keys: '?', action: 'help', label: 'Show / hide this list' },
];

const BY_KEY = new Map(SHORTCUTS.map((s) => [s.keys.toLowerCase(), s.action]));

function isEditable(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function insideDialog(el) {
  try {
    return Boolean(el && typeof el.closest === 'function' && el.closest('[role="dialog"]'));
  } catch {
    return false;
  }
}

/**
 * Map a keydown event to a console action, or null.
 * @param {KeyboardEvent|{key: string, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean,
 *        repeat?: boolean, defaultPrevented?: boolean, target?: any}} event
 * @param {{ dialogOpen?: boolean }} [opts]
 */
export function shortcutAction(event, { dialogOpen = false } = {}) {
  if (!event || event.defaultPrevented || event.repeat) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (dialogOpen || isEditable(event.target) || insideDialog(event.target)) return null;
  const key = String(event.key || '').toLowerCase();
  return BY_KEY.get(key) || null;
}
