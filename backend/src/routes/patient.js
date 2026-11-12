'use strict';
/**
 * Patient-facing routes: recommendations (FR-08, FR-09), appointments (FR-10),
 * visit history + feedback (FR-19, FR-20), notifications (FR-11), and the staff-issued
 * linked tokens on a visit (FR-04).
 */
const { createRouter, badRequest, conflict, forbidden, notFound, isUniqueViolation } = require('../utils/errors');
const { getDb, models, sess, byIds, insertOne } = require('../db');
const scheduleService = require('../services/scheduleService');

const { Visit, Branch, Token, ServicePoint, Feedback } = models;
const v = require('../utils/validate');
const time = require('../utils/time');
const fb = require('../services/featureBuilder');
const { requireRole } = require('../middleware/auth');
const appointmentService = require('../services/appointmentService');
const recommendationService = require('../services/recommendationService');
const notificationService = require('../services/notificationService');
const queueService = require('../services/queueService');

const router = createRouter();
const patientOnly = requireRole('PATIENT');

// ---- Recommendations (FR-08 / FR-09). lat/lng are used in memory only (NFR-05). ----
router.get('/recommendations', async (req, res) => {
  const specialty = v.str(req.query.specialty, 'specialty', { required: true, max: 80 });
  const lat = v.num(req.query.lat, 'lat', { min: -90, max: 90 });
  const lng = v.num(req.query.lng, 'lng', { min: -180, max: 180 });
  if ((lat === null) !== (lng === null)) throw badRequest('Provide both lat and lng, or neither');
  const excludeDoctorId = v.int(req.query.excludeDoctorId, 'excludeDoctorId', { min: 1 });
  res.json(await recommendationService.recommend(getDb(), { specialty, lat, lng, excludeDoctorId, user: req.user }));
});

// ---- Appointments (FR-10) ----
router.get('/doctors/:id/slots', async (req, res) => {
  const date = v.date(req.query.date, 'date') || time.today();
  res.json(await appointmentService.listSlots(getDb(), v.id(req.params.id), date));
});

router.get('/appointments', patientOnly, async (req, res) => {
  res.json(await appointmentService.listForPatient(getDb(), req.user.user_id));
});

router.post('/appointments', patientOnly, async (req, res) => {
  const body = req.body || {};
  const doctorId = v.int(body.doctorId, 'doctorId', { required: true, min: 1 });
  const slot = v.dateTime(body.slotStart, 'slotStart', { required: true });
  res.status(201).json(await appointmentService.book(getDb(), req.user, doctorId, slot));
});

router.put('/appointments/:id', patientOnly, async (req, res) => {
  const slot = v.dateTime((req.body || {}).slotStart, 'slotStart', { required: true });
  res.json(await appointmentService.reschedule(getDb(), req.user, v.id(req.params.id), slot));
});

router.delete('/appointments/:id', patientOnly, async (req, res) => {
  res.json(await appointmentService.cancel(getDb(), req.user, v.id(req.params.id)));
});

router.post('/appointments/:id/check-in', patientOnly, async (req, res) => {
  res.status(201).json(await appointmentService.checkIn(getDb(), req.user, v.id(req.params.id)));
});

