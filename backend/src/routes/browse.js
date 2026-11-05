'use strict';
/** Browse module (FR-02): branches, specialties, departments and doctors with live queue length. */
const { createRouter, notFound } = require('../utils/errors');
const { getDb } = require('../db');
const v = require('../utils/validate');
const time = require('../utils/time');
const scheduleService = require('../services/scheduleService');
const predictionService = require('../services/predictionService');
const queueService = require('../services/queueService');

const router = createRouter();

router.get('/branches', async (req, res) => {
  const db = getDb();
  const patientOnly = req.user.role === 'PATIENT';
  const rows = await db.query(
    `SELECT branch_id, name, address, latitude, longitude, status FROM branches
      ${patientOnly ? "WHERE status = 'ACTIVE'" : ''} ORDER BY branch_id`,
    []
  );
  res.json(
    rows.map((b) => ({
      id: b.branch_id,
      name: b.name,
      address: b.address,
      latitude: Number(b.latitude),
      longitude: Number(b.longitude),
      status: b.status,
    }))
  );
});

router.get('/specialties', async (req, res) => {
  const rows = await getDb().query(
    `SELECT DISTINCT dp.specialty FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id
      WHERE dp.is_active = 1 AND b.status = 'ACTIVE' ORDER BY dp.specialty`,
    []
  );
  res.json(rows.map((r) => r.specialty));
});

router.get('/branches/:id/departments', async (req, res) => {
  const db = getDb();
  const branchId = v.id(req.params.id);
  const branch = await db.get('SELECT branch_id, status FROM branches WHERE branch_id = ?', [branchId]);
  if (!branch || (req.user.role === 'PATIENT' && branch.status !== 'ACTIVE')) throw notFound('Branch not found');
  const rows = await db.query(
    `SELECT dp.department_id, dp.branch_id, dp.specialty, dp.name,
            (SELECT COUNT(*) FROM doctors d JOIN users u ON u.user_id = d.user_id
              WHERE d.department_id = dp.department_id AND d.is_active = 1 AND u.is_active = 1) AS doctor_count
       FROM departments dp WHERE dp.branch_id = ? AND dp.is_active = 1 ORDER BY dp.specialty`,
    [branchId]
  );
  res.json(
    rows.map((d) => ({
      id: d.department_id,
      branchId: d.branch_id,
      specialty: d.specialty,
      name: d.name,
      doctorCount: Number(d.doctor_count) || 0,
    }))
  );
});

router.get('/departments/:id/doctors', async (req, res) => {
  const db = getDb();
  const departmentId = v.id(req.params.id);
  const now = time.clock.now();
  const date = v.date(req.query.date, 'date') || time.formatDate(now);
  const dept = await db.get(
    `SELECT dp.department_id, dp.is_active, b.status FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id
      WHERE dp.department_id = ?`,
    [departmentId]
  );
  if (!dept || !dept.is_active || dept.status !== 'ACTIVE') throw notFound('Department not found');
  const ids = await db.query(
    `SELECT d.doctor_id FROM doctors d JOIN users u ON u.user_id = d.user_id
      WHERE d.department_id = ? AND d.is_active = 1 AND u.is_active = 1 ORDER BY d.doctor_id`,
    [departmentId]
  );
  const doctors = [];
  for (const { doctor_id: id } of ids) {
    const doctor = await scheduleService.getDoctor(db, id);
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
