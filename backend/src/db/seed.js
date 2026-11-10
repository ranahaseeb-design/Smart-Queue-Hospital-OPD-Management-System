'use strict';
/**
 * `npm run seed` — DROP, recreate and fill the database with demo data (development only).
 * Honours DB_CLIENT and SQLITE_PATH (or the DB_* MySQL settings).
 *
 * Master data (docs/API_CONTRACT.md, "Seed / demo accounts"):
 *   - 3 Lahore branches (Model Town, Gulberg, DHA), 4-5 departments each from the standardised
 *     specialties (General Medicine and Cardiology at every branch), 2 doctors per department,
 *     one OPD room per doctor, one LAB and one PHARMACY counter per branch;
 *   - accounts: admin@opd.test, branchadmin@opd.test (branch 1) / Admin@123,
 *     doctor1..doctorN@opd.test, lab1@opd.test, pharmacy1@opd.test / Staff@123,
 *     patient@opd.test (phone 03001234567) / Patient@123;
 *   - schedules Monday-Sunday: every doctor works one session a day, alternating between the
 *     morning (08:00-14:00) and evening (14:00-22:00) shift, max 40 patients per session.
 *
 * Synthetic history (~60 days, every row flagged tokens.is_synthetic = 1): a discrete-event
 * simulation of each doctor's queue and each branch's LAB / PHARMACY counter with morning and
 * Monday peaks, consultation times around each doctor's own average, priority patients,
 * emergencies (PRIORITY_SET), skips and recalls, cancellations, appointment check-ins, linked
 * LAB / PHARMACY tokens, end-of-day no-shows, matching queue_events (FR-21), one wait_predictions
 * row per token whose features_json is exactly what the live feature builder would have stored
 * at issue time (see db/history.js), model_version 'baseline', and feedback on ~30% of
 * completed visits. Doctors' avg_consult_minutes evolve exactly like the nightly job.
 * Today: a few WAITING tokens of synthetic patients in two doctors' queues (incl. doctor1).
 */
const bcrypt = require('bcryptjs');
const config = require('../config');
const time = require('../utils/time');
const settingsService = require('../services/settingsService');
const forecastService = require('../services/forecastService');
const predictionService = require('../services/predictionService');
const { getDb, closeDb, createSchema, dropSchema, deleteSqliteFile, insertMany } = require('./index');
const { replayFirstPredictions, createRng } = require('./history');

const PASSWORDS = Object.freeze({ admin: 'Admin@123', staff: 'Staff@123', patient: 'Patient@123' });

const BRANCHES = [
  {
    name: 'Model Town',
    address: 'Main Boulevard, Block M, Model Town, Lahore',
    latitude: 31.4834,
    longitude: 74.3255,
    specialties: ['General Medicine', 'Cardiology', 'Pediatrics', 'ENT', 'Orthopedics'],
  },
  {
    name: 'Gulberg',
    address: 'Main Boulevard, Gulberg III, Lahore',
    latitude: 31.5204,
    longitude: 74.3587,
    specialties: ['General Medicine', 'Cardiology', 'Dermatology', 'Pediatrics'],
  },
  {
    name: 'DHA',
    address: 'Sector C, Phase 5, DHA, Lahore',
    latitude: 31.4697,
    longitude: 74.4091,
    specialties: ['General Medicine', 'Cardiology', 'Orthopedics', 'Dermatology', 'ENT'],
  },
];

/** Consultation minutes range, relative patient load and probability of a lab referral. */
const SPECIALTY_PROFILE = {
  'General Medicine': { consult: [7, 9], load: 1.15, lab: 0.3 },
  Cardiology: { consult: [12, 15], load: 0.95, lab: 0.45 },
  Pediatrics: { consult: [9, 11], load: 1.05, lab: 0.2 },
  ENT: { consult: [8, 10], load: 0.9, lab: 0.15 },
  Orthopedics: { consult: [10, 13], load: 0.9, lab: 0.35 },
  Dermatology: { consult: [8, 10], load: 0.85, lab: 0.1 },
};

const DOCTOR_NAMES = [
  'Ahmed Raza', 'Sana Malik', 'Sara Ahmed', 'Imran Qureshi', 'Ayesha Khan', 'Bilal Hussain', 'Hina Javed',
  'Usman Tariq', 'Faisal Mahmood', 'Nadia Aslam', 'Kamran Shah', 'Mehwish Iqbal', 'Tariq Jamil', 'Rabia Saleem',
  'Zainab Abbas', 'Hamza Siddiqui', 'Farah Naz', 'Adeel Akhtar', 'Saad Rehman', 'Maryam Farooq', 'Omer Sheikh',
  'Amna Butt', 'Waqas Anwar', 'Kiran Yousaf', 'Noman Ali', 'Fatima Zahid', 'Junaid Haider', 'Saima Nawaz',
  'Asad Mirza', 'Huma Rauf',
];
const FIRST_NAMES = [
  'Ali', 'Hassan', 'Hussain', 'Umar', 'Usman', 'Bilal', 'Hamza', 'Zain', 'Saad', 'Fahad', 'Danish', 'Imran',
  'Kashif', 'Nadeem', 'Shahid', 'Tahir', 'Yasir', 'Rizwan', 'Arslan', 'Waleed', 'Ayesha', 'Fatima', 'Zainab',
  'Maryam', 'Hira', 'Sana', 'Iqra', 'Amna', 'Mahnoor', 'Laiba', 'Rabia', 'Sadia', 'Nimra', 'Kinza', 'Saba',
  'Mehreen', 'Naila', 'Shazia', 'Bushra', 'Rukhsana',
];
const LAST_NAMES = [
  'Khan', 'Ahmed', 'Ali', 'Hussain', 'Malik', 'Butt', 'Chaudhry', 'Qureshi', 'Sheikh', 'Iqbal', 'Raza', 'Shah',
  'Mirza', 'Javed', 'Aslam', 'Akhtar', 'Anwar', 'Farooq', 'Rehman', 'Saleem', 'Nawaz', 'Bhatti', 'Gill', 'Abbasi',
  'Siddiqui', 'Hashmi', 'Rana', 'Cheema', 'Bajwa', 'Dar',
];

