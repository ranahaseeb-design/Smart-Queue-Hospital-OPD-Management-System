// Doctor schedules (FR-14): weekly sessions per doctor, day of week 1 = Mon ... 7 = Sun, times HH:mm.
// Schedules drive "available today", appointment slots (FR-10) and capacity for congestion (Eq. 6.5).
// Schedules are hard-deleted (API contract), so the remove action is labelled "Delete".
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import CrudPage from '../components/CrudPage.jsx';
import { Card } from '../components/ui.jsx';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useScope } from '../context/ScopeContext.jsx';
import { useDoctors, useServicePoints } from '../hooks/useLookups.js';
import { DAYS_OF_WEEK, dayName, toHHmm } from '../utils/format.js';

const toMinutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Seven-column week view of one doctor's sessions. */
function WeekStrip({ rows }) {
  return (
    <Card title="Week at a glance" bodyClassName="week-strip">
      {DAYS_OF_WEEK.map((d) => {
        const sessions = rows
          .filter((r) => Number(r.dayOfWeek) === d.value)
          .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
        return (
          <div key={d.value} className={`week-day ${sessions.length ? '' : 'off'}`}>
            <span className="week-day-name">{d.short}</span>
            {sessions.length ? sessions.map((s) => (
              <span key={s.id} className="week-session" title={s.servicePointName}>
                {toHHmm(s.startTime)}–{toHHmm(s.endTime)}
                <small>{s.servicePointName}</small>
              </span>
            )) : <span className="muted small">Off</span>}
          </div>
        );
      })}
    </Card>
  );
}

