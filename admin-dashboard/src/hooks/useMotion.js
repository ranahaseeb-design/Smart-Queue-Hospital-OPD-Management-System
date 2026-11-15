// Motion helpers (Decision 7: every animation respects prefers-reduced-motion; the tokens zero
// CSS durations, and JS animations such as the KPI count-up check it here).
import { useEffect, useRef, useState } from 'react';
import { countUpValue } from '../utils/overview.js';

const QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(QUERY)?.matches);
  } catch {
    return false;
  }
}

/** Live value of prefers-reduced-motion. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = globalThis.window?.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const update = () => setReduced(Boolean(mq.matches));
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

/**
 * Animates a number from its previous value to `value` (ease-out, `duration` ms). Returns the
 * value to display. Non-numeric values (null -> "—") and reduced motion skip the animation.
 * The first render counts up from 0 so the tiles "arrive"; later updates count from the last value.
 */
export function useCountUp(value, { duration = 700 } = {}) {
  const reduced = usePrefersReducedMotion();
  const numeric = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const [display, setDisplay] = useState(() => (numeric && !reduced ? 0 : value));
  const fromRef = useRef(numeric && !reduced ? 0 : value);

  useEffect(() => {
    if (!numeric || reduced || typeof requestAnimationFrame === 'undefined') {
      fromRef.current = value;
      setDisplay(value);
      return undefined;
    }
    const from = Number.isFinite(Number(fromRef.current)) ? Number(fromRef.current) : 0;
    const to = Number(value);
    if (from === to) {
      setDisplay(to);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const v = countUpValue(from, to, t);
      fromRef.current = v;
      setDisplay(v);
      if (t < 1) raf = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, numeric, reduced, duration]);

  return display;
}
