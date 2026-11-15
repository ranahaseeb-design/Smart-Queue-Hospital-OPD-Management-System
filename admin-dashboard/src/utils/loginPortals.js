// Role-card sign-in (shared by the Smart OPD Dashboard and the standalone staff screens; keep both copies identical).
// Each card is a login portal. The backend verifies it: POST /api/auth/login with `portal`
// refuses a token when the account does not match (docs/API_CONTRACT.md, "/auth/login").
// Doctors and other staff sign in on the Staff Dashboard, administrators on the Admin Dashboard;
// a card that belongs to the other dashboard links to that dashboard's login with the card
// preselected (only the portal id travels in the URL — never credentials or tokens).

export const LOGIN_PORTALS = [
  {
    // Patients and walk-ins (kiosk): sign in, or check in as a guest without credentials.
    id: 'patient',
    apiPortal: 'PATIENT',
    app: 'patient',
    title: 'Patient Portal / Get Token',
    subtitle: 'Join an OPD queue or check in as a walk-in — no staff login needed',
    icon: 'ticket',
    featured: true,
  },
  {
    id: 'doctor',
    apiPortal: 'DOCTOR',
    app: 'staff',
    title: 'Doctor Login',
    subtitle: 'Access Doctor Portal',
    icon: 'stethoscope',
  },
  {
    id: 'staff',
    apiPortal: 'STAFF',
    app: 'staff',
    title: 'Staff Login',
    subtitle: 'Access Staff Portal',
    icon: 'users',
  },
  {
    id: 'branch-admin',
    apiPortal: 'BRANCH_ADMIN',
    app: 'admin',
    title: 'Branch Administrator Login',
    subtitle: 'Manage Your Branch',
    icon: 'building',
  },
  {
    id: 'hospital-admin',
    apiPortal: 'HOSPITAL_ADMIN',
    app: 'admin',
    title: 'Hospital Administrator Login',
    subtitle: 'Manage Entire Hospital',
    icon: 'shieldCheck',
  },
];

/** The portal for a `?portal=` value, or null when it is missing/unknown. */
export function portalById(id) {
  if (typeof id !== 'string') return null;
  return LOGIN_PORTALS.find((p) => p.id === id.trim().toLowerCase()) || null;
}

/**
 * Where a card leads from the app `localApp` ('staff' | 'admin' | 'all'): null = open the form
 * here, otherwise the other dashboard's login URL with the card preselected. The combined Smart
 * OPD Dashboard passes 'all': every card opens its form in place.
 */
export function portalHref(portal, localApp, otherAppUrl) {
  if (!portal || localApp === 'all' || portal.app === localApp) return null;
  const base = String(otherAppUrl || '').replace(/\/+$/, '');
  return `${base}/login?portal=${encodeURIComponent(portal.id)}`;
}