// ---- Visits & feedback (FR-19, FR-20) ----
router.get('/visits', patientOnly, async (req, res) => {
  const db = getDb();
  const visitDocs = await Visit.find({ patient_id: req.user.user_id })
    .sort({ visit_date: -1, _id: -1 })
    .limit(200)
    .session(sess(db))
    .lean();
  const branchNames = await byIds(db, Branch, visitDocs.map((x) => x.branch_id), { name: 1 });
  const visits = visitDocs
    .filter((x) => branchNames.has(x.branch_id))
    .map((x) => ({ ...x, visit_id: x._id, branch_name: branchNames.get(x.branch_id).name }));
  const out = [];
  for (const visit of visits) {
    const tokenDocs = await Token.find({ visit_id: visit.visit_id }).sort({ issued_at: 1, _id: 1 }).session(sess(db)).lean();
    const sps = await byIds(db, ServicePoint, tokenDocs.map((t) => t.service_point_id), { name: 1 });
    const doctors = await scheduleService.getDoctors(db, tokenDocs.map((t) => t.doctor_id).filter(Boolean));
    const tokens = tokenDocs
      .filter((t) => sps.has(t.service_point_id))
      .map((t) => ({
        ...t,
        token_id: t._id,
        doctor_name: t.doctor_id && doctors.has(t.doctor_id) ? doctors.get(t.doctor_id).full_name : null,
        sp_name: sps.get(t.service_point_id).name,
      }));
    const feedback = await Feedback.findOne({ visit_id: visit.visit_id }, { rating: 1, comment: 1 }).session(sess(db)).lean();
    const hasCompleted = tokens.some((t) => t.status === 'COMPLETED');
    out.push({
      id: visit.visit_id,
      visitDate: time.toApiDate(visit.visit_date),
      status: visit.status,
      branch: { id: visit.branch_id, name: visit.branch_name },
      tokens: tokens.map((t) => ({
        id: t.token_id,
        displayNumber: fb.displayNumber(t.queue_type, t.token_number),
        queueType: t.queue_type,
        status: t.status,
        issuedAt: time.toApi(t.issued_at),
        calledAt: time.toApi(t.called_at),
        completedAt: time.toApi(t.completed_at),
        doctorName: t.doctor_name || null,
        servicePointName: t.sp_name,
      })),
      feedback: feedback ? { rating: Number(feedback.rating), comment: feedback.comment } : null,
      canGiveFeedback: hasCompleted && !feedback,
    });
  }
  res.json(out);
});

router.post('/visits/:id/feedback', patientOnly, async (req, res) => {
  const db = getDb();
  const visitId = v.id(req.params.id);
  const body = req.body || {};
  const rating = v.int(body.rating, 'rating', { required: true, min: 1, max: 5 });
  const comment = v.str(body.comment, 'comment', { max: 1000 });
  const visit = await Visit.findById(visitId, { patient_id: 1 }).session(sess(db)).lean();
  if (!visit) throw notFound('Visit not found');
  if (visit.patient_id !== req.user.user_id) throw forbidden('This is not your visit');
  const completed = await Token.exists({ visit_id: visitId, status: 'COMPLETED' }).session(sess(db));
  if (!completed) throw badRequest('Feedback can only be given after a completed consultation');
  const existing = await Feedback.exists({ visit_id: visitId }).session(sess(db));
  if (existing) throw conflict('Feedback has already been given for this visit');
  try {
    // The unique index uq_feedback_visit settles a simultaneous second submission (-> 409).
    const insertId = await insertOne(db, Feedback, { visit_id: visitId, rating, comment, created_at: time.nowDb() });
    res.status(201).json({ id: insertId, rating, comment });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Feedback has already been given for this visit');
    throw err;
  }
});

// ---- Linked LAB / PHARMACY tokens (FR-04) — issued by staff after consultation ----
router.post('/visits/:id/linked-tokens', requireRole('STAFF'), async (req, res) => {
  const body = req.body || {};
  const type = v.oneOf(body.type, 'type', ['LAB', 'PHARMACY'], { required: true });
  const servicePointId = v.int(body.servicePointId, 'servicePointId', { min: 1 });
  res
    .status(201)
    .json(await queueService.issueLinkedToken(getDb(), req.user, v.id(req.params.id), { type, servicePointId }));
});

// ---- Notifications (FR-11) ----
router.get('/notifications', async (req, res) => {
  res.json(await notificationService.listForUser(getDb(), req.user.user_id));
});

router.post('/notifications/read-all', async (req, res) => {
  await notificationService.markAllRead(getDb(), req.user.user_id);
  res.json({ ok: true });
});

router.post('/notifications/device-token', async (req, res) => {
  const fcmToken = v.str((req.body || {}).fcmToken, 'fcmToken', { required: true, max: 255 });
  await notificationService.setDeviceToken(getDb(), req.user.user_id, fcmToken);
  res.json({ ok: true });
});

module.exports = router;
