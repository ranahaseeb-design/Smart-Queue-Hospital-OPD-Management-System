// Runtime configuration (Vite injects import.meta.env at build time).

/** Staff Dashboard origin — the Doctor and Staff login cards link there. */
export const STAFF_APP_URL = (import.meta.env?.VITE_STAFF_APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
