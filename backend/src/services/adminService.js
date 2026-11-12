'use strict';
/**
 * Administration of master data and accounts (FR-14) with the Section 3.2 scoping rules:
 *
 *  - HOSPITAL_ADMIN manages everything (optional ?branchId= filter on lists).
 *  - BRANCH_ADMIN manages departments, doctors, schedules, service points, staff accounts and
 *    staff assignments of their own branch only; branches are read-only for them and requests
 *    that target another branch answer 403 FORBIDDEN.
 *
 * DELETE on master data is a soft deactivation (is_active = false / status = INACTIVE) so records
 * referenced by tokens and history are never lost; schedules and staff assignments, which are
 * pure configuration, are hard-deleted.
 */
const time = require('../utils/time');
const v = require('../utils/validate');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const access = require('./accessService');
const userService = require('./userService');
const scheduleService = require('./scheduleService');
const { models, sess, asRow, asRows, byIds, insertOne, nextId } = require('../db');

const { Branch, Department, Doctor, DoctorSchedule, ServicePoint, StaffAssignment, User, Token } = models;

const SERVICE_POINT_TYPES = ['OPD', 'LAB', 'PHARMACY'];
const STAFF_ROLES = ['STAFF', 'BRANCH_ADMIN', 'HOSPITAL_ADMIN'];
const ALL_ROLES = ['PATIENT', ...STAFF_ROLES];

const isHospitalAdmin = (user) => user.role === 'HOSPITAL_ADMIN';

