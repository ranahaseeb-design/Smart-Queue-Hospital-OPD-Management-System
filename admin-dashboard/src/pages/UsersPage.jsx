// Staff & Users (FR-14): user accounts and staff-to-service-point assignments.
// Branch admins may only manage STAFF accounts of their own branch; hospital admins manage all
// administrator and staff accounts (Section 3.2, "Manage staff accounts").
import { useState } from 'react';
import CrudPage from '../components/CrudPage.jsx';
import { ActiveBadge, Badge, Tabs } from '../components/ui.jsx';
import { api, errorMessage } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { useBranchField, useServicePoints } from '../hooks/useLookups.js';
import { ROLE_LABELS, ROLES, assignableRoles } from '../utils/roles.js';
import { MANAGED_ROLES, adminBranchIdPatch, usersRoleQuery } from '../utils/users.js';
import { ServicePointType } from './ServicePointsPage.jsx';

const ROLE_TONE = { HOSPITAL_ADMIN: 'primary', BRANCH_ADMIN: 'info', STAFF: 'success', PATIENT: 'neutral' };

function spLabel(sp, withBranch) {
  return `${sp.name} (${sp.type})${withBranch && sp.branchName ? ` — ${sp.branchName}` : ''}`;
}

function UsersTab({ tabs }) {
  const { user: me, permissions } = useAuth();
  const { scopeQuery, locked } = useScope();
  const branchField = useBranchField();
  const servicePoints = useServicePoints(scopeQuery);
  const [roleFilter, setRoleFilter] = useState('');
  const hospital = permissions.manageAdminAccounts;
  const roles = assignableRoles(me);

  // The admin users API manages STAFF, BRANCH_ADMIN and HOSPITAL_ADMIN accounts (API contract).
  // Patients register themselves in the mobile app: "All roles" does not fetch them (see
  // usersRoleQuery); hospital admins can still list them explicitly, read-only.
  const roleFilterOptions = hospital ? [...MANAGED_ROLES, ROLES.PATIENT] : [ROLES.STAFF];

  const manageable = (r) => r.role !== ROLES.PATIENT && (hospital || r.role === ROLES.STAFF);
  const canEditRow = (r) => manageable(r);
  const canRemoveRow = (r) => manageable(r) && r.id !== me?.id;

  const spOptions = servicePoints.list
    .filter((sp) => sp.isActive !== false)
    .map((sp) => ({ value: String(sp.id), label: spLabel(sp, !locked) }));

  const columns = [
    {
      key: 'fullName',
      label: 'Name',
      searchValue: (r) => `${r.fullName} ${r.email || ''} ${r.phone || ''}`,
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.fullName}{r.id === me?.id && <span className="muted small"> (you)</span>}</strong>
          <span className="muted small">{[r.email, r.phone].filter(Boolean).join(' · ') || '—'}</span>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      searchValue: (r) => ROLE_LABELS[r.role],
      render: (r) => (
        <span className="badge-row">
          <Badge tone={ROLE_TONE[r.role]}>{ROLE_LABELS[r.role] || r.role}</Badge>
          {r.doctorId && <Badge tone="neutral">Doctor</Badge>}
        </span>
      ),
    },
    {
      key: 'scope',
      label: 'Branch / assignments',
      sortable: false,
      searchValue: (r) => [
        r.adminBranchId ? branchField.branchNameById(r.adminBranchId) : '',
        ...(r.assignments || []).map((a) => `${a.servicePointName} ${a.branchName}`),
      ].join(' '),
      render: (r) => {
        if (r.role === ROLES.HOSPITAL_ADMIN) return <span className="muted">All branches</span>;
        if (r.role === ROLES.BRANCH_ADMIN) return branchField.branchNameById(r.adminBranchId);
        const list = r.assignments || [];
        if (!list.length) return <span className="muted">{r.role === ROLES.STAFF ? 'Not assigned' : '—'}</span>;
        return (
          <span className="chip-list">
            {list.map((a) => (
              <span key={a.servicePointId} className="chip" title={a.branchName}>
                {a.servicePointName}{!locked && a.branchName ? ` · ${a.branchName}` : ''}
              </span>
            ))}
          </span>
        );
      },
    },
    { key: 'isActive', label: 'Status', render: (r) => <ActiveBadge active={r.isActive !== false} /> },
  ];

  const roleToolbar = (
    <label className="inline-field">
      <span>Role</span>
      <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
        {roleFilterOptions.length > 1 && <option value="">All roles</option>}
        {roleFilterOptions.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>
    </label>
  );

  return (
    <CrudPage
      title="Staff & Users"
      subtitle={hospital
        ? 'Staff, branch administrator and hospital administrator accounts.'
        : 'Staff accounts of your branch. Doctors are created under Doctors.'}
      itemName="user"
      endpoint="/admin/users"
      query={{ ...scopeQuery, role: usersRoleQuery(hospital, roleFilter) }}
      columns={columns}
      initialSort={{ key: 'fullName', dir: 'asc' }}
      toolbar={roleToolbar}
      canCreate={permissions.manageUsers}
      canEdit={canEditRow}
      canRemove={canRemoveRow}
      isActive={(r) => r.isActive !== false}
      rowName={(r) => r.fullName}
      emptyValues={() => ({
        fullName: '', email: '', phone: '', password: '', role: ROLES.STAFF,
        adminBranchId: branchField.defaultBranchId, servicePointId: '', isActive: true,
      })}
      toForm={(r) => ({
        fullName: r.fullName || '',
        email: r.email || '',
        phone: r.phone || '',
        password: '',
        role: r.role,
        // The stored branch only: defaulting here would silently move the account on save.
        adminBranchId: r.adminBranchId ? String(r.adminBranchId) : '',
        servicePointId: '',
        isActive: r.isActive !== false,
      })}
      fields={(v, mode, row) => {
        // Administrators cannot change their own role or deactivate themselves (avoids lock-out).
        const self = mode === 'edit' && row?.id === me?.id;
        return [
          { name: 'fullName', label: 'Full name', required: true },
          {
            name: 'role', label: 'Role', type: 'select', required: true, placeholder: false,
            options: roles.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
            disabled: roles.length === 1 || self,
            help: self
              ? 'You cannot change your own role.'
              : roles.length === 1 ? 'Branch administrators can create staff accounts only.' : undefined,
          },
          { name: 'email', label: 'E-mail (login)', type: 'email', required: true },
          { name: 'phone', label: 'Phone', type: 'tel', placeholder: '03xx xxxxxxx' },
          {
            name: 'password',
            label: mode === 'create' ? 'Initial password' : 'New password',
            type: 'password',
            required: mode === 'create',
            minLength: 6,
            help: mode === 'create' ? 'At least 6 characters.' : 'Leave blank to keep the current password.',
          },
          v.role === ROLES.STAFF
            ? {
              // Staff home branch: hospital admins pick any branch; branch admins are fixed to theirs.
              name: 'adminBranchId', label: 'Home branch', type: 'select',
              placeholder: 'No home branch', options: branchField.options,
              disabled: branchField.locked,
              help: branchField.locked
                ? 'Staff accounts belong to your branch.'
                : 'The branch this staff member belongs to.',
            }
            : {
              name: 'adminBranchId', label: 'Administered branch', type: 'select', required: true,
              options: branchField.options, hidden: v.role !== ROLES.BRANCH_ADMIN,
            },
          {
            name: 'servicePointId', label: 'Assign to service point', type: 'select',
            placeholder: 'No assignment yet', options: spOptions,
            hidden: mode !== 'create' || v.role !== ROLES.STAFF,
            help: 'Optional. More assignments can be added on the Assignments tab.',
          },
          { name: 'isActive', label: 'Active', type: 'checkbox', checkboxLabel: 'Account is active', hidden: mode === 'create' || self },
        ];
      }}
      toPayload={(v, mode, row) => {
        const body = {
          fullName: v.fullName.trim(),
          email: v.email.trim(),
          phone: v.phone?.trim() || null,
          role: v.role,
          // Sent only when set or changed: a present null clears the branch on the backend.
          ...adminBranchIdPatch(v, mode, row),
          isActive: mode === 'create' ? true : Boolean(v.isActive),
        };
        if (v.password) body.password = v.password;
        return body;
      }}
      customSubmit={async ({ mode, values, payload, row }) => {
        if (mode === 'edit') {
          await api.put(`/admin/users/${row.id}`, payload);
          return 'User updated';
        }
        const created = await api.post('/admin/users', payload);
        const userId = created?.id ?? created?.user?.id;
        if (values.role === ROLES.STAFF && values.servicePointId && userId) {
          // The account already exists at this point, so an assignment failure must not
          // keep the form open (re-submitting would hit a duplicate e-mail conflict).
          try {
            await api.post('/admin/assignments', { userId, servicePointId: Number(values.servicePointId) });
          } catch (err) {
            return `Account created for ${payload.fullName}, but the assignment failed (${errorMessage(err)}). Add it on the Assignments tab.`;
          }
          return `Account created for ${payload.fullName} and assigned to the service point`;
        }
        return `Account created for ${payload.fullName}`;
      }}
    >
      {tabs}
    </CrudPage>
  );
}

