// "● Live" indicator for live screens, tied to the real Socket.IO state (RealtimeContext) and
// the page's refresh state: Live (pulsing, socket connected), Reconnecting, or Polling while the
// socket is down (Decision 8 polling fallback). Status is a word, never colour alone.
import { useRealtime } from '../context/RealtimeContext.jsx';
import { Spinner } from './ui.jsx';

const TEXT = {
  live: { label: 'Live', title: 'Connected to the real-time channel: numbers update as queues change' },
  connecting: { label: 'Reconnecting', title: 'Connecting to the real-time channel' },
  offline: { label: 'Polling', title: 'Real-time channel unavailable' },
};

export default function LiveIndicator({ refreshing = false, pollSeconds = 15 }) {
  const { status } = useRealtime();
  const st = TEXT[status] || TEXT.offline;
  const label = status === 'offline' ? `${st.label} every ${pollSeconds} s` : st.label;
  return (
    <span className={`live-indicator live-indicator-${status}`} title={st.title} data-status={status}>
      <span className="live-indicator-dot" aria-hidden="true" />
      <span>{label}</span>
      {refreshing && <Spinner size="xs" label="Updating" />}
    </span>
  );
}
