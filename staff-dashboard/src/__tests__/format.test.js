import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatInstantClock,
  formatMinutes,
  minutesSince,
  parseLocalDateTime,
  priorityLabel,
  priorityTone,
  statusLabel,
} from '../utils/format.js';

describe('parseLocalDateTime (contract datetimes have no zone suffix)', () => {
  it('parses "YYYY-MM-DDTHH:mm:ss" as local wall-clock time', () => {
    const d = parseLocalDateTime('2026-10-29T09:12:05');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(12);
    expect(d.getSeconds()).toBe(5);
  });

  it('returns null for empty or invalid values', () => {
    expect(parseLocalDateTime(null)).toBeNull();
    expect(parseLocalDateTime('')).toBeNull();
    expect(parseLocalDateTime('not a date')).toBeNull();
  });
});

describe('time formatting', () => {
  it('formats a clock time', () => {
    expect(formatClock('2026-10-29T07:05:00')).toBe('07:05');
    expect(formatClock(null)).toBe('—');
  });

  it('formats durations in minutes and hours', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(12.4)).toBe('12 min');
    expect(formatMinutes(65)).toBe('1 h 05 min');
    expect(formatMinutes(null)).toBe('—');
  });

  it('computes whole minutes elapsed and never goes negative (browser zone)', () => {
    const now = new Date(2026, 9, 29, 10, 0, 0);
    expect(minutesSince('2026-10-29T09:30:00', now, null)).toBe(30);
    expect(minutesSince('2026-10-29T10:30:00', now, null)).toBe(0);
    expect(minutesSince(null, now, null)).toBeNull();
  });

  it('compares hospital wall-clock times whatever zone the browser runs in', () => {
    // 05:00 UTC = 10:00 in Asia/Karachi (UTC+5, no DST).
    const now = new Date(Date.UTC(2026, 9, 29, 5, 0, 0));
    expect(minutesSince('2026-10-29T09:30:00', now, 'Asia/Karachi')).toBe(30);
    expect(minutesSince('2026-10-29T09:30:00', now)).toBe(30); // default HOSPITAL_TIME_ZONE
    expect(minutesSince('2026-10-29T10:30:00', now, 'Asia/Karachi')).toBe(0);
    // An unknown zone falls back to the browser zone instead of throwing.
    expect(minutesSince('2026-10-29T09:30:00', new Date(2026, 9, 29, 10, 0, 0), 'Not/AZone')).toBe(30);
  });

  it('formats an instant as hospital clock time', () => {
    expect(formatInstantClock(new Date(Date.UTC(2026, 9, 29, 8, 5, 9)), 'Asia/Karachi')).toBe('13:05:09');
    expect(formatInstantClock(null)).toBe('—');
  });
});

describe('priority helpers (FR-13)', () => {
  it('labels levels and categories', () => {
    expect(priorityLabel(0, 'NONE')).toBeNull();
    expect(priorityLabel(1, 'ELDERLY')).toBe('Elderly');
    expect(priorityLabel(1, 'DIFFERENTLY_ABLED')).toBe('Differently-abled');
    expect(priorityLabel(1, 'NONE')).toBe('Priority');
    expect(priorityLabel(2, 'ELDERLY')).toBe('Emergency');
  });

  it('maps levels to colour tones', () => {
    expect(priorityTone(0)).toBe('normal');
    expect(priorityTone(1)).toBe('priority');
    expect(priorityTone(2)).toBe('emergency');
    expect(priorityTone(undefined)).toBe('normal');
  });

  it('labels token statuses', () => {
    expect(statusLabel('IN_SERVICE')).toBe('In service');
    expect(statusLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});
