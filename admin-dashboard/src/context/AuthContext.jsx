// Authentication state for the Admin Dashboard (FR-01 login, Section 3.2 roles).
// Only BRANCH_ADMIN and HOSPITAL_ADMIN may sign in here; the JWT lives in localStorage
// and any 401 from the API logs the user out.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onUnauthorized, session } from '../api/client.js';
import { isAdminRole, permissionsFor } from '../utils/roles.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => session.getToken());
  const [user, setUser] = useState(() => session.getUser());
  const [sessionExpired, setSessionExpired] = useState(false);

  const logout = useCallback((expired = false) => {
    session.clear();
    setToken(null);
    setUser(null);
    setSessionExpired(Boolean(expired));
  }, []);

  // 401 on any authenticated request -> logout (requirement of the admin app).
  useEffect(() => {
    onUnauthorized(() => logout(true));
    return () => onUnauthorized(null);
  }, [logout]);

  // Refresh the profile once on load so role / branch changes made elsewhere are picked up.
  useEffect(() => {
    if (!token) return undefined;
    const ctrl = new AbortController();
    api.get('/auth/me', undefined, { signal: ctrl.signal })
      .then((res) => {
        const fresh = res?.user;
        if (!fresh) return;
        if (!isAdminRole(fresh.role) || fresh.isActive === false) {
          logout(true);
          return;
        }
        session.saveUser(fresh);
        setUser(fresh);
      })
      .catch(() => { /* 401 handled globally; network errors keep the cached user */ });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const login = useCallback(async (identifier, password) => {
    const res = await api.login(identifier.trim(), password);
    if (!res?.token || !res?.user) {
      throw new ApiError(500, 'BAD_RESPONSE', 'Unexpected response from the server');
    }
    if (!isAdminRole(res.user.role)) {
      // Patients and staff have their own apps; do not keep their token here.
      const where = res.user.role === 'PATIENT'
        ? 'Patients should use the Smart OPD mobile app.'
        : 'Doctors and OPD, lab or pharmacy staff should use the Staff Dashboard.';
      throw new ApiError(403, 'FORBIDDEN',
        `This dashboard is for Branch and Hospital Administrators only. ${where}`);
    }
    session.save(res.token, res.user);
    setSessionExpired(false);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const value = useMemo(() => ({
    token,
    user,
    isAuthenticated: Boolean(token && user),
    permissions: permissionsFor(user),
    sessionExpired,
    login,
    logout,
  }), [token, user, sessionExpired, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
