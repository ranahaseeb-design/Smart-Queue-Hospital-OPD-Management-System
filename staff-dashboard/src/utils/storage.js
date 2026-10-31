// Thin, exception-safe wrapper around localStorage (private mode / disabled storage must not crash the app).
const memory = new Map();

function store() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* access denied */
  }
  return null;
}

export function getItem(key) {
  const s = store();
  try {
    return s ? s.getItem(key) : memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function setItem(key, value) {
  memory.set(key, value);
  const s = store();
  try {
    if (s) s.setItem(key, value);
  } catch {
    /* quota or access error: keep the in-memory copy */
  }
}

export function removeItem(key) {
  memory.delete(key);
  const s = store();
  try {
    if (s) s.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getJSON(key) {
  const raw = getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setJSON(key, value) {
  setItem(key, JSON.stringify(value));
}

export const KEYS = {
  token: 'smartopd.staff.token',
  user: 'smartopd.staff.user',
  servicePoint: (userId) => `smartopd.staff.servicePoint.${userId}`,
};
