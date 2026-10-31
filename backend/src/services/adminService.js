'use strict';
/**
 * Administration of master data and accounts (FR-14) with the Section 3.2 scoping rules:
 *
 *  - HOSPITAL_ADMIN manages everything (optional ?branchId= filter on lists).
 *  - BRANCH_ADMIN manages departments, doctors, schedules, service points, staff accounts and
 *    staff assignments of their own branch only; branches are read-only for them and requests
 *    that target another branch answer 403 FORBIDDEN.
 *
 * DELETE on master data is a soft deactivation (is_active = 0 / status = INACTIVE) so records
 * referenced by tokens and history are never lost; schedules and staff assignments, which are
 * pure configuration, are hard-deleted.
 */
const time = require('../utils/time');
const v = require('../utils/validate');
const { badRequest, conflict, forbidden, notFound } = require('../utils/errors');
const access = require('./accessService');
const userService = require('./userService');
const { placeholders } = require('../db');

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

/** Branch filter for list endpoints (403 when a branch admin asks for another branch). */
function listScope(user, query) {
  const requested = v.int(query.branchId, 'branchId', { min: 1 });
  return access.scopeBranch(user, requested);
}

async function requireBranch(db, branchId) {
  const b = await db.get('SELECT * FROM branches WHERE branch_id = ?', [branchId]);
  if (!b) throw notFound('Branch not found');
  return b;
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
  const dup = await db.get('SELECT branch_id FROM branches WHERE LOWER(name) = ? AND branch_id <> ?', [
    name.toLowerCase(),
    excludeId,
  ]);
  if (dup) throw conflict(`A branch named "${name}" already exists`);
}

const branches = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const rows = await db.query(
      `SELECT * FROM branches ${scope ? 'WHERE branch_id = ?' : ''} ORDER BY branch_id`,
      scope ? [scope] : []
    );
    return rows.map(toBranch);
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
    const { insertId } = await db.run(
      'INSERT INTO branches (name, address, latitude, longitude, status) VALUES (?, ?, ?, ?, ?)',
      [data.name, data.address || null, data.latitude, data.longitude, data.status || 'ACTIVE']
    );
    return toBranch(await requireBranch(db, insertId));
  },
  async update(db, user, id, rawBody) {
    requireHospitalAdmin(user, 'branch changes');
    const current = await requireBranch(db, id);
    const data = validateBranch(bodyOf(rawBody), current);
    if (data.name) await assertBranchNameFree(db, data.name, id);
    await updateColumns(db, 'branches', 'branch_id', id, {
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
    await db.run(`UPDATE branches SET status = 'INACTIVE' WHERE branch_id = ?`, [id]);
    return toBranch(await requireBranch(db, id));
  },
};

/** UPDATE only the provided (non-undefined) columns. */
async function updateColumns(db, table, idColumn, id, columns) {
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  await db.run(
    `UPDATE ${table} SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE ${idColumn} = ?`,
    [...entries.map(([, value]) => (typeof value === 'boolean' ? (value ? 1 : 0) : value)), id]
  );
}

// =============================================================================================
// Departments
// =============================================================================================

const DEPARTMENT_SQL = `
  SELECT dp.*, b.name AS branch_name,
         (SELECT COUNT(*) FROM doctors d WHERE d.department_id = dp.department_id AND d.is_active = 1) AS doctor_count
    FROM departments dp JOIN branches b ON b.branch_id = dp.branch_id`;

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
  const row = await db.get(`${DEPARTMENT_SQL} WHERE dp.department_id = ?`, [id]);
  if (!row) throw notFound('Department not found');
  return row;
}

async function assertSpecialtyFree(db, branchId, specialty, excludeId = 0) {
  const dup = await db.get(
    `SELECT department_id FROM departments
      WHERE branch_id = ? AND LOWER(specialty) = ? AND is_active = 1 AND department_id <> ?`,
    [branchId, specialty.toLowerCase(), excludeId]
  );
  if (dup) throw conflict(`An active ${specialty} department already exists at this branch`);
}

