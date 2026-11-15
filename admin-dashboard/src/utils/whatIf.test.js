import { describe, expect, it } from 'vitest';
import {
  backlogSeries, extraCapacityPerHour, hourOf, parseTimeRange, resolveAvgConsult, simulateExtraSession,
} from './whatIf.js';

const pt = (h, a, c, extra = {}) => ({ forecastHour: `2026-11-14T${String(h).padStart(2, '0')}:00:00`, expectedArrivals: a, capacity: c, ...extra });

describe('parseTimeRange', () => {
  it('parses recommendation time ranges (end exclusive)', () => {
    expect(parseTimeRange('16:00-17:00')).toEqual({ startHour: 16, endHour: 17 });
    expect(parseTimeRange('17:00 – 19:00')).toEqual({ startHour: 17, endHour: 19 });
    expect(parseTimeRange('08:30-09:15')).toEqual({ startHour: 8, endHour: 10 });
    expect(parseTimeRange('23:00-00:00')).toEqual({ startHour: 23, endHour: 24 });
  });

  it('returns null for missing or invalid ranges', () => {
    expect(parseTimeRange(undefined)).toBeNull();
    expect(parseTimeRange('morning')).toBeNull();
  });
});

describe('extra capacity and consult time', () => {
  it('adds 60 / avgConsultMinutes patients per hour', () => {
    expect(extraCapacityPerHour(10)).toBe(6);
    expect(extraCapacityPerHour(7.5)).toBe(8);
    expect(extraCapacityPerHour(0)).toBeNull();
    expect(extraCapacityPerHour(null)).toBeNull();
  });

  it('prefers the forecast avgConsultMinutes, else the mean of active doctors', () => {
    const doctors = [
      { departmentId: 3, avgConsultMinutes: 8, isActive: true },
      { departmentId: 3, avgConsultMinutes: 11, isActive: true },
      { departmentId: 3, avgConsultMinutes: 30, isActive: false },
      { departmentId: 4, avgConsultMinutes: 20, isActive: true },
    ];
    expect(resolveAvgConsult([{ departmentId: 3, avgConsultMinutes: 9.2 }], doctors, 3)).toEqual({ value: 9.2, source: 'forecast' });
    expect(resolveAvgConsult([{ departmentId: 3 }], doctors, 3)).toEqual({ value: 9.5, source: 'doctors' });
    expect(resolveAvgConsult([], [], 3)).toEqual({ value: null, source: null });
  });

  it('reads the hour from forecastHour or an HH:mm label', () => {
    expect(hourOf(pt(16, 0, 0))).toBe(16);
    expect(hourOf({ hour: '09:00' })).toBe(9);
    expect(hourOf({})).toBeNull();
  });
});

describe('backlogSeries (hourly backlog model)', () => {
  it('carries unserved patients forward and converts them to minutes of wait', () => {
    const s = backlogSeries([pt(9, 8, 6), pt(10, 8, 6), pt(11, 2, 6)]);
    expect(s.map((x) => x.backlog)).toEqual([2, 4, 0]);
    expect(s.map((x) => x.wait)).toEqual([20, 40, 0]);
  });

  it('has no wait estimate when there is a backlog but no capacity', () => {
    expect(backlogSeries([pt(7, 3, 0)])[0]).toEqual({ backlog: 3, wait: null });
    expect(backlogSeries([pt(7, 0, 0)])[0]).toEqual({ backlog: 0, wait: 0 });
  });
});

describe('simulateExtraSession (+1 doctor session what-if)', () => {
  const day = [pt(15, 5, 6), pt(16, 10, 6), pt(17, 9, 6), pt(18, 4, 6), pt(19, 2, 6)];

  it('adds capacity only inside the range and reduces the estimated wait', () => {
    const r = simulateExtraSession(day, { avgConsultMinutes: 10, timeRange: '16:00-17:00' });
    expect(r.available).toBe(true);
    expect(r.extraPerHour).toBe(6);
    expect(r.addedCapacity).toBe(6);
    expect(r.points.map((p) => p.simulatedCapacity)).toEqual([6, 12, 6, 6, 6]);
    // current plan: backlog 0, 4, 7, 5, 1 -> never cleared, window runs to 19:00
    expect(r.points.map((p) => p.backlogBefore)).toEqual([0, 4, 7, 5, 1]);
    // +1 session: backlog 0, 0, 3, 1, 0
    expect(r.points.map((p) => p.backlogAfter)).toEqual([0, 0, 3, 1, 0]);
    expect(r.window).toEqual({ from: '16:00', to: '19:00', hours: 4 });
    expect(r.peakBacklogBefore).toBe(7);
    expect(r.peakBacklogAfter).toBe(3);
    expect(r.backlogReduction).toBe(4);
    // waits before: 40, 70, 50, 10 -> 42.5; after: 0, 30, 10, 0 -> 10
    expect(r.avgWaitBefore).toBe(42.5);
    expect(r.avgWaitAfter).toBe(10);
    expect(r.waitReduction).toBe(32.5);
  });

  it('ends the window when the current backlog clears after the range', () => {
    const r = simulateExtraSession([pt(9, 8, 6), pt(10, 3, 6), pt(11, 9, 6)], { avgConsultMinutes: 12, timeRange: '09:00-10:00' });
    expect(r.window).toEqual({ from: '09:00', to: '10:00', hours: 2 });
    expect(r.waitReduction).toBeGreaterThan(0);
  });

  it('never reports a negative reduction', () => {
    const r = simulateExtraSession([pt(9, 1, 6), pt(10, 1, 6)], { avgConsultMinutes: 10, timeRange: '09:00-11:00' });
    expect(r.waitReduction).toBe(0);
    expect(r.backlogReduction).toBe(0);
  });

  it('refuses to estimate without a consult time, a range or a forecast', () => {
    expect(simulateExtraSession(day, { timeRange: '16:00-17:00' })).toEqual({ available: false, reason: 'NO_CONSULT_TIME' });
    expect(simulateExtraSession(day, { avgConsultMinutes: 10 })).toEqual({ available: false, reason: 'NO_TIME_RANGE' });
    expect(simulateExtraSession([], { avgConsultMinutes: 10, timeRange: '16:00-17:00' })).toEqual({ available: false, reason: 'NO_FORECAST' });
    expect(simulateExtraSession([pt(9, 1, 1)], { avgConsultMinutes: 10, timeRange: '16:00-17:00' })).toEqual({ available: false, reason: 'NO_FORECAST' });
  });
});
