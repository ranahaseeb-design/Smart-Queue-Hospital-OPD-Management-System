/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { routerFuture, scopeValue } from '../test/dom.js';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});
vi.mock('../context/ScopeContext.jsx', () => ({ useScope: () => scopeValue() }));

const { default: WorkloadPage } = await import('./WorkloadPage.jsx');

const hour = (h) => `2026-11-14T${String(h).padStart(2, '0')}:00:00`;
const RECS = {
  workload: [{ branchId: 1, branchName: 'Gulberg', patientsPerDoctorHour: 3.1, utilization: 0.92, avgWaitMinutes: 40 }],
  recommendations: [
    { branchId: 1, branchName: 'Gulberg', departmentId: 1, departmentName: 'Cardiology', date: '2026-11-14', timeRange: '16:00-17:00', shortfallSessions: 1, message: 'Forecast exceeds capacity by about one doctor session.' },
    { branchId: 2, branchName: 'DHA', departmentId: 7, departmentName: 'Orthopedics', date: '2026-11-14', timeRange: '09:00-10:00', shortfallSessions: 1, message: 'Orthopedics short at 09:00.' },
  ],
};
const FORECASTS = [
  // Cardiology with the new avgConsultMinutes field
  ...[[15, 5, 6], [16, 10, 6], [17, 9, 6], [18, 4, 6], [19, 2, 6]].map(([h, a, c]) => ({
    departmentId: 1, departmentName: 'Cardiology', forecastHour: hour(h), expectedArrivals: a, capacity: c, avgConsultMinutes: 10,
  })),
  // Orthopedics without avgConsultMinutes (older backend) -> falls back to /admin/doctors
  ...[[9, 8, 6], [10, 3, 6]].map(([h, a, c]) => ({
    departmentId: 7, departmentName: 'Orthopedics', forecastHour: hour(h), expectedArrivals: a, capacity: c,
  })),
];
const DOCTORS = [
  { id: 1, departmentId: 7, departmentName: 'Orthopedics', avgConsultMinutes: 12, isActive: true },
];

function mockApi({ recs = RECS, forecasts = FORECASTS, doctors = DOCTORS } = {}) {
  mocks.get.mockImplementation(async (path) => {
    if (path === '/admin/recommendations') return recs;
    if (path === '/admin/forecasts') return forecasts;
    if (path === '/admin/doctors') return doctors;
    throw new Error(`unexpected ${path}`);
  });
}

const renderAt = (url = '/workload') => render(
  <MemoryRouter future={routerFuture} initialEntries={[url]}><WorkloadPage /></MemoryRouter>,
);

const card = (name) => screen.getByText(name, { selector: 'strong' }).closest('article');

beforeEach(() => {
  mocks.get.mockReset();
  window.__reducedMotion = true;
});

describe('<WorkloadPage> +1 doctor session what-if', () => {
  it('toggles the estimate and shows the wait reduction from the backlog model', async () => {
    mockApi();
    renderAt();
    await screen.findByText('Cardiology', { selector: 'strong' });
    const c = card('Cardiology');
    const toggle = await waitFor(() => {
      const t = within(c).getByRole('switch', { name: '+1 extra doctor session' });
      expect(t.disabled).toBe(false);
      return t;
    });
    expect(within(c).getByText('Estimate')).toBeTruthy();
    expect(within(c).getByText('—')).toBeTruthy(); // no reduction until toggled
    expect(within(c).getByText(/Would add 6.0 patients\/h \(60 ÷ 10.0 min/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // avg wait 42.5 -> 10 min, reduction 32.5 -> "−33 min" (whole minutes)
    await waitFor(() => expect(within(c).getByText('−33 min')).toBeTruthy());
    expect(within(c).getByText('→ 10 min')).toBeTruthy();
    expect(c.className).toContain('is-sim');
    // Nothing is written: only GET requests were made
    expect(mocks.get.mock.calls.every(([p]) => p.startsWith('/admin/'))).toBe(true);
  });

  it('falls back to the doctors’ average consult time when the forecast lacks it', async () => {
    mockApi();
    renderAt();
    await screen.findByText('Orthopedics', { selector: 'strong' });
    const c = card('Orthopedics');
    await waitFor(() => expect(within(c).getByText(/60 ÷ 12.0 min average consultation, from the doctors’ profiles/)).toBeTruthy());
  });

  it('explains when the estimate is impossible instead of inventing numbers', async () => {
    mockApi({ forecasts: [], doctors: [] });
    renderAt();
    await screen.findByText('Cardiology', { selector: 'strong' });
    const c = card('Cardiology');
    await waitFor(() => expect(within(c).getByText(/no hourly forecast for this department/i)).toBeTruthy());
    expect(within(c).getByRole('switch').disabled).toBe(true);
  });

  it('highlights and focuses the deep-linked department (?departmentId=)', async () => {
    mockApi();
    renderAt('/workload?departmentId=7');
    await screen.findByText('Showing Orthopedics');
    const c = card('Orthopedics');
    expect(c.className).toContain('rec-highlight');
    expect(card('Cardiology').className).not.toContain('rec-highlight');
    await waitFor(() => expect(document.activeElement).toBe(c));
    expect(c.scrollIntoView).toHaveBeenCalled();
  });

  it('says so when the deep-linked department has no recommendation', async () => {
    mockApi();
    renderAt('/workload?departmentId=99');
    expect(await screen.findByText('No staffing recommendation for department #99')).toBeTruthy();
  });

  it('shows the empty state without recommendations', async () => {
    mockApi({ recs: { workload: [], recommendations: [] } });
    renderAt();
    expect(await screen.findByText('No resource shortfalls forecast')).toBeTruthy();
  });
});
