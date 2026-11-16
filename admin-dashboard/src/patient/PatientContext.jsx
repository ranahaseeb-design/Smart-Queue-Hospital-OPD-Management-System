// Patient portal state shared by the booking page, the token pass and the demo drawer:
// the signed-in patient, the current booking selection, a refresh signal (bumped after demo
// load or a live queue event) and one Socket.IO connection (FR-05, NFR-01).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { API_URL } from '../api/client.js';
import { papi, patientToken, patientUser, storePatientUser } from './patientApi.js';

const PatientContext = createContext(null);

export function PatientProvider({ children }) {
  const [user, setUserState] = useState(() => patientUser());
  const [unread, setUnread] = useState(0);
  const [selection, setSelection] = useState({ areaId: 'model-town', specialty: null, branchId: null, doctorId: null });
  const [refreshTick, setRefreshTick] = useState(0);
  const [live, setLive] = useState(false);
  const socketRef = useRef(null);
  const listeners = useRef(new Set());

  const bumpRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  /** Profile saved on the profile page: update the header and the stored session copy. */
  const setUser = useCallback((next) => {
    setUserState(next);
    storePatientUser(next);
  }, []);

  /** Unread in-app notifications (FR-11) for the header badge. */
  const refreshUnread = useCallback(async () => {
    try {
      const rows = await papi.notifications();
      setUnread(rows.filter((n) => !n.isRead).length);
    } catch {
      /* badge only: keep the last count */
    }
  }, []);
  useEffect(() => {
    refreshUnread();
  }, [refreshUnread]);

  useEffect(() => {
    const token = patientToken();
    if (!token) return undefined;
    const socket = io(API_URL, { auth: { token }, transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    socket.on('connect', () => setLive(true));
    socket.on('disconnect', () => setLive(false));
    socket.on('connect_error', () => setLive(false));
    const relay = (event) => (payload) => listeners.current.forEach((fn) => fn(event, payload));
    socket.on('notification', () => setUnread((n) => n + 1));
    for (const event of ['token:updated', 'notification', 'queue:updated']) socket.on(event, relay(event));
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /** Listen to live events: fn(eventName, payload). Returns an unsubscribe function. */
  const onLive = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  /** Join a socket room (e.g. token:<id>) the patient is allowed in; returns a leave function. */
  const watchRoom = useCallback((room) => {
    const socket = socketRef.current;
    if (!socket) return () => {};
    const join = () => socket.emit('subscribe', { room });
    if (socket.connected) join();
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      if (socket.connected) socket.emit('unsubscribe', { room });
    };
  }, []);

  const value = useMemo(
    () => ({ user, setUser, unread, refreshUnread, selection, setSelection, refreshTick, bumpRefresh, live, onLive, watchRoom }),
    [user, setUser, unread, refreshUnread, selection, refreshTick, bumpRefresh, live, onLive, watchRoom],
  );
  return <PatientContext.Provider value={value}>{children}</PatientContext.Provider>;
}

export function usePatient() {
  const ctx = useContext(PatientContext);
  if (!ctx) throw new Error('usePatient must be used inside PatientProvider');
  return ctx;
}
