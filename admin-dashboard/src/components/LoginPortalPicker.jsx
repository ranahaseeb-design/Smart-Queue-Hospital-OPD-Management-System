// Four-card sign-in screen (shared by the Staff and Admin dashboards; keep both copies identical).
// Cards for this dashboard's roles open the form in place (onSelect); the others are links to the
// other dashboard's login with that card preselected (see utils/loginPortals.js).
import { LOGIN_PORTALS, portalHref } from '../utils/loginPortals.js';

const ICONS = {
  stethoscope: (
    <>
      <path d="M5 3v5a5 5 0 0 0 10 0V3" />
      <path d="M3.5 3h3M13.5 3h3" />
      <path d="M10 13v2.5a5 5 0 0 0 10 0V13" />
      <circle cx="20" cy="11" r="2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.7a3.5 3.5 0 0 1 0 6.6" />
      <path d="M18 14.3a6.5 6.5 0 0 1 3.5 5.7" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16" />
      <path d="M15 9h3a2 2 0 0 1 2 2v10" />
      <path d="M3 21h18" />
      <path d="M8 7.5h3M8 11.5h3M8 15.5h3" />
    </>
  ),
  shieldCheck: (
    <>
      <path d="M12 3l7 3v5.2c0 4.4-2.9 8.2-7 9.8-4.1-1.6-7-5.4-7-9.8V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  ticket: (
    <>
      <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" />
      <path d="M9 6v12" strokeDasharray="2 2.5" />
      <path d="M13 10h4M13 14h3" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowLeft: <path d="M19 12H5M11 18l-6-6 6-6" />,
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
};

export function PortalIcon({ name, className = '' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`portal-svg ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

export default function LoginPortalPicker({ localApp, otherAppUrl, otherAppName, onSelect }) {
  return (
    <div className="portal-grid" role="list" aria-label="Login options">
      {LOGIN_PORTALS.map((portal, i) => {
        const href = portalHref(portal, localApp, otherAppUrl);
        const body = (
          <>
            <span className="portal-icon" aria-hidden="true">
              <PortalIcon name={portal.icon} />
            </span>
            <span className="portal-title">{portal.title}</span>
            <span className="portal-subtitle">{portal.subtitle}</span>
            <span className="portal-select">
              Select
              <PortalIcon name={href ? 'external' : 'arrowRight'} className="portal-select-icon" />
            </span>
            {href && <span className="portal-elsewhere">Opens the {otherAppName}</span>}
          </>
        );
        const style = { '--portal-index': i };
        return (
          <div role="listitem" key={portal.id} className={`portal-cell${portal.featured ? ' portal-cell--featured' : ''}`}>
            {href ? (
              <a
                className="portal-card"
                href={href}
                style={style}
                aria-label={`${portal.title} — ${portal.subtitle} (opens the ${otherAppName})`}
              >
                {body}
              </a>
            ) : (
              <button
                type="button"
                className="portal-card"
                style={style}
                onClick={() => onSelect(portal)}
                aria-label={`${portal.title} — ${portal.subtitle}`}
              >
                {body}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
