// Live pace gauge for the consultation in the room: elapsed time against the doctor's rolling average
// (`summary.avgConsultMinutes` of the queue response). Emerald below the average, amber from the average,
// crimson from 1.5x. Status is shown as a word too, never colour alone (NFR-03).
import { useNow } from '../hooks/useNow.js';
import { PACE_CRITICAL_RATIO, formatElapsed, paceState, secondsSince } from '../utils/format.js';

/** Bar scale: the bar is full at 2x the average, so the average sits in the middle. */
const SCALE_RATIO = 2;

function trimMinutes(m) {
  const n = Number(m);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 10) / 10} min`;
}

function spoken(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m} min ${s} s`;
}

/**
 * @param {{ calledAt?: string|null, startedAt?: Date|null, avgMinutes?: number|null,
 *           serviceWord?: string, now?: Date }} props
 * `startedAt` is the instant this screen saw the service start (the contract has no start time on
 * QueueToken); otherwise the gauge counts from `calledAt`.
 */
export default function PaceGauge({ calledAt, startedAt = null, avgMinutes, serviceWord = 'consultation', now: fixedNow }) {
  const ticking = useNow(1000);
  const now = fixedNow || ticking;
  const fromStart = startedAt instanceof Date && !Number.isNaN(startedAt.getTime());
  const elapsed = fromStart
    ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
    : secondsSince(calledAt, now);
  const pace = paceState(elapsed, avgMinutes);
  const known = pace.level !== 'unknown';
  const fill = known ? Math.min(1, pace.ratio / SCALE_RATIO) : 0;
  const maxSeconds = known ? Math.round(Number(avgMinutes) * 60 * SCALE_RATIO) : undefined;
  const sinceWord = fromStart ? 'since start' : 'since called';

  return (
    <div className={`pace pace--${pace.level}`}>
      <div className="pace-top">
        <div className="pace-elapsed">
          <span className="pace-time" aria-hidden="true">
            {formatElapsed(elapsed)}
          </span>
          <span className="pace-since">{sinceWord}</span>
        </div>
        <div className="pace-status">
          <span className="pace-word">{pace.label}</span>
          <span className="pace-avg">{known ? `Avg ${serviceWord} ${trimMinutes(avgMinutes)}` : 'No average yet today'}</span>
        </div>
      </div>
      <div
        className="pace-track"
        role="meter"
        aria-label={`${serviceWord} pace`}
        aria-valuemin={0}
        aria-valuemax={maxSeconds}
        aria-valuenow={elapsed ?? undefined}
        aria-valuetext={
          elapsed == null
            ? 'Elapsed time unknown'
            : `${spoken(elapsed)} ${sinceWord}${known ? `, ${pace.label.toLowerCase()}, average ${trimMinutes(avgMinutes)}` : ''}`
        }
      >
        <span className="pace-fill" style={{ transform: `scaleX(${fill})` }} />
        {known && (
          <>
            <span className="pace-mark" style={{ left: `${(1 / SCALE_RATIO) * 100}%` }} title="Average" />
            <span className="pace-mark pace-mark--critical" style={{ left: `${(PACE_CRITICAL_RATIO / SCALE_RATIO) * 100}%` }} title="1.5 x average" />
          </>
        )}
      </div>
      {known && (
        <div className="pace-scale" aria-hidden="true">
          <span>0</span>
          <span style={{ left: `${(1 / SCALE_RATIO) * 100}%` }}>avg</span>
          <span style={{ left: `${(PACE_CRITICAL_RATIO / SCALE_RATIO) * 100}%` }}>1.5×</span>
        </div>
      )}
    </div>
  );
}
