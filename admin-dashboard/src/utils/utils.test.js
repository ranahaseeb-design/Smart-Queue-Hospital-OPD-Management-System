import { describe, expect, it } from 'vitest';
import { addDays, dayName, fmtPercent, parseLocal, toDateInput, toHHmm } from './format.js';
import { congestionLevel, normaliseSettings, validateSettings } from './settings.js';
import { aggregateForecastByHour } from './forecast.js';
import {
  categoryLabel, chartCategoryColumns, filenameFromDisposition, labelColumn, numericColumns,
} from './reports.js';
import { safeReturnPath } from './navigation.js';
import { assignableRoles, isAdminRole, permissionsFor } from './roles.js';
import { fmtShare, improvementVsBaseline } from './models.js';
import { adminBranchIdPatch } from './users.js';
import { buildQuery } from '../api/client.js';
import { validateFields } from '../components/FormFields.jsx';

const validSettings = {
  recommendationWeights: { wait: '0.6', distance: '0.25', congestion: '0.15' },
  congestionThresholds: { high: '0.85', critical: '1.0' },
  alternativeSuggestionWaitMinutes: '45',
  notifyPositionsAhead: '3',
  slotMinutes: '15',
};

describe('format', () => {
  it('parses zone-less API datetimes as local time', () => {
    const d = parseLocal('2026-10-29T09:12:00');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(12);
    expect(parseLocal('')).toBeNull();
    expect(parseLocal('not a date')).toBeNull();
  });

  it('round-trips dates and adds days across month ends', () => {
    expect(toDateInput(parseLocal('2026-01-05'))).toBe('2026-01-05');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('normalises times and ISO day numbers', () => {
    expect(toHHmm('09:00:00')).toBe('09:00');
    expect(toHHmm('9:30')).toBe('09:30');
    expect(dayName(1)).toBe('Mon');
    expect(dayName(7, false)).toBe('Sunday');
    expect(dayName(0)).toBe('—');
  });

  it('formats ratios as percentages', () => {
    expect(fmtPercent(0.856)).toBe('86%');
    expect(fmtPercent(null)).toBe('—');
  });
});

describe('settings validation (FR-08 / FR-17)', () => {
  it('accepts the contract defaults', () => {
    expect(validateSettings(validSettings)).toEqual({});
  });

  it('requires weights to sum to 1', () => {
    const errs = validateSettings({ ...validSettings, recommendationWeights: { wait: '0.5', distance: '0.25', congestion: '0.15' } });
    expect(errs.recommendationWeights).toMatch(/sum to 1/);
  });

  it('rejects out-of-range weights and inverted thresholds', () => {
    const errs = validateSettings({
      ...validSettings,
      recommendationWeights: { wait: '1.2', distance: '0', congestion: '0' },
      congestionThresholds: { high: '1.1', critical: '1.0' },
    });
    expect(errs['recommendationWeights.wait']).toBeDefined();
    expect(errs.congestionThresholds).toMatch(/lower/);
  });

  it('requires whole numbers for minute / position settings', () => {
    const errs = validateSettings({ ...validSettings, slotMinutes: '7.5', notifyPositionsAhead: '' });
    expect(errs.slotMinutes).toBeDefined();
    expect(errs.notifyPositionsAhead).toBeDefined();
  });

  it('converts form strings into the numeric API payload', () => {
    expect(normaliseSettings(validSettings)).toEqual({
      recommendationWeights: { wait: 0.6, distance: 0.25, congestion: 0.15 },
      congestionThresholds: { high: 0.85, critical: 1 },
      alternativeSuggestionWaitMinutes: 45,
      notifyPositionsAhead: 3,
      slotMinutes: 15,
    });
  });

  it('classifies congestion with the configured thresholds (Eq. 6.5)', () => {
    expect(congestionLevel(0.5)).toBe('NORMAL');
    expect(congestionLevel(0.85)).toBe('HIGH');
    expect(congestionLevel(0.99)).toBe('HIGH');
    expect(congestionLevel(1.0)).toBe('CRITICAL');
    expect(congestionLevel(0.7, { high: 0.6, critical: 0.9 })).toBe('HIGH');
  });
});

describe('forecast aggregation (FR-17)', () => {
  const rows = [
    { departmentId: 1, forecastHour: '2026-10-30T10:00:00', expectedArrivals: 6, capacity: 12, congestionRatio: 0.5, congestionLevel: 'NORMAL', isPeak: false, source: 'baseline' },
    { departmentId: 2, forecastHour: '2026-10-30T10:00:00', expectedArrivals: 10, capacity: 6, congestionRatio: 1.67, congestionLevel: 'CRITICAL', isPeak: true, source: 'baseline' },
    { departmentId: 1, forecastHour: '2026-10-30T09:00:00', expectedArrivals: 4, capacity: 12, congestionRatio: 0.33, congestionLevel: 'NORMAL', isPeak: false, source: 'rf-1' },
  ];

  it('sums departments per hour, recomputes the ratio and keeps peaks', () => {
    const pts = aggregateForecastByHour(rows);
    expect(pts.map((p) => p.hour)).toEqual(['09:00', '10:00']);
    const ten = pts[1];
    expect(ten.expectedArrivals).toBe(16);
    expect(ten.capacity).toBe(18);
    expect(ten.congestionRatio).toBe(0.89);
    expect(ten.congestionLevel).toBe('HIGH');
    expect(ten.isPeak).toBe(true);
  });

  it('keeps the server ratio and level for a single department', () => {
    const pts = aggregateForecastByHour([rows[1]]);
    expect(pts[0].congestionRatio).toBe(1.67);
    expect(pts[0].congestionLevel).toBe('CRITICAL');
  });

  it('handles empty input', () => {
    expect(aggregateForecastByHour(undefined)).toEqual([]);
  });
});

describe('reports helpers (FR-16)', () => {
  const columns = [
    { key: 'doctorId', label: 'ID' },
    { key: 'doctorName', label: 'Doctor' },
    { key: 'consultations', label: 'Consultations' },
    { key: 'avgConsultMinutes', label: 'Avg consult (min)' },
  ];
  const rows = [
    { doctorId: 1, doctorName: 'Dr. A', consultations: 40, avgConsultMinutes: '9.5' },
    { doctorId: 2, doctorName: 'Dr. B', consultations: 31, avgConsultMinutes: 12 },
  ];

  it('detects numeric metric columns and the label column, skipping ids', () => {
    expect(numericColumns(columns, rows).map((c) => c.key)).toEqual(['consultations', 'avgConsultMinutes']);
    expect(labelColumn(columns, rows).key).toBe('doctorName');
  });

  it('extends the chart category until labels are unique (branch + department)', () => {
    const cols = [
      { key: 'branchName', label: 'Branch' },
      { key: 'departmentName', label: 'Department' },
      { key: 'specialty', label: 'Specialty' },
      { key: 'tokensIssued', label: 'Tokens issued' },
      { key: 'peakHour', label: 'Busiest hour' },
    ];
    const traffic = [
      { branchName: 'Model Town', departmentName: 'Cardiology', specialty: 'Cardiology', tokensIssued: 40, peakHour: '10:00' },
      { branchName: 'Model Town', departmentName: 'ENT', specialty: 'ENT', tokensIssued: 12, peakHour: '11:00' },
      { branchName: 'Gulberg', departmentName: 'Cardiology', specialty: 'Cardiology', tokensIssued: 33, peakHour: '10:00' },
    ];
    const picked = chartCategoryColumns(cols, traffic);
    expect(picked.map((c) => c.key)).toEqual(['branchName', 'departmentName']);
    expect(categoryLabel(traffic[2], picked)).toBe('Gulberg · Cardiology');
    // A report whose first text column is already unique keeps a single category column.
    expect(chartCategoryColumns(columns, rows).map((c) => c.key)).toEqual(['doctorName']);
    expect(categoryLabel({}, picked)).toBe('—');
    expect(chartCategoryColumns([{ key: 'n', label: 'N' }], [{ n: 1 }])).toEqual([]);
  });

  it('reads the filename from Content-Disposition', () => {
    expect(filenameFromDisposition('attachment; filename="waiting-times.csv"', 'x.csv')).toBe('waiting-times.csv');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''feedback%20report.csv", 'x.csv')).toBe('feedback report.csv');
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
  });
});

describe('login redirect', () => {
  it('only returns to paths inside the app', () => {
    expect(safeReturnPath('/forecasts?date=2026-10-30')).toBe('/forecasts?date=2026-10-30');
    expect(safeReturnPath(undefined)).toBe('/overview');
    expect(safeReturnPath('/login')).toBe('/overview');
    expect(safeReturnPath('//evil.example')).toBe('/overview');
    expect(safeReturnPath('/\\evil.example')).toBe('/overview');
    expect(safeReturnPath('https://evil.example')).toBe('/overview');
  });
});

describe('roles (Section 3.2)', () => {
  it('only lets administrators in', () => {
    expect(isAdminRole('HOSPITAL_ADMIN')).toBe(true);
    expect(isAdminRole('BRANCH_ADMIN')).toBe(true);
    expect(isAdminRole('STAFF')).toBe(false);
    expect(isAdminRole('PATIENT')).toBe(false);
  });

  it('restricts branch admins to their branch and to staff accounts', () => {
    const p = permissionsFor({ role: 'BRANCH_ADMIN', adminBranchId: 1 });
    expect(p.allBranches).toBe(false);
    expect(p.manageBranches).toBe(false);
    expect(p.manageSettings).toBe(false);
    expect(p.manageModels).toBe(false);
    expect(p.manageMasterData).toBe(true);
    expect(assignableRoles({ role: 'BRANCH_ADMIN' })).toEqual(['STAFF']);
  });

  it('gives hospital admins everything', () => {
    const p = permissionsFor({ role: 'HOSPITAL_ADMIN' });
    expect(Object.values(p).every(Boolean)).toBe(true);
    expect(assignableRoles({ role: 'HOSPITAL_ADMIN' })).toContain('BRANCH_ADMIN');
  });
});

describe('model metrics (FR-22)', () => {
  it('formats the within-10-minutes share from a fraction or a percentage', () => {
    expect(fmtShare(0.625)).toBe('62.5%');
    expect(fmtShare(62.5)).toBe('62.5%');
    expect(fmtShare(null)).toBe('—');
  });

  it('computes the MAE improvement over the baseline', () => {
    expect(improvementVsBaseline({ mae: 8, baselineMae: 10 })).toBeCloseTo(20);
    expect(improvementVsBaseline({ mae: 12, baselineMae: 10 })).toBeCloseTo(-20);
    expect(improvementVsBaseline({ mae: null, baselineMae: 10 })).toBeNull();
    expect(improvementVsBaseline({ mae: 5, baselineMae: 0 })).toBeNull();
  });
});

describe('api helpers', () => {
  it('builds query strings without empty values', () => {
    expect(buildQuery({ branchId: 2, departmentId: '', date: '2026-10-30', x: null })).toBe('?branchId=2&date=2026-10-30');
    expect(buildQuery({})).toBe('');
    expect(buildQuery()).toBe('');
  });
});

describe('form validation', () => {
  const fields = [
    { name: 'fullName', label: 'Full name', required: true },
    { name: 'email', label: 'E-mail', type: 'email', required: true },
    { name: 'password', label: 'Password', type: 'password', minLength: 6 },
    { name: 'avg', label: 'Avg', type: 'number', min: 1, max: 120 },
    { name: 'days', label: 'Days', type: 'days', required: true },
    { name: 'start', label: 'Start', type: 'time', required: true },
  ];

  it('flags required, format and range problems', () => {
    const errs = validateFields(fields, { fullName: ' ', email: 'nope', password: '123', avg: '500', days: [], start: '9' });
    expect(Object.keys(errs).sort()).toEqual(['avg', 'days', 'email', 'fullName', 'password', 'start']);
  });

  it('passes valid values', () => {
    expect(validateFields(fields, {
      fullName: 'Dr. Sara Ahmed', email: 'sara@opd.test', password: 'secret1', avg: '12', days: [1, 2], start: '09:00',
    })).toEqual({});
  });
});

describe('adminBranchIdPatch (user create/update payload)', () => {
  const staffRow = { id: 7, role: 'STAFF', adminBranchId: 2 };

  it('sends the chosen branch on create for STAFF and BRANCH_ADMIN only', () => {
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '3' }, 'create')).toEqual({ adminBranchId: 3 });
    expect(adminBranchIdPatch({ role: 'BRANCH_ADMIN', adminBranchId: '1' }, 'create')).toEqual({ adminBranchId: 1 });
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '' }, 'create')).toEqual({});
    expect(adminBranchIdPatch({ role: 'HOSPITAL_ADMIN', adminBranchId: '1' }, 'create')).toEqual({});
  });

  it('omits the key on edit when the branch is unchanged (never wipes the home branch)', () => {
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '2' }, 'edit', staffRow)).toEqual({});
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '' }, 'edit', { role: 'STAFF', adminBranchId: null })).toEqual({});
    expect(adminBranchIdPatch({ role: 'HOSPITAL_ADMIN', adminBranchId: '' }, 'edit', staffRow)).toEqual({});
  });

  it('sends a changed branch, and null only when explicitly cleared', () => {
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '4' }, 'edit', staffRow)).toEqual({ adminBranchId: 4 });
    expect(adminBranchIdPatch({ role: 'STAFF', adminBranchId: '' }, 'edit', staffRow)).toEqual({ adminBranchId: null });
    expect(adminBranchIdPatch({ role: 'BRANCH_ADMIN', adminBranchId: '5' }, 'edit', { role: 'HOSPITAL_ADMIN', adminBranchId: null }))
      .toEqual({ adminBranchId: 5 });
  });
});
