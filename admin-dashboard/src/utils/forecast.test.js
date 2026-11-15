import { describe, expect, it } from 'vitest';
import { aggregateForecastByHour, excessPatients, forecastTotals, rowShortfallDoctorHours } from './forecast.js';

const row = (o) => ({ departmentId: 1, forecastHour: '2026-11-14T10:00:00', expectedArrivals: 0, capacity: 0, ...o });

describe('forecast shortfalls (contract: shortfallDoctorHours, avgConsultMinutes)', () => {
  it('computes patients over capacity, never negative', () => {
    expect(excessPatients(row({ expectedArrivals: 9, capacity: 6 }))).toBe(3);
    expect(excessPatients(row({ expectedArrivals: 4, capacity: 6 }))).toBe(0);
    expect(excessPatients({})).toBe(0);
  });

  it('prefers the API value, falls back to the contract formula, else null', () => {
    expect(rowShortfallDoctorHours(row({ shortfallDoctorHours: 1.4, expectedArrivals: 9, capacity: 6 }))).toBe(1.4);
    // max(0, 9 - 6) * 12 / 60 = 0.6
    expect(rowShortfallDoctorHours(row({ expectedArrivals: 9, capacity: 6, avgConsultMinutes: 12 }))).toBe(0.6);
    expect(rowShortfallDoctorHours(row({ expectedArrivals: 9, capacity: 6 }))).toBeNull();
    expect(rowShortfallDoctorHours(row({ expectedArrivals: 9, capacity: 6, shortfallDoctorHours: null }))).toBeNull();
  });

  it('sums per-department shortfalls per hour (capacity is not shared between departments)', () => {
    const pts = aggregateForecastByHour([
      row({ departmentId: 1, expectedArrivals: 10, capacity: 6, shortfallDoctorHours: 0.8 }),
      row({ departmentId: 2, expectedArrivals: 2, capacity: 8, shortfallDoctorHours: 0 }),
    ]);
    expect(pts).toHaveLength(1);
    // the aggregate (12 vs 14) looks fine, but department 1 is short
    expect(pts[0].congestionRatio).toBe(0.86);
    expect(pts[0].excessPatients).toBe(4);
    expect(pts[0].isShortfall).toBe(true);
    expect(pts[0].shortfallDoctorHours).toBe(0.8);
  });

  it('does not show a partial doctor-hour sum when a department lacks the field', () => {
    const pts = aggregateForecastByHour([
      row({ departmentId: 1, expectedArrivals: 10, capacity: 6, shortfallDoctorHours: 0.8 }),
      row({ departmentId: 2, expectedArrivals: 9, capacity: 6 }),
    ]);
    expect(pts[0].shortfallDoctorHours).toBeNull();
    expect(pts[0].excessPatients).toBe(7);
  });

  it('keeps avgConsultMinutes for a single department', () => {
    const pts = aggregateForecastByHour([row({ expectedArrivals: 3, capacity: 6, avgConsultMinutes: 7.5 })]);
    expect(pts[0].avgConsultMinutes).toBe(7.5);
    expect(pts[0].isShortfall).toBe(false);
    expect(pts[0].shortfallDoctorHours).toBe(0);
  });

  it('totals the day', () => {
    const pts = aggregateForecastByHour([
      row({ forecastHour: '2026-11-14T09:00:00', expectedArrivals: 4, capacity: 6, shortfallDoctorHours: 0 }),
      row({ forecastHour: '2026-11-14T10:00:00', expectedArrivals: 9, capacity: 6, shortfallDoctorHours: 0.6 }),
      row({ forecastHour: '2026-11-14T11:00:00', expectedArrivals: 8, capacity: 6, shortfallDoctorHours: 0.4 }),
    ]);
    expect(forecastTotals(pts)).toEqual({ arrivals: 21, shortfallHours: 2, shortfallDoctorHours: 1, excessPatients: 5 });
    expect(forecastTotals([]).shortfallDoctorHours).toBeNull();
  });
});
