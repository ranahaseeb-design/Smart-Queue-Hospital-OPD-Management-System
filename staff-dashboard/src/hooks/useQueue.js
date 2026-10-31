// Live queue state for one service point (FR-05, FR-12).
// - Loads GET /api/service-points/:id/queue
// - Subscribes to Socket.IO room sp:<id> and re-fetches on 'queue:updated'
// - Falls back to polling every 15 s while the live channel is down (NFR-01)
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { POLL_INTERVAL_MS } from '../config.js';
import { connectQueueSocket } from '../socket.js';
import { useAuth } from '../auth/AuthContext.jsx';

const EVENT_DEBOUNCE_MS = 250;

export function useQueue(servicePointId) {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [connection, setConnection] = useState('connecting');

  const generation = useRef(0); // bumps when the service point changes; stale responses are dropped
  const inFlight = useRef(null);
  const pending = useRef(false);

  const fetchOnce = useCallback(async () => {
    const gen = generation.current;
    try {
      const q = await api.queue(servicePointId);
      if (gen !== generation.current) return;
      setData(q);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      if (gen !== generation.current) return;
      setError(e);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [servicePointId]);

  /** Re-fetch the queue; concurrent calls are coalesced into at most one extra request. */
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true;
      return inFlight.current;
    }
    const run = (async () => {
      do {
        pending.current = false;
        await fetchOnce();
      } while (pending.current);
    })();
    inFlight.current = run;
    try {
      await run;
    } finally {
      inFlight.current = null;
    }
    return undefined;
  }, [fetchOnce]);

  // Initial load and reset when switching service point.
  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    pending.current = false;
    setData(null);
    setError(null);
    setLoading(true);
    refresh();
  }, [servicePointId, refresh]);

  // Real-time channel.
  useEffect(() => {
    if (!token || servicePointId == null) return undefined;
    let debounce = null;
    const disconnect = connectQueueSocket({
      token,
      servicePointId,
      onStatusChange: (status) => {
        setConnection(status);
        // Catch up on anything missed while disconnected.
        if (status === 'connected') refresh();
      },
      onQueueUpdated: () => {
        clearTimeout(debounce);
        debounce = setTimeout(refresh, EVENT_DEBOUNCE_MS);
      },
      // A rejected socket handshake may mean the JWT expired; /auth/me returns 401 in that
      // case, which triggers the global logout handler in api.js.
      onAuthError: () => {
        api.me().catch(() => {});
      },
    });
    return () => {
      clearTimeout(debounce);
      disconnect();
    };
  }, [token, servicePointId, refresh]);

  // Fallback polling while the socket is not connected. Keyed on a boolean so that moving between
  // 'connecting' and 'disconnected' (socket.io retries every few seconds) never restarts the timer;
  // otherwise the interval would be cleared before it ever fired and nothing would be polled.
  const live = connection === 'connected';
  useEffect(() => {
    if (live) return undefined;
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  // Refresh when the tab becomes visible again (browsers throttle background timers).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  return { data, error, loading, lastUpdated, connection, refresh };
}
