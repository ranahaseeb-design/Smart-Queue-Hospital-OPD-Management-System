'use strict';
/**
 * Demo tools for live presentations (config.demoTools, off in production):
 *   POST /demo/load-queue { doctorId, count? = 5 } — issue `count` (1–10) OPD tokens for freshly
 *   created "Demo Patient" accounts in that doctor's queue, through the normal issue path
 *   (queue events, predictions, notifications and socket updates), so the doctor's "My queue"
 *   fills instantly and congestion / branch-recommendation behaviour can be shown.
 * The tokens are flagged is_synthetic, like the seeded history.
 */
const { createRouter, notFound, forbidden, badRequest } = require('../utils/errors');
const demoService = require('../services/demoService');
const { signToken } = require('../middleware/auth');
const time = require('../utils/time');
const scheduleService = require('../services/scheduleService');
const config = require('../config');
const { getDb, models } = require('../db');
const v = require('../utils/validate');
const queueService = require('../services/queueService');
const userService = require('../services/userService');

const router = createRouter();

router.post('/demo/load-queue', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  const body = req.body || {};
  const doctorId = v.int(body.doctorId, 'doctorId', { required: true, min: 1 });
  const count = v.int(body.count, 'count', { min: 1, max: 10 }) || 5;
  const db = getDb();

  const patients = await userService.createDemoPatients(db, count);
  const tokens = [];
  for (const patient of patients) {
    // The first refusal (doctor not scheduled / session full) stops the batch with its error;
    // tokens issued before it stay in the queue.
    const detail = await queueService.issueOpdToken(db, patient, doctorId);
    tokens.push(detail);
  }
  await models.Token.updateMany({ _id: { $in: tokens.map((t) => t.id) } }, { $set: { is_synthetic: true } });

  const last = tokens[tokens.length - 1];
  res.status(201).json({
    doctorId,
    servicePoint: last ? last.servicePoint : null,
    branch: last ? last.branch : null,
    issued: tokens.map((t) => ({ id: t.id, displayNumber: t.displayNumber, patientsAhead: t.patientsAhead })),
    waitingNow: last ? last.patientsAhead + 1 : 0,
  });
});

// ---- One-click committee demo data and the peak-congestion toggle (any signed-in role) ----
router.post('/demo/seed', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  res.status(201).json(await demoService.seedCommitteeDemo(getDb()));
});

router.get('/demo/peak', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  const db = getDb();
  const loads = await demoService.branchLoads(db);
  res.json({ peakActive: await demoService.peakActive(db), branches: loads.map((l) => ({ branchId: l.branch._id, name: l.branch.name, loadPercent: Math.round(l.ratio * 100), waiting: l.waiting })) });
});

router.post('/demo/peak', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  const enabled = v.bool((req.body || {}).enabled, 'enabled');
  if (enabled === null) throw badRequest('enabled (true/false) is required');
  res.json(await demoService.setPeakCongestion(getDb(), enabled));
});

// ---- Doctor / room switcher for committee demos ----
// Staff and admins can open any doctor's live queue without signing out: the switcher lists the
// active doctors with today's room, and switch-doctor returns a session for the chosen doctor.
// Demo tools only (404 when DEMO_TOOLS is off); branch admins only for their own branch.
const SWITCH_ROLES = ['STAFF', 'BRANCH_ADMIN', 'HOSPITAL_ADMIN'];

function assertCanSwitch(user) {
  if (!SWITCH_ROLES.includes(user.role)) throw forbidden('Only staff and administrators can switch doctors');
}

async function activeDoctorRows(db, now) {
  const ids = await models.Doctor.distinct('_id', { is_active: true });
  const doctors = [...(await scheduleService.getDoctors(db, ids)).values()].filter(scheduleService.isDoctorBookable);
  const date = time.formatDate(now);
  const rows = [];
  for (const d of doctors) {
    const avail = await scheduleService.availability(db, d, date, now);
    rows.push({ doctor: d, avail });
  }
  return rows;
}

router.get('/demo/doctors', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  assertCanSwitch(req.user);
  const rows = await activeDoctorRows(getDb(), time.clock.now());
  const visible = req.user.role === 'BRANCH_ADMIN' ? rows.filter((r) => r.doctor.branch_id === req.user.admin_branch_id) : rows;
  res.json(
    visible
      .map(({ doctor, avail }) => ({
        doctorId: doctor.doctor_id,
        fullName: doctor.full_name,
        specialty: doctor.specialty,
        branchId: doctor.branch_id,
        branchName: doctor.branch_name,
        servicePointName: avail.session ? avail.session.servicePointName : null,
        acceptingNow: avail.acceptingNow,
        queueLength: avail.queueLength,
      }))
      .sort((a, b) => a.branchName.localeCompare(b.branchName) || (a.servicePointName || '~').localeCompare(b.servicePointName || '~', undefined, { numeric: true }))
  );
});

router.post('/demo/switch-doctor', async (req, res) => {
  if (!config.demoTools) throw notFound('Demo tools are not enabled');
  assertCanSwitch(req.user);
  const doctorId = v.int((req.body || {}).doctorId, 'doctorId', { required: true, min: 1 });
  const db = getDb();
  const doctor = await scheduleService.getDoctor(db, doctorId);
  if (!doctor || !scheduleService.isDoctorBookable(doctor)) throw notFound('Doctor not found or not active');
  if (req.user.role === 'BRANCH_ADMIN' && doctor.branch_id !== req.user.admin_branch_id) {
    throw forbidden('Branch administrators can only open doctors of their own branch');
  }
  const row = await userService.getUserRow(db, doctor.user_id);
  res.json({ token: signToken(row), user: await userService.serializeUser(db, row) });
});

module.exports = router;