function requireHospitalAdmin(user, what = 'this action') {
  if (!isHospitalAdmin(user)) throw forbidden(`Only the hospital administrator can perform ${what}`);
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const bodyOf = (body) => {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  return body;
};

/** Binary string comparison (the former SQL ORDER BY on text columns). */
const cmp = (a, b) => {
  const x = a === null || a === undefined ? '' : String(a);
  const y = b === null || b === undefined ? '' : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Case-insensitive exact match (the former LOWER(col) = ?). */
const ciEquals = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/** Branch filter for list endpoints (403 when a branch admin asks for another branch). */
function listScope(user, query) {
  const requested = v.int(query.branchId, 'branchId', { min: 1 });
  return access.scopeBranch(user, requested);
}

async function requireBranch(db, branchId) {
  const b = asRow(Branch, await Branch.findById(branchId).session(sess(db)).lean());
  if (!b) throw notFound('Branch not found');
  return b;
}

/** $set only the provided (non-undefined) fields. */
async function updateColumns(db, Model, id, columns) {
  const set = {};
  for (const [key, value] of Object.entries(columns)) if (value !== undefined) set[key] = value;
  if (!Object.keys(set).length) return;
  await Model.updateOne({ _id: id }, { $set: set }, { session: sess(db) });
}

// =============================================================================================
// Branches
// =============================================================================================

function toBranch(r) {
  return {
    id: r.branch_id,
    name: r.name,
    address: r.address,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    status: r.status,
    isActive: r.status === 'ACTIVE',
  };
}

function validateBranch(body, current) {
  const out = {};
  if (!current || has(body, 'name')) out.name = v.str(body.name, 'name', { required: true, min: 2, max: 100 });
  if (has(body, 'address')) out.address = v.str(body.address, 'address', { max: 255 });
  if (!current || has(body, 'latitude')) out.latitude = v.num(body.latitude, 'latitude', { required: true, min: -90, max: 90 });
  if (!current || has(body, 'longitude')) {
    out.longitude = v.num(body.longitude, 'longitude', { required: true, min: -180, max: 180 });
  }
  if (has(body, 'status')) out.status = v.oneOf(body.status, 'status', ['ACTIVE', 'INACTIVE'], { required: true });
  else if (has(body, 'isActive')) out.status = v.bool(body.isActive, 'isActive', { required: true }) ? 'ACTIVE' : 'INACTIVE';
  return out;
}

async function assertBranchNameFree(db, name, excludeId = 0) {
  const dup = await Branch.exists({ name: ciEquals(name), _id: { $ne: excludeId } }).session(sess(db));
  if (dup) throw conflict(`A branch named "${name}" already exists`);
}

const branches = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const rows = await Branch.find(scope ? { _id: scope } : {}).sort({ _id: 1 }).session(sess(db)).lean();
    return asRows(Branch, rows).map(toBranch);
  },
  async get(db, user, id) {
    const row = await requireBranch(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toBranch(row);
  },
  async create(db, user, rawBody) {
    requireHospitalAdmin(user, 'branch creation');
    const data = validateBranch(bodyOf(rawBody), null);
    await assertBranchNameFree(db, data.name);
    const insertId = await insertOne(db, Branch, {
      name: data.name,
      address: data.address || null,
      latitude: data.latitude,
      longitude: data.longitude,
      status: data.status || 'ACTIVE',
    });
    return toBranch(await requireBranch(db, insertId));
  },
  async update(db, user, id, rawBody) {
    requireHospitalAdmin(user, 'branch changes');
    const current = await requireBranch(db, id);
    const data = validateBranch(bodyOf(rawBody), current);
    if (data.name) await assertBranchNameFree(db, data.name, id);
    await updateColumns(db, Branch, id, {
      name: data.name,
      address: data.address,
      latitude: data.latitude,
      longitude: data.longitude,
      status: data.status,
    });
    return toBranch(await requireBranch(db, id));
  },
  async remove(db, user, id) {
    requireHospitalAdmin(user, 'branch deactivation');
    await requireBranch(db, id);
    await Branch.updateOne({ _id: id }, { $set: { status: 'INACTIVE' } }, { session: sess(db) });
    return toBranch(await requireBranch(db, id));
  },
};

// =============================================================================================
// Departments
// =============================================================================================

/** Department rows with branch_name and doctor_count (active doctors), inner join on branch. */
async function departmentRows(db, filter) {
  const docs = await Department.find(filter).session(sess(db)).lean();
  const branchNames = await byIds(db, Branch, docs.map((d) => d.branch_id), { name: 1 });
  const counts = new Map();
  if (docs.length) {
    const active = await Doctor.find({ department_id: { $in: docs.map((d) => d._id) }, is_active: true }, { department_id: 1 })
      .session(sess(db))
      .lean();
    for (const d of active) counts.set(d.department_id, (counts.get(d.department_id) || 0) + 1);
  }
  return docs
    .filter((d) => branchNames.has(d.branch_id))
    .map((d) => ({
      ...asRow(Department, d),
      branch_name: branchNames.get(d.branch_id).name,
      doctor_count: counts.get(d._id) || 0,
    }));
}

function toDepartment(r) {
  return {
    id: r.department_id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    specialty: r.specialty,
    name: r.name,
    isActive: Boolean(r.is_active),
    doctorCount: Number(r.doctor_count) || 0,
  };
}

async function requireDepartment(db, id) {
  const row = (await departmentRows(db, { _id: id }))[0];
  if (!row) throw notFound('Department not found');
  return row;
}

async function assertSpecialtyFree(db, branchId, specialty, excludeId = 0) {
  const dup = await Department.exists({
    branch_id: branchId,
    specialty: ciEquals(specialty),
    is_active: true,
    _id: { $ne: excludeId },
  }).session(sess(db));
  if (dup) throw conflict(`An active ${specialty} department already exists at this branch`);
}

const departments = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const rows = await departmentRows(db, scope ? { branch_id: scope } : {});
    rows.sort((a, b) => a.branch_id - b.branch_id || cmp(a.specialty, b.specialty) || a.department_id - b.department_id);
    return rows.map(toDepartment);
  },
  async get(db, user, id) {
    const row = await requireDepartment(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toDepartment(row);
  },
  async create(db, user, rawBody) {
    const body = bodyOf(rawBody);
    const branchId = v.int(body.branchId, 'branchId', { required: true, min: 1 });
    access.assertBranchAccess(user, branchId);
    await requireBranch(db, branchId);
    const specialty = v.str(body.specialty, 'specialty', { required: true, min: 2, max: 80 });
    const name = v.str(body.name, 'name', { max: 100 }) || specialty;
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : true;
    if (isActive) await assertSpecialtyFree(db, branchId, specialty);
    const insertId = await insertOne(db, Department, { branch_id: branchId, specialty, name, is_active: isActive });
    return toDepartment(await requireDepartment(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const body = bodyOf(rawBody);
    const current = await requireDepartment(db, id);
    access.assertBranchAccess(user, current.branch_id);
    let branchId;
    if (has(body, 'branchId')) {
      branchId = v.int(body.branchId, 'branchId', { required: true, min: 1 });
      if (branchId !== current.branch_id) {
        access.assertBranchAccess(user, branchId);
        await requireBranch(db, branchId);
        const used = await Doctor.countDocuments({ department_id: id }).session(sess(db));
        if (used > 0) throw conflict('A department with doctors cannot be moved to another branch');
      }
    }
    const specialty = has(body, 'specialty') ? v.str(body.specialty, 'specialty', { required: true, min: 2, max: 80 }) : undefined;
    const name = has(body, 'name') ? v.str(body.name, 'name', { max: 100 }) || specialty || current.specialty : undefined;
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : undefined;
    const finalActive = isActive === undefined ? Boolean(current.is_active) : isActive;
    if (finalActive) {
      await assertSpecialtyFree(db, branchId || current.branch_id, specialty || current.specialty, id);
    }
    await updateColumns(db, Department, id, {
      branch_id: branchId,
      specialty,
      name,
      is_active: isActive,
    });
    return toDepartment(await requireDepartment(db, id));
  },
  async remove(db, user, id) {
    const current = await requireDepartment(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await Department.updateOne({ _id: id }, { $set: { is_active: false } }, { session: sess(db) });
    return toDepartment(await requireDepartment(db, id));
  },
};

// =============================================================================================
// Doctors (STAFF user + doctors document)
// =============================================================================================

function toDoctor(r) {
  return {
    id: r.doctor_id,
    userId: r.user_id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    departmentId: r.department_id,
    departmentName: r.department_name || r.specialty,
    specialty: r.specialty,
    branchId: r.branch_id,
    branchName: r.branch_name,
    avgConsultMinutes: Number(r.avg_consult_minutes),
    isActive: Boolean(r.is_active) && Boolean(r.user_active),
  };
}

async function requireDoctor(db, id) {
  const row = await scheduleService.getDoctor(db, id);
  if (!row) throw notFound('Doctor not found');
  return row;
}

async function departmentInScope(db, user, departmentId) {
  const dept = asRow(Department, await Department.findById(departmentId, { branch_id: 1, is_active: 1 }).session(sess(db)).lean());
  if (!dept) throw notFound('Department not found');
  access.assertBranchAccess(user, dept.branch_id);
  return dept;
}

const doctors = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const departmentId = v.int(query.departmentId, 'departmentId', { min: 1 });
    const filter = {};
    if (departmentId) filter.department_id = departmentId;
    const ids = await Doctor.distinct('_id', filter).session(sess(db));
    const rows = [...(await scheduleService.getDoctors(db, ids)).values()].filter((r) => !scope || r.branch_id === scope);
    rows.sort((a, b) => a.branch_id - b.branch_id || cmp(a.specialty, b.specialty) || cmp(a.full_name, b.full_name));
    return rows.map(toDoctor);
  },
  async get(db, user, id) {
    const row = await requireDoctor(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toDoctor(row);
  },
  async create(db, user, rawBody) {
    const body = bodyOf(rawBody);
    const fullName = v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 });
    const email = v.email(body.email, 'email', { required: true });
    const phone = v.phone(body.phone);
    const password = v.password(body.password, 'password', { required: true });
    const departmentId = v.int(body.departmentId, 'departmentId', { required: true, min: 1 });
    const avg = v.num(body.avgConsultMinutes, 'avgConsultMinutes', { min: 1, max: 120 });
    const dept = await departmentInScope(db, user, departmentId);
    if (!dept.is_active) throw badRequest('The department is inactive');
    await userService.assertUnique(db, { email, phone });
    const hash = await userService.hashPassword(password);
    const userId = await nextId('users');
    const doctorId = await nextId('doctors');
    await db.transaction(async (tx) => {
      await User.create(
        [
          {
            _id: userId,
            full_name: fullName,
            email,
            phone,
            password_hash: hash,
            role: 'STAFF',
            date_of_birth: null,
            priority_category: 'NONE',
            admin_branch_id: null,
            fcm_token: null,
            is_active: true,
            created_at: time.nowDb(),
          },
        ],
        { session: sess(tx) }
      );
      await Doctor.create(
        [
          {
            _id: doctorId,
            user_id: userId,
            department_id: departmentId,
            avg_consult_minutes: avg === null ? 10 : time.round(avg, 2),
            is_active: true,
          },
        ],
        { session: sess(tx) }
      );
    });
    return toDoctor(await requireDoctor(db, doctorId));
  },
  async update(db, user, id, rawBody) {
    const body = bodyOf(rawBody);
    const current = await requireDoctor(db, id);
    access.assertBranchAccess(user, current.branch_id);
    const fullName = has(body, 'fullName') ? v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 }) : undefined;
    const email = has(body, 'email') ? v.email(body.email, 'email', { required: true }) : undefined;
    const phone = has(body, 'phone') ? v.phone(body.phone) : undefined;
    const password = has(body, 'password') && body.password !== '' ? v.password(body.password) : undefined;
    const avg = has(body, 'avgConsultMinutes')
      ? v.num(body.avgConsultMinutes, 'avgConsultMinutes', { required: true, min: 1, max: 120 })
      : undefined;
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : undefined;
    let departmentId;
    if (has(body, 'departmentId')) {
      departmentId = v.int(body.departmentId, 'departmentId', { required: true, min: 1 });
      if (departmentId !== current.department_id) {
        const dept = await departmentInScope(db, user, departmentId);
        if (dept.branch_id !== current.branch_id) {
          const sched = await DoctorSchedule.countDocuments({ doctor_id: id }).session(sess(db));
          if (sched > 0) {
            throw conflict('Remove the doctor\'s schedules before moving them to a department of another branch');
          }
        }
      }
    }
    await userService.assertUnique(
      db,
      { email: email || null, phone: phone || null },
      current.user_id
    );
    const hash = password ? await userService.hashPassword(password) : undefined;
    await db.transaction(async (tx) => {
      await updateColumns(tx, User, current.user_id, {
        full_name: fullName,
        email,
        phone,
        password_hash: hash,
        is_active: isActive,
      });
      await updateColumns(tx, Doctor, id, {
        department_id: departmentId,
        avg_consult_minutes: avg === undefined ? undefined : time.round(avg, 2),
        is_active: isActive,
      });
    });
    return toDoctor(await requireDoctor(db, id));
  },
  async remove(db, user, id) {
    const current = await requireDoctor(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await db.transaction(async (tx) => {
      await Doctor.updateOne({ _id: id }, { $set: { is_active: false } }, { session: sess(tx) });
      await User.updateOne({ _id: current.user_id }, { $set: { is_active: false } }, { session: sess(tx) });
    });
    return toDoctor(await requireDoctor(db, id));
  },
};

