import { useEffect, useState } from 'react';

/** Current time, re-rendering every `intervalMs` (used for "waiting 12 min" counters). */
export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
