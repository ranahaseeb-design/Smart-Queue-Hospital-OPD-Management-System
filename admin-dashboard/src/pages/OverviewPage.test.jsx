/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { routerFuture, scopeValue } from '../test/dom.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), scope: null, status: 'live' }));

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});
vi.mock('../context/ScopeContext.jsx', () => ({ useScope: () => mocks.scope }));
vi.mock('../context/RealtimeContext.jsx', () => ({
  useRealtime: () => ({ status: mocks.status, on: () => () => {} }),
}));

const { default: OverviewPage } = await import('./OverviewPage.jsx');

const DASHBOARD = {
  kpis: { waiting: 14, inService: 3, completedToday: 40, avgWaitMinutes: 22, maxWaitMinutes: 65, activeDoctors: 8, activeServicePoints: 12 },
  trend: [
    { hour: '09:00', waiting: 4, inService: 2, completed: 5, avgWaitMinutes: 10, maxWaitMinutes: 20 },
    { hour: '10:00', waiting: 9, inService: 3, completed: 18, avgWaitMinutes: 18, maxWaitMinutes: 40 },
    { hour: '11:00', waiting: 14, inService: 3, completed: 40, avgWaitMinutes: null, maxWaitMinutes: null },
  ],
  branches: [{ branchId: 1, name: 'Gulberg', waiting: 10, avgWaitMinutes: 25, congestionLevel: 'CRITICAL' }],
  departments: [
    {
      departmentId: 1, branchId: 1, branchName: 'Gulberg', name: 'Cardiology', specialty: 'Cardiology', waiting: 9, activeDoctors: 2,
      avgWaitMinutes: 30, maxWaitMinutes: 65, congestionRatio: 1.12, congestionLevel: 'CRITICAL',
      doctors: [
        { doctorId: 5, fullName: 'Dr. Sara Ahmed', servicePointId: 3, servicePointName: 'Room 4', waiting: 5, nowServing: 'OPD-012', avgConsultMinutes: 7.5, estimatedWaitMinutes: 38, acceptingNow: true },
      ],
    },
    {
      departmentId: 2, branchId: 1, branchName: 'Gulberg', name: 'Orthopedics', specialty: 'Orthopedics', waiting: 2, activeDoctors: 2,
      avgWaitMinutes: 12, maxWaitMinutes: 20, congestionRatio: 0.75, congestionLevel: 'NORMAL', doctors: [],
    },
    {
      departmentId: 3, branchId: 2, branchName: 'DHA', name: 'Gynaecology', specialty: 'Gynaecology', waiting: 3, activeDoctors: 2,
      avgWaitMinutes: 8, maxWaitMinutes: 15, congestionRatio: 0.4, congestionLevel: 'NORMAL', // no `doctors` (older backend)
    },
  ],
  servicePoints: [],
};

const ALERTS = [
  { id: 'live-1', level: 'CRITICAL', source: 'LIVE', branchId: 1, branchName: 'Gulberg', departmentId: 1, departmentName: 'Cardiology', message: 'Cardiology at Gulberg is over capacity.', at: '2026-11-14T10:00:00' },
  { id: 'forecast-9', level: 'HIGH', source: 'FORECAST', branchId: 2, branchName: 'DHA', departmentId: 3, departmentName: 'Gynaecology', message: 'Forecast 6 arrivals vs capacity 5.', at: '2026-11-14T16:00:00' },
];

