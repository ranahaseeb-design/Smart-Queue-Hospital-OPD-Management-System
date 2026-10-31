// Branch scope (the branch filter in the top bar).
// Hospital admins can pick "All branches" or one branch (FR-15 input "Branch / department filter");
// branch admins are locked to their own branch (Section 3.2 "Own branch").
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const ScopeContext = createContext(null);
const STORAGE_KEY = 'smartopd.admin.branchFilter';

function readStoredBranch() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function ScopeProvider({ children }) {
  const { user, permissions } = useAuth();
  const [branches, setBranches] = useState([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [selected, setSelected] = useState(() => readStoredBranch());

  const loadBranches = useCallback(async () => {
    setBranchesLoading(true);
    try {
      const list = await api.get('/admin/branches');
      setBranches(Array.isArray(list) ? list : []);
    } catch {
      setBranches([]);
    } finally {
      setBranchesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) loadBranches();
  }, [user, loadBranches]);

  const locked = !permissions.allBranches;
  const branchId = locked ? (user?.adminBranchId ?? null) : selected;

  // Drop a stored selection that no longer exists.
  useEffect(() => {
    if (!locked && selected && branches.length && !branches.some((b) => b.id === selected)) {
      setSelected(null);
    }
  }, [branches, selected, locked]);

  const setBranchId = useCallback((id) => {
    if (locked) return;
    const v = id ? Number(id) : null;
    setSelected(v);
    try {
      if (v) localStorage.setItem(STORAGE_KEY, String(v));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }, [locked]);

  const value = useMemo(() => {
    const current = branches.find((b) => b.id === branchId) || null;
    return {
      branches,
      branchesLoading,
      reloadBranches: loadBranches,
      branchId,
      branch: current,
      branchName: current?.name || (branchId ? `Branch #${branchId}` : 'All branches'),
      locked,
      setBranchId,
      /** Query object to spread into admin requests (?branchId=). */
      scopeQuery: branchId ? { branchId } : {},
      branchNameById: (id) => branches.find((b) => b.id === Number(id))?.name || (id ? `Branch #${id}` : '—'),
    };
  }, [branches, branchesLoading, loadBranches, branchId, locked, setBranchId]);

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope must be used inside ScopeProvider');
  return ctx;
}
