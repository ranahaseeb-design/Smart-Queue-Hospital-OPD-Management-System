// Service points the signed-in staff member is assigned to (GET /api/staff/service-points),
// plus the remembered choice when there is more than one (Section 4.2.2).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { getItem, KEYS, removeItem, setItem } from '../utils/storage.js';
import { useAuth } from './AuthContext.jsx';

const ServicePointsContext = createContext(null);

const POINTS_RETRY_MS = 10000;

export function ServicePointsProvider({ children }) {
  const { token, user } = useAuth();
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.servicePoints();
      setPoints(Array.isArray(list) ? list : []);
      setLoaded(true);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPoints([]);
    setLoaded(false);
    if (token && user) reload();
  }, [token, user && user.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // If the list could not be loaded (e.g. the server was briefly unreachable when the page opened),
  // retry quietly so the queue header regains the doctor's name and the remembered choice is saved.
  useEffect(() => {
    if (!error || loaded || !token) return undefined;
    const id = setTimeout(reload, POINTS_RETRY_MS);
    return () => clearTimeout(id);
  }, [error, loaded, token, reload]);

  const userId = user && user.id;

  const rememberedId = useCallback(() => (userId ? getItem(KEYS.servicePoint(userId)) : null), [userId]);

  const remember = useCallback(
    (id) => {
      if (!userId) return;
      if (id == null) removeItem(KEYS.servicePoint(userId));
      else setItem(KEYS.servicePoint(userId), String(id));
    },
    [userId],
  );

  const findPoint = useCallback((id) => points.find((p) => String(p.id) === String(id)) || null, [points]);

  const value = useMemo(
    () => ({ points, loading, loaded, error, reload, rememberedId, remember, findPoint }),
    [points, loading, loaded, error, reload, rememberedId, remember, findPoint],
  );

  return <ServicePointsContext.Provider value={value}>{children}</ServicePointsContext.Provider>;
}

export function useServicePoints() {
  const ctx = useContext(ServicePointsContext);
  if (!ctx) throw new Error('useServicePoints must be used inside <ServicePointsProvider>');
  return ctx;
}
