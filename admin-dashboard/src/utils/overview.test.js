import { describe, expect, it } from 'vitest';
import {
  alertKey, countUpValue, easeOutCubic, filterDepartments, kpiAnnouncement, sparkPath, stripAlerts, trendSeries,
  utilisationBand,
} from './overview.js';

describe('utilisationBand (department load matrix)', () => {
  it('is emerald below 70 %, amber 70–85 %, crimson above 85 %', () => {
    expect(utilisationBand(0)).toBe('low');
    expect(utilisationBand(0.69)).toBe('low');
    expect(utilisationBand(0.7)).toBe('mid');
    expect(utilisationBand(0.85)).toBe('mid');
    expect(utilisationBand(0.851)).toBe('high');
    expect(utilisationBand(1.4)).toBe('high');
  });

  it('is "none" when the ratio is unknown', () => {
    [null, undefined, '', 'x', Infinity].forEach((v) => expect(utilisationBand(v)).toBe('none'));
  });
});

describe('stripAlerts (sliding congestion strip)', () => {
  const alerts = [
    { id: 'forecast-1', level: 'HIGH', source: 'FORECAST', departmentId: 1, at: '2026-11-14T16:00:00' },
    { id: 'forecast-2', level: 'CRITICAL', source: 'FORECAST', departmentId: 1, at: '2026-11-14T17:00:00' },
    { id: 'forecast-3', level: 'CRITICAL', source: 'FORECAST', departmentId: 1, at: '2026-11-14T15:00:00' },
    { id: 'live-2', level: 'HIGH', source: 'LIVE', departmentId: 2, at: '2026-11-14T10:00:00' },
    { id: 'live-3', level: 'CRITICAL', source: 'LIVE', departmentId: 3, at: '2026-11-14T10:05:00' },
    { id: 'n', level: 'NORMAL', source: 'LIVE', departmentId: 4, at: '2026-11-14T10:05:00' },
  ];

  it('keeps HIGH/CRITICAL only, one per department, worst and live first', () => {
    const items = stripAlerts(alerts);
    expect(items.map((a) => a.departmentId)).toEqual([3, 1, 2]);
    const dept1 = items.find((a) => a.departmentId === 1);
    expect(dept1.id).toBe('forecast-3'); // soonest CRITICAL forecast hour
    expect(dept1.count).toBe(3);
  });

  it('hides dismissed keys until the department escalates', () => {
    const dismissed = new Set([alertKey({ departmentId: 2, source: 'LIVE', level: 'HIGH' })]);
    expect(stripAlerts(alerts, dismissed).map((a) => a.departmentId)).toEqual([3, 1]);
    const escalated = [...alerts, { id: 'live-2', level: 'CRITICAL', source: 'LIVE', departmentId: 2, at: '2026-11-14T10:10:00' }];
    expect(stripAlerts(escalated, dismissed).map((a) => a.departmentId)).toContain(2);
  });

  it('copes with missing or malformed input', () => {
    expect(stripAlerts(null)).toEqual([]);
    expect(stripAlerts([null, {}])).toEqual([]);
  });
});

describe('trend + sparkline', () => {
  it('extracts a numeric series, keeping nulls for hours without data', () => {
    const trend = [{ hour: '09:00', waiting: 3 }, { hour: '10:00', waiting: null }, { hour: '11:00', waiting: '5' }];
    expect(trendSeries(trend, 'waiting')).toEqual([3, null, 5]);
    expect(trendSeries(undefined, 'waiting')).toEqual([]);
  });

  it('draws nothing with fewer than two values', () => {
    expect(sparkPath([])).toBeNull();
    expect(sparkPath([4])).toBeNull();
    expect(sparkPath([null, 4, null])).toBeNull();
  });

  it('scales into the box and breaks the line at nulls', () => {
    const p = sparkPath([0, 10, null, 5, 10], 100, 20, 0);
    expect(p.line.startsWith('M0 20 L25 0')).toBe(true);
    expect(p.line.split('M')).toHaveLength(3); // two segments
    expect(p.last).toEqual({ x: 100, y: 0 });
    expect(p.min).toBe(0);
    expect(p.max).toBe(10);
  });

  it('centres a flat series', () => {
    const p = sparkPath([2, 2, 2], 100, 20, 0);
    expect(p.line).toBe('M0 10 L50 10 L100 10');
  });
});

describe('count-up', () => {
  it('eases from the previous value to the target', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(countUpValue(0, 10, 0)).toBe(0);
    expect(countUpValue(0, 10, 1)).toBe(10);
    expect(countUpValue(10, 0, 0.5)).toBeCloseTo(1.25);
    expect(countUpValue(null, 8, 1)).toBe(8);
    expect(countUpValue(3, null, 0.5)).toBeNull();
  });
});

describe('filterDepartments (branch scope + department filter)', () => {
  const rows = [
    { departmentId: 1, branchId: 1, congestionRatio: 0.5, waiting: 4 },
    { departmentId: 2, branchId: 2, congestionRatio: 1.2, waiting: 9 },
    { departmentId: 3, branchId: 1, congestionRatio: null, waiting: 1 },
    { departmentId: 4, branchId: 1, congestionRatio: 0.9, waiting: 6 },
  ];

  it('sorts by load, unknown ratios last', () => {
    expect(filterDepartments(rows).map((d) => d.departmentId)).toEqual([2, 4, 1, 3]);
  });

  it('filters by branch and department immediately', () => {
    expect(filterDepartments(rows, { branchId: 1 }).map((d) => d.departmentId)).toEqual([4, 1, 3]);
    expect(filterDepartments(rows, { branchId: '1', departmentId: '4' }).map((d) => d.departmentId)).toEqual([4]);
    expect(filterDepartments(null)).toEqual([]);
  });
});

describe('kpiAnnouncement (aria-live summary)', () => {
  it('lists the numeric KPIs only', () => {
    expect(kpiAnnouncement([
      { label: 'Waiting now', value: 12 },
      { label: 'Avg current wait', value: 31.6, unit: 'min' },
      { label: 'Max current wait', value: null },
    ])).toBe('Waiting now 12. Avg current wait 32 min');
  });
});
