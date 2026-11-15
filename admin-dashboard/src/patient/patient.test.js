// Patient portal logic: haversine, congestion rule, recommendation choice, token pass states.
import { describe, expect, it } from 'vitest';
import { AREAS, CONGESTION_RULE, estimateSource, haversineKm, isCongested, pickRecommendation } from './geo.js';
import { journeySteps, priorityTag, statusBanner } from './TokenPassPage.jsx';

describe('geo helpers', () => {
  it('haversine distance matches known Lahore distances (Eq. 6.4)', () => {
    const modelTown = AREAS.find((a) => a.id === 'model-town');
    const gulberg = AREAS.find((a) => a.id === 'gulberg');
    expect(haversineKm(modelTown, modelTown)).toBe(0);
    // Area centres 0.0326° lat and 0.0173° lng apart: √(3.63² + 1.64²) ≈ 3.98 km.
    expect(haversineKm(modelTown, gulberg)).toBe(4);
    // Lahore → Islamabad (Faisal Mosque) is about 270 km on the great circle.
    expect(haversineKm({ lat: 31.5204, lng: 74.3587 }, { lat: 33.7297, lng: 73.0372 })).toBeCloseTo(276, -1);
    expect(haversineKm(modelTown, { lat: 'x', lng: 1 })).toBeNull();
    expect(haversineKm(null, gulberg)).toBeNull();
  });

  it('a queue is busy above 25 min or more than 4 waiting', () => {
    expect(CONGESTION_RULE).toEqual({ waitMinutes: 25, waiting: 4, loadPercent: 75 });
    expect(isCongested({ estimatedWaitMinutes: 3, queueLength: 1 }, { loadPercent: 75 })).toBe(true);
    expect(isCongested({ estimatedWaitMinutes: 3, queueLength: 1 }, { loadPercent: 74 })).toBe(false);
    expect(isCongested({ estimatedWaitMinutes: 25, queueLength: 4 })).toBe(false);
    expect(isCongested({ estimatedWaitMinutes: 26, queueLength: 0 })).toBe(true);
    expect(isCongested({ estimatedWaitMinutes: 3, queueLength: 5 })).toBe(true);
    expect(isCongested(null)).toBe(false);
  });

  it('labels Random Forest estimates and the baseline fallback honestly', () => {
    expect(estimateSource('rf-20261115-1640')).toEqual({ ai: true, label: 'Random Forest · rf-20261115-1640' });
    expect(estimateSource('baseline').ai).toBe(false);
    expect(estimateSource(null).ai).toBe(false);
  });
});

describe('pickRecommendation', () => {
  const current = { id: 1, branchId: 1, estimatedWaitMinutes: 54 };
  const item = (branchId, doctorId, wait, km) => ({ branchId, doctorId, branchName: `B${branchId}`, doctorName: `D${doctorId}`, predictedWaitMinutes: wait, distanceKm: km });

  it('takes the top-scored option that saves 5+ minutes, with minutes saved', () => {
    const r = pickRecommendation([item(2, 7, 2, 5.2), item(3, 9, 2, 8.1)], current);
    expect(r.best).toMatchObject({ branchId: 2, doctorId: 7, minutesSaved: 52, sameBranch: false });
    expect(r.otherBranch).toBeNull();
  });

  it('a free doctor in the same branch wins, and the nearest other branch is offered too', () => {
    const r = pickRecommendation([item(1, 2, 3, 0), item(2, 7, 2, 5.2)], current);
    expect(r.best).toMatchObject({ doctorId: 2, sameBranch: true, minutesSaved: 51 });
    expect(r.otherBranch).toMatchObject({ branchId: 2, minutesSaved: 52 });
  });

  it('ignores the current doctor and options that save under 5 minutes', () => {
    expect(pickRecommendation([item(1, 1, 0, 0), item(2, 7, 50, 3)], current)).toEqual({ best: null, otherBranch: null });
    expect(pickRecommendation([], current).best).toBeNull();
    expect(pickRecommendation([item(2, 7, 2, 5)], { id: 1, branchId: 1, estimatedWaitMinutes: null }).best).toBeNull();
  });
});

describe('token pass', () => {
  const base = {
    displayNumber: 'OPD-004',
    servicePoint: { name: 'Room 1' },
    doctor: { fullName: 'Dr. Ahmed Raza' },
    priorityLevel: 0,
    patientsAhead: 3,
    linkedTokens: [],
  };

  it('status banners: waiting, called (proceed to room), in service, skipped, completed', () => {
    expect(statusBanner({ ...base, status: 'WAITING' }).text).toBe('3 patients ahead of you');
    expect(statusBanner({ ...base, status: 'WAITING', patientsAhead: 0 }).text).toBe('You are next');
    expect(statusBanner({ ...base, status: 'CALLED' }).title).toBe('NOW SERVING — Proceed to Room 1');
    expect(statusBanner({ ...base, status: 'IN_SERVICE' }).title).toBe('In consultation');
    expect(statusBanner({ ...base, status: 'SKIPPED' }).title).toBe('Missed your turn');
    expect(statusBanner({ ...base, status: 'COMPLETED' }).tone).toBe('done');
  });

  it('priority tags', () => {
    expect(priorityTag({ priorityLevel: 0 }).label).toBe('Standard');
    expect(priorityTag({ priorityLevel: 1 }).label).toBe('Senior / Priority');
    expect(priorityTag({ priorityLevel: 2 }).label).toBe('Urgent');
    expect(priorityTag({ priorityLevel: 0, appointmentId: 5 }).label).toBe('Appointment');
  });

  it('journey: registration → OPD → lab/pharmacy → completed', () => {
    const states = (t) => journeySteps(t).map((s) => s.state);
    expect(states({ ...base, status: 'WAITING' })).toEqual(['done', 'active', 'pending', 'pending']);
    expect(states({ ...base, status: 'COMPLETED' })).toEqual(['done', 'done', 'skipped', 'done']);
    const withLab = { ...base, status: 'COMPLETED', linkedTokens: [{ queueType: 'LAB', displayNumber: 'LAB-008', status: 'WAITING', patientsAhead: 2, estimate: { minutes: 10 } }] };
    expect(states(withLab)).toEqual(['done', 'done', 'active', 'pending']);
    expect(journeySteps(withLab)[2].detail).toBe('Lab LAB-008 — 2 ahead · ~10 min');
    const labDone = { ...withLab, linkedTokens: [{ ...withLab.linkedTokens[0], status: 'COMPLETED' }] };
    expect(states(labDone)).toEqual(['done', 'done', 'done', 'done']);
  });
});