// =============================================================================================
// Doctor schedules (hard delete)
// =============================================================================================

/** Schedule rows with doctor name, specialty, branch and room name (inner joins). */
async function scheduleRows(db, filter) {
  const docs = await DoctorSchedule.find(filter).session(sess(db)).lean();
  const doctorRows = await scheduleService.getDoctors(db, docs.map((s) => s.doctor_id));
  const sps = await byIds(db, ServicePoint, docs.map((s) => s.service_point_id), { name: 1 });
  return docs
    .filter((s) => doctorRows.has(s.doctor_id) && sps.has(s.service_point_id))
    .map((s) => {
      const d = doctorRows.get(s.doctor_id);
      return {
        ...asRow(DoctorSchedule, s),
        doctor_name: d.full_name,
        specialty: d.specialty,
        branch_id: d.branch_id,
        branch_name: d.branch_name,
        service_point_name: sps.get(s.service_point_id).name,
      };
    });
}

function toSchedule(r) {
  return {
    id: r.schedule_id,
    doctorId: r.doctor_id,
    doctorName: r.doctor_name,
    specialty: r.specialty,
    servicePointId: r.service_point_id,
    servicePointName: r.service_point_name,
    branchId: r.branch_id,
    branchName: r.branch_name,
    dayOfWeek: Number(r.day_of_week),
    startTime: time.shortTime(r.start_time),
    endTime: time.shortTime(r.end_time),
    maxPatients: r.max_patients === null || r.max_patients === undefined ? null : Number(r.max_patients),
  };
}

