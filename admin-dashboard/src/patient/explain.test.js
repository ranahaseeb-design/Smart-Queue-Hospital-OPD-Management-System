// Patient portal text helpers: Explain AI estimate, session-full reason, appointments.
import { describe, expect, it } from 'vitest';
import { canCheckIn, dateKey, explainLines, unavailableText, visitSummary } from './explain.js';

const base = { patientsAhead: 3, priorityAhead: 1, normalAhead: 2, doctorAvgConsultMinutes: 7, minutesToStart: 0, baselineMinutes: 21 };

describe('explain AI estimate', () => {
  it('shows the model adjustment for Random Forest estimates', () => {
    const out = explainLines({ minutes: 25, low: 20, high: 30, modelVersion: 'rf-1', explain: { ...base, method: 'MODEL', modelAdjustmentMinutes: 4 } });
    expect(out.headline).toMatch(/Random Forest/);
    expect(out.lines.find((l) => l.label.startsWith('AI adjustment')).value).toBe('+4 min');
    expect(out.lines[0].value).toBe('3 (1 with priority)');
    expect(out.note).toBeNull();
  });

  it('says why the formula was used', () => {
    const cold = explainLines({ minutes: 21, low: 16, high: 26, modelVersion: 'baseline', explain: { ...base, method: 'BASELINE', reason: 'COLD_START' } });
    expect(cold.note).toMatch(/too little history/);
    const down = explainLines({ minutes: 21, low: 16, high: 26, modelVersion: 'baseline', explain: { ...base, method: 'BASELINE', reason: 'AI_UNAVAILABLE' } });
    expect(down.note).toMatch(/not available/);
    expect(explainLines({ minutes: 3 })).toBeNull();
  });
});

describe('doctor availability text', () => {
  it('names a full session', () => {
    expect(unavailableText({ acceptingNow: false, unavailableReason: 'SESSION_FULL' })).toMatch(/^Session full/);
    expect(unavailableText({ acceptingNow: true })).toBeNull();
    expect(unavailableText({ acceptingNow: false, availableToday: false })).toBe('Not scheduled today');
  });
});

describe('appointments and visits', () => {
  it('opens check-in 60 minutes before the slot, only for booked appointments', () => {
    const now = new Date(2026, 10, 3, 9, 30);
    expect(canCheckIn({ status: 'BOOKED', slotStart: '2026-11-03T10:15:00' }, now)).toBe(true);
    expect(canCheckIn({ status: 'BOOKED', slotStart: '2026-11-03T11:00:00' }, now)).toBe(false);
    expect(canCheckIn({ status: 'CANCELLED', slotStart: '2026-11-03T10:00:00' }, now)).toBe(false);
  });

  it('formats dates and visit summaries', () => {
    expect(dateKey(1, new Date(2026, 11, 31))).toBe('2027-01-01');
    expect(visitSummary({ tokens: [{ displayNumber: 'OPD-004', status: 'COMPLETED' }, { displayNumber: 'PHA-002', status: 'IN_SERVICE' }] }))
      .toBe('OPD-004 completed · PHA-002 in service');
  });
});
