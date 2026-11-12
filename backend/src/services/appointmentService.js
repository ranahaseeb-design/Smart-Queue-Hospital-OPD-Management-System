'use strict';
/**
 * Appointment Service (FR-10): slot calculation from doctor schedules (settings.slotMinutes),
 * booking without double booking, rescheduling, cancellation (slot released) and check-in,
 * which converts the appointment into an OPD token.
 *
 * No double booking: the checks run inside a transaction and the partial unique index
 * uq_active_slot ({ doctor_id, slot_start } where status is BOOKED / CHECKED_IN) is the
 * backstop for two simultaneous bookings (duplicate key -> 409 CONFLICT).
 */
const time = require('../utils/time');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const { models, sess, insertOne, isDuplicateKey, lockKey } = require('../db');
const scheduleService = require('./scheduleService');
const settingsService = require('./settingsService');
const notificationService = require('./notificationService');
const queueService = require('./queueService');

const { Appointment, Token } = models;

const BLOCKING = ['BOOKED', 'CHECKED_IN'];

/**
 * Check-in window (FR-10): opens CHECK_IN_EARLY_MINUTES before slot_start and closes at the end
 * of the doctor's schedule session that contains the slot. The token is issued to that session's
 * service point, so an appointment in a later session is not queued in an earlier room.
 */
const CHECK_IN_EARLY_MINUTES = 60;

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

/** Taken slot starts of a doctor on a date: Set of epoch milliseconds. */
async function takenSlots(db, doctorId, dateStr, excludeAppointmentId = 0) {
  const rows = await Appointment.find(
    {
      doctor_id: doctorId,
      status: { $in: BLOCKING },
      slot_start: time.dayRange(dateStr),
      _id: { $ne: excludeAppointmentId },
    },
    { slot_start: 1 }
  )
    .session(sess(db))
    .lean();
  return new Set(rows.map((r) => time.dbDate(r.slot_start).getTime()));
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
      .map((s) => ({ start: time.toApi(s), available: bookable && !taken.has(time.dbDate(s).getTime()) })),
  };
}