export default function SchedulesPage() {
  const { permissions } = useAuth();
  const { scopeQuery, branchName } = useScope();
  const [params, setParams] = useSearchParams();
  const doctorId = params.get('doctorId') || '';
  const doctors = useDoctors(scopeQuery);
  const servicePoints = useServicePoints(scopeQuery);
  const canManage = permissions.manageMasterData;

  const doctorById = useMemo(
    () => new Map(doctors.list.map((d) => [String(d.id), d])),
    [doctors.list],
  );
  const selectedDoctor = doctorById.get(doctorId);

  const setDoctor = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('doctorId', id); else next.delete('doctorId');
    setParams(next, { replace: true });
  };

  const doctorOptions = doctors.list
    .filter((d) => d.isActive !== false)
    .map((d) => ({ value: String(d.id), label: `${d.fullName} — ${d.specialty || d.departmentName}${d.branchName ? ` (${d.branchName})` : ''}` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  /** OPD rooms in the doctor's branch (a doctor consults in an OPD room). */
  const roomOptions = (docId, currentSpId) => {
    const doc = doctorById.get(String(docId));
    return servicePoints.list
      .filter((sp) => sp.type === 'OPD')
      .filter((sp) => !doc || Number(sp.branchId) === Number(doc.branchId))
      .filter((sp) => sp.isActive !== false || String(sp.id) === String(currentSpId))
      .map((sp) => ({ value: String(sp.id), label: `${sp.name}${doc ? '' : ` — ${sp.branchName || ''}`}` }));
  };

  const columns = [
    {
      key: 'dayOfWeek', label: 'Day', sortValue: (r) => Number(r.dayOfWeek) * 10000 + (toMinutes(toHHmm(r.startTime)) ?? 0),
      searchValue: (r) => dayName(r.dayOfWeek, false), render: (r) => <strong>{dayName(r.dayOfWeek, false)}</strong>,
    },
    {
      key: 'time', label: 'Session', sortable: false,
      render: (r) => <span className="mono">{toHHmm(r.startTime)} – {toHHmm(r.endTime)}</span>,
    },
    ...(doctorId ? [] : [{ key: 'doctorName', label: 'Doctor' }]),
    { key: 'servicePointName', label: 'Room' },
    { key: 'maxPatients', label: 'Max patients', align: 'right', render: (r) => r.maxPatients ?? 'No limit' },
  ];

  const filterToolbar = (
    <label className="inline-field">
      <span>Doctor</span>
      <select value={doctorId} onChange={(e) => setDoctor(e.target.value)} aria-label="Filter by doctor">
        <option value="">All doctors</option>
        {doctorOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );

  return (
    <CrudPage
      title="Schedules"
      subtitle={selectedDoctor
        ? `Weekly OPD sessions of ${selectedDoctor.fullName} (${selectedDoctor.specialty || selectedDoctor.departmentName}).`
        : `Weekly OPD sessions of doctors — ${branchName}. Pick a doctor to see the week at a glance.`}
      itemName="schedule"
      endpoint="/admin/schedules"
      query={{ ...scopeQuery, doctorId: doctorId || undefined }}
      columns={columns}
      initialSort={{ key: 'dayOfWeek', dir: 'asc' }}
      toolbar={filterToolbar}
      canCreate={canManage}
      canEdit={() => canManage}
      canRemove={() => canManage}
      removeLabel="Delete"
      rowName={(r) => `${r.doctorName || 'Doctor'}, ${dayName(r.dayOfWeek, false)} ${toHHmm(r.startTime)}–${toHHmm(r.endTime)}`}
      summary={(rows) => (doctorId && rows.length ? <WeekStrip rows={rows} /> : null)}
      emptyText={doctorId ? 'This doctor has no sessions yet.' : undefined}
      emptyValues={() => ({
        doctorId, servicePointId: '', days: [], dayOfWeek: '', startTime: '09:00', endTime: '13:00', maxPatients: '',
      })}
      toForm={(r) => ({
        doctorId: String(r.doctorId ?? ''),
        servicePointId: String(r.servicePointId ?? ''),
        dayOfWeek: String(r.dayOfWeek ?? ''),
        days: [],
        startTime: toHHmm(r.startTime),
        endTime: toHHmm(r.endTime),
        maxPatients: r.maxPatients ?? '',
      })}
      fields={(v, mode) => [
        { name: 'doctorId', label: 'Doctor', type: 'select', required: true, options: doctorOptions, full: true },
        {
          name: 'servicePointId', label: 'OPD room', type: 'select', required: true,
          options: roomOptions(v.doctorId, v.servicePointId),
          help: v.doctorId ? undefined : 'Select the doctor first to list rooms of the same branch.',
        },
        { name: 'maxPatients', label: 'Max patients', type: 'number', min: 1, max: 500, integer: true, placeholder: 'No limit' },
        mode === 'create'
          ? { name: 'days', label: 'Days', type: 'days', required: true, full: true, help: 'One session is created for each selected day.' }
          : {
            name: 'dayOfWeek', label: 'Day', type: 'select', required: true,
            options: DAYS_OF_WEEK.map((d) => ({ value: String(d.value), label: d.label })),
          },
        { name: 'startTime', label: 'Start time', type: 'time', required: true },
        { name: 'endTime', label: 'End time', type: 'time', required: true },
      ]}
      validate={(v) => {
        const s = toMinutes(v.startTime);
        const e = toMinutes(v.endTime);
        // The room list depends on the doctor's branch; a room picked before switching the doctor
        // to another branch is no longer offered and must be chosen again.
        const roomValid = !v.servicePointId
          || roomOptions(v.doctorId, v.servicePointId).some((o) => o.value === String(v.servicePointId));
        return {
          endTime: s !== null && e !== null && e <= s ? 'End time must be after the start time' : undefined,
          servicePointId: roomValid ? undefined : "Select an OPD room in the doctor's branch",
        };
      }}
      toPayload={(v) => {
        const body = {
          doctorId: Number(v.doctorId),
          servicePointId: Number(v.servicePointId),
          startTime: v.startTime,
          endTime: v.endTime,
          maxPatients: v.maxPatients === '' || v.maxPatients === null ? null : Number(v.maxPatients),
        };
        if (v.dayOfWeek) body.dayOfWeek = Number(v.dayOfWeek);
        return body;
      }}
      customSubmit={async ({ mode, values, payload, row }) => {
        if (mode === 'edit') {
          await api.put(`/admin/schedules/${row.id}`, payload);
          return 'Schedule updated';
        }
        // Create one schedule row per selected day; stop at the first failure and report progress.
        const created = [];
        for (const day of values.days) {
          try {
            await api.post('/admin/schedules', { ...payload, dayOfWeek: Number(day) });
            created.push(dayName(day));
          } catch (err) {
            if (created.length) err.message = `${err.message} (already created: ${created.join(', ')})`;
            throw err;
          }
        }
        return `Created ${created.length} session${created.length === 1 ? '' : 's'} (${created.join(', ')})`;
      }}
    />
  );
}
