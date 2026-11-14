/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { routerFuture, scopeValue } from '../test/dom.js';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, api: { ...actual.api, get: mocks.get, post: mocks.post } };
});
vi.mock('../context/ScopeContext.jsx', () => ({ useScope: () => scopeValue() }));
vi.mock('../context/AuthContext.jsx', () => ({ useAuth: () => ({ permissions: { runForecasts: true } }) }));
vi.mock('../context/ToastContext.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: ForecastsPage, ShortfallLine } = await import('./ForecastsPage.jsx');

const hour = (h) => `2026-11-14T${String(h).padStart(2, '0')}:00:00`;
const FORECASTS = [
  { branchId: 1, departmentId: 1, departmentName: 'Cardiology', forecastHour: hour(9), expectedArrivals: 4, capacity: 6, congestionRatio: 0.67, congestionLevel: 'NORMAL', isPeak: false, source: 'baseline', avgConsultMinutes: 10, shortfallDoctorHours: 0 },
  { branchId: 1, departmentId: 1, departmentName: 'Cardiology', forecastHour: hour(10), expectedArrivals: 9, capacity: 6, congestionRatio: 1.5, congestionLevel: 'CRITICAL', isPeak: true, source: 'baseline', avgConsultMinutes: 10, shortfallDoctorHours: 0.5 },
];

function mockApi(forecasts = FORECASTS) {
  mocks.get.mockImplementation(async (path) => {
    if (path === '/admin/departments') return [{ id: 1, name: 'Cardiology', branchName: 'Gulberg', isActive: true }];
    if (path === '/admin/settings') return { congestionThresholds: { high: 0.85, critical: 1 } };
    if (path === '/admin/forecasts') return forecasts;
    throw new Error(`unexpected ${path}`);
  });
}

const renderPage = () => render(<MemoryRouter future={routerFuture}><ForecastsPage /></MemoryRouter>);

beforeEach(() => {
  mocks.get.mockReset();
});

describe('<ForecastsPage>', () => {
  it('shows the staffing shortfall KPI in doctor-hours and a Shortfall column', async () => {
    mockApi();
    renderPage();
    expect(await screen.findByText('Staffing shortfall')).toBeTruthy();
    expect(screen.getByText('doctor-h')).toBeTruthy();
    expect(screen.getByText('1 hour above capacity ·', { exact: false })).toBeTruthy();
    expect(screen.getByText('0.5 dr-h')).toBeTruthy();
    expect(screen.getByText(/Forecast arrivals vs. scheduled capacity/)).toBeTruthy();
  });

  it('falls back to patients over capacity when the backend has no shortfall fields', async () => {
    mockApi(FORECASTS.map(({ avgConsultMinutes, shortfallDoctorHours, ...r }) => r)); // eslint-disable-line no-unused-vars
    renderPage();
    expect(await screen.findByText('Staffing shortfall')).toBeTruthy();
    expect(screen.getByText('patients')).toBeTruthy();
  });

  it('preselects department and date from a Workload deep link', async () => {
    mockApi();
    render(<MemoryRouter future={routerFuture} initialEntries={['/forecasts?departmentId=1&date=2026-11-15']}><ForecastsPage /></MemoryRouter>);
    await screen.findByText('Staffing shortfall');
    expect(mocks.get).toHaveBeenCalledWith('/admin/forecasts', { departmentId: '1', date: '2026-11-15' }, expect.anything());
  });

  it('shows the empty state when there is no forecast', async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText(/No forecast for/)).toBeTruthy();
  });
});

describe('<ShortfallLine> (chart tooltip)', () => {
  it('states the exact doctor-hours for a shortfall hour', () => {
    render(<ShortfallLine row={{ isShortfall: true, shortfallDoctorHours: 1.4, excessPatients: 6.2, congestionLevel: 'CRITICAL', congestionRatio: 1.6 }} />);
    expect(screen.getByText('Shortfall 1.4 doctor-hours (6.2 patients over capacity)')).toBeTruthy();
  });

  it('says when doctor-hours are not reported, and when capacity is enough', () => {
    const { rerender } = render(<ShortfallLine row={{ isShortfall: true, shortfallDoctorHours: null, excessPatients: 2, congestionLevel: 'HIGH' }} />);
    expect(screen.getByText('2.0 patients over capacity (doctor-hours not reported)')).toBeTruthy();
    rerender(<ShortfallLine row={{ isShortfall: false, excessPatients: 0, congestionLevel: 'NORMAL' }} />);
    expect(screen.getByText('Capacity covers the forecast')).toBeTruthy();
  });
});
