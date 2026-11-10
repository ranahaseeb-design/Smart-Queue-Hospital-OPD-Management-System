export default function Spinner({ label = 'Loading…', fullPage = false, small = false }) {
  const cls = ['spinner-wrap', fullPage ? 'spinner-wrap--page' : '', small ? 'spinner-wrap--small' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} role="status" aria-live="polite">
      {fullPage && (
        <span className="brand-mark brand-mark--lg" aria-hidden="true">
          <BrandGlyph />
        </span>
      )}
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </div>
  );
}

/** The Smart OPD cross used in the brand mark. */
export function BrandGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="brand-glyph">
      <path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" fill="currentColor" />
    </svg>
  );
}
