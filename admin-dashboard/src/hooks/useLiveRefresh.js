// Live refresh for monitoring screens (FR-15, NFR-01):
//  - re-fetch on socket events (debounced, so a burst of queue changes causes one request);
//  - polling fallback every `pollMs` while the socket is not connected.
import { useEffect, useRef } from 'react';
import { useRealtime } from '../context/RealtimeContext.jsx';

export function useLiveRefresh(refresh, {
  events = ['queue:updated', 'alert'],
  debounceMs = 1200,
  pollMs = 20000,
  filter,
} = {}) {
  const { on, status } = useRealtime();
  const refreshRef = useRef(refresh);
  const filterRef = useRef(filter);
  refreshRef.current = refresh;
  filterRef.current = filter;
  const eventsKey = events.join('|');

  useEffect(() => {
    let timer = null;
    const trigger = (payload) => {
      if (filterRef.current && !filterRef.current(payload)) return;
      clearTimeout(timer);
      timer = setTimeout(() => refreshRef.current(), debounceMs);
    };
    const offs = eventsKey.split('|').map((evt) => on(evt, trigger));
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [on, eventsKey, debounceMs]);

  useEffect(() => {
    if (status === 'live' || !pollMs) return undefined;
    const id = setInterval(() => refreshRef.current(), pollMs);
    return () => clearInterval(id);
  }, [status, pollMs]);

  return status;
}
