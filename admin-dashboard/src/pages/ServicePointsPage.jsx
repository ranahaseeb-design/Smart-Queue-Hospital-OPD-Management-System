// Service points (FR-14): OPD consultation rooms, laboratory and pharmacy counters per branch.
import CrudPage from '../components/CrudPage.jsx';
import { ActiveBadge, Badge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useBranchField } from '../hooks/useLookups.js';

export const SERVICE_POINT_TYPES = [
  { value: 'OPD', label: 'OPD room' },
  { value: 'LAB', label: 'Laboratory counter' },
  { value: 'PHARMACY', label: 'Pharmacy counter' },
];

const TYPE_TONE = { OPD: 'info', LAB: 'violet', PHARMACY: 'teal' };

export function ServicePointType({ type }) {
  return <Badge tone={TYPE_TONE[type] || 'neutral'}>{type}</Badge>;
}

export default function ServicePointsPage() {
  const { permissions } = useAuth();
  const { scopeQuery, branchName } = useScope();
  const branchField = useBranchField();
  const canManage = permissions.manageMasterData;

  const columns = [
    { key: 'name', label: 'Name', render: (r) => <strong>{r.name}</strong> },
    { key: 'type', label: 'Type', render: (r) => <ServicePointType type={r.type} /> },
    {
      key: 'branchName',
      label: 'Branch',
      sortValue: (r) => r.branchName || branchField.branchNameById(r.branchId),
      searchValue: (r) => r.branchName || branchField.branchNameById(r.branchId),
      render: (r) => r.branchName || branchField.branchNameById(r.branchId),
    },
    { key: 'isActive', label: 'Status', render: (r) => <ActiveBadge active={r.isActive !== false} /> },
  ];

  return (
    <CrudPage
      title="Service Points"
      subtitle={`OPD rooms, lab and pharmacy counters — ${branchName}. Staff are assigned to service points under Staff & Users.`}
      itemName="service point"
      endpoint="/admin/service-points"
      query={scopeQuery}
      columns={columns}
      initialSort={{ key: 'branchName', dir: 'asc' }}
      canCreate={canManage}
      canEdit={() => canManage}
      canRemove={() => canManage}
      isActive={(r) => r.isActive !== false}
      emptyValues={() => ({ branchId: branchField.defaultBranchId, type: 'OPD', name: '', isActive: true })}
      toForm={(r) => ({
        branchId: String(r.branchId ?? ''),
        type: r.type || 'OPD',
        name: r.name || '',
        isActive: r.isActive !== false,
      })}
      fields={(v, mode) => [
        branchField.field(),
        { name: 'type', label: 'Type', type: 'select', required: true, placeholder: false, options: SERVICE_POINT_TYPES },
        { name: 'name', label: 'Name', required: true, placeholder: v.type === 'OPD' ? 'Room 4' : `${v.type === 'LAB' ? 'Lab' : 'Pharmacy'} Counter 1`, full: true },
        { name: 'isActive', label: 'Active', type: 'checkbox', checkboxLabel: 'Service point is active', hidden: mode === 'create' },
      ]}
      toPayload={(v) => ({
        branchId: Number(v.branchId),
        type: v.type,
        name: v.name.trim(),
        isActive: Boolean(v.isActive),
      })}
    />
  );
}
