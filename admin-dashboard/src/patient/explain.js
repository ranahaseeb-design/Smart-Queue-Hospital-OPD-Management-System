// Plain-language helpers for the patient portal: "Explain AI estimate" (FR-06 transparency, from
// TokenDetail.estimate.explain), why a doctor cannot take a token now, and appointment / visit text.
// API datetimes are hospital wall-clock times (Asia/Karachi), so "now" and "today" use the hospital
// clock (hospitalNow) — a browser in another time zone would otherwise ask for the wrong day.
import { hospitalNow } from '../utils/format.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Lines for the "Explain AI estimate" panel: what the estimate is built from, in the patient's words.
 * Returns { headline, lines: [{ label, value }], note } or null when there is nothing to explain.
 */
export function explainLines(estimate) {
  const ex = estimate?.explain;
  if (!estimate || !ex) return null;
  const lines = [
    { label: 'Patients ahead of you', value: ex.priorityAhead > 0 ? `${ex.patientsAhead} (${ex.priorityAhead} with priority)` : String(ex.patientsAhead) },
  ];
  if (ex.doctorAvgConsultMinutes != null) lines.push({ label: "Doctor's average consultation", value: `${ex.doctorAvgConsultMinutes} min` });
  if (ex.minutesToStart > 0) lines.push({ label: 'Session starts in', value: `${ex.minutesToStart} min` });
  lines.push({
    label: 'Simple formula (patients ahead × consult time)',
    value: `${ex.baselineMinutes} min`,
  });
  if (ex.method === 'MODEL' && ex.modelAdjustmentMinutes != null) {
    const adj = ex.modelAdjustmentMinutes;
    lines.push({
      label: 'AI adjustment for today’s conditions',
      value: adj === 0 ? 'none' : `${adj > 0 ? '+' : '−'}${Math.abs(adj)} min`,
    });
  }
  if (ex.interruptionsLastHour > 0) lines.push({ label: 'Skips / recalls in the last hour', value: String(ex.interruptionsLastHour) });
  if (ex.departmentLoad != null) lines.push({ label: 'Department load', value: `${ex.departmentLoad} waiting per active doctor` });

  let headline;
  let note = null;
  if (ex.method === 'MODEL') {
    headline = `Predicted by the Random Forest model (${estimate.modelVersion}) from the queue, the doctor’s pace, the time of day and the department load.`;
  } else {
    headline = 'Calculated with the standard formula: patients ahead × the doctor’s average consultation time.';
    note = ex.reason === 'COLD_START'
      ? 'This doctor has too little history for a reliable AI prediction yet, so the formula is used.'
      : 'The AI prediction service is not available right now, so the formula is used.';
  }
  return { headline, lines, note, range: `${estimate.low}–${estimate.high} min` };
}

/** Why a doctor row cannot be booked now (GET /departments/:id/doctors unavailableReason). */
export function unavailableText(doctor) {
  if (!doctor || doctor.acceptingNow) return null;
  switch (doctor.unavailableReason) {
    case 'SESSION_FULL':
      return 'Session full — the doctor has reached today’s patient limit';
    case 'SESSION_ENDED':
      return 'Session has ended for today';
    case 'INACTIVE':
      return 'Not available';
    case 'NOT_SCHEDULED':
      return 'Not scheduled today';
    default:
      return doctor.availableToday ? 'Not taking patients right now' : 'Not scheduled today';
  }
}

const APPOINTMENT_STATUS = {
  BOOKED: { label: 'Booked', tone: 'blue' },
  CHECKED_IN: { label: 'Checked in', tone: 'green' },
  CANCELLED: { label: 'Cancelled', tone: 'slate' },
  COMPLETED: { label: 'Completed', tone: 'green' },
  NO_SHOW: { label: 'Missed', tone: 'red' },
};
export function appointmentStatus(status) {
  return APPOINTMENT_STATUS[status] || { label: status, tone: 'slate' };
}

/** Check-in opens 60 min before the slot (contract); the server decides the closing time. */
export function canCheckIn(appointment, now = hospitalNow()) {
  if (!appointment || appointment.status !== 'BOOKED') return false;
  const start = new Date(appointment.slotStart);
  return start.getTime() - now.getTime() <= 60 * 60 * 1000;
}

/** "Mon 3 Nov, 10:15" from a hospital-local ISO datetime without offset. */
export function slotText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function timeText(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** YYYY-MM-DD for the hospital's today + `offset` days. */
export function dateKey(offset = 0, now = hospitalNow()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One-line summary of a visit's tokens: "OPD-004 completed · PHARMACY-002 completed". */
export function visitSummary(visit) {
  const tokens = visit?.tokens || [];
  if (!tokens.length) return 'No tokens';
  return tokens.map((t) => `${t.displayNumber} ${String(t.status).replace('_', ' ').toLowerCase()}`).join(' · ');
}

export { plural };
