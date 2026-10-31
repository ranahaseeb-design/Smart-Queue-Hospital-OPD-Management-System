'use strict';
/**
 * Appointment Service (FR-10): slot calculation from doctor schedules (settings.slotMinutes),
 * booking without double booking, rescheduling, cancellation (slot released) and check-in,
 * which converts the appointment into an OPD token.
 */
const time = require('../utils/time');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const scheduleService = require('./scheduleService');
const settingsService = require('./settingsService');
const notificationService = require('./notificationService');
const queueService = require('./queueService');

const BLOCKING = ['BOOKED', 'CHECKED_IN'];

function formatSlotHuman(d) {
  return `${time.dayName(d)} ${time.formatDate(d)} at ${time.formatTime(d)}`;
}

/** All slot starts (Date) of a doctor on a date, from that weekday's schedule(s). */
async function slotGrid(db, doctorId, dateStr) {
  const settings = await settingsService.getSettings(db);
  const step = settings.slotMinutes;
  const sessions = await scheduleService.doctorSessions(db, doctorId, dateStr);
  const slots = [];
  for (const s of sessions) {
    for (let t = s.start.getTime(); t + step * time.MINUTE <= s.end.getTime(); t += step * time.MINUTE) {
      slots.push(new Date(t));
    }
  }
  return { slotMinutes: step, slots };
}

async function takenSlots(db, doctorId, dateStr, excludeAppointmentId = 0) {
  const rows = await db.query(
    `SELECT slot_start FROM appointments
      WHERE doctor_id = ? AND status IN ('BOOKED', 'CHECKED_IN') AND slot_start >= ? AND slot_start < ?
        AND appointment_id <> ?`,
    [doctorId, `${dateStr} 00:00:00`, `${time.addDaysStr(dateStr, 1)} 00:00:00`, excludeAppointmentId]
  );
  return new Set(rows.map((r) => String(r.slot_start).slice(0, 19)));
}

