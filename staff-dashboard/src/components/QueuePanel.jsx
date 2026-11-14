// Left side of the staff console: the live queue with two tabs, "Waiting queue" and
// "Skipped (recallable)", each with its count (WAI-ARIA tabs: arrow keys move between tabs).
import { useRef } from 'react';
import SkippedList from './SkippedList.jsx';
import WaitingList from './WaitingList.jsx';

export const QUEUE_TABS = [
  { id: 'waiting', label: 'Waiting queue' },
  { id: 'skipped', label: 'Skipped (recallable)' },
];

export default function QueuePanel({
  tab = 'waiting',
  onTabChange,
  waiting,
  skipped,
  busy,
  now,
  hasOpenToken,
  onPriority,
  onTransfer,
  onRecall,
  canOperate,
}) {
  const tabRefs = useRef({});
  const counts = {
    waiting: Array.isArray(waiting) ? waiting.length : 0,
    skipped: Array.isArray(skipped) ? skipped.length : 0,
  };

  function onKeyDown(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = QUEUE_TABS.findIndex((t) => t.id === tab);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % QUEUE_TABS.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + QUEUE_TABS.length) % QUEUE_TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = QUEUE_TABS.length - 1;
    const id = QUEUE_TABS[next].id;
    onTabChange(id);
    tabRefs.current[id]?.focus();
  }

  return (
    <section className="card queue-panel" aria-labelledby="queue-panel-heading">
      <h2 id="queue-panel-heading" className="sr-only">
        Live queue
      </h2>
      <div className="tabs" role="tablist" aria-label="Queue lists" onKeyDown={onKeyDown}>
        {QUEUE_TABS.map((t) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`queue-tab-${t.id}`}
              aria-selected={selected ? 'true' : 'false'}
              aria-controls={`queue-tabpanel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={`tab${selected ? ' is-selected' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              <span>{t.label}</span>
              <span
                className={`count-pill${t.id === 'skipped' ? ' count-pill--warning' : ''}`}
                aria-label={`${counts[t.id]} ${t.id === 'skipped' ? 'skipped tokens' : 'patients waiting'}`}
              >
                {counts[t.id]}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`queue-tabpanel-${tab}`}
        aria-labelledby={`queue-tab-${tab}`}
        className="tabpanel"
        tabIndex={0}
      >
        {tab === 'skipped' ? (
          <SkippedList
            embedded
            tokens={skipped}
            busy={busy}
            hasOpenToken={hasOpenToken}
            onRecall={onRecall}
            onPriority={onPriority}
            canOperate={canOperate}
          />
        ) : (
          <WaitingList
            embedded
            tokens={waiting}
            busy={busy}
            now={now}
            onPriority={onPriority}
            onTransfer={onTransfer}
            canOperate={canOperate}
          />
        )}
      </div>
    </section>
  );
}
