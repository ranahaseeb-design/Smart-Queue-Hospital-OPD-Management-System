// Loads a GET resource and re-loads it whenever the path or query changes.
// `reload({ silent: true })` refreshes in the background without clearing the current data,
// which is what live refreshes use so tables do not flicker.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

export function useResource(path, query, { enabled = true, initial = null } = {}) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled && path));
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const ctrlRef = useRef(null);
  const key = JSON.stringify(query || {});

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled || !path) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await api.get(path, JSON.parse(key), { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      setData(res);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) return;
      setError(err);
    } finally {
      if (!ctrl.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [path, key, enabled]);

  useEffect(() => {
    load();
    return () => ctrlRef.current?.abort();
  }, [load]);

  return { data, setData, error, loading, refreshing, updatedAt, reload: load };
}