/** GET /doctors/:id/slots */
async function listSlots(db, doctorId, dateStr, now = time.clock.now()) {
  const doctor = await scheduleService.getDoctor(db, doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const { slotMinutes, slots } = await slotGrid(db, doctorId, dateStr);
  const taken = await takenSlots(db, doctorId, dateStr);
  const bookable = scheduleService.isDoctorBookable(doctor);
  return {
    doctorId,
    date: dateStr,
    slotMinutes,
    slots: slots
      .filter((s) => s > now)
      .map((s) => ({ start: time.toApi(s), available: bookable && !taken.has(time.formatDateTime(s)) })),
  };
}

async function appointmentRow(db, appointmentId) {
  return db.get(
    `SELECT a.*, u.full_name AS doctor_name, dp.specialty, b.branch_id, b.name AS branch_name,
            (SELECT t.token_id FROM tokens t WHERE t.appointment_id = a.appointment_id) AS token_id
       FROM appointments a
       JOIN doctors d ON d.doctor_id = a.doctor_id
       JOIN users u ON u.user_id = d.user_id
       JOIN departments dp ON dp.department_id = d.department_id
       JOIN branches b ON b.branch_id = dp.branch_id
      WHERE a.appointment_id = ?`,
    [appointmentId]
  );
}

function toAppointment(r) {
  return {
    id: r.appointment_id,
    doctor: { id: r.doctor_id, fullName: r.doctor_name, specialty: r.specialty },
    branch: { id: r.branch_id, name: r.branch_name },
    slotStart: time.toApi(r.slot_start),
    status: r.status,
    updatedAt: time.toApi(r.updated_at),
    tokenId: r.token_id || null,
  };
}

async function listForPatient(db, patientId) {
  const rows = await db.query('SELECT appointment_id FROM appointments WHERE patient_id = ? ORDER BY slot_start DESC, appointment_id DESC', [
    patientId,
  ]);
  const out = [];
  for (const r of rows) out.push(toAppointment(await appointmentRow(db, r.appointment_id)));
  return out;
}

/** Validate that `slot` is a future slot on the doctor's schedule grid. */
async function assertValidSlot(db, doctor, slot, now) {
  if (!scheduleService.isDoctorBookable(doctor)) throw conflict('The doctor is not accepting appointments');
  if (slot <= now) throw badRequest('slotStart must be in the future');
  const dateStr = time.formatDate(slot);
  const { slots } = await slotGrid(db, doctor.doctor_id, dateStr);
  if (!slots.some((s) => s.getTime() === slot.getTime())) {
    throw badRequest("slotStart is not a valid slot on the doctor's schedule");
  }
  return dateStr;
}

async function assertSlotFree(tx, doctorId, slotStr, excludeAppointmentId = 0) {
  const taken = await tx.get(
    `SELECT appointment_id FROM appointments
      WHERE doctor_id = ? AND slot_start = ? AND status IN ('BOOKED', 'CHECKED_IN') AND appointment_id <> ?`,
    [doctorId, slotStr, excludeAppointmentId]
  );
  if (taken) throw conflict('This slot is already booked');
}

async function assertNoOtherBookingThatDay(tx, patientId, doctorId, dateStr, excludeAppointmentId = 0) {
  const other = await tx.get(
    `SELECT appointment_id FROM appointments
      WHERE patient_id = ? AND doctor_id = ? AND status IN ('BOOKED', 'CHECKED_IN')
        AND slot_start >= ? AND slot_start < ? AND appointment_id <> ?`,
    [patientId, doctorId, `${dateStr} 00:00:00`, `${time.addDaysStr(dateStr, 1)} 00:00:00`, excludeAppointmentId]
  );
  if (other) throw conflict('You already have an appointment with this doctor on that day');
}

async function book(db, patient, doctorId, slot, now = time.clock.now()) {
  const doctor = await scheduleService.getDoctor(db, doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const dateStr = await assertValidSlot(db, doctor, slot, now);
  const slotStr = time.formatDateTime(slot);
  const at = time.formatDateTime(now);
  const id = await db.transaction(async (tx) => {
    await tx.lockRow('doctors', 'doctor_id', doctorId); // serialise bookings per doctor (no double booking)
    await assertSlotFree(tx, doctorId, slotStr);
    await assertNoOtherBookingThatDay(tx, patient.user_id, doctorId, dateStr);
    const r = await tx.run(
      `INSERT INTO appointments (patient_id, doctor_id, slot_start, status, updated_at) VALUES (?, ?, ?, 'BOOKED', ?)`,
      [patient.user_id, doctorId, slotStr, at]
    );
    return r.insertId;
  });
  await notificationService.notify(db, patient.user_id, {
    message: `Appointment booked with ${doctor.full_name} (${doctor.specialty}, ${doctor.branch_name}) on ${formatSlotHuman(slot)}.`,
    email: true,
    subject: 'Appointment confirmed',
  });
  return toAppointment(await appointmentRow(db, id));
}

async function requireOwn(db, user, appointmentId) {
  const row = await appointmentRow(db, appointmentId);
  if (!row) throw notFound('Appointment not found');
  if (row.patient_id !== user.user_id) throw forbidden('This is not your appointment');
  return row;
}

async function reschedule(db, user, appointmentId, slot, now = time.clock.now()) {
  const row = await requireOwn(db, user, appointmentId);
  if (row.status !== 'BOOKED') throw conflict('Only booked appointments can be rescheduled');
  const doctor = await scheduleService.getDoctor(db, row.doctor_id);
  const dateStr = await assertValidSlot(db, doctor, slot, now);
  const slotStr = time.formatDateTime(slot);
  const at = time.formatDateTime(now);
  await db.transaction(async (tx) => {
    await tx.lockRow('doctors', 'doctor_id', row.doctor_id);
    await assertSlotFree(tx, row.doctor_id, slotStr, appointmentId);
    await assertNoOtherBookingThatDay(tx, user.user_id, row.doctor_id, dateStr, appointmentId);
    const r = await tx.run(
      `UPDATE appointments SET slot_start = ?, updated_at = ? WHERE appointment_id = ? AND status = 'BOOKED'`,
      [slotStr, at, appointmentId]
    );
    if (r.changes !== 1) throw conflict('Appointment changed, please refresh');
  });
  await notificationService.notify(db, user.user_id, {
    message: `Appointment with ${row.doctor_name} rescheduled to ${formatSlotHuman(slot)}.`,
    email: true,
    subject: 'Appointment rescheduled',
  });
  return toAppointment(await appointmentRow(db, appointmentId));
}

async function cancel(db, user, appointmentId, now = time.clock.now()) {
  const row = await requireOwn(db, user, appointmentId);
  if (row.status !== 'BOOKED') throw conflict('Only booked appointments can be cancelled');
  const at = time.formatDateTime(now);
  const r = await db.run(
    `UPDATE appointments SET status = 'CANCELLED', updated_at = ? WHERE appointment_id = ? AND status = 'BOOKED'`,
    [at, appointmentId]
  );
  if (r.changes !== 1) throw conflict('Appointment changed, please refresh');
  await notificationService.notify(db, user.user_id, {
    message: `Appointment with ${row.doctor_name} on ${formatSlotHuman(time.parseDateTime(row.slot_start))} was cancelled.`,
    email: true,
    subject: 'Appointment cancelled',
  });
  return toAppointment(await appointmentRow(db, appointmentId));
}

/** Check in on the appointment day: creates an OPD token linked to the appointment. */
async function checkIn(db, user, appointmentId, now = time.clock.now()) {
  const row = await requireOwn(db, user, appointmentId);
  if (row.status !== 'BOOKED') throw conflict(`Appointment is ${row.status}; only booked appointments can be checked in`);
  if (String(row.slot_start).slice(0, 10) !== time.formatDate(now)) {
    throw conflict('Check-in is only possible on the day of the appointment');
  }
  return queueService.issueOpdToken(db, user, row.doctor_id, { appointmentId, now });
}

module.exports = { listSlots, listForPatient, book, reschedule, cancel, checkIn, toAppointment, appointmentRow, BLOCKING };
