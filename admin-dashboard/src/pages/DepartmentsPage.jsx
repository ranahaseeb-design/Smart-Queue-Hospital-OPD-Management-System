// Departments per branch (FR-14). Specialty names are standardised across branches so the
// recommendation engine (FR-08) can compare the same specialty in different branches.
import CrudPage from '../components/CrudPage.jsx';
import { ActiveBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useBranchField, useSpecialties } from '../hooks/useLookups.js';

export default function DepartmentsPage() {
  const { permissions } = useAuth();
  const { scopeQuery, branchName } = useScope();
  const branchField = useBranchField();
  const specialties = useSpecialties();
  const canManage = permissions.manageMasterData;

  const columns = [
    { key: 'name', label: 'Department', render: (r) => <strong>{r.name || r.specialty}</strong> },
    { key: 'specialty', label: 'Specialty' },
    {
      key: 'branchName',
      label: 'Branch',
      sortValue: (r) => r.branchName || branchField.branchNameById(r.branchId),
      searchValue: (r) => r.branchName || branchField.branchNameById(r.branchId),
      render: (r) => r.branchName || branchField.branchNameById(r.branchId),
    },
    { key: 'doctorCount', label: 'Doctors', align: 'right', render: (r) => r.doctorCount ?? '—' },
    { key: 'isActive', label: 'Status', render: (r) => <ActiveBadge active={r.isActive !== false} /> },
  ];

  return (
    <CrudPage
      title="Departments"
      subtitle={`OPD departments — ${branchName}.`}
      itemName="department"
      endpoint="/admin/departments"
      query={scopeQuery}
      columns={columns}
      initialSort={{ key: 'branchName', dir: 'asc' }}
      canCreate={canManage}
      canEdit={() => canManage}
      canRemove={() => canManage}
      isActive={(r) => r.isActive !== false}
      emptyValues={() => ({ branchId: branchField.defaultBranchId, specialty: '', name: '', isActive: true })}
      toForm={(r) => ({
        branchId: String(r.branchId ?? ''),
        specialty: r.specialty || '',
        name: r.name || '',
        isActive: r.isActive !== false,
      })}
      fields={(v, mode) => [
        branchField.field(),
        {
          name: 'specialty',
          label: 'Specialty',
          type: 'suggest',
          required: true,
          suggestions: specialties,
          placeholder: 'e.g. Cardiology',
          help: 'Use a standard specialty name so patients can be recommended the same specialty at other branches.',
        },
        { name: 'name', label: 'Display name', placeholder: 'Defaults to the specialty', full: true },
        { name: 'isActive', label: 'Active', type: 'checkbox', checkboxLabel: 'Department is active', hidden: mode === 'create' },
      ]}
      toPayload={(v) => ({
        branchId: Number(v.branchId),
        specialty: v.specialty.trim(),
        name: v.name?.trim() || v.specialty.trim(),
        isActive: Boolean(v.isActive),
      })}
    />
  );
}