const FEEDBACK_COMMENTS = {
  5: ['Very smooth experience, the token updates were accurate.', 'Doctor was very attentive. Short wait.', 'Excellent service, will recommend.'],
  4: ['Good experience overall.', 'Waiting time was close to the estimate.', 'Staff was helpful.'],
  3: ['Average experience, some delay at the counter.', 'Wait was a bit longer than shown.', 'Okay, but the waiting area was crowded.'],
  2: ['Waited much longer than expected.', 'Queue moved slowly in the morning.', 'Too crowded, needs more doctors.'],
  1: ['Very long wait, the estimate was not accurate.', 'Very disappointing, waited for hours.'],
};

const SESSIONS = {
  MORNING: {
    start: 8 * 60,
    end: 14 * 60,
    util: 0.72,
    // [fromMinute, toMinute, weight] relative to the session start (arrival intensity)
    weights: [[-60, 0, 1.0], [0, 120, 2.2], [120, 210, 1.4], [210, 315, 0.6]],
  },
  EVENING: {
    start: 14 * 60,
    end: 22 * 60,
    util: 0.5,
    weights: [[-30, 0, 0.5], [0, 120, 0.8], [120, 300, 1.6], [300, 435, 0.9]],
  },
};
const DOW_FACTOR = [null, 1.3, 1.1, 1.0, 1.0, 0.85, 1.05, 0.75]; // Monday peak, quiet Sunday
const MAX_PATIENTS = 40;
const SYNTHETIC_PATIENTS = 1500;
const COUNTER_TRUE_AVG = { LAB: 5.5, PHARMACY: 2.8 };
const P = {
  priorityPatient: 0.12,
  emergency: 0.025,
  cancel: 0.03,
  skip: 0.05,
  recall: 0.5,
  appointment: 0.08,
  noShowAppointment: 0.4,
  cancelledAppointment: 0.2,
  pharmacy: 0.55,
  counterSkip: 0.02,
  feedback: 0.3,
  feedbackComment: 0.45,
};
const ROLLING_WINDOW = predictionService.ROLLING_WINDOW;
const MIN_SAMPLES = predictionService.MIN_SAMPLES;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Local Date for `sec` seconds after midnight of dateStr (may run past midnight). */
function atSec(dateStr, sec) {
  const d = time.parseDate(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, Math.round(sec));
}