async function requireSchedule(db, id) {
  const row = (await scheduleRows(db, { _id: id }))[0];
  if (!row) throw notFound('Schedule not found');
  return row;
}

/** Validate a full schedule (doctor/room/branch consistency, times, overlaps). */
async function validateSchedule(db, user, s, excludeId = 0) {
  const d = await Doctor.findById(s.doctorId, { department_id: 1 }).session(sess(db)).lean();
  const dept = d ? await Department.findById(d.department_id, { branch_id: 1 }).session(sess(db)).lean() : null;
  if (!d || !dept) throw notFound('Doctor not found');
  const doctor = { doctor_id: d._id, branch_id: dept.branch_id };
  access.assertBranchAccess(user, doctor.branch_id);
  const sp = await ServicePoint.findById(s.servicePointId, { branch_id: 1, type: 1 }).session(sess(db)).lean();
  if (!sp) throw notFound('Service point not found');
  if (sp.type !== 'OPD') throw badRequest('Doctor schedules must use an OPD room');
  if (sp.branch_id !== doctor.branch_id) throw badRequest("The room must belong to the doctor's branch");
  if (s.startTime >= s.endTime) throw badRequest('endTime must be after startTime');

  const sameDay = await DoctorSchedule.find({
    day_of_week: s.dayOfWeek,
    _id: { $ne: excludeId },
    $or: [{ doctor_id: s.doctorId }, { service_point_id: s.servicePointId }],
  })
    .session(sess(db))
    .lean();
  for (const o of sameDay) {
    const overlaps = time.normalizeTime(o.start_time) < s.endTime && s.startTime < time.normalizeTime(o.end_time);
    if (!overlaps) continue;
    if (o.doctor_id === s.doctorId) throw conflict('The doctor already has an overlapping session on that day');
    throw conflict('The room is already booked by another doctor at that time');
  }
}

function readSchedule(body, current) {
  const pick = (key, fn) => (has(body, key) || !current ? fn() : undefined);
  const s = {
    doctorId: pick('doctorId', () => v.int(body.doctorId, 'doctorId', { required: true, min: 1 })),
    servicePointId: pick('servicePointId', () => v.int(body.servicePointId, 'servicePointId', { required: true, min: 1 })),
    dayOfWeek: pick('dayOfWeek', () => v.int(body.dayOfWeek, 'dayOfWeek', { required: true, min: 1, max: 7 })),
    startTime: pick('startTime', () => v.timeOfDay(body.startTime, 'startTime', { required: true })),
    endTime: pick('endTime', () => v.timeOfDay(body.endTime, 'endTime', { required: true })),
    maxPatients: has(body, 'maxPatients') ? v.int(body.maxPatients, 'maxPatients', { min: 1, max: 500 }) : undefined,
  };
  if (current) {
    return {
      doctorId: s.doctorId ?? current.doctor_id,
      servicePointId: s.servicePointId ?? current.service_point_id,
      dayOfWeek: s.dayOfWeek ?? Number(current.day_of_week),
      startTime: s.startTime ?? time.normalizeTime(current.start_time),
      endTime: s.endTime ?? time.normalizeTime(current.end_time),
      maxPatients: s.maxPatients === undefined ? current.max_patients : s.maxPatients,
    };
  }
  return { ...s, maxPatients: s.maxPatients === undefined ? null : s.maxPatients };
}

