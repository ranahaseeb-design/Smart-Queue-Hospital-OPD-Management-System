// Lookup lists used by master-data forms (select options) and helpers for the branch field.
import { useMemo } from 'react';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from './useResource.js';

const asArray = (d) => (Array.isArray(d) ? d : []);

/**
 * Branch select support for forms. Branch admins are locked to their own branch (Section 3.2),
 * hospital admins default to the branch currently selected in the top bar.
 */
export function useBranchField() {
  const { branches, branchId, locked, branchNameById } = useScope();
  return useMemo(() => {
    const options = branches.map((b) => ({
      value: String(b.id),
      label: `${b.name}${b.status === 'INACTIVE' ? ' (inactive)' : ''}`,
    }));
    const defaultBranchId = branchId ? String(branchId) : (branches.length === 1 ? String(branches[0].id) : '');
    const field = (overrides = {}) => ({
      name: 'branchId',
      label: 'Branch',
      type: 'select',
      required: true,
      options,
      disabled: locked,
      help: locked ? 'Branch administrators manage their own branch only.' : undefined,
      ...overrides,
    });
    return { options, defaultBranchId, field, locked, branchNameById };
  }, [branches, branchId, locked, branchNameById]);
}

export function useDepartments(query) {
  const res = useResource('/admin/departments', query);
  return { ...res, list: asArray(res.data) };
}

export function useDoctors(query) {
  const res = useResource('/admin/doctors', query);
  return { ...res, list: asArray(res.data) };
}

export function useServicePoints(query) {
  const res = useResource('/admin/service-points', query);
  return { ...res, list: asArray(res.data) };
}

export function useSpecialties() {
  const res = useResource('/specialties');
  return asArray(res.data);
}