const fmt = (d) => (d ? time.formatDateTime(d) : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Same averaging as predictionService.meanDuration (order-independent, see time.meanMinutes).
const meanOrNull = (arr) => (arr.length >= MIN_SAMPLES ? time.meanMinutes(arr) : null);

function lastStatus(tok) {
  return tok.changes[tok.changes.length - 1].status;
}
/** First call time: a recall does not overwrite tokens.called_at (live recallToken behaviour). */
function firstCalledAt(tok) {
  const c = tok.changes.find((x) => x.status === 'CALLED');
  return c ? c.at : null;
}
function completedAt(tok) {
  const c = tok.changes.find((x) => x.status === 'COMPLETED');
  return c ? c.at : null;
}
function finalPriority(tok) {
  return tok.priorityChanges.length ? tok.priorityChanges[tok.priorityChanges.length - 1].level : tok.initialPriority;
}

// ---------------------------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------------------------

function buildMasterData(rng, now, historyDays) {
  const createdAt = fmt(time.addDays(time.startOfDay(now), -(historyDays + 30)));
  const branches = BRANCHES.map((b, i) => ({ id: i + 1, ...b }));
  const departments = [];
  const servicePoints = [];
  const doctors = [];
  const users = [];
  const schedules = [];
  const assignments = [];

  let userId = 0;
  const addUser = (u) => {
    userId += 1;
    const row = {
      id: userId,
      email: null,
      phone: null,
      dateOfBirth: null,
      priorityCategory: 'NONE',
      adminBranchId: null,
      createdAt,
      ...u,
    };
    users.push(row);
    return row;
  };

  const admin = addUser({ fullName: 'Ayesha Siddiqui', email: 'admin@opd.test', role: 'HOSPITAL_ADMIN', password: 'admin' });
  const branchAdmin = addUser({
    fullName: 'Kamran Butt',
    email: 'branchadmin@opd.test',
    role: 'BRANCH_ADMIN',
    adminBranchId: 1,
    password: 'admin',
  });

  let deptId = 0;
  let spId = 0;
  let doctorNo = 0;
  for (const b of branches) {
    let room = 0;
    for (const specialty of b.specialties) {
      deptId += 1;
      departments.push({ id: deptId, branchId: b.id, specialty, name: `${specialty} OPD` });
      for (let k = 0; k < 2; k += 1) {
        doctorNo += 1;
        room += 1;
        spId += 1;
        servicePoints.push({ id: spId, branchId: b.id, type: 'OPD', name: `Room ${room}` });
        const user = addUser({
          fullName: `Dr. ${DOCTOR_NAMES[(doctorNo - 1) % DOCTOR_NAMES.length]}`,
          email: `doctor${doctorNo}@opd.test`,
          role: 'STAFF',
          password: 'staff',
        });
        const [lo, hi] = SPECIALTY_PROFILE[specialty].consult;
        const baseAvg = time.round(rng.uniform(lo, hi), 2);
        const doctor = {
          id: doctorNo,
          no: doctorNo,
          userId: user.id,
          name: user.fullName,
          departmentId: deptId,
          branchId: b.id,
          specialty,
          roomId: spId,
          baseAvg,
          trueAvg: baseAvg, // consultations scatter around this value
          currentAvg: baseAvg, // doctors.avg_consult_minutes as the nightly job would keep it
          consults: [], // completed consultation durations (minutes), oldest first
          shiftByDow: {},
        };
        // Alternate morning / evening shifts; the two doctors of a department are opposite.
        for (let dow = 1; dow <= 7; dow += 1) {
          const morning = (dow % 2 === 1) === (k === 0);
          doctor.shiftByDow[dow] = morning ? 'MORNING' : 'EVENING';
          const s = SESSIONS[doctor.shiftByDow[dow]];
          schedules.push({
            id: schedules.length + 1,
            doctorId: doctor.id,
            servicePointId: spId,
            dayOfWeek: dow,
            startTime: `${String(s.start / 60).padStart(2, '0')}:00:00`,
            endTime: `${String(s.end / 60).padStart(2, '0')}:00:00`,
            maxPatients: MAX_PATIENTS,
          });
        }
        doctors.push(doctor);
        assignments.push({ id: assignments.length + 1, userId: user.id, servicePointId: spId });
      }
    }
    for (const type of ['LAB', 'PHARMACY']) {
      spId += 1;
      servicePoints.push({ id: spId, branchId: b.id, type, name: type === 'LAB' ? 'Lab Counter' : 'Pharmacy Counter' });
    }
  }

  const counters = servicePoints
    .filter((sp) => sp.type !== 'OPD')
    .map((sp) => ({ ...sp, durations: [], staffUserId: null }));
  const lab1 = addUser({ fullName: 'Nasir Mehmood', email: 'lab1@opd.test', role: 'STAFF', password: 'staff' });
  const pharmacy1 = addUser({ fullName: 'Sobia Anjum', email: 'pharmacy1@opd.test', role: 'STAFF', password: 'staff' });
  const branch1Lab = counters.find((c) => c.branchId === 1 && c.type === 'LAB');
  const branch1Pharmacy = counters.find((c) => c.branchId === 1 && c.type === 'PHARMACY');
  branch1Lab.staffUserId = lab1.id;
  branch1Pharmacy.staffUserId = pharmacy1.id;
  assignments.push({ id: assignments.length + 1, userId: lab1.id, servicePointId: branch1Lab.id });
  assignments.push({ id: assignments.length + 1, userId: pharmacy1.id, servicePointId: branch1Pharmacy.id });

  const demoPatient = addUser({
    fullName: 'Ali Khan',
    email: 'patient@opd.test',
    phone: '03001234567',
    role: 'PATIENT',
    dateOfBirth: '1990-05-14',
    password: 'patient',
  });

  const patients = [];
  for (let i = 1; i <= SYNTHETIC_PATIENTS; i += 1) {
    const r = rng.next();
    const priorityCategory = r < 0.11 ? 'ELDERLY' : r < 0.14 ? 'DIFFERENTLY_ABLED' : 'NONE';
    // ELDERLY is derived from the date of birth (userService.ELDERLY_MIN_AGE = 60): keep the stored
    // categories consistent with it (ELDERLY >= 61, everyone else < 60 years old today).
    const thisYear = now.getFullYear();
    const year = priorityCategory === 'ELDERLY' ? rng.int(thisYear - 88, thisYear - 61) : rng.int(thisYear - 59, 2020);
    const u = addUser({
      fullName: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      phone: `0321${String(i).padStart(7, '0')}`,
      role: 'PATIENT',
      dateOfBirth: `${year}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      priorityCategory,
      password: 'synthetic',
    });
    patients.push(u);
  }

  return {
    branches,
    departments,
    servicePoints,
    doctors,
    users,
    schedules,
    assignments,
    counters,
    admin,
    branchAdmin,
    demoPatient,
    patients,
    priorityPatients: patients.filter((p) => p.priorityCategory !== 'NONE'),
    normalPatients: patients.filter((p) => p.priorityCategory === 'NONE'),
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------

class Simulator {
  constructor(rng, md, now) {
    this.rng = rng;
    this.md = md;
    this.now = now;
    this.seq = 0;
    this.nextVisitId = 1;
    this.nextTokenId = 1;
    this.nextEventId = 1;
    this.nextPredictionId = 1;
    this.nextAppointmentId = 1;
    this.nextFeedbackId = 1;
    this.rows = {
      visits: [],
      appointments: [],
      tokens: [],
      events: [],
      predictions: [],
      feedback: [],
    };
    this.counts = { opd: 0, lab: 0, pharmacy: 0 };
  }

  pickPatient(used, priority) {
    const pool = priority ? this.md.priorityPatients : this.md.normalPatients;
    for (let i = 0; i < 60; i += 1) {
      const p = this.rng.pick(pool);
      if (!used.has(p.id)) {
        used.add(p.id);
        return p;
      }
    }
    return this.rng.pick(pool);
  }

  /** Arrival seconds-after-midnight for one doctor session (sorted, unique). */
  arrivalTimes(shift, count) {
    const s = SESSIONS[shift];
    // Piecewise-uniform intensity: pick a band with probability weight x length, then a second in it.
    const bands = s.weights.map(([from, to, w]) => [[from, to], w * (to - from)]);
    const secs = new Set();
    while (secs.size < count) {
      const [from, to] = this.rng.weighted(bands);
      secs.add((s.start + from) * 60 + this.rng.int(0, (to - from) * 60 - 1));
    }
    return [...secs].sort((a, b) => a - b);
  }

  newToken({ dateStr, sec, patient, visitId, sp, doctor, queueType, priority, by, from, to, note }) {
    const issuedAt = atSec(dateStr, sec);
    const tok = {
      seq: (this.seq += 1),
      id: 0,
      tokenNumber: 0,
      date: dateStr,
      visitId,
      patientId: patient.id,
      servicePointId: sp,
      doctorId: doctor ? doctor.id : null,
      departmentId: doctor ? doctor.departmentId : null,
      branchId: doctor ? doctor.branchId : null,
      queueType,
      issuedSec: sec,
      issuedAt,
      initialPriority: priority,
      priorityChanges: [],
      changes: [{ at: issuedAt, sec, status: 'WAITING' }],
      events: [{ type: 'ISSUED', at: issuedAt, by, from, to, note }],
      appointment: null,
      cancelSec: null,
      emergencySec: null,
      forceComplete: false,
      noFeedback: false,
    };
    return tok;
  }

  change(tok, sec, status, event) {
    const at = atSec(tok.date, sec);
    tok.changes.push({ at, sec, status });
    if (event) tok.events.push({ at, ...event });
  }

  /**
   * One doctor's OPD queue for one day. Returns timeline tokens.
   */
  simulateDoctorDay(dateStr, dow, doctor, used, { demoPatient = null } = {}) {
    const rng = this.rng;
    const shift = doctor.shiftByDow[dow];
    const s = SESSIONS[shift];
    const capacity = (s.end - s.start) / doctor.trueAvg;
    const expected =
      capacity * s.util * DOW_FACTOR[dow] * SPECIALTY_PROFILE[doctor.specialty].load * rng.uniform(0.85, 1.15);
    const count = clamp(Math.round(expected), 5, MAX_PATIENTS);
    const secs = this.arrivalTimes(shift, count);
    const room = doctor.roomId;
    const staffUser = doctor.userId;
    const usedSlots = new Set();
    const demoIndex = demoPatient ? Math.floor(secs.length / 2) : -1;

    const tokens = secs.map((sec, i) => {
      const isDemo = i === demoIndex;
      const priorityPatient = !isDemo && rng.chance(P.priorityPatient);
      const patient = isDemo ? demoPatient : this.pickPatient(used, priorityPatient);
      const priority = patient.priorityCategory === 'NONE' ? 0 : 1;
      const visitId = this.nextVisitId++;
      this.rows.visits.push([visitId, patient.id, doctor.branchId, dateStr, 'CLOSED']);

      // Appointment check-in: the slot is shortly after the check-in time.
      let appointment = null;
      const minuteOfDay = sec / 60;
      if (!isDemo && rng.chance(P.appointment) && minuteOfDay >= s.start - 30 && minuteOfDay <= s.end - 60) {
        let slotMin = Math.ceil((minuteOfDay + rng.int(5, 20)) / 15) * 15;
        slotMin = Math.max(slotMin, s.start);
        if (slotMin + 15 <= s.end && !usedSlots.has(slotMin)) {
          usedSlots.add(slotMin);
          appointment = { id: this.nextAppointmentId++, patientId: patient.id, doctorId: doctor.id, slotMin };
        }
      }
      const tok = this.newToken({
        dateStr,
        sec,
        patient,
        visitId,
        sp: room,
        doctor,
        queueType: 'OPD',
        priority,
        by: patient.id,
        from: room,
        to: null,
        note: appointment ? `Checked in for appointment #${appointment.id}` : null,
      });
      tok.appointment = appointment;
      if (isDemo) {
        tok.forceComplete = true;
        tok.noFeedback = true;
      } else {
        if (rng.chance(P.emergency)) tok.emergencySec = sec + rng.int(60, 240);
        if (rng.chance(P.cancel)) tok.cancelSec = sec + rng.int(5 * 60, 60 * 60);
      }
      return tok;
    });

    // Discrete-event simulation of the consultation room.
    const priorityAt = (tok, sec) => (tok.emergencySec !== null && tok.emergencySec <= sec ? 2 : tok.initialPriority);
    let clock = s.start * 60 + rng.int(0, 12 * 60); // the doctor starts 0-12 minutes late
    let next = 0;
    const waiting = [];
    const recalls = [];
    for (;;) {
      while (next < tokens.length && tokens[next].issuedSec <= clock) waiting.push(tokens[next++]);
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        const w = waiting[i];
        if (w.cancelSec !== null && w.cancelSec <= clock) {
          this.change(w, w.cancelSec, 'CANCELLED', { type: 'CANCELLED', by: w.patientId, from: room });
          waiting.splice(i, 1);
        }
      }
      let tok = null;
      let recalled = false;
      const ri = recalls.findIndex((r) => r.readySec <= clock);
      if (ri >= 0) {
        tok = recalls[ri].tok;
        recalls.splice(ri, 1);
        recalled = true;
      } else if (waiting.length) {
        waiting.sort(
          (a, b) => priorityAt(b, clock) - priorityAt(a, clock) || a.issuedSec - b.issuedSec || a.seq - b.seq
        );
        tok = waiting.shift();
      }
      if (!tok) {
        const candidates = [];
        if (next < tokens.length) candidates.push(tokens[next].issuedSec + rng.int(60, 180));
        if (recalls.length) candidates.push(Math.min(...recalls.map((r) => r.readySec)));
        if (!candidates.length) break;
        clock = Math.max(clock, Math.min(...candidates));
        continue;
      }
      this.change(tok, clock, 'CALLED', { type: recalled ? 'RECALLED' : 'CALLED', by: staffUser, from: room });
      if (!recalled && !tok.forceComplete && rng.chance(P.skip)) {
        const skipSec = clock + rng.int(90, 180);
        this.change(tok, skipSec, 'SKIPPED', { type: 'SKIPPED', by: staffUser, from: room });
        clock = skipSec;
        if (rng.chance(P.recall)) recalls.push({ tok, readySec: skipSec + rng.int(10 * 60, 40 * 60) });
        continue;
      }
      const startSec = clock + rng.int(30, 120);
      const minutes = clamp(rng.logNormal(doctor.trueAvg, 0.35), 2, 45);
      const doneSec = startSec + Math.round(minutes * 60);
      this.change(tok, startSec, 'IN_SERVICE', { type: 'STARTED', by: staffUser, from: room });
      this.change(tok, doneSec, 'COMPLETED', { type: 'COMPLETED', by: staffUser, from: room });
      clock = doneSec + rng.int(0, 60);
    }

    // Emergencies only happened if the token was still waiting at that moment (FR-13).
    for (const tok of tokens) {
      if (tok.emergencySec === null) continue;
      const leftQueue = tok.changes.length > 1 ? tok.changes[1].sec : Infinity;
      if (tok.emergencySec < leftQueue) {
        const at = atSec(dateStr, tok.emergencySec);
        tok.priorityChanges.push({ at, level: 2 });
        tok.events.push({ type: 'PRIORITY_SET', at, by: staffUser, from: room, note: 'Level 2: Emergency case' });
      }
    }
    this.closeDay(tokens, room);

    // Appointments: check-ins (from the tokens), no-shows that never checked in, cancellations.
    const appointments = [];
    for (const tok of tokens) {
      if (!tok.appointment) continue;
      const a = tok.appointment;
      const status = lastStatus(tok);
      const final =
        status === 'COMPLETED' ? 'COMPLETED' : status === 'CANCELLED' ? 'CANCELLED' : status === 'NO_SHOW' ? 'NO_SHOW' : 'CHECKED_IN';
      const lastChange = tok.changes[tok.changes.length - 1].at;
      appointments.push({
        ...a,
        slot: atSec(dateStr, a.slotMin * 60),
        status: final,
        updatedAt: lastChange,
        bookedUntil: tok.issuedAt,
        token: tok,
      });
    }
    const freeSlot = () => {
      for (let tries = 0; tries < 20; tries += 1) {
        const slotMin = s.start + 15 * rng.int(0, (s.end - s.start) / 15 - 1);
        if (!usedSlots.has(slotMin)) {
          usedSlots.add(slotMin);
          return slotMin;
        }
      }
      return null;
    };
    if (rng.chance(P.noShowAppointment)) {
      const slotMin = freeSlot();
      if (slotMin !== null) {
        const patient = this.pickPatient(used, false);
        appointments.push({
          id: this.nextAppointmentId++,
          patientId: patient.id,
          doctorId: doctor.id,
          slot: atSec(dateStr, slotMin * 60),
          status: 'NO_SHOW',
          updatedAt: atSec(dateStr, 24 * 3600 + 300),
          bookedUntil: null,
        });
      }
    }
    if (rng.chance(P.cancelledAppointment)) {
      const slotMin = freeSlot();
      if (slotMin !== null) {
        const patient = this.pickPatient(used, false);
        appointments.push({
          id: this.nextAppointmentId++,
          patientId: patient.id,
          doctorId: doctor.id,
          slot: atSec(dateStr, slotMin * 60),
          status: 'CANCELLED',
          updatedAt: atSec(dateStr, -rng.int(1, 3) * 86400 + rng.int(9, 20) * 3600),
          bookedUntil: undefined, // cancelled before the day: never BOOKED on the day
        });
      }
    }
    return { tokens, appointments };
  }

  /** End-of-day closure (as the nightly job does): skipped/unserved tokens -> NO_SHOW. */
  closeDay(tokens, servicePointId) {
    for (const tok of tokens) {
      const status = lastStatus(tok);
      if (status === 'WAITING' || status === 'CALLED' || status === 'SKIPPED') {
        const lastSec = tok.changes[tok.changes.length - 1].sec;
        const sec = Math.max(24 * 3600 + 300, lastSec + 60);
        this.change(tok, sec, 'NO_SHOW', { type: 'NO_SHOW', by: null, from: servicePointId, note: 'End-of-day closure' });
      }
    }
  }

  /** One LAB / PHARMACY counter for one day; `tokens` already created (sorted by issue time). */
  simulateCounterDay(counter, tokens) {
    const rng = this.rng;
    tokens.sort((a, b) => a.issuedSec - b.issuedSec || a.seq - b.seq);
    const priorityAt = (tok) => tok.initialPriority;
    let clock = 8 * 3600;
    let next = 0;
    const waiting = [];
    for (;;) {
      while (next < tokens.length && tokens[next].issuedSec <= clock) waiting.push(tokens[next++]);
      if (!waiting.length) {
        if (next >= tokens.length) break;
        clock = Math.max(clock, tokens[next].issuedSec + rng.int(30, 90));
        continue;
      }
      waiting.sort((a, b) => priorityAt(b) - priorityAt(a) || a.issuedSec - b.issuedSec || a.seq - b.seq);
      const tok = waiting.shift();
      const by = counter.staffUserId;
      this.change(tok, clock, 'CALLED', { type: 'CALLED', by, from: counter.id });
      if (rng.chance(P.counterSkip)) {
        const skipSec = clock + rng.int(60, 120);
        this.change(tok, skipSec, 'SKIPPED', { type: 'SKIPPED', by, from: counter.id });
        clock = skipSec;
        continue;
      }
      const startSec = clock + rng.int(15, 60);
      const minutes = clamp(rng.logNormal(COUNTER_TRUE_AVG[counter.type], 0.4), 0.5, 30);
      const doneSec = startSec + Math.round(minutes * 60);
      this.change(tok, startSec, 'IN_SERVICE', { type: 'STARTED', by, from: counter.id });
      this.change(tok, doneSec, 'COMPLETED', { type: 'COMPLETED', by, from: counter.id });
      clock = doneSec + rng.int(0, 30);
    }
    this.closeDay(tokens, counter.id);
  }

  /** Linked LAB / PHARMACY tokens issued by the doctor after a completed consultation (FR-04). */
  linkedTokens(dateStr, opdTokens) {
    const byCounter = new Map();
    const counterOf = (branchId, type) => this.md.counters.find((c) => c.branchId === branchId && c.type === type);
    for (const opd of opdTokens) {
      if (lastStatus(opd) !== 'COMPLETED') continue;
      const done = opd.changes.find((c) => c.status === 'COMPLETED').sec;
      const doctor = this.md.doctors.find((d) => d.id === opd.doctorId);
      const wants = [];
      if (this.rng.chance(SPECIALTY_PROFILE[doctor.specialty].lab)) wants.push(['LAB', done + this.rng.int(30, 120)]);
      if (this.rng.chance(P.pharmacy)) wants.push(['PHARMACY', done + this.rng.int(130, 240)]);
      for (const [type, sec] of wants) {
        const counter = counterOf(opd.branchId, type);
        const tok = this.newToken({
          dateStr,
          sec,
          patient: { id: opd.patientId },
          visitId: opd.visitId,
          sp: counter.id,
          doctor: null,
          queueType: type,
          priority: finalPriority(opd),
          by: doctor.userId,
          from: null,
          to: counter.id,
          note: `Linked ${type} token`,
        });
        tok.branchId = opd.branchId;
        if (!byCounter.has(counter.id)) byCounter.set(counter.id, { counter, tokens: [] });
        byCounter.get(counter.id).tokens.push(tok);
      }
    }
    const all = [];
    for (const { counter, tokens } of byCounter.values()) {
      // Unique issue seconds per counter (live inserts are serialised).
      tokens.sort((a, b) => a.issuedSec - b.issuedSec || a.seq - b.seq);
      for (let i = 1; i < tokens.length; i += 1) {
        if (tokens[i].issuedSec <= tokens[i - 1].issuedSec) {
          const sec = tokens[i - 1].issuedSec + 1;
          tokens[i].issuedSec = sec;
          tokens[i].issuedAt = atSec(dateStr, sec);
          tokens[i].changes[0] = { at: tokens[i].issuedAt, sec, status: 'WAITING' };
          tokens[i].events[0].at = tokens[i].issuedAt;
        }
      }
      this.simulateCounterDay(counter, tokens);
      all.push(...tokens);
    }
    return all;
  }

  /** Assign ids + numbers, replay predictions, append rows for one day. */
  finishDay(dateStr, dayTokens, appointments, { doctorAvg, counterAvg, visitStatus = 'CLOSED' }) {
    dayTokens.sort((a, b) => a.issuedAt - b.issuedAt || a.seq - b.seq);
    const numbers = new Map();
    for (const tok of dayTokens) {
      tok.id = this.nextTokenId++;
      const n = (numbers.get(tok.servicePointId) || 0) + 1;
      numbers.set(tok.servicePointId, n);
      tok.tokenNumber = n;
    }

    // Replay context of the day.
    const dow = time.isoDow(time.parseDate(dateStr));
    const doctors = new Map();
    const departmentSessions = new Map();
    for (const d of this.md.doctors) {
      const s = SESSIONS[d.shiftByDow[dow]];
      const session = { start: atSec(dateStr, s.start * 60), end: atSec(dateStr, s.end * 60) };
      doctors.set(d.id, {
        id: d.id,
        departmentId: d.departmentId,
        branchId: d.branchId,
        avgConsultMinutes: doctorAvg.get(d.id),
        session,
      });
      if (!departmentSessions.has(d.departmentId)) departmentSessions.set(d.departmentId, []);
      departmentSessions.get(d.departmentId).push({ doctorId: d.id, start: session.start, end: session.end });
    }
    const apptByDoctor = new Map();
    for (const a of appointments) {
      if (a.bookedUntil === undefined) continue; // cancelled before the day
      if (!apptByDoctor.has(a.doctorId)) apptByDoctor.set(a.doctorId, []);
      apptByDoctor.get(a.doctorId).push({ slot: a.slot, bookedFrom: null, bookedUntil: a.bookedUntil });
    }
    const events = new Map(dayTokens.map((t) => [t.id, t.events]));
    const predictions = replayFirstPredictions({
      tokens: dayTokens,
      events,
      doctors,
      counterAverages: counterAvg,
      departmentSessions,
      appointments: apptByDoctor,
    });

    for (const a of appointments) {
      this.rows.appointments.push([a.id, a.patientId, a.doctorId, fmt(a.slot), a.status, fmt(a.updatedAt)]);
    }
    const dayEvents = [];
    for (const tok of dayTokens) {
      if (tok.queueType === 'OPD') this.counts.opd += 1;
      else if (tok.queueType === 'LAB') this.counts.lab += 1;
      else this.counts.pharmacy += 1;
      this.rows.tokens.push([
        tok.id,
        tok.visitId,
        tok.servicePointId,
        tok.doctorId,
        tok.appointment ? tok.appointment.id : null,
        tok.tokenNumber,
        dateStr,
        tok.queueType,
        finalPriority(tok),
        lastStatus(tok),
        fmt(tok.issuedAt),
        fmt(firstCalledAt(tok)),
        fmt(completedAt(tok)),
        1,
      ]);
      for (const e of tok.events) dayEvents.push({ ms: e.at.getTime(), tok, e });
      const p = predictions.get(tok.id);
      this.rows.predictions.push([
        this.nextPredictionId++,
        tok.id,
        p.minutes,
        'baseline',
        JSON.stringify(p.features),
        fmt(tok.issuedAt),
      ]);
    }
    dayEvents.sort((a, b) => a.ms - b.ms || a.tok.id - b.tok.id);
    for (const { tok, e } of dayEvents) {
      this.rows.events.push([
        this.nextEventId++,
        tok.id,
        e.type,
        e.by === undefined ? null : e.by,
        e.from === undefined ? null : e.from,
        e.to === undefined ? null : e.to,
        e.note || null,
        fmt(e.at),
      ]);
    }
    if (visitStatus !== 'CLOSED') {
      // Today's visits stay OPEN (the visit rows were pushed as CLOSED by default).
      const ids = new Set(dayTokens.map((t) => t.visitId));
      for (const v of this.rows.visits) if (ids.has(v[0])) v[4] = visitStatus;
    }
  }

  feedbackFor(opdTokens) {
    const rng = this.rng;
    const nowMs = this.now.getTime();
    for (const tok of opdTokens) {
      if (tok.noFeedback || lastStatus(tok) !== 'COMPLETED' || !rng.chance(P.feedback)) continue;
      const wait = (firstCalledAt(tok) - tok.issuedAt) / 60000;
      const dist =
        wait < 20
          ? [[5, 0.55], [4, 0.35], [3, 0.1]]
          : wait < 45
            ? [[5, 0.3], [4, 0.45], [3, 0.2], [2, 0.05]]
            : wait < 90
              ? [[5, 0.15], [4, 0.35], [3, 0.3], [2, 0.15], [1, 0.05]]
              : [[4, 0.2], [3, 0.35], [2, 0.3], [1, 0.15]];
      const rating = rng.weighted(dist);
      const comment = rng.chance(P.feedbackComment) ? rng.pick(FEEDBACK_COMMENTS[rating]) : null;
      const done = completedAt(tok).getTime();
      const createdMs = Math.min(done + rng.uniform(0.5, 30) * 3600 * 1000, nowMs - 60 * 1000);
      this.rows.feedback.push([this.nextFeedbackId++, tok.visitId, rating, comment, fmt(new Date(Math.max(done, createdMs)))]);
    }
  }
}

