// Live refresh for monitoring screens (FR-15, NFR-01):
//  - re-fetch on socket events (debounced, so a burst of queue changes causes one request);
//  - polling fallback every `pollMs` while the socket is not connected;
//  - one re-fetch when the socket comes back after a drop (events missed while offline).
import { useEffect, useRef } from 'react';
import { useRealtime } from '../context/RealtimeContext.jsx';

/**
 * True when the realtime status changes to 'live' after a drop: from 'offline', or from any
 * non-live status once the socket has been live before. The first 'connecting' -> 'live' of a
 * freshly opened page is not a reconnect (the page has just loaded its data).
 */
export function isReconnect(prevStatus, status, wasLive) {
  if (status !== 'live' || prevStatus === 'live' || prevStatus == null) return false;
  return prevStatus === 'offline' || Boolean(wasLive);
}

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

  // Catch up once after a reconnect: polling stops while live, so changes made while the
  // socket was down would otherwise stay invisible until the next event.
  const prevStatusRef = useRef(null);
  const wasLiveRef = useRef(false);
  useEffect(() => {
    if (isReconnect(prevStatusRef.current, status, wasLiveRef.current)) refreshRef.current();
    prevStatusRef.current = status;
    if (status === 'live') wasLiveRef.current = true;
  }, [status]);

  useEffect(() => {
    if (status === 'live' || !pollMs) return undefined;
    const id = setInterval(() => refreshRef.current(), pollMs);
    return () => clearInterval(id);
  }, [status, pollMs]);

  return status;
}
