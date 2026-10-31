// Doctors (FR-14). Creating a doctor also creates the doctor's STAFF login account
// (POST /admin/doctors creates the user and the doctor row in one request).
import { Link } from 'react-router-dom';
import CrudPage from '../components/CrudPage.jsx';
import Icon from '../components/Icon.jsx';
import { ActiveBadge, Banner } from '../components/ui.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useDepartments } from '../hooks/useLookups.js';
import { fmtNum } from '../utils/format.js';

export default function DoctorsPage() {
  const { permissions } = useAuth();
  const { scopeQuery, branchName, locked } = useScope();
  const departments = useDepartments(scopeQuery);
  const canManage = permissions.manageMasterData;

  const deptOptions = (currentId) => departments.list
    .filter((d) => d.isActive !== false || String(d.id) === String(currentId))
    .map((d) => ({
      value: String(d.id),
      label: `${d.name || d.specialty}${!locked && d.branchName ? ` — ${d.branchName}` : ''}${d.isActive === false ? ' (inactive)' : ''}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const columns = [
    {
      key: 'fullName',
      label: 'Doctor',
      render: (r) => (
        <div className="cell-stack">
          <strong>{r.fullName}</strong>
          <span className="muted small">{[r.email, r.phone].filter(Boolean).join(' · ')}</span>
        </div>
      ),
      searchValue: (r) => `${r.fullName} ${r.email} ${r.phone || ''}`,
    },
    {
      key: 'specialty',
      label: 'Department',
      render: (r) => (
        <div className="cell-stack">
          <span>{r.departmentName || r.specialty}</span>
          {!locked && r.branchName && <span className="muted small">{r.branchName}</span>}
        </div>
      ),
      searchValue: (r) => `${r.departmentName} ${r.specialty} ${r.branchName}`,
    },
    { key: 'avgConsultMinutes', label: 'Avg consult', align: 'right', render: (r) => `${fmtNum(r.avgConsultMinutes, 1)} min` },
    { key: 'isActive', label: 'Status', render: (r) => <ActiveBadge active={r.isActive !== false} /> },
  ];

  return (
    <CrudPage
      title="Doctors"
      subtitle={`Doctors and their consultation profile — ${branchName}. Weekly sessions are managed under Schedules.`}
      itemName="doctor"
      endpoint="/admin/doctors"
      query={scopeQuery}
      columns={columns}
      initialSort={{ key: 'fullName', dir: 'asc' }}
      canCreate={canManage}
      canEdit={() => canManage}
      canRemove={() => canManage}
      isActive={(r) => r.isActive !== false}
      rowName={(r) => r.fullName}
      extraRowActions={(r) => (
        <Link className="btn btn-sm btn-ghost" to={`/schedules?doctorId=${r.id}`} title="View weekly schedule">
          <Icon name="schedules" size={14} /> Schedule
        </Link>
      )}
      emptyValues={() => ({
        fullName: '', email: '', phone: '', password: '', departmentId: '', avgConsultMinutes: '10', isActive: true,
      })}
      toForm={(r) => ({
        fullName: r.fullName || '',
        email: r.email || '',
        phone: r.phone || '',
        password: '',
        departmentId: String(r.departmentId ?? ''),
        avgConsultMinutes: r.avgConsultMinutes ?? '',
        isActive: r.isActive !== false,
      })}
      formNote={(mode) => mode === 'create' && (
        <Banner kind="info">
          A Staff login account is created for the doctor with this e-mail and password.
          The doctor signs in to the Staff Dashboard to run the OPD queue.
        </Banner>
      )}
      fields={(v, mode) => [
        { name: 'fullName', label: 'Full name', required: true, placeholder: 'Dr. Sara Ahmed' },
        {
          name: 'departmentId', label: 'Department', type: 'select', required: true,
          options: deptOptions(v.departmentId),
          help: departments.loading ? 'Loading departments…' : (departments.list.length ? undefined : 'Create a department first.'),
        },
        { name: 'email', label: 'E-mail (login)', type: 'email', required: true, placeholder: 'doctor@hospital.pk' },
        { name: 'phone', label: 'Phone', type: 'tel', placeholder: '03xx xxxxxxx' },
        {
          name: 'password',
          label: mode === 'create' ? 'Initial password' : 'New password',
          type: 'password',
          required: mode === 'create',
          minLength: 6,
          help: mode === 'create' ? 'At least 6 characters.' : 'Leave blank to keep the current password.',
        },
        {
          name: 'avgConsultMinutes', label: 'Average consultation (min)', type: 'number', min: 1, max: 120, step: '0.5',
          help: 'Initial value for waiting-time estimates; refreshed from completed consultations.',
        },
        { name: 'isActive', label: 'Active', type: 'checkbox', checkboxLabel: 'Doctor is active', hidden: mode === 'create' },
      ]}
      toPayload={(v, mode) => {
        const body = {
          fullName: v.fullName.trim(),
          email: v.email.trim(),
          phone: v.phone?.trim() || null,
          departmentId: Number(v.departmentId),
        };
        if (v.avgConsultMinutes !== '' && v.avgConsultMinutes !== null) body.avgConsultMinutes = Number(v.avgConsultMinutes);
        if (mode === 'create') {
          body.password = v.password;
        } else {
          body.isActive = Boolean(v.isActive);
          if (v.password) body.password = v.password;
        }
        return body;
      }}
    />
  );
}