/** Nightly-job values: doctors' rolling consult average and counters' rolling service average. */
function rollingDoctorAverage(doctor) {
  const avg = meanOrNull(doctor.consults.slice(-ROLLING_WINDOW));
  if (avg !== null && avg > 0 && Math.abs(avg - doctor.currentAvg) >= 0.01) doctor.currentAvg = Math.min(avg, 999);
}
function counterAverage(counter) {
  return meanOrNull(counter.durations.slice(-ROLLING_WINDOW)) || predictionService.DEFAULT_SERVICE_MINUTES[counter.type] || 5;
}
/** Milliseconds truncated to whole seconds, as the DATETIME columns store them (fmt drops ms). */
const storedMs = (d) => Math.floor(d.getTime() / 1000) * 1000;
/**
 * Consultation / service durations in the order the nightly job reads them (completed_at, then
 * token id), computed from the stored second-precision times so that the seeded averages equal
 * what predictionService.refreshDoctorAverages recomputes from the database.
 */
function durationsOf(tokens) {
  return tokens
    .filter((t) => lastStatus(t) === 'COMPLETED')
    .sort((a, b) => storedMs(completedAt(a)) - storedMs(completedAt(b)) || a.id - b.id)
    .map((t) => (storedMs(completedAt(t)) - storedMs(firstCalledAt(t))) / 60000)
    .filter((d) => d >= 0);
}

