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

// Session key prefix. Standalone: "smartopd.staff". Inside the Smart OPD Dashboard the host sets
// it per tab before these screens load ("smartopd.doctor" for doctors, "smartopd.staff" for lab /
// pharmacy / OPD staff), so a doctor and a staff member signed in in two tabs never share keys.
export const DEFAULT_KEY_PREFIX = 'smartopd.staff';
let keyPrefix = DEFAULT_KEY_PREFIX;

export function setKeyPrefix(prefix) {
  keyPrefix = typeof prefix === 'string' && prefix ? prefix : DEFAULT_KEY_PREFIX;
}

export const KEYS = {
  get token() {
    return `${keyPrefix}.token`;
  },
  get user() {
    return `${keyPrefix}.user`;
  },
  servicePoint: (userId) => `${keyPrefix}.servicePoint.${userId}`,
};
