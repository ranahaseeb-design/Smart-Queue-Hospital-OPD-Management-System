// Department load matrix for the Live Overview (FR-15): one row per department with live queue,
// waits and a utilisation bar from the congestion ratio (Eq. 6.5; emerald < 70 %, amber 70–85 %,
// crimson > 85 %). Rows expand to list the department's doctors (`departments[].doctors` of
// GET /admin/dashboard). Older backends without `doctors` get an honest "not available" note.
import { Fragment, useState } from 'react';
import Icon from './Icon.jsx';
import { Badge, CongestionBadge, EmptyState } from './ui.jsx';
import { BAND_LABEL, utilisationBand } from '../utils/overview.js';
import { fmtMinutes, fmtNum, fmtPercent } from '../utils/format.js';

function nowServingText(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  return v.displayNumber || null;
}

function UtilisationBar({ ratio }) {
  const band = utilisationBand(ratio);
  const n = Number(ratio);
  const scale = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  return (
    <span className="util-cell" title={`Waiting ÷ remaining session capacity (Eq. 6.5) — ${BAND_LABEL[band]}`}>
      <span className={`util-bar util-${band}`} aria-hidden="true">
        <span style={{ transform: `scaleX(${scale})` }} />
        {Number.isFinite(n) && n > 1 && <i className="util-over" />}
      </span>
      <span className="util-value">{band === 'none' ? '—' : fmtPercent(ratio)}</span>
    </span>
  );
}

function DoctorList({ doctors, id }) {
  if (!Array.isArray(doctors)) {
    return (
      <p className="matrix-note" id={id}>
        <Icon name="info" size={14} /> Per-doctor detail is not provided by the server yet.
      </p>
    );
  }
  if (!doctors.length) {
    return <p className="matrix-note" id={id}><Icon name="info" size={14} /> No doctors are scheduled in this department today.</p>;
  }
  return (
    <div className="matrix-doctors-scroll" id={id}>
      <table className="matrix-doctors">
        <caption className="sr-only">Doctors</caption>
        <thead>
          <tr>
            <th scope="col">Doctor</th>
            <th scope="col">Room</th>
            <th scope="col" className="align-right">Waiting</th>
            <th scope="col">Now serving</th>
            <th scope="col" className="align-right">Avg consult</th>
            <th scope="col" className="align-right">Est. wait</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {doctors.map((d) => {
            const serving = nowServingText(d.nowServing);
            return (
              <tr key={d.doctorId ?? d.fullName}>
                <td><strong>{d.fullName || '—'}</strong></td>
                <td>{d.servicePointName || '—'}</td>
                <td className="align-right">{fmtNum(d.waiting)}</td>
                <td>{serving ? <span className="token-pill">{serving}</span> : <span className="muted">Idle</span>}</td>
                <td className="align-right">{d.avgConsultMinutes === null || d.avgConsultMinutes === undefined ? '—' : `${fmtNum(d.avgConsultMinutes, 1)} min`}</td>
                <td className="align-right">{fmtMinutes(d.estimatedWaitMinutes)}</td>
                <td>{d.acceptingNow ? <Badge tone="success" dot>Accepting</Badge> : <Badge tone="neutral" dot>Not accepting</Badge>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function DepartmentMatrix({ rows, showBranch = true, emptyText }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  if (!rows.length) {
    return <EmptyState icon="departments" title="No departments in scope">{emptyText}</EmptyState>;
  }

  return (
    <div className="matrix-scroll">
      <table className="table table-dense matrix">
        <caption className="sr-only">Department load, worst first</caption>
        <thead>
          <tr>
            <th scope="col">Department</th>
            <th scope="col" className="align-right">Waiting</th>
            <th scope="col" className="align-right col-md">Doctors</th>
            <th scope="col" className="align-right">Avg wait</th>
            <th scope="col" className="align-right col-lg">Max wait</th>
            <th scope="col" className="col-util">Utilisation</th>
            <th scope="col">Congestion</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const id = String(d.departmentId);
            const isOpen = open.has(id);
            const detailId = `dept-doctors-${id}`;
            const count = Array.isArray(d.doctors) ? d.doctors.length : null;
            return (
              <Fragment key={id}>
                <tr className={`matrix-row ${isOpen ? 'is-open' : ''} matrix-${String(d.congestionLevel || 'NORMAL').toLowerCase()}`}>
                  <td>
                    <button
                      type="button"
                      className="matrix-toggle"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? detailId : undefined}
                      onClick={() => toggle(id)}
                    >
                      <Icon name="chevronRight" size={16} className="matrix-chevron" />
                      <span className="cell-stack">
                        <strong>{d.name || d.specialty}</strong>
                        <span className="muted small">
                          {[showBranch ? d.branchName : null, count !== null ? `${count} doctor${count === 1 ? '' : 's'}` : null]
                            .filter(Boolean).join(' · ') || 'Show doctors'}
                        </span>
                      </span>
                    </button>
                  </td>
                  <td className="align-right"><strong>{fmtNum(d.waiting)}</strong></td>
                  <td className="align-right col-md">{fmtNum(d.activeDoctors)}</td>
                  <td className="align-right">{fmtMinutes(d.avgWaitMinutes)}</td>
                  <td className="align-right col-lg">{fmtMinutes(d.maxWaitMinutes)}</td>
                  <td className="col-util"><UtilisationBar ratio={d.congestionRatio} /></td>
                  <td><CongestionBadge level={d.congestionLevel} /></td>
                </tr>
                {isOpen && (
                  <tr className="matrix-detail">
                    <td colSpan={7}>
                      <DoctorList doctors={d.doctors} id={detailId} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