// ---------------------------------------------------------------------------------------------
// Seed entry point
// ---------------------------------------------------------------------------------------------

/**
 * Fill an empty schema with demo data.
 * @param {object} db adapter
 * @param {{ historyDays?: number, now?: Date, logger?: Console, runForecast?: boolean, rngSeed?: number }} [opts]
 */
async function seed(db, { historyDays = 60, now = time.clock.now(), logger = console, runForecast = true, rngSeed = 20261030 } = {}) {
  const started = Date.now();
  const rng = createRng(rngSeed);
  const md = buildMasterData(rng, now, historyDays);
  const sim = new Simulator(rng, md, now);
  const todayStr = time.formatDate(now);

  // ---- History, one day at a time (doctor averages evolve like the nightly job) ----
  const demoDay = time.addDaysStr(todayStr, -Math.min(7, historyDays));
  const doctor1 = md.doctors[0];
  for (let back = historyDays; back >= 1; back -= 1) {
    const dateStr = time.addDaysStr(todayStr, -back);
    const dow = time.isoDow(time.parseDate(dateStr));
    const doctorAvg = new Map(md.doctors.map((d) => [d.id, d.currentAvg]));
    const counterAvg = new Map(md.counters.map((c) => [c.id, counterAverage(c)]));
    const used = new Set();
    const opdTokens = [];
    const appointments = [];
    for (const doctor of md.doctors) {
      const demoPatient = dateStr === demoDay && doctor === doctor1 ? md.demoPatient : null;
      const r = sim.simulateDoctorDay(dateStr, dow, doctor, used, { demoPatient });
      opdTokens.push(...r.tokens);
      appointments.push(...r.appointments);
    }
    const linked = sim.linkedTokens(dateStr, opdTokens);
    sim.finishDay(dateStr, [...opdTokens, ...linked], appointments, { doctorAvg, counterAvg });
    sim.feedbackFor(opdTokens);

    for (const d of md.doctors) {
      d.consults.push(...durationsOf(opdTokens.filter((t) => t.doctorId === d.id)));
      rollingDoctorAverage(d);
    }
    for (const c of md.counters) c.durations.push(...durationsOf(linked.filter((t) => t.servicePointId === c.id)));
  }

  // ---- Today: a few WAITING tokens so the dashboards are not empty ----
  const nowSec = Math.floor((now - time.startOfDay(now)) / 1000);
  const plan = [
    { doctor: md.doctors[0], minutesAgo: [34, 21, 8], priorities: [false, true, false] },
    { doctor: md.doctors.find((d) => d.branchId === 2 && d.specialty === 'General Medicine'), minutesAgo: [27, 12], priorities: [false, false] },
  ];
  const usedToday = new Set();
  const todayTokens = [];
  for (const { doctor, minutesAgo, priorities } of plan) {
    minutesAgo.forEach((ago, i) => {
      // Issued 'ago' minutes before now (compressed proportionally just after midnight).
      const sec = nowSec >= 40 * 60 ? nowSec - ago * 60 : Math.max(0, Math.floor(nowSec * (1 - ago / 40)) - 1);
      const patient = sim.pickPatient(usedToday, priorities[i]);
      const visitId = sim.nextVisitId++;
      sim.rows.visits.push([visitId, patient.id, doctor.branchId, todayStr, 'OPEN']);
      todayTokens.push(
        sim.newToken({
          dateStr: todayStr,
          sec,
          patient,
          visitId,
          sp: doctor.roomId,
          doctor,
          queueType: 'OPD',
          priority: patient.priorityCategory === 'NONE' ? 0 : 1,
          by: patient.id,
          from: doctor.roomId,
          to: null,
          note: null,
        })
      );
    });
  }
  sim.finishDay(todayStr, todayTokens, [], {
    doctorAvg: new Map(md.doctors.map((d) => [d.id, d.currentAvg])),
    counterAvg: new Map(md.counters.map((c) => [c.id, counterAverage(c)])),
    visitStatus: 'OPEN',
  });

  // ---- Password hashes (one bcrypt per distinct password keeps the seed fast) ----
  const hashes = {
    admin: await bcrypt.hash(PASSWORDS.admin, config.bcryptRounds),
    staff: await bcrypt.hash(PASSWORDS.staff, config.bcryptRounds),
    patient: await bcrypt.hash(PASSWORDS.patient, config.bcryptRounds),
    // Synthetic patients cannot log in: random secret that is never revealed.
    synthetic: await bcrypt.hash(`synthetic-${require('node:crypto').randomBytes(16).toString('hex')}`, config.bcryptRounds),
  };

  // ---- Insert everything in one transaction ----
  await db.transaction(async (tx) => {
    await insertMany(
      tx,
      'branches',
      ['branch_id', 'name', 'address', 'latitude', 'longitude', 'status'],
      md.branches.map((b) => [b.id, b.name, b.address, b.latitude, b.longitude, 'ACTIVE'])
    );
    await insertMany(
      tx,
      'users',
      ['user_id', 'full_name', 'email', 'phone', 'password_hash', 'role', 'date_of_birth', 'priority_category',
        'admin_branch_id', 'fcm_token', 'is_active', 'created_at'],
      md.users.map((u) => [u.id, u.fullName, u.email, u.phone, hashes[u.password], u.role, u.dateOfBirth,
        u.priorityCategory, u.adminBranchId, null, 1, u.createdAt])
    );
    await insertMany(
      tx,
      'departments',
      ['department_id', 'branch_id', 'specialty', 'name', 'is_active'],
      md.departments.map((d) => [d.id, d.branchId, d.specialty, d.name, 1])
    );
    await insertMany(
      tx,
      'service_points',
      ['service_point_id', 'branch_id', 'type', 'name', 'is_active'],
      md.servicePoints.map((s) => [s.id, s.branchId, s.type, s.name, 1])
    );
    await insertMany(
      tx,
      'doctors',
      ['doctor_id', 'user_id', 'department_id', 'avg_consult_minutes', 'is_active'],
      md.doctors.map((d) => [d.id, d.userId, d.departmentId, d.currentAvg, 1])
    );
    await insertMany(
      tx,
      'doctor_schedules',
      ['schedule_id', 'doctor_id', 'service_point_id', 'day_of_week', 'start_time', 'end_time', 'max_patients'],
      md.schedules.map((s) => [s.id, s.doctorId, s.servicePointId, s.dayOfWeek, s.startTime, s.endTime, s.maxPatients])
    );
    await insertMany(
      tx,
      'staff_assignments',
      ['assignment_id', 'user_id', 'service_point_id'],
      md.assignments.map((a) => [a.id, a.userId, a.servicePointId])
    );
    await insertMany(tx, 'visits', ['visit_id', 'patient_id', 'branch_id', 'visit_date', 'status'], sim.rows.visits);
    await insertMany(
      tx,
      'appointments',
      ['appointment_id', 'patient_id', 'doctor_id', 'slot_start', 'status', 'updated_at'],
      sim.rows.appointments
    );
    await insertMany(
      tx,
      'tokens',
      ['token_id', 'visit_id', 'service_point_id', 'doctor_id', 'appointment_id', 'token_number', 'token_date',
        'queue_type', 'priority_level', 'status', 'issued_at', 'called_at', 'completed_at', 'is_synthetic'],
      sim.rows.tokens
    );
    await insertMany(
      tx,
      'queue_events',
      ['event_id', 'token_id', 'event_type', 'performed_by', 'from_point_id', 'to_point_id', 'note', 'event_time'],
      sim.rows.events
    );
    await insertMany(
      tx,
      'wait_predictions',
      ['prediction_id', 'token_id', 'predicted_minutes', 'model_version', 'features_json', 'created_at'],
      sim.rows.predictions
    );
    await insertMany(tx, 'feedback', ['feedback_id', 'visit_id', 'rating', 'comment', 'created_at'], sim.rows.feedback);
  });
  await settingsService.writeDefaults(db);
  predictionService.clearCaches();

  let forecasts = 0;
  if (runForecast) forecasts = await forecastService.runBaselineForecast(db, { now });

  const summary = {
    historyDays,
    users: md.users.length,
    branches: md.branches.length,
    departments: md.departments.length,
    doctors: md.doctors.length,
    servicePoints: md.servicePoints.length,
    tokens: sim.rows.tokens.length,
    opdTokens: sim.counts.opd,
    labTokens: sim.counts.lab,
    pharmacyTokens: sim.counts.pharmacy,
    queueEvents: sim.rows.events.length,
    predictions: sim.rows.predictions.length,
    appointments: sim.rows.appointments.length,
    feedback: sim.rows.feedback.length,
    todayWaiting: todayTokens.length,
    forecasts,
    seconds: time.round((Date.now() - started) / 1000, 1),
  };
  if (logger) logger.log(`[seed] ${JSON.stringify(summary)}`);
  return summary;
}