const schedules = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const doctorId = v.int(query.doctorId, 'doctorId', { min: 1 });
    const servicePointId = v.int(query.servicePointId, 'servicePointId', { min: 1 });
    const filter = {};
    if (doctorId) filter.doctor_id = doctorId;
    if (servicePointId) filter.service_point_id = servicePointId;
    const rows = (await scheduleRows(db, filter)).filter((r) => !scope || r.branch_id === scope);
    rows.sort(
      (a, b) =>
        a.branch_id - b.branch_id ||
        cmp(a.doctor_name, b.doctor_name) ||
        a.day_of_week - b.day_of_week ||
        cmp(a.start_time, b.start_time)
    );
    return rows.map(toSchedule);
  },
  async get(db, user, id) {
    const row = await requireSchedule(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toSchedule(row);
  },
  async create(db, user, rawBody) {
    const s = readSchedule(bodyOf(rawBody), null);
    await validateSchedule(db, user, s);
    const insertId = await insertOne(db, DoctorSchedule, {
      doctor_id: s.doctorId,
      service_point_id: s.servicePointId,
      day_of_week: s.dayOfWeek,
      start_time: s.startTime,
      end_time: s.endTime,
      max_patients: s.maxPatients,
    });
    return toSchedule(await requireSchedule(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const current = await requireSchedule(db, id);
    access.assertBranchAccess(user, current.branch_id);
    const s = readSchedule(bodyOf(rawBody), current);
    await validateSchedule(db, user, s, id);
    await DoctorSchedule.updateOne(
      { _id: id },
      {
        $set: {
          doctor_id: s.doctorId,
          service_point_id: s.servicePointId,
          day_of_week: s.dayOfWeek,
          start_time: s.startTime,
          end_time: s.endTime,
          max_patients: s.maxPatients === undefined ? null : s.maxPatients,
        },
      },
      { session: sess(db) }
    );
    return toSchedule(await requireSchedule(db, id));
  },
  async remove(db, user, id) {
    const current = await requireSchedule(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await DoctorSchedule.deleteOne({ _id: id }, { session: sess(db) });
    return toSchedule(current);
  },
};

// =============================================================================================
// Service points (OPD rooms, LAB and PHARMACY counters)
// =============================================================================================

async function servicePointRows(db, filter) {
  const docs = await ServicePoint.find(filter).session(sess(db)).lean();
  const branchNames = await byIds(db, Branch, docs.map((s) => s.branch_id), { name: 1 });
  return docs
    .filter((s) => branchNames.has(s.branch_id))
    .map((s) => ({ ...asRow(ServicePoint, s), branch_name: branchNames.get(s.branch_id).name }));
}

function toServicePoint(r) {
  return {
    id: r.service_point_id,
    branchId: r.branch_id,
    branchName: r.branch_name,
    type: r.type,
    name: r.name,
    isActive: Boolean(r.is_active),
  };
}

async function requireServicePoint(db, id) {
  const row = (await servicePointRows(db, { _id: id }))[0];
  if (!row) throw notFound('Service point not found');
  return row;
}

async function assertServicePointNameFree(db, branchId, name, excludeId = 0) {
  const dup = await ServicePoint.exists({ branch_id: branchId, name: ciEquals(name), _id: { $ne: excludeId } }).session(sess(db));
  if (dup) throw conflict(`A service point named "${name}" already exists at this branch`);
}

async function servicePointInUse(db, id) {
  const s = sess(db);
  return Boolean(
    (await DoctorSchedule.exists({ service_point_id: id }).session(s)) ||
      (await StaffAssignment.exists({ service_point_id: id }).session(s)) ||
      (await Token.exists({ service_point_id: id }).session(s))
  );
}

const servicePoints = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const type = v.oneOf(query.type, 'type', SERVICE_POINT_TYPES);
    const filter = {};
    if (scope) filter.branch_id = scope;
    if (type) filter.type = type;
    const rows = await servicePointRows(db, filter);
    rows.sort((a, b) => a.branch_id - b.branch_id || cmp(a.type, b.type) || a.service_point_id - b.service_point_id);
    return rows.map(toServicePoint);
  },
  async get(db, user, id) {
    const row = await requireServicePoint(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toServicePoint(row);
  },
  async create(db, user, rawBody) {
    const body = bodyOf(rawBody);
    const branchId = v.int(body.branchId, 'branchId', { required: true, min: 1 });
    access.assertBranchAccess(user, branchId);
    await requireBranch(db, branchId);
    const type = v.oneOf(body.type, 'type', SERVICE_POINT_TYPES, { required: true });
    const name = v.str(body.name, 'name', { required: true, min: 1, max: 60 });
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : true;
    await assertServicePointNameFree(db, branchId, name);
    const insertId = await insertOne(db, ServicePoint, { branch_id: branchId, type, name, is_active: isActive });
    return toServicePoint(await requireServicePoint(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const body = bodyOf(rawBody);
    const current = await requireServicePoint(db, id);
    access.assertBranchAccess(user, current.branch_id);
    let branchId;
    if (has(body, 'branchId')) {
      branchId = v.int(body.branchId, 'branchId', { required: true, min: 1 });
      if (branchId !== current.branch_id) {
        access.assertBranchAccess(user, branchId);
        await requireBranch(db, branchId);
        if (await servicePointInUse(db, id)) {
          throw conflict('A service point with schedules, assignments or tokens cannot move to another branch');
        }
      }
    }
    const type = has(body, 'type') ? v.oneOf(body.type, 'type', SERVICE_POINT_TYPES, { required: true }) : undefined;
    if (type && type !== current.type && (await servicePointInUse(db, id))) {
      throw conflict('The type of a service point in use cannot be changed');
    }
    const name = has(body, 'name') ? v.str(body.name, 'name', { required: true, min: 1, max: 60 }) : undefined;
    if (name || branchId) await assertServicePointNameFree(db, branchId || current.branch_id, name || current.name, id);
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : undefined;
    await updateColumns(db, ServicePoint, id, {
      branch_id: branchId,
      type,
      name,
      is_active: isActive,
    });
    return toServicePoint(await requireServicePoint(db, id));
  },
  async remove(db, user, id) {
    const current = await requireServicePoint(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await ServicePoint.updateOne({ _id: id }, { $set: { is_active: false } }, { session: sess(db) });
    return toServicePoint(await requireServicePoint(db, id));
  },
};

// =============================================================================================
// User accounts
// =============================================================================================

/** Branch ids a user is affiliated with: Map userId -> Set(branchId). */
async function userBranchMap(db, userIds) {
  const map = new Map(userIds.map((id) => [id, new Set()]));
  if (!userIds.length) return map;
  const s = sess(db);
  const users = await User.find({ _id: { $in: userIds }, admin_branch_id: { $ne: null } }, { admin_branch_id: 1 }).session(s).lean();
  for (const u of users) map.get(u._id).add(u.admin_branch_id);
  const assigns = await StaffAssignment.find({ user_id: { $in: userIds } }).session(s).lean();
  const sps = await byIds(db, ServicePoint, assigns.map((a) => a.service_point_id), { branch_id: 1 });
  for (const a of assigns) if (sps.has(a.service_point_id)) map.get(a.user_id).add(sps.get(a.service_point_id).branch_id);
  const docs = await Doctor.find({ user_id: { $in: userIds } }, { user_id: 1, department_id: 1 }).session(s).lean();
  const depts = await byIds(db, Department, docs.map((d) => d.department_id), { branch_id: 1 });
  for (const d of docs) if (depts.has(d.department_id)) map.get(d.user_id).add(depts.get(d.department_id).branch_id);
  return map;
}

/** Contract User shape for many rows at once (doctorId, assignments) + adminBranchName. */
async function serializeUsers(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.user_id);
  const doctorsByUser = new Map();
  const assignmentsByUser = new Map();
  const CHUNK = 1000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const docs = await Doctor.find({ user_id: { $in: chunk } }, { user_id: 1 }).session(sess(db)).lean();
    docs.forEach((d) => doctorsByUser.set(d.user_id, d._id));
    for (const a of await userService.assignmentRows(db, chunk)) {
      if (!assignmentsByUser.has(a.user_id)) assignmentsByUser.set(a.user_id, []);
      assignmentsByUser.get(a.user_id).push({
        servicePointId: a.service_point_id,
        servicePointName: a.name,
        type: a.type,
        branchId: a.branch_id,
        branchName: a.branch_name,
      });
    }
  }
  const branchNames = new Map((await Branch.find({}, { name: 1 }).session(sess(db)).lean()).map((b) => [b._id, b.name]));
  return rows.map((row) => ({
    id: row.user_id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    dateOfBirth: time.toApiDate(row.date_of_birth),
    priorityCategory: row.priority_category,
    adminBranchId: row.admin_branch_id || null,
    adminBranchName: row.admin_branch_id ? branchNames.get(row.admin_branch_id) || null : null,
    isActive: Boolean(row.is_active),
    doctorId: doctorsByUser.get(row.user_id) || null,
    assignments: assignmentsByUser.get(row.user_id) || [],
    createdAt: time.toApi(row.created_at),
  }));
}

async function requireUser(db, id) {
  const row = asRow(User, await User.findById(id).session(sess(db)).lean());
  if (!row) throw notFound('User not found');
  return row;
}

/**
 * Branch admins may only see/manage STAFF accounts affiliated with their branch: home branch
 * (admin_branch_id), a service-point assignment or a doctor department there. Unaffiliated staff
 * (no branch at all) are managed by the hospital administrator only, so a branch admin cannot
 * take them over by assigning them to the own branch.
 */
async function assertUserManageable(db, user, target) {
  if (isHospitalAdmin(user)) return;
  if (target.role !== 'STAFF') throw forbidden('Branch administrators can only manage staff accounts');
  const branchesOfTarget = (await userBranchMap(db, [target.user_id])).get(target.user_id);
  if (branchesOfTarget.has(user.admin_branch_id)) return;
  throw forbidden(
    branchesOfTarget.size === 0
      ? 'This staff member has no branch yet; only the hospital administrator can manage them'
      : 'This staff member does not belong to your branch'
  );
}

async function serializeOne(db, row) {
  return (await serializeUsers(db, [row]))[0];
}

const ROLE_ORDER = { HOSPITAL_ADMIN: 0, BRANCH_ADMIN: 1, STAFF: 2 };

const users = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    // ?role= takes one role or a comma-separated list (e.g. STAFF,BRANCH_ADMIN,HOSPITAL_ADMIN).
    let roles = [...new Set(String(query.role ?? '').split(',').map((r) => r.trim()).filter(Boolean)
      .map((r) => v.oneOf(r, 'role', ALL_ROLES, { required: true })))];
    if (!isHospitalAdmin(user)) {
      if (roles.some((r) => r !== 'STAFF')) throw forbidden('Branch administrators can only list staff accounts');
      roles = ['STAFF'];
    }
    const filter = {};
    if (roles.length) filter.role = { $in: roles };
    if (scope) {
      const spIds = await ServicePoint.distinct('_id', { branch_id: scope }).session(sess(db));
      const deptIds = await Department.distinct('_id', { branch_id: scope }).session(sess(db));
      const assigned = await StaffAssignment.distinct('user_id', { service_point_id: { $in: spIds } }).session(sess(db));
      const doctorUsers = await Doctor.distinct('user_id', { department_id: { $in: deptIds } }).session(sess(db));
      filter.$or = [{ admin_branch_id: scope }, { _id: { $in: [...new Set([...assigned, ...doctorUsers])] } }];
    }
    const rows = asRows(User, await User.find(filter).session(sess(db)).lean());
    rows.sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) || cmp(a.full_name, b.full_name) || a.user_id - b.user_id
    );
    return serializeUsers(db, rows);
  },
  async get(db, user, id) {
    const row = await requireUser(db, id);
    await assertUserManageable(db, user, row);
    return serializeOne(db, row);
  },
  async create(db, user, rawBody) {
    const body = bodyOf(rawBody);
    const fullName = v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 });
    const email = v.email(body.email, 'email', { required: true });
    const phone = v.phone(body.phone);
    const password = v.password(body.password, 'password', { required: true });
    const role = v.oneOf(body.role, 'role', STAFF_ROLES, { required: true });
    let adminBranchId = v.int(body.adminBranchId, 'adminBranchId', { min: 1 });
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : true;

    if (!isHospitalAdmin(user)) {
      if (role !== 'STAFF') throw forbidden('Branch administrators can only create staff accounts');
      if (adminBranchId && adminBranchId !== user.admin_branch_id) {
        throw forbidden('Branch administrators can only create staff for their own branch');
      }
      adminBranchId = user.admin_branch_id; // the staff member's home branch
    }
    if (role === 'BRANCH_ADMIN' && !adminBranchId) throw badRequest('adminBranchId is required for a branch administrator');
    if (role === 'HOSPITAL_ADMIN') adminBranchId = null;
    if (adminBranchId) await requireBranch(db, adminBranchId);
    await userService.assertUnique(db, { email, phone });
    const hash = await userService.hashPassword(password);
    const insertId = await insertOne(db, User, {
      full_name: fullName,
      email,
      phone,
      password_hash: hash,
      role,
      date_of_birth: null,
      priority_category: 'NONE',
      admin_branch_id: adminBranchId || null,
      fcm_token: null,
      is_active: isActive,
      created_at: time.nowDb(),
    });
    return serializeOne(db, await requireUser(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const body = bodyOf(rawBody);
    const target = await requireUser(db, id);
    await assertUserManageable(db, user, target);
    const isSelf = target.user_id === user.user_id;

    const fullName = has(body, 'fullName') ? v.str(body.fullName, 'fullName', { required: true, min: 2, max: 100 }) : undefined;
    const email = has(body, 'email') ? v.email(body.email) : undefined;
    const phone = has(body, 'phone') ? v.phone(body.phone) : undefined;
    const password = has(body, 'password') && body.password !== '' ? v.password(body.password) : undefined;
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : undefined;
    let role = has(body, 'role') ? v.oneOf(body.role, 'role', ALL_ROLES, { required: true }) : target.role;
    let adminBranchId = has(body, 'adminBranchId')
      ? v.int(body.adminBranchId, 'adminBranchId', { min: 1 })
      : target.admin_branch_id || null;

    if (role !== target.role) {
      if (target.role === 'PATIENT' || role === 'PATIENT') throw badRequest('Patient accounts cannot change role');
      if (!isHospitalAdmin(user)) throw forbidden('Branch administrators cannot change roles');
      if (isSelf) throw conflict('You cannot change your own role');
      const doctor = await Doctor.exists({ user_id: id }).session(sess(db));
      if (doctor) throw conflict('Doctor accounts must keep the STAFF role');
    }
    if (isSelf && isActive === false) throw conflict('You cannot deactivate your own account');
    if (!isHospitalAdmin(user) && adminBranchId && adminBranchId !== user.admin_branch_id) {
      throw forbidden('Branch administrators can only assign their own branch');
    }
    if (role === 'BRANCH_ADMIN' && !adminBranchId) throw badRequest('adminBranchId is required for a branch administrator');
    if (role === 'HOSPITAL_ADMIN' || role === 'PATIENT') adminBranchId = null;
    if (adminBranchId) await requireBranch(db, adminBranchId);

    const finalEmail = email === undefined ? target.email : email;
    const finalPhone = phone === undefined ? target.phone : phone;
    if (!finalEmail && !finalPhone) throw badRequest('An account needs an e-mail address or a phone number');
    await userService.assertUnique(db, { email: email || null, phone: phone || null }, id);
    const hash = password ? await userService.hashPassword(password) : undefined;
    await updateColumns(db, User, id, {
      full_name: fullName,
      email,
      phone,
      password_hash: hash,
      role: role !== target.role ? role : undefined,
      admin_branch_id: adminBranchId !== (target.admin_branch_id || null) ? adminBranchId : undefined,
      is_active: isActive,
    });
    return serializeOne(db, await requireUser(db, id));
  },
  async remove(db, user, id) {
    const target = await requireUser(db, id);
    await assertUserManageable(db, user, target);
    if (target.user_id === user.user_id) throw conflict('You cannot deactivate your own account');
    await User.updateOne({ _id: id }, { $set: { is_active: false } }, { session: sess(db) });
    return serializeOne(db, await requireUser(db, id));
  },
};

