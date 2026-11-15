// REST client of the patient portal (PATIENT JWT from smartopd.patient.token). Same backend and
// contract as the mobile app: docs/API_CONTRACT.md. A 401 ends the patient session.
import { API_URL } from '../api/client.js';
import { SESSION_KEYS, clearSession } from '../utils/unifiedSession.js';

export class PatientApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function patientToken() {
  try {
    return window.localStorage.getItem(SESSION_KEYS.patient.token);
  } catch {
    return null;
  }
}

export function patientUser() {
  try {
    return JSON.parse(window.localStorage.getItem(SESSION_KEYS.patient.user) || 'null');
  } catch {
    return null;
  }
}

/** Sign out of the patient session only (other roles in other tabs stay signed in). */
export function signOut() {
  clearSession('patient');
  window.location.assign('/login');
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${patientToken()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new PatientApiError(0, 'NETWORK', 'Cannot reach the server. Check the connection and try again.');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (res.status === 401) {
    signOut();
    throw new PatientApiError(401, 'UNAUTHORIZED', 'Your session has ended. Please sign in again.');
  }
  if (!res.ok) {
    throw new PatientApiError(res.status, json?.error?.code || 'ERROR', json?.error?.message || `Request failed (${res.status})`);
  }
  return json;
}

const enc = encodeURIComponent;

export const papi = {
  me: () => request('GET', '/auth/me'),
  specialties: () => request('GET', '/specialties'),
  branches: () => request('GET', '/branches'),
  departments: (branchId) => request('GET', `/branches/${branchId}/departments`),
  doctors: (departmentId) => request('GET', `/departments/${departmentId}/doctors`),
  recommendations: ({ specialty, lat, lng, excludeDoctorId }) => {
    const q = [`specialty=${enc(specialty)}`];
    if (lat != null && lng != null) q.push(`lat=${lat}`, `lng=${lng}`);
    if (excludeDoctorId) q.push(`excludeDoctorId=${excludeDoctorId}`);
    return request('GET', `/recommendations?${q.join('&')}`);
  },
  joinQueue: (doctorId) => request('POST', '/tokens', { doctorId }),
  activeTokens: () => request('GET', '/tokens/active'),
  token: (id) => request('GET', `/tokens/${id}`),
  cancelToken: (id) => request('DELETE', `/tokens/${id}`),
  switchToken: (id, doctorId) => request('POST', `/tokens/${id}/switch`, { doctorId }),
  slots: (doctorId, date) => request('GET', `/doctors/${doctorId}/slots?date=${enc(date)}`),
  appointments: () => request('GET', '/appointments'),
  bookAppointment: (doctorId, slotStart) => request('POST', '/appointments', { doctorId, slotStart }),
  rescheduleAppointment: (id, slotStart) => request('PUT', `/appointments/${id}`, { slotStart }),
  cancelAppointment: (id) => request('DELETE', `/appointments/${id}`),
  checkIn: (id) => request('POST', `/appointments/${id}/check-in`, {}),
  visits: () => request('GET', '/visits'),
  feedback: (visitId, rating, comment) => request('POST', `/visits/${visitId}/feedback`, { rating, comment: comment || undefined }),
  loadDemoQueue: (doctorId, count) => request('POST', '/demo/load-queue', { doctorId, count }),
  seedCommitteeDemo: () => request('POST', '/demo/seed', {}),
  peakStatus: () => request('GET', '/demo/peak'),
  setPeak: (enabled) => request('POST', '/demo/peak', { enabled }),
};

export function errorText(err) {
  return err?.message || 'Something went wrong. Please try again.';
}
