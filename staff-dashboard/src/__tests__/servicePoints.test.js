import { describe, expect, it } from 'vitest';
import {
  canIssueLinkedTokens,
  describeTarget,
  groupTransferTargets,
  pickInitialServicePoint,
  targetsOfType,
  transferTargetUnavailableReason,
} from '../utils/servicePoints.js';

const points = [
  { id: 3, name: 'Room 1', type: 'OPD' },
  { id: 7, name: 'Lab counter', type: 'LAB' },
];

const targets = [
  { servicePointId: 11, name: 'Room 10', type: 'OPD', doctorId: 4, doctorName: 'Dr. Bilal', specialty: 'ENT', waiting: 5 },
  {
    servicePointId: 9,
    name: 'Room 2',
    type: 'OPD',
    doctorId: 2,
    doctorName: 'Dr. Sara Ahmed',
    specialty: 'Cardiology',
    waiting: 1,
  },
  { servicePointId: 20, name: 'Pharmacy', type: 'PHARMACY', doctorId: null, doctorName: null, specialty: null, waiting: 2 },
  { servicePointId: 21, name: 'Lab B', type: 'LAB', doctorId: null, doctorName: null, specialty: null, waiting: 4 },
  { servicePointId: 22, name: 'Lab A', type: 'LAB', doctorId: null, doctorName: null, specialty: null, waiting: 1 },
];

describe('pickInitialServicePoint', () => {
  it('returns null when nothing is assigned', () => {
    expect(pickInitialServicePoint([], null)).toBeNull();
    expect(pickInitialServicePoint(undefined, '3')).toBeNull();
  });

  it('opens the only assigned point directly', () => {
    expect(pickInitialServicePoint([points[0]], null)).toBe(3);
  });

  it('uses the remembered point when it is still assigned', () => {
    expect(pickInitialServicePoint(points, '7')).toBe(7);
  });

  it('asks again when the remembered point is no longer assigned', () => {
    expect(pickInitialServicePoint(points, '99')).toBeNull();
    expect(pickInitialServicePoint(points, null)).toBeNull();
  });
});

describe('transfer / linked-token targets', () => {
  it('only OPD rooms issue linked tokens (FR-04)', () => {
    expect(canIssueLinkedTokens('OPD')).toBe(true);
    expect(canIssueLinkedTokens('LAB')).toBe(false);
    expect(canIssueLinkedTokens('PHARMACY')).toBe(false);
  });

  it('marks OPD rooms without a doctor today as unavailable transfer targets', () => {
    expect(transferTargetUnavailableReason({ ...targets[0], doctorId: null })).toBe('No doctor today');
    expect(transferTargetUnavailableReason(targets[0])).toBeNull();
    expect(transferTargetUnavailableReason(targets[2])).toBeNull(); // pharmacy needs no doctor
    expect(transferTargetUnavailableReason(targets[3])).toBeNull(); // lab needs no doctor
  });

  it('filters by type and sorts by shortest queue', () => {
    expect(targetsOfType(targets, 'LAB').map((t) => t.servicePointId)).toEqual([22, 21]);
    expect(targetsOfType(null, 'LAB')).toEqual([]);
  });

  it('groups OPD first, then LAB, then PHARMACY, with natural name order', () => {
    const groups = groupTransferTargets(targets);
    expect(groups.map((g) => g.type)).toEqual(['OPD', 'LAB', 'PHARMACY']);
    expect(groups[0].items.map((t) => t.name)).toEqual(['Room 2', 'Room 10']);
  });

  it('filters by room, doctor or specialty text', () => {
    const groups = groupTransferTargets(targets, 'cardio');
    expect(groups).toHaveLength(1);
    expect(groups[0].items[0].servicePointId).toBe(9);
    expect(groupTransferTargets(targets, 'nothing-matches')).toEqual([]);
  });

  it('describes a target in one line', () => {
    expect(describeTarget(targets[1])).toBe('Room 2 · Dr. Sara Ahmed · Cardiology');
    expect(describeTarget(targets[2])).toBe('Pharmacy');
  });
});