/** Drop and recreate the schema of the configured database. */
async function resetDatabase(logger = console) {
  if (config.db.client === 'sqlite') {
    await closeDb();
    try {
      deleteSqliteFile();
      const db = getDb();
      await createSchema(db);
      return db;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      // The file is held open by another process (e.g. the AI service on Windows): drop tables instead.
      if (logger) logger.log(`[seed] ${config.db.sqlitePath} is in use (${err.code}); dropping tables instead`);
      const db = getDb();
      await dropSchema(db);
      await createSchema(db);
      return db;
    }
  }
  const admin = getDb();
  await admin.execAdmin(`DROP DATABASE IF EXISTS \`${config.db.database}\``);
  await closeDb();
  const db = getDb();
  await createSchema(db);
  return db;
}

async function main() {
  const target = config.db.client === 'sqlite' ? config.db.sqlitePath : `${config.db.host}/${config.db.database}`;
  console.log(`[seed] Resetting ${config.db.client} database ${target}`);
  const db = await resetDatabase();
  await seed(db, { historyDays: config.seedHistoryDays });
  await closeDb();
  console.log('[seed] Done. Accounts: admin@opd.test / branchadmin@opd.test (Admin@123), doctor1..doctor28@opd.test, '
    + 'lab1@opd.test, pharmacy1@opd.test (Staff@123), patient@opd.test or 03001234567 (Patient@123)');
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('[seed] Failed:', err && err.stack ? err.stack : err);
    await closeDb().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { seed, resetDatabase, PASSWORDS, BRANCHES, SPECIALTY_PROFILE };
