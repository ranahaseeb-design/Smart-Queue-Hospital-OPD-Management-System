// Authentication state for the Staff Dashboard (FR-01). Only STAFF users may sign in here;
// administrators use the separate Admin Dashboard and patients use the mobile app (Section 3.2).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from '../api.js';
import { getItem, getJSON, KEYS, removeItem, setItem, setJSON } from '../utils/storage.js';

const AuthContext = createContext(null);

export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

/** Explain why a non-staff account cannot use this dashboard. */
export function nonStaffMessage(role) {
  const base = 'This dashboard is only for doctors and OPD, laboratory and pharmacy staff.';
  if (role === 'PATIENT') return `${base} Patients should use the Smart OPD mobile app.`;
  if (role === 'BRANCH_ADMIN' || role === 'HOSPITAL_ADMIN') {
    return `${base} Administrator accounts should sign in to the Admin Dashboard.`;
  }
  return base;
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => getItem(KEYS.token));
  const [user, setUser] = useState(() => getJSON(KEYS.user));
  const [checking, setChecking] = useState(() => Boolean(getItem(KEYS.token)));
  const [notice, setNotice] = useState(null);

  const logout = useCallback((message) => {
    removeItem(KEYS.token);
    removeItem(KEYS.user);
    setToken(null);
    setUser(null);
    setNotice(typeof message === 'string' ? message : null);
  }, []);

  // Any authenticated request answered with 401 ends the session.
  useEffect(() => {
    setUnauthorizedHandler(() => logout(SESSION_EXPIRED_MESSAGE));
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  // Re-validate a stored session once on start-up. Network failures keep the cached user
  // so a brief outage does not throw staff out mid-shift; a 401 logs out via the handler above.
  useEffect(() => {
    if (!getItem(KEYS.token)) return undefined;
    let cancelled = false;
    api
      .me()
      .then((res) => {
        if (cancelled) return;
        const fresh = res && res.user;
        if (!fresh || fresh.role !== 'STAFF' || fresh.isActive === false) {
          logout(fresh ? nonStaffMessage(fresh.role) : SESSION_EXPIRED_MESSAGE);
          return;
        }
        setJSON(KEYS.user, fresh);
        setUser(fresh);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [logout]);

  const login = useCallback(async (identifier, password) => {
    const res = await api.login(identifier.trim(), password);
    const nextUser = res && res.user;
    if (!res || !res.token || !nextUser) {
      throw new ApiError(500, 'SERVER_ERROR', 'Unexpected response from the server.');
    }
    if (nextUser.role !== 'STAFF') {
      // Do not keep a token for accounts that are not allowed here.
      throw new ApiError(403, 'FORBIDDEN', nonStaffMessage(nextUser.role));
    }
    setItem(KEYS.token, res.token);
    setJSON(KEYS.user, nextUser);
    setToken(res.token);
    setUser(nextUser);
    setNotice(null);
    setChecking(false);
    return nextUser;
  }, []);

  const value = useMemo(
    () => ({ token, user, checking, notice, login, logout, clearNotice: () => setNotice(null) }),
    [token, user, checking, notice, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
