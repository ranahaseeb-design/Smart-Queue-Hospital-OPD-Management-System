const TEXT = {
  connected: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Offline · refreshing every 15 s',
};

/** Dot + word showing the state of the real-time channel (FR-05): Live, Connecting (reconnecting), Offline. */
export default function ConnectionStatus({ status }) {
  const text = TEXT[status] || TEXT.connecting;
  return (
    <span className={`conn conn--${status}`} role="status" title={`Live updates: ${text}`}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{text}</span>
    </span>
  );
}