// =============================================================================================
// Staff assignments (hard delete)
// =============================================================================================

/** Assignment rows with user name/role, service point name/type/branch and branch name. */
async function assignmentRows(db, filter) {
  const docs = await StaffAssignment.find(filter).session(sess(db)).lean();
  const usersById = await byIds(db, User, docs.map((a) => a.user_id), { full_name: 1, role: 1 });
  const sps = await byIds(db, ServicePoint, docs.map((a) => a.service_point_id), { name: 1, type: 1, branch_id: 1 });
  const branchNames = await byIds(db, Branch, [...sps.values()].map((s) => s.branch_id), { name: 1 });
  return docs
    .filter((a) => usersById.has(a.user_id) && sps.has(a.service_point_id) && branchNames.has(sps.get(a.service_point_id).branch_id))
    .map((a) => {
      const u = usersById.get(a.user_id);
      const sp = sps.get(a.service_point_id);
      return {
        assignment_id: a._id,
        user_id: a.user_id,
        user_name: u.full_name,
        role: u.role,
        service_point_id: a.service_point_id,
        service_point_name: sp.name,
        type: sp.type,
        branch_id: sp.branch_id,
        branch_name: branchNames.get(sp.branch_id).name,
      };
    });
}

function toAssignment(r) {
  return {
    id: r.assignment_id,
    userId: r.user_id,
    userName: r.user_name,
    servicePointId: r.service_point_id,
    servicePointName: r.service_point_name,
    type: r.type,
    branchId: r.branch_id,
    branchName: r.branch_name,
  };
}

