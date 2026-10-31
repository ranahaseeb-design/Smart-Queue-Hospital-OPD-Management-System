// Socket.IO connection for live monitoring (FR-15 "Refresh through the real-time channel", NFR-01).
// Connects with the JWT, subscribes to the 'admin' room and re-broadcasts server events
// (queue:updated, alert) to interested components. Pages re-fetch REST resources on events.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';
import { useToast } from './ToastContext.jsx';

const RealtimeContext = createContext(null);
const EVENTS = ['queue:updated', 'alert'];

export function RealtimeProvider({ children }) {
  const { token } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState('connecting'); // connecting | live | offline
  const listeners = useRef(new Map()); // event -> Set(handler)
  const seenAlerts = useRef(new Set());

  useEffect(() => {
    if (!token) return undefined;
    setStatus('connecting');
    // autoConnect is off and the connection is opened on the next tick: React StrictMode (dev)
    // mounts, unmounts and re-mounts the provider synchronously, and closing a WebSocket that is
    // still CONNECTING logs a browser warning on every page load.
    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
      autoConnect: false,
    });
    const connectTimer = setTimeout(() => socket.connect(), 0);

    socket.on('connect', () => {
      setStatus('live');
      socket.emit('subscribe', { room: 'admin' });
    });
    socket.on('disconnect', () => setStatus('offline'));
    socket.on('connect_error', () => setStatus('offline'));

    for (const evt of EVENTS) {
      socket.on(evt, (payload) => {
        const set = listeners.current.get(evt);
        if (set) set.forEach((fn) => { try { fn(payload); } catch { /* listener errors must not break others */ } });
      });
    }

    // Congestion alerts (FR-17) also surface as a toast. The backend re-uses the alert id per
    // department (e.g. "live-3") and emits again when the level rises (HIGH -> CRITICAL), so the
    // duplicate guard keys on id + level + time, not on the id alone.
    socket.on('alert', (a) => {
      const key = `${a?.id ?? a?.departmentId}|${a?.level}|${a?.at}`;
      if (seenAlerts.current.has(key)) return;
      seenAlerts.current.add(key);
      const where = [a?.branchName, a?.departmentName].filter(Boolean).join(' · ');
      toast.warning(a?.message || 'Congestion alert', {
        title: `${a?.level || 'HIGH'} congestion${where ? ` — ${where}` : ''}`,
      });
    });

    return () => {
      clearTimeout(connectTimer);
      if (socket.connected) socket.emit('unsubscribe', { room: 'admin' });
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [token, toast]);

  const value = useMemo(() => ({
    status,
    /** Subscribe to a server event; returns an unsubscribe function. */
    on(event, handler) {
      if (!listeners.current.has(event)) listeners.current.set(event, new Set());
      listeners.current.get(event).add(handler);
      return () => listeners.current.get(event)?.delete(handler);
    },
  }), [status]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used inside RealtimeProvider');
  return ctx;
}