const departments = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const rows = await db.query(
      `${DEPARTMENT_SQL} ${scope ? 'WHERE dp.branch_id = ?' : ''} ORDER BY dp.branch_id, dp.specialty, dp.department_id`,
      scope ? [scope] : []
    );
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
    const { insertId } = await db.run(
      'INSERT INTO departments (branch_id, specialty, name, is_active) VALUES (?, ?, ?, ?)',
      [branchId, specialty, name, isActive ? 1 : 0]
    );
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
        const used = await db.get('SELECT COUNT(*) AS n FROM doctors WHERE department_id = ?', [id]);
        if (Number(used.n) > 0) throw conflict('A department with doctors cannot be moved to another branch');
      }
    }
    const specialty = has(body, 'specialty') ? v.str(body.specialty, 'specialty', { required: true, min: 2, max: 80 }) : undefined;
    const name = has(body, 'name') ? v.str(body.name, 'name', { max: 100 }) || specialty || current.specialty : undefined;
    const isActive = has(body, 'isActive') ? v.bool(body.isActive, 'isActive', { required: true }) : undefined;
    const finalActive = isActive === undefined ? Boolean(current.is_active) : isActive;
    if (finalActive) {
      await assertSpecialtyFree(db, branchId || current.branch_id, specialty || current.specialty, id);
    }
    await updateColumns(db, 'departments', 'department_id', id, {
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
    await db.run('UPDATE departments SET is_active = 0 WHERE department_id = ?', [id]);
    return toDepartment(await requireDepartment(db, id));
  },
};

// =============================================================================================
// Doctors (STAFF user + doctors row)
// =============================================================================================

const DOCTOR_SQL = `
  SELECT d.doctor_id, d.user_id, d.department_id, d.avg_consult_minutes, d.is_active,
         u.full_name, u.email, u.phone, u.is_active AS user_active,
         dp.name AS department_name, dp.specialty, dp.branch_id, b.name AS branch_name
    FROM doctors d
    JOIN users u ON u.user_id = d.user_id
    JOIN departments dp ON dp.department_id = d.department_id
    JOIN branches b ON b.branch_id = dp.branch_id`;

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
  const row = await db.get(`${DOCTOR_SQL} WHERE d.doctor_id = ?`, [id]);
  if (!row) throw notFound('Doctor not found');
  return row;
}

async function departmentInScope(db, user, departmentId) {
  const dept = await db.get('SELECT department_id, branch_id, is_active FROM departments WHERE department_id = ?', [
    departmentId,
  ]);
  if (!dept) throw notFound('Department not found');
  access.assertBranchAccess(user, dept.branch_id);
  return dept;
}

const doctors = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const departmentId = v.int(query.departmentId, 'departmentId', { min: 1 });
    const where = [];
    const params = [];
    if (scope) {
      where.push('dp.branch_id = ?');
      params.push(scope);
    }
    if (departmentId) {
      where.push('d.department_id = ?');
      params.push(departmentId);
    }
    const rows = await db.query(
      `${DOCTOR_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY dp.branch_id, dp.specialty, u.full_name`,
      params
    );
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
    const doctorId = await db.transaction(async (tx) => {
      const u = await tx.run(
        `INSERT INTO users (full_name, email, phone, password_hash, role, date_of_birth, priority_category,
                            admin_branch_id, fcm_token, is_active, created_at)
         VALUES (?, ?, ?, ?, 'STAFF', NULL, 'NONE', NULL, NULL, 1, ?)`,
        [fullName, email, phone, hash, time.nowDb()]
      );
      const d = await tx.run(
        'INSERT INTO doctors (user_id, department_id, avg_consult_minutes, is_active) VALUES (?, ?, ?, 1)',
        [u.insertId, departmentId, avg === null ? 10 : time.round(avg, 2)]
      );
      return d.insertId;
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
          const sched = await db.get('SELECT COUNT(*) AS n FROM doctor_schedules WHERE doctor_id = ?', [id]);
          if (Number(sched.n) > 0) {
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
      await updateColumns(tx, 'users', 'user_id', current.user_id, {
        full_name: fullName,
        email,
        phone,
        password_hash: hash,
        is_active: isActive,
      });
      await updateColumns(tx, 'doctors', 'doctor_id', id, {
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
      await tx.run('UPDATE doctors SET is_active = 0 WHERE doctor_id = ?', [id]);
      await tx.run('UPDATE users SET is_active = 0 WHERE user_id = ?', [current.user_id]);
    });
    return toDoctor(await requireDoctor(db, id));
  },
};

// =============================================================================================
// Doctor schedules (hard delete)
// =============================================================================================

const SCHEDULE_SQL = `
  SELECT ds.*, u.full_name AS doctor_name, dp.specialty, dp.branch_id, b.name AS branch_name,
         sp.name AS service_point_name
    FROM doctor_schedules ds
    JOIN doctors d ON d.doctor_id = ds.doctor_id
    JOIN users u ON u.user_id = d.user_id
    JOIN departments dp ON dp.department_id = d.department_id
    JOIN branches b ON b.branch_id = dp.branch_id
    JOIN service_points sp ON sp.service_point_id = ds.service_point_id`;

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
  const row = await db.get(`${SCHEDULE_SQL} WHERE ds.schedule_id = ?`, [id]);
  if (!row) throw notFound('Schedule not found');
  return row;
}