/** Appointment row with doctor, specialty, branch and the linked token id (null if missing). */
async function appointmentRow(db, appointmentId) {
  const a = await Appointment.findById(appointmentId).session(sess(db)).lean();
  if (!a) return undefined;
  const doctor = await scheduleService.getDoctor(db, a.doctor_id);
  if (!doctor) return undefined;
  const token = await Token.findOne({ appointment_id: a._id }, { _id: 1 }).session(sess(db)).lean();
  return {
    ...a,
    appointment_id: a._id,
    doctor_name: doctor.full_name,
    specialty: doctor.specialty,
    branch_id: doctor.branch_id,
    branch_name: doctor.branch_name,
    token_id: token ? token._id : null,
  };
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
  const rows = await Appointment.find({ patient_id: patientId }, { _id: 1 })
    .sort({ slot_start: -1, _id: -1 })
    .session(sess(db))
    .lean();
  const out = [];
  for (const r of rows) {
    const row = await appointmentRow(db, r._id);
    if (row) out.push(toAppointment(row));
  }
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

async function assertSlotFree(tx, doctorId, slot, excludeAppointmentId = 0) {
  const taken = await Appointment.exists({
    doctor_id: doctorId,
    slot_start: slot,
    status: { $in: BLOCKING },
    _id: { $ne: excludeAppointmentId },
  }).session(sess(tx));
  if (taken) throw conflict('This slot is already booked');
}

async function assertNoOtherBookingThatDay(tx, patientId, doctorId, dateStr, excludeAppointmentId = 0) {
  const other = await Appointment.exists({
    patient_id: patientId,
    doctor_id: doctorId,
    status: { $in: BLOCKING },
    slot_start: time.dayRange(dateStr),
    _id: { $ne: excludeAppointmentId },
  }).session(sess(tx));
  if (other) throw conflict('You already have an appointment with this doctor on that day');
}

/** A duplicate key on uq_active_slot means another booking took the slot first. */
function slotConflict(err) {
  if (isDuplicateKey(err)) return conflict('This slot is already booked');
  return err;
}

async function book(db, patient, doctorId, slot, now = time.clock.now()) {
  const doctor = await scheduleService.getDoctor(db, doctorId);
  if (!doctor) throw notFound('Doctor not found');
  const dateStr = await assertValidSlot(db, doctor, slot, now);
  const slotAt = time.dbDate(slot);
  const at = time.dbDate(now);
  let id;
  try {
    id = await db.transaction(async (tx) => {
      await lockKey(`doctor:${doctorId}`, sess(tx)); // serialise bookings per doctor
      await assertSlotFree(tx, doctorId, slotAt);
      await assertNoOtherBookingThatDay(tx, patient.user_id, doctorId, dateStr);
      return insertOne(tx, Appointment, {
        patient_id: patient.user_id,
        doctor_id: doctorId,
        slot_start: slotAt,
        status: 'BOOKED',
        updated_at: at,
      });
    });
  } catch (err) {
    throw slotConflict(err);
  }
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
  const slotAt = time.dbDate(slot);
  const at = time.dbDate(now);
  try {
    await db.transaction(async (tx) => {
      await lockKey(`doctor:${row.doctor_id}`, sess(tx));
      await assertSlotFree(tx, row.doctor_id, slotAt, appointmentId);
      await assertNoOtherBookingThatDay(tx, user.user_id, row.doctor_id, dateStr, appointmentId);
      const r = await Appointment.updateOne(
        { _id: appointmentId, status: 'BOOKED' },
        { $set: { slot_start: slotAt, updated_at: at } },
        { session: sess(tx) }
      );
      if (r.matchedCount !== 1) throw conflict('Appointment changed, please refresh');
    });
  } catch (err) {
    throw slotConflict(err);
  }
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
  const at = time.dbDate(now);
  const r = await Appointment.updateOne(
    { _id: appointmentId, status: 'BOOKED' },
    { $set: { status: 'CANCELLED', updated_at: at } },
    { session: sess(db) }
  );
  if (r.matchedCount !== 1) throw conflict('Appointment changed, please refresh');
  await notificationService.notify(db, user.user_id, {
    message: `Appointment with ${row.doctor_name} on ${formatSlotHuman(time.parseDateTime(row.slot_start))} was cancelled.`,
    email: true,
    subject: 'Appointment cancelled',
  });
  return toAppointment(await appointmentRow(db, appointmentId));
}

/**
 * Check in (FR-10): allowed from CHECK_IN_EARLY_MINUTES before slot_start until the end of the
 * session containing the slot; creates an OPD token linked to the appointment at that session's
 * service point.
 */
async function checkIn(db, user, appointmentId, now = time.clock.now()) {
  const row = await requireOwn(db, user, appointmentId);
  if (row.status !== 'BOOKED') throw conflict(`Appointment is ${row.status}; only booked appointments can be checked in`);
  const slotStart = time.parseDateTime(row.slot_start);
  const slotDate = time.formatDate(slotStart);
  const sessions = await scheduleService.doctorSessions(db, row.doctor_id, slotDate);
  const session = sessions.find((s) => s.start <= slotStart && slotStart < s.end);
  if (!session) throw conflict('The doctor no longer has a session at the appointment time; please reschedule');
  const opensAt = new Date(slotStart.getTime() - CHECK_IN_EARLY_MINUTES * time.MINUTE);
  if (now < opensAt) {
    throw conflict(
      `Check-in opens ${CHECK_IN_EARLY_MINUTES} minutes before the appointment (from ${formatSlotHuman(opensAt)})`
    );
  }
  // Not relaxed by DEMO_ALWAYS_OPEN: the window belongs to the booked slot, not to "now".
  if (now >= session.end) {
    throw conflict('The session of this appointment has ended; check-in is closed');
  }
  return queueService.issueOpdToken(db, user, row.doctor_id, { appointmentId, session, now });
}

module.exports = {
  listSlots,
  listForPatient,
  book,
  reschedule,
  cancel,
  checkIn,
  toAppointment,
  appointmentRow,
  BLOCKING,
  CHECK_IN_EARLY_MINUTES,
};