function mockApi({ dashboard = DASHBOARD, alerts = ALERTS } = {}) {
  mocks.get.mockImplementation(async (path) => {
    if (path === '/admin/dashboard') return dashboard;
    if (path === '/admin/alerts') return alerts;
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  return render(<MemoryRouter future={routerFuture}><OverviewPage /></MemoryRouter>);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.scope = scopeValue();
  mocks.status = 'live';
  window.__reducedMotion = true; // final numbers immediately
});

describe('<OverviewPage>', () => {
  it('shows the 7 KPIs, a Live indicator tied to the socket and sparklines from trend', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Today at a glance');
    expect(screen.getByText('Waiting now')).toBeTruthy();
    expect(screen.getByText('Active service points')).toBeTruthy();
    expect(document.querySelectorAll('.kpi-live')).toHaveLength(7);
    // trend-backed tiles get a sparkline (waiting, in service, completed, avg wait, max wait)
    expect(document.querySelectorAll('svg.sparkline')).toHaveLength(5);
    expect(document.querySelector('.live-indicator').dataset.status).toBe('live');
    expect(document.querySelector('.live-indicator').textContent).toBe('Live');
    // polite live region with the numbers
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]').textContent).toContain('Waiting now 14');
  });

  it('shows the polling fallback when the socket is down', async () => {
    mocks.status = 'offline';
    mockApi();
    renderPage();
    expect(await screen.findByText('Polling every 15 s')).toBeTruthy();
  });

  it('renders the alert strip with a staffing-fix deep link and per-alert dismiss', async () => {
    mockApi();
    renderPage();
    const strip = await screen.findByRole('region', { name: 'Congestion alerts' });
    await waitFor(() => expect(strip.querySelectorAll('.strip-alert')).toHaveLength(2));
    const critical = strip.querySelector('.strip-critical');
    expect(critical.textContent).toContain('Cardiology · Gulberg');
    expect(within(critical).getByRole('link', { name: /Simulate staffing fix/ }).getAttribute('href')).toBe('/workload?departmentId=1');
    fireEvent.click(within(critical).getByRole('button', { name: /Dismiss CRITICAL alert/ }));
    expect(strip.querySelectorAll('.strip-alert')).toHaveLength(1);
    expect(sessionStorage.getItem('smartopd.admin.dismissedAlerts')).toContain('1|LIVE|CRITICAL');
  });

  it('colours utilisation bars by band and expands a department to its doctors', async () => {
    mockApi();
    renderPage();
    await screen.findByText('Department load');
    expect(document.querySelectorAll('.util-high')).toHaveLength(1);
    expect(document.querySelectorAll('.util-mid')).toHaveLength(1);
    expect(document.querySelectorAll('.util-low')).toHaveLength(1);

    const toggle = screen.getByRole('button', { name: /^Cardiology/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Dr. Sara Ahmed')).toBeTruthy();
    expect(screen.getByText('OPD-012')).toBeTruthy();
    expect(screen.getByText('Accepting')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Gynaecology/ }));
    expect(screen.getByText(/Per-doctor detail is not provided/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Orthopedics/ }));
    expect(screen.getByText(/No doctors are scheduled/)).toBeTruthy();
  });

  it('filters the matrix by the department dropdown and the branch scope', async () => {
    mockApi();
    const { rerender } = renderPage();
    await screen.findByText('Department load');
    fireEvent.change(screen.getByLabelText('Department filter'), { target: { value: '2' } });
    const matrix = document.querySelector('table.matrix');
    expect(matrix.querySelectorAll('tr.matrix-row')).toHaveLength(1);
    expect(screen.getByText('Orthopedics — right now')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Department filter'), { target: { value: '' } });
    mocks.scope = scopeValue({ branchId: 2, branchName: 'DHA', scopeQuery: { branchId: 2 }, branch: { id: 2, name: 'DHA' } });
    rerender(<MemoryRouter future={routerFuture}><OverviewPage /></MemoryRouter>);
    await waitFor(() => expect(document.querySelectorAll('table.matrix tr.matrix-row')).toHaveLength(1));
    expect(document.querySelector('table.matrix').textContent).toContain('Gynaecology');
  });

  it('degrades gracefully without trend, doctors or alerts', async () => {
    const { trend, ...noTrend } = DASHBOARD; // eslint-disable-line no-unused-vars
    mockApi({ dashboard: { ...noTrend, departments: [] }, alerts: [] });
    renderPage();
    await screen.findByText('Today at a glance');
    expect(document.querySelectorAll('svg.sparkline')).toHaveLength(0);
    expect(screen.getByText('No departments in scope')).toBeTruthy();
    expect(screen.getByText('No active congestion alerts')).toBeTruthy();
    expect(document.querySelectorAll('.strip-alert')).toHaveLength(0);
  });

  it('shows an error with retry when the dashboard cannot load', async () => {
    mocks.get.mockImplementation(async (path) => {
      if (path === '/admin/alerts') return [];
      throw new Error('boom');
    });
    renderPage();
    expect(await screen.findByText('Could not load data')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
});