/** Validate a full schedule (doctor/room/branch consistency, times, overlaps). */
async function validateSchedule(db, user, s, excludeId = 0) {
  const doctor = await db.get(
    `SELECT d.doctor_id, dp.branch_id FROM doctors d JOIN departments dp ON dp.department_id = d.department_id
      WHERE d.doctor_id = ?`,
    [s.doctorId]
  );
  if (!doctor) throw notFound('Doctor not found');
  access.assertBranchAccess(user, doctor.branch_id);
  const sp = await db.get('SELECT service_point_id, branch_id, type FROM service_points WHERE service_point_id = ?', [
    s.servicePointId,
  ]);
  if (!sp) throw notFound('Service point not found');
  if (sp.type !== 'OPD') throw badRequest('Doctor schedules must use an OPD room');
  if (sp.branch_id !== doctor.branch_id) throw badRequest("The room must belong to the doctor's branch");
  if (s.startTime >= s.endTime) throw badRequest('endTime must be after startTime');

  const sameDay = await db.query(
    `SELECT ds.schedule_id, ds.doctor_id, ds.service_point_id, ds.start_time, ds.end_time
       FROM doctor_schedules ds
      WHERE ds.day_of_week = ? AND ds.schedule_id <> ? AND (ds.doctor_id = ? OR ds.service_point_id = ?)`,
    [s.dayOfWeek, excludeId, s.doctorId, s.servicePointId]
  );
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
    const where = [];
    const params = [];
    if (scope) {
      where.push('dp.branch_id = ?');
      params.push(scope);
    }
    if (doctorId) {
      where.push('ds.doctor_id = ?');
      params.push(doctorId);
    }
    if (servicePointId) {
      where.push('ds.service_point_id = ?');
      params.push(servicePointId);
    }
    const rows = await db.query(
      `${SCHEDULE_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY dp.branch_id, u.full_name, ds.day_of_week, ds.start_time`,
      params
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
    const { insertId } = await db.run(
      `INSERT INTO doctor_schedules (doctor_id, service_point_id, day_of_week, start_time, end_time, max_patients)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [s.doctorId, s.servicePointId, s.dayOfWeek, s.startTime, s.endTime, s.maxPatients]
    );
    return toSchedule(await requireSchedule(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const current = await requireSchedule(db, id);
    access.assertBranchAccess(user, current.branch_id);
    const s = readSchedule(bodyOf(rawBody), current);
    await validateSchedule(db, user, s, id);
    await db.run(
      `UPDATE doctor_schedules SET doctor_id = ?, service_point_id = ?, day_of_week = ?, start_time = ?, end_time = ?,
              max_patients = ? WHERE schedule_id = ?`,
      [s.doctorId, s.servicePointId, s.dayOfWeek, s.startTime, s.endTime, s.maxPatients, id]
    );
    return toSchedule(await requireSchedule(db, id));
  },
  async remove(db, user, id) {
    const current = await requireSchedule(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await db.run('DELETE FROM doctor_schedules WHERE schedule_id = ?', [id]);
    return toSchedule(current);
  },
};

// =============================================================================================
// Service points (OPD rooms, LAB and PHARMACY counters)
// =============================================================================================

const SERVICE_POINT_SQL = `
  SELECT sp.*, b.name AS branch_name FROM service_points sp JOIN branches b ON b.branch_id = sp.branch_id`;

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
  const row = await db.get(`${SERVICE_POINT_SQL} WHERE sp.service_point_id = ?`, [id]);
  if (!row) throw notFound('Service point not found');
  return row;
}

async function assertServicePointNameFree(db, branchId, name, excludeId = 0) {
  const dup = await db.get(
    'SELECT service_point_id FROM service_points WHERE branch_id = ? AND LOWER(name) = ? AND service_point_id <> ?',
    [branchId, name.toLowerCase(), excludeId]
  );
  if (dup) throw conflict(`A service point named "${name}" already exists at this branch`);
}

async function servicePointInUse(db, id) {
  const row = await db.get(
    `SELECT (SELECT COUNT(*) FROM doctor_schedules WHERE service_point_id = ?) +
            (SELECT COUNT(*) FROM staff_assignments WHERE service_point_id = ?) +
            (SELECT COUNT(*) FROM tokens WHERE service_point_id = ?) AS n`,
    [id, id, id]
  );
  return Number(row.n) > 0;
}

const servicePoints = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const type = v.oneOf(query.type, 'type', SERVICE_POINT_TYPES);
    const where = [];
    const params = [];
    if (scope) {
      where.push('sp.branch_id = ?');
      params.push(scope);
    }
    if (type) {
      where.push('sp.type = ?');
      params.push(type);
    }
    const rows = await db.query(
      `${SERVICE_POINT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY sp.branch_id, sp.type, sp.service_point_id`,
      params
    );
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
    const { insertId } = await db.run(
      'INSERT INTO service_points (branch_id, type, name, is_active) VALUES (?, ?, ?, ?)',
      [branchId, type, name, isActive ? 1 : 0]
    );
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
    await updateColumns(db, 'service_points', 'service_point_id', id, {
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
    await db.run('UPDATE service_points SET is_active = 0 WHERE service_point_id = ?', [id]);
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
  const ph = placeholders(userIds.length);
  const rows = await db.query(
    `SELECT u.user_id, u.admin_branch_id AS branch_id FROM users u
      WHERE u.user_id IN (${ph}) AND u.admin_branch_id IS NOT NULL
     UNION
     SELECT sa.user_id, sp.branch_id FROM staff_assignments sa
       JOIN service_points sp ON sp.service_point_id = sa.service_point_id
      WHERE sa.user_id IN (${ph})
     UNION
     SELECT d.user_id, dp.branch_id FROM doctors d JOIN departments dp ON dp.department_id = d.department_id
      WHERE d.user_id IN (${ph})`,
    [...userIds, ...userIds, ...userIds]
  );
  for (const r of rows) map.get(r.user_id).add(r.branch_id);
  return map;
}

/** Contract User shape for many rows at once (doctorId, assignments) + adminBranchName. */
async function serializeUsers(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.user_id);
  const out = new Map();
  const CHUNK = 400;
  const doctorsByUser = new Map();
  const assignmentsByUser = new Map();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = placeholders(chunk.length);
    const docs = await db.query(`SELECT doctor_id, user_id FROM doctors WHERE user_id IN (${ph})`, chunk);
    docs.forEach((d) => doctorsByUser.set(d.user_id, d.doctor_id));
    const assigns = await db.query(
      `SELECT sa.user_id, sa.service_point_id, sp.name, sp.type, sp.branch_id, b.name AS branch_name
         FROM staff_assignments sa JOIN service_points sp ON sp.service_point_id = sa.service_point_id
         JOIN branches b ON b.branch_id = sp.branch_id
        WHERE sa.user_id IN (${ph}) ORDER BY sa.assignment_id`,
      chunk
    );
    for (const a of assigns) {
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
  const branchNames = new Map(
    (await db.query('SELECT branch_id, name FROM branches', [])).map((b) => [b.branch_id, b.name])
  );
  for (const row of rows) {
    out.set(row.user_id, {
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
    });
  }
  return rows.map((r) => out.get(r.user_id));
}

async function requireUser(db, id) {
  const row = await db.get('SELECT * FROM users WHERE user_id = ?', [id]);
  if (!row) throw notFound('User not found');
  return row;
}

/** Branch admins may only see/manage STAFF accounts affiliated with their branch. */
async function assertUserManageable(db, user, target, { allowUnaffiliated = false } = {}) {
  if (isHospitalAdmin(user)) return;
  if (target.role !== 'STAFF') throw forbidden('Branch administrators can only manage staff accounts');
  const branchesOfTarget = (await userBranchMap(db, [target.user_id])).get(target.user_id);
  if (branchesOfTarget.has(user.admin_branch_id)) return;
  if (allowUnaffiliated && branchesOfTarget.size === 0) return;
  throw forbidden('This staff member does not belong to your branch');
}

async function serializeOne(db, row) {
  return (await serializeUsers(db, [row]))[0];
}

const users = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    let role = v.oneOf(query.role, 'role', ALL_ROLES);
    if (!isHospitalAdmin(user)) {
      if (role && role !== 'STAFF') throw forbidden('Branch administrators can only list staff accounts');
      role = 'STAFF';
    }
    const where = [];
    const params = [];
    if (role) {
      where.push('u.role = ?');
      params.push(role);
    }
    if (scope) {
      where.push(`(u.admin_branch_id = ?
        OR u.user_id IN (SELECT sa.user_id FROM staff_assignments sa
                           JOIN service_points sp ON sp.service_point_id = sa.service_point_id WHERE sp.branch_id = ?)
        OR u.user_id IN (SELECT d.user_id FROM doctors d
                           JOIN departments dp ON dp.department_id = d.department_id WHERE dp.branch_id = ?))`);
      params.push(scope, scope, scope);
    }
    const rows = await db.query(
      `SELECT u.* FROM users u ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY CASE u.role WHEN 'HOSPITAL_ADMIN' THEN 0 WHEN 'BRANCH_ADMIN' THEN 1 WHEN 'STAFF' THEN 2 ELSE 3 END,
                 u.full_name, u.user_id`,
      params
    );
    return serializeUsers(db, rows);
  },
  async get(db, user, id) {
    const row = await requireUser(db, id);
    await assertUserManageable(db, user, row, { allowUnaffiliated: true });
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
    const { insertId } = await db.run(
      `INSERT INTO users (full_name, email, phone, password_hash, role, date_of_birth, priority_category,
                          admin_branch_id, fcm_token, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'NONE', ?, NULL, ?, ?)`,
      [fullName, email, phone, hash, role, adminBranchId, isActive ? 1 : 0, time.nowDb()]
    );
    return serializeOne(db, await requireUser(db, insertId));
  },
  async update(db, user, id, rawBody) {
    const body = bodyOf(rawBody);
    const target = await requireUser(db, id);
    await assertUserManageable(db, user, target, { allowUnaffiliated: true });
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
      const doctor = await db.get('SELECT doctor_id FROM doctors WHERE user_id = ?', [id]);
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
    await updateColumns(db, 'users', 'user_id', id, {
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
    await assertUserManageable(db, user, target, { allowUnaffiliated: true });
    if (target.user_id === user.user_id) throw conflict('You cannot deactivate your own account');
    await db.run('UPDATE users SET is_active = 0 WHERE user_id = ?', [id]);
    return serializeOne(db, await requireUser(db, id));
  },
};

// =============================================================================================
// Staff assignments (hard delete)
// =============================================================================================

const ASSIGNMENT_SQL = `
  SELECT sa.assignment_id, sa.user_id, u.full_name AS user_name, u.role, sa.service_point_id,
         sp.name AS service_point_name, sp.type, sp.branch_id, b.name AS branch_name
    FROM staff_assignments sa
    JOIN users u ON u.user_id = sa.user_id
    JOIN service_points sp ON sp.service_point_id = sa.service_point_id
    JOIN branches b ON b.branch_id = sp.branch_id`;

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
  const row = await db.get(`${ASSIGNMENT_SQL} WHERE sa.assignment_id = ?`, [id]);
  if (!row) throw notFound('Assignment not found');
  return row;
}

const assignments = {
  async list(db, user, query) {
    const scope = listScope(user, query);
    const userId = v.int(query.userId, 'userId', { min: 1 });
    const servicePointId = v.int(query.servicePointId, 'servicePointId', { min: 1 });
    const where = [];
    const params = [];
    if (scope) {
      where.push('sp.branch_id = ?');
      params.push(scope);
    }
    if (userId) {
      where.push('sa.user_id = ?');
      params.push(userId);
    }
    if (servicePointId) {
      where.push('sa.service_point_id = ?');
      params.push(servicePointId);
    }
    const rows = await db.query(
      `${ASSIGNMENT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY sp.branch_id, u.full_name, sp.name`,
      params
    );
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
    await assertUserManageable(db, user, target, { allowUnaffiliated: true });
    if (!sp.is_active) throw badRequest('The service point is inactive');
    const dup = await db.get('SELECT assignment_id FROM staff_assignments WHERE user_id = ? AND service_point_id = ?', [
      userId,
      servicePointId,
    ]);
    if (dup) throw conflict('This staff member is already assigned to that service point');
    const { insertId } = await db.run('INSERT INTO staff_assignments (user_id, service_point_id) VALUES (?, ?)', [
      userId,
      servicePointId,
    ]);
    return toAssignment(await requireAssignment(db, insertId));
  },
  async remove(db, user, id) {
    const current = await requireAssignment(db, id);
    access.assertBranchAccess(user, current.branch_id);
    await db.run('DELETE FROM staff_assignments WHERE assignment_id = ?', [id]);
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
