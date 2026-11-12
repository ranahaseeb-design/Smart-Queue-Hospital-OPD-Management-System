'use strict';
/** Browse module (FR-02): branches, specialties, departments and doctors with live queue length. */
const { createRouter, notFound } = require('../utils/errors');
const { getDb, models, sess } = require('../db');
const v = require('../utils/validate');
const time = require('../utils/time');
const scheduleService = require('../services/scheduleService');
const predictionService = require('../services/predictionService');
const queueService = require('../services/queueService');
const { activeDoctorIds } = require('../services/recommendationService');

const { Branch, Department } = models;

const router = createRouter();

// GET /branches (ACTIVE only for patients)
router.get('/branches', async (req, res) => {
  const db = getDb();
  const patientOnly = req.user.role === 'PATIENT';
  const rows = await Branch.find(patientOnly ? { status: 'ACTIVE' } : {}).sort({ _id: 1 }).session(sess(db)).lean();
  res.json(
    rows.map((b) => ({
      id: b._id,
      name: b.name,
      address: b.address,
      latitude: Number(b.latitude),
      longitude: Number(b.longitude),
      status: b.status,
    }))
  );
});

// GET /specialties — distinct specialties of active departments in active branches
router.get('/specialties', async (req, res) => {
  const db = getDb();
  const activeBranchIds = await Branch.distinct('_id', { status: 'ACTIVE' }).session(sess(db));
  const specialties = await Department.distinct('specialty', { is_active: true, branch_id: { $in: activeBranchIds } }).session(
    sess(db)
  );
  res.json(specialties.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

// GET /branches/:id/departments
router.get('/branches/:id/departments', async (req, res) => {
  const db = getDb();
  const branchId = v.id(req.params.id);
  const branch = await Branch.findById(branchId, { status: 1 }).session(sess(db)).lean();
  if (!branch || (req.user.role === 'PATIENT' && branch.status !== 'ACTIVE')) throw notFound('Branch not found');
  const rows = await Department.find({ branch_id: branchId, is_active: true }).sort({ specialty: 1, _id: 1 }).session(sess(db)).lean();
  const out = [];
  for (const d of rows) {
    out.push({
      id: d._id,
      branchId: d.branch_id,
      specialty: d.specialty,
      name: d.name,
      doctorCount: (await activeDoctorIds(db, d._id)).length,
    });
  }
  res.json(out);
});

// GET /departments/:id/doctors?date=YYYY-MM-DD
router.get('/departments/:id/doctors', async (req, res) => {
  const db = getDb();
  const departmentId = v.id(req.params.id);
  const now = time.clock.now();
  const date = v.date(req.query.date, 'date') || time.formatDate(now);
  const dept = await Department.findById(departmentId, { is_active: 1, branch_id: 1 }).session(sess(db)).lean();
  const branch = dept ? await Branch.findById(dept.branch_id, { status: 1 }).session(sess(db)).lean() : null;
  if (!dept || !branch || !dept.is_active || branch.status !== 'ACTIVE') throw notFound('Department not found');
  const ids = await activeDoctorIds(db, departmentId);
  const doctors = [];
  for (const id of ids) {
    const doctor = await scheduleService.getDoctor(db, id);
    if (!doctor) continue;
    const avail = await scheduleService.availability(db, doctor, date, now);
    doctors.push({ doctor, avail });
  }
  const priorityLevel = req.user.role === 'PATIENT' ? queueService.priorityFromCategory(req.user.priority_category, req.user.date_of_birth) : 0;
  const isToday = date === time.formatDate(now);
  const predictions = isToday
    ? await predictionService.predictHypothetical(
        db,
        doctors.filter((d) => d.avail.session).map((d) => ({ ...d.doctor, session: d.avail.session })),
        { priorityLevel, now }
      )
    : new Map();
  res.json(
    doctors.map(({ doctor, avail }) => {
      const p = predictions.get(doctor.doctor_id);
      return {
        id: doctor.doctor_id,
        fullName: doctor.full_name,
        departmentId: doctor.department_id,
        specialty: doctor.specialty,
        branchId: doctor.branch_id,
        avgConsultMinutes: Number(doctor.avg_consult_minutes),
        servicePointId: avail.session ? avail.session.servicePointId : null,
        servicePointName: avail.session ? avail.session.servicePointName : null,
        session: avail.session ? { startTime: avail.session.startTime, endTime: avail.session.endTime } : null,
        availableToday: avail.availableToday,
        acceptingNow: avail.acceptingNow,
        queueLength: avail.queueLength,
        estimatedWaitMinutes: p ? Math.round(p.minutes) : null,
      };
    })
  );
});

module.exports = router;