function AssignmentsTab({ tabs }) {
  const { permissions } = useAuth();
  const { scopeQuery, locked } = useScope();
  const servicePoints = useServicePoints(scopeQuery);
  const staff = useResource('/admin/users', { ...scopeQuery, role: ROLES.STAFF });
  const canManage = permissions.manageUsers;

  const staffOptions = (Array.isArray(staff.data) ? staff.data : [])
    .filter((u) => u.isActive !== false)
    .map((u) => ({ value: String(u.id), label: `${u.fullName}${u.email ? ` (${u.email})` : ''}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const spOptions = servicePoints.list
    .filter((sp) => sp.isActive !== false)
    .map((sp) => ({ value: String(sp.id), label: spLabel(sp, !locked) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const columns = [
    { key: 'userName', label: 'Staff member', render: (r) => <strong>{r.userName}</strong> },
    { key: 'servicePointName', label: 'Service point' },
    { key: 'type', label: 'Type', render: (r) => <ServicePointType type={r.type} /> },
    { key: 'branchName', label: 'Branch', render: (r) => r.branchName || '—' },
  ];

  return (
    <CrudPage
      title="Staff & Users"
      subtitle="Which staff member works at which OPD room, lab or pharmacy counter. Staff only see the queues of their assigned service points."
      itemName="assignment"
      endpoint="/admin/assignments"
      query={scopeQuery}
      columns={columns}
      initialSort={{ key: 'userName', dir: 'asc' }}
      canCreate={canManage}
      canRemove={() => canManage}
      removeLabel="Remove"
      rowName={(r) => `${r.userName} → ${r.servicePointName}`}
      emptyValues={{ userId: '', servicePointId: '' }}
      fields={[
        { name: 'userId', label: 'Staff member', type: 'select', required: true, options: staffOptions, full: true },
        { name: 'servicePointId', label: 'Service point', type: 'select', required: true, options: spOptions, full: true },
      ]}
      toPayload={(v) => ({ userId: Number(v.userId), servicePointId: Number(v.servicePointId) })}
      removeMessage={(r) => (
        <>Remove <strong>{r.userName}</strong> from <strong>{r.servicePointName}</strong>? They will no longer see that queue in the Staff Dashboard.</>
      )}
    >
      {tabs}
    </CrudPage>
  );
}

export default function UsersPage() {
  const [tab, setTab] = useState('users');
  const tabs = (
    <Tabs
      value={tab}
      onChange={setTab}
      tabs={[
        { value: 'users', label: 'User accounts' },
        { value: 'assignments', label: 'Service point assignments' },
      ]}
    />
  );
  return tab === 'users' ? <UsersTab tabs={tabs} /> : <AssignmentsTab tabs={tabs} />;
}