async function requireAssignment(db, id) {
  const row = (await assignmentRows(db, { _id: id }))[0];
  if (!row) throw notFound('Assignment not found');
  return row;
}

const assignments = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const userId = v.int(query.userId, 'userId', { min: 1 });
    const servicePointId = v.int(query.servicePointId, 'servicePointId', { min: 1 });
    const filter = {};
    if (userId) filter.user_id = userId;
    if (servicePointId) filter.service_point_id = servicePointId;
    const rows = (await assignmentRows(db, filter)).filter((r) => !scope || r.branch_id === scope);
    rows.sort((a, b) => a.branch_id - b.branch_id || cmp(a.user_name, b.user_name) || cmp(a.service_point_name, b.service_point_name));
    return rows.map(toAssignment);
  },
  async get(db, user, id) {
    const row = await requireAssignment(db, id);
    access.assertBranchAccess(user, row.branch_id);
    return toAssignment(row);
  },
  async create(db, user, rawBody) {
    const body = bodyOf(rawBody);
    const userId = v.int(body.userId, 'userId', { required: true, min: 1 });
    const servicePointId = v.int(body.servicePointId, 'servicePointId', { required: true, min: 1 });
    const target = await requireUser(db, userId);
    if (target.role !== 'STAFF') throw badRequest('Only staff accounts can be assigned to service points');
    const sp = await requireServicePoint(db, servicePointId);
    access.assertBranchAccess(user, sp.branch_id);
    await assertUserManageable(db, user, target);
    if (!sp.is_active) throw badRequest('The service point is inactive');
    const dup = await StaffAssignment.exists({ user_id: userId, service_point_id: servicePointId }).session(sess(db));
    if (dup) throw conflict('This staff member is already assigned to that service point');
    // The unique index uq_assignment backs this check (duplicate key -> 409).
    const insertId = await insertOne(db, StaffAssignment, { user_id: userId, service_point_id: servicePointId });
    return toAssignment(await requireAssignment(db, insertId));
  },
  async remove(db, user, id) {
    const current = await requireAssignment(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await StaffAssignment.deleteOne({ _id: id }, { session: sess(db) });
    return toAssignment(current);
  },
};

module.exports = {
  branches,
  departments,
  doctors,
  schedules,
  servicePoints,
  users,
  assignments,
  serializeUsers,
  requireHospitalAdmin,
  listScope,
};
