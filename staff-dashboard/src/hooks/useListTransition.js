// Animated insert / remove of list rows without an animation library (Decision 9): new rows get
// phase 'enter' (CSS keyframe), removed rows stay in place for a moment with phase 'exit' and are then
// dropped. Under prefers-reduced-motion nothing is kept back and nothing animates.
import { useEffect, useState } from 'react';

export const LIST_TRANSITION_MS = 320;

/** True when the user asked the OS for reduced motion (false outside a browser). */
export function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Merge the next items into the currently rendered rows.
 * - rows still present take the fresh item and keep their phase ('enter' stays until settled)
 * - new keys come in with phase 'enter'
 * - keys that disappeared stay at their previous position with phase 'exit'
 * @param {Array<{key: string, item: any, phase: 'idle'|'enter'|'exit'}>} rendered
 * @param {any[]} items
 * @param {(item: any) => string|number} getKey
 * @param {{ animate?: boolean }} [opts] animate=false returns the plain list (reduced motion)
 */
export function mergeTransition(rendered, items, getKey, { animate = true } = {}) {
  const next = (Array.isArray(items) ? items : []).map((item) => ({ key: String(getKey(item)), item }));
  if (!animate) return next.map((r) => ({ ...r, phase: 'idle' }));

  const prevByKey = new Map((rendered || []).map((r) => [r.key, r]));
  const nextKeys = new Set(next.map((r) => r.key));
  const result = next.map((r) => {
    const prev = prevByKey.get(r.key);
    if (!prev) return { ...r, phase: 'enter' };
    return { ...r, phase: prev.phase === 'exit' ? 'enter' : prev.phase };
  });

  // Re-insert leaving rows after the row that preceded them before (or at the top).
  (rendered || []).forEach((r, index) => {
    if (nextKeys.has(r.key)) return;
    let anchor = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      const k = rendered[i].key;
      const at = result.findIndex((x) => x.key === k);
      if (at !== -1) {
        anchor = at;
        break;
      }
    }
    result.splice(anchor + 1, 0, { key: r.key, item: r.item, phase: 'exit' });
  });
  return result;
}

/** Drop rows that finished leaving and settle entering rows. */
export function settleTransition(rendered) {
  return rendered.filter((r) => r.phase !== 'exit').map((r) => (r.phase === 'idle' ? r : { ...r, phase: 'idle' }));
}

/**
 * Rows to render for `items`, with transition phases. The first render shows every row as 'idle'
 * (no animation on page load).
 */
export function useListTransition(items, getKey, duration = LIST_TRANSITION_MS) {
  const [state, setState] = useState(() => ({
    items,
    rows: mergeTransition([], items, getKey, { animate: false }),
  }));

  // Derived state: merge synchronously during render when the list changes, so a stale list is never
  // painted (React re-runs the component before committing).
  let rows = state.rows;
  if (state.items !== items) {
    rows = mergeTransition(state.rows, items, getKey, { animate: !prefersReducedMotion() });
    setState({ items, rows });
  }

  const animating = rows.some((r) => r.phase !== 'idle');
  useEffect(() => {
    if (!animating) return undefined;
    const id = setTimeout(() => setState((s) => ({ ...s, rows: settleTransition(s.rows) })), duration);
    return () => clearTimeout(id);
  }, [animating, rows, duration]);

  return rows;
}
