// Branches (FR-14). Hospital admins create / edit / deactivate; branch admins see a read-only list.
import CrudPage from '../components/CrudPage.jsx';
import { ActiveBadge } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { fmtNum } from '../utils/format.js';

const COLUMNS = [
  { key: 'name', label: 'Branch', render: (r) => <strong>{r.name}</strong> },
  { key: 'address', label: 'Address', render: (r) => r.address || '—' },
  {
    key: 'location',
    label: 'Coordinates',
    sortable: false,
    searchValue: (r) => `${r.latitude} ${r.longitude}`,
    render: (r) => (
      <span className="mono small">{fmtNum(r.latitude, 4)}, {fmtNum(r.longitude, 4)}</span>
    ),
  },
  { key: 'status', label: 'Status', render: (r) => <ActiveBadge active={r.status !== 'INACTIVE'} /> },
];

const isCoordinate = (v, limit) => v !== '' && Number.isFinite(Number(v)) && Math.abs(Number(v)) <= limit;

export default function BranchesPage() {
  const { permissions } = useAuth();
  const { reloadBranches } = useScope();
  const canManage = permissions.manageBranches;

  return (
    <CrudPage
      title="Branches"
      subtitle="Hospital branches with their location (used for distance in branch recommendations, FR-08)."
      itemName="branch"
      endpoint="/admin/branches"
      columns={COLUMNS}
      initialSort={{ key: 'name', dir: 'asc' }}
      readOnlyNote={canManage ? null : 'Branches are managed by the Hospital Administrator. You have read-only access.'}
      canCreate={canManage}
      canEdit={() => canManage}
      canRemove={() => canManage}
      isActive={(r) => r.status !== 'INACTIVE'}
      onChanged={reloadBranches}
      emptyValues={{ name: '', address: '', latitude: '', longitude: '', status: 'ACTIVE' }}
      toForm={(r) => ({
        name: r.name || '',
        address: r.address || '',
        latitude: r.latitude ?? '',
        longitude: r.longitude ?? '',
        status: r.status || 'ACTIVE',
      })}
      fields={[
        { name: 'name', label: 'Branch name', required: true, placeholder: 'e.g. Model Town' },
        {
          name: 'status', label: 'Status', type: 'select', required: true, placeholder: false,
          options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }],
        },
        { name: 'address', label: 'Address', full: true, placeholder: 'Street, area, city' },
        { name: 'latitude', label: 'Latitude', type: 'number', step: 'any', required: true, min: -90, max: 90, placeholder: '31.4834' },
        { name: 'longitude', label: 'Longitude', type: 'number', step: 'any', required: true, min: -180, max: 180, placeholder: '74.3245' },
      ]}
      validate={(v) => ({
        // Empty values are reported as "required" by the generic form validation.
        latitude: v.latitude === '' || isCoordinate(v.latitude, 90) ? undefined : 'Latitude must be between -90 and 90',
        longitude: v.longitude === '' || isCoordinate(v.longitude, 180) ? undefined : 'Longitude must be between -180 and 180',
      })}
      toPayload={(v) => ({
        name: v.name.trim(),
        address: v.address?.trim() || null,
        latitude: Number(v.latitude),
        longitude: Number(v.longitude),
        status: v.status,
      })}
    />
  );
}
