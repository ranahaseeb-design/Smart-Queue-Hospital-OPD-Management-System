export default function Spinner({ label = 'Loading…', fullPage = false, small = false }) {
  const cls = ['spinner-wrap', fullPage ? 'spinner-wrap--page' : '', small ? 'spinner-wrap--small' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="spinner-label">{label}</span>}
    </div>
  );
}
