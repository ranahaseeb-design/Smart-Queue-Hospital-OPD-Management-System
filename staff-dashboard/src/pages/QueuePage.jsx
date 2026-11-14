// Staff console (Upgrade 2026 "Staff Dashboard"; Section 4.12, Table 4.19): a split-screen, touch-first
// screen. LEFT = the live queue in the backend's order with tabs "Waiting queue" / "Skipped (recallable)";
// RIGHT = the consultation stage (token, priority tag, stage, pace gauge, action bar), today's summary and
// recently completed consultations (linked tokens after the consultation). Stacks on narrow screens.
// FR-04 linked tokens, FR-05 live updates, FR-12 queue operations, FR-13 priority handling, NFR-03.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import ConnectionStatus from '../components/ConnectionStatus.jsx';
import LinkedTokenModal from '../components/LinkedTokenModal.jsx';
import NowServingCard from '../components/NowServingCard.jsx';
import PriorityModal from '../components/PriorityModal.jsx';
import QueuePanel from '../components/QueuePanel.jsx';
import RecentlyCompletedList from '../components/RecentlyCompletedList.jsx';
import ShortcutHelp from '../components/ShortcutHelp.jsx';
import Icon from '../components/Icon.jsx';
import { QueueSkeleton } from '../components/Skeleton.jsx';
import SummaryTiles from '../components/SummaryTiles.jsx';
import TransferModal from '../components/TransferModal.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useServicePoints } from '../auth/ServicePointsContext.jsx';
import { useNow } from '../hooks/useNow.js';
import { useQueue } from '../hooks/useQueue.js';
import { api } from '../api.js';
import { PRIORITY_LEVELS, formatInstantClock, servicePointTypeLabel } from '../utils/format.js';
import { describeQueueChange } from '../utils/queueDiff.js';
import { canIssueLinkedTokens, canOperateToken } from '../utils/servicePoints.js';
import { shortcutAction } from '../utils/shortcuts.js';
import { stageActions } from '../utils/stageActions.js';

const EMPTY = [];

export default function QueuePage() {
  const { servicePointId } = useParams();
  const { loaded, findPoint, remember } = useServicePoints();
  const assigned = loaded ? findPoint(servicePointId) : null;
  const assignedId = assigned ? assigned.id : null;

  // Remember the point that is actually open so the next sign-in lands here.
  useEffect(() => {
    if (assignedId != null) remember(assignedId);
  }, [assignedId, remember]);

  if (loaded && !assigned) {
    return (
      <div className="app-shell">
        <AppHeader />
        <main id="main" className="page page--narrow">
          <NotAssignedNotice />
        </main>
      </div>
    );
  }

  // Keyed so that switching service point starts from a clean state.
  return <QueueScreen key={servicePointId} servicePointId={servicePointId} pointInfo={assigned} />;
}

function NotAssignedNotice() {
  return (
    <div className="card notice-card notice-card--error" role="alert">
      <span className="empty-state-icon empty-state-icon--danger" aria-hidden="true">
        <Icon name="alert" />
      </span>
      <h1 className="page-title">Not your service point</h1>
      <p>You are not assigned to this service point, so its queue cannot be shown.</p>
      <Link to="/select" className="btn btn--primary">
        Choose a service point
      </Link>
    </div>
  );
}

function QueueScreen({ servicePointId, pointInfo }) {
  const { user } = useAuth();
  const toast = useToast();
  const now = useNow(30000);
  const { data, error, loading, lastUpdated, connection, refresh } = useQueue(servicePointId);
  const [busy, setBusy] = useState(null); // key of the action in progress, e.g. 'call-next', 'recall:42'
  const [dialog, setDialog] = useState(null); // { kind: 'skip'|'transfer'|'priority'|'linked'|'help', token }
  const [tab, setTab] = useState('waiting');
  const [announcement, setAnnouncement] = useState('');
  // Instant this screen saw a service start (QueueToken has no start time); the pace gauge uses it.
  const [startedAt, setStartedAt] = useState({});

  const servicePoint = {
    id: servicePointId,
    ...(pointInfo || {}),
    ...((data && data.servicePoint) || {}),
  };
  const nowServing = (data && data.nowServing) || null;
  const waiting = useMemo(() => (data && Array.isArray(data.waiting) ? data.waiting : EMPTY), [data]);
  const skipped = useMemo(() => (data && Array.isArray(data.skipped) ? data.skipped : EMPTY), [data]);
  const recentlyCompleted = useMemo(
    () => (data && Array.isArray(data.recentlyCompleted) ? data.recentlyCompleted : EMPTY),
    [data],
  );
  const linkedAllowed = canIssueLinkedTokens(servicePoint.type, user);
  const canOperate = useCallback((t) => canOperateToken(t, servicePoint.type, user), [servicePoint.type, user]);
  const summary = (data && data.summary) || null;
  const doctorName = pointInfo && pointInfo.doctorName;

  // Tab title shows the point and the token being served (useful with several tabs open).
  useEffect(() => {
    const parts = [nowServing ? nowServing.displayNumber : null, servicePoint.name, 'Smart OPD Staff'];
    document.title = parts.filter(Boolean).join(' · ');
  }, [nowServing && nowServing.displayNumber, servicePoint.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    document.title = 'Smart OPD · Staff Dashboard';
  }, []);

  // Screen-reader announcement of live queue changes (Decision 7).
  const previous = useRef(null);
  useEffect(() => {
    if (!data) return;
    const text = describeQueueChange(previous.current, data);
    previous.current = data;
    if (text) setAnnouncement(text);
  }, [data]);

  /**
   * Run one queue operation: show progress, report the outcome as a toast and re-fetch the queue.
   * The busy flag stays set until the fresh queue arrives so buttons never act on stale state.
   */
  const run = useCallback(
    async (key, fn, { success, errorPrefix } = {}) => {
      setBusy(key);
      let result;
      try {
        result = await fn();
        const message = typeof success === 'function' ? success(result) : success;
        if (message && typeof message === 'object') toast[message.type || 'success'](message.text);
        else if (message) toast.success(message);
      } catch (e) {
        toast.error(errorPrefix ? `${errorPrefix}: ${e.message}` : e.message);
        result = undefined;
      } finally {
        await refresh();
        setBusy(null);
      }
      return result;
    },
    [refresh, toast],
  );

  // FR-12: call next (409 when a CALLED / IN_SERVICE token is still open here).
  const callNext = () =>
    run('call-next', () => api.callNext(servicePointId), {
      errorPrefix: 'Cannot call next',
      success: (res) =>
        res && res.token
          ? `Called ${res.token.displayNumber}${res.token.patientName ? ` — ${res.token.patientName}` : ''}`
          : { type: 'info', text: 'No patients are waiting.' },
    });

  const start = async (t) => {
    const res = await run('start', () => api.start(t.id), {
      success: `${servicePoint.type === 'OPD' ? 'Consultation' : 'Service'} started for ${t.displayNumber}.`,
    });
    if (res !== undefined) setStartedAt((m) => ({ ...m, [t.id]: new Date() }));
  };

  const complete = (t) => run('complete', () => api.complete(t.id), { success: `${t.displayNumber} completed.` });

  const skip = async (t) => {
    await run('skip', () => api.skip(t.id), {
      success: `${t.displayNumber} skipped. You can recall it from the Skipped tab.`,
    });
    setDialog(null);
  };

  const recall = (t) =>
    run(`recall:${t.id}`, () => api.recall(t.id), {
      errorPrefix: `Cannot recall ${t.displayNumber}`,
      success: `${t.displayNumber} recalled — the patient has been called again.`,
    });

  // Modals perform their own request; on success they hand back the result here.
  const closeDialog = () => setDialog(null);

  const onTransferred = (result, target) => {
    setDialog(null);
    const from = (result && result.from) || dialog?.token;
    const to = result && result.to;
    toast.success(
      `${from ? from.displayNumber : 'Token'} transferred to ${target.name}${to ? ` as ${to.displayNumber}` : ''}.`,
    );
    refresh();
  };

  const onPrioritySet = (updated) => {
    const original = dialog?.token;
    setDialog(null);
    const level = PRIORITY_LEVELS.find((p) => p.level === Number(updated && updated.priorityLevel));
    toast.success(
      `Priority for ${(updated && updated.displayNumber) || original?.displayNumber} set to ${
        level ? level.label.toLowerCase() : updated?.priorityLevel
      }.`,
    );
    refresh();
  };

  const onLinkedIssued = (issued, type) => {
    setDialog(null);
    const where = issued && issued.servicePoint && issued.servicePoint.name;
    toast.success(
      `${issued && issued.displayNumber ? issued.displayNumber : `${type} token`} issued${where ? ` at ${where}` : ''}.`,
    );
    refresh();
  };

  // Keyboard shortcuts (documented in ShortcutHelp and the README). The latest state is read through a
  // ref so the listener is registered once.
  const latest = useRef({});
  latest.current = {
    data,
    nowServing,
    waiting,
    skipped,
    busy,
    dialog,
    linkedAllowed,
    canOperate,
    type: servicePoint.type,
    callNext,
    start,
    complete,
    recall,
  };
  useEffect(() => {
    function onKeyDown(e) {
      const s = latest.current;
      const action = shortcutAction(e, { dialogOpen: Boolean(s.dialog) });
      if (!action) return;
      if (action === 'help') {
        e.preventDefault();
        setDialog({ kind: 'help' });
        return;
      }
      if (action === 'tab-waiting' || action === 'tab-skipped') {
        e.preventDefault();
        setTab(action === 'tab-waiting' ? 'waiting' : 'skipped');
        return;
      }
      if (!s.data) return;
      const model = stageActions({
        token: s.nowServing,
        waitingCount: s.waiting.length,
        skipped: s.skipped,
        busy: s.busy,
        canIssueLinked: s.linkedAllowed,
        servicePointType: s.type,
        canOperate: s.canOperate,
      }).find((a) => a.id === action);
      if (!model) return;
      e.preventDefault();
      if (!model.enabled) {
        if (model.reason) toast.info(`${model.label}: ${model.reason}.`);
        return;
      }
      const t = s.nowServing;
      if (action === 'call-next') s.callNext();
      else if (action === 'start') s.start(t);
      else if (action === 'complete') s.complete(t);
      else if (action === 'skip') setDialog({ kind: 'skip', token: t });
      else if (action === 'transfer') setDialog({ kind: 'transfer', token: t });
      else if (action === 'linked') setDialog({ kind: 'linked', token: t });
      else if (action === 'recall' && model.target) s.recall(model.target);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toast]);

  const forbidden = error && error.status === 403;

  return (
    <div className="app-shell">
      <AppHeader servicePoint={servicePoint.name ? servicePoint : null} />
      <main id="main" className="page page--console" aria-busy={loading && !data ? 'true' : undefined}>
        <div className="page-header queue-toolbar">
          <div className="queue-heading">
            <h1 className="page-title">My queue</h1>
            <p className="page-subtitle">
              {[servicePoint.name, doctorName, servicePointTypeLabel(servicePoint.type), servicePoint.branchName]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="toolbar-right">
            <ConnectionStatus status={connection} />
            {lastUpdated && (
              <span className="toolbar-updated" aria-live="off">
                Updated {formatInstantClock(lastUpdated)}
              </span>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--touch"
              onClick={() => setDialog({ kind: 'help' })}
              aria-label="Show keyboard shortcuts"
              aria-keyshortcuts="?"
            >
              <Icon name="keyboard" />
              <span className="hide-sm">Shortcuts</span>
            </button>
            <Link to="/display" className="btn btn--ghost btn--touch" aria-label="Open the waiting-room display board">
              <Icon name="tv" />
              <span className="hide-sm">Display board</span>
            </Link>
            <button
              type="button"
              className="btn btn--secondary btn--touch"
              onClick={() => refresh()}
              disabled={Boolean(busy)}
              aria-label="Refresh queue now"
            >
              <Icon name="refresh" />
              <span className="hide-sm">Refresh</span>
            </button>
          </div>
        </div>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>

        {forbidden ? (
          <NotAssignedNotice />
        ) : !data ? (
          error ? (
            <div className="card notice-card notice-card--error" role="alert">
              <span className="empty-state-icon empty-state-icon--danger" aria-hidden="true">
                <Icon name="alert" />
              </span>
              <h2 className="card-title">Could not load the queue</h2>
              <p>{error.message}</p>
              <button type="button" className="btn btn--primary" onClick={() => refresh()}>
                Try again
              </button>
            </div>
          ) : (
            <QueueSkeleton />
          )
        ) : (
          <>
            {error && (
              <div className="banner banner--warning" role="alert">
                <Icon name="alert" />
                <span className="banner-text">
                  Could not refresh the queue ({error.message}). Showing the last known state.
                </span>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => refresh()}>
                  Retry
                </button>
              </div>
            )}

            <div className="console">
              <div className="console-queue">
                <QueuePanel
                  tab={tab}
                  onTabChange={setTab}
                  waiting={waiting}
                  skipped={skipped}
                  busy={busy}
                  now={now}
                  hasOpenToken={Boolean(nowServing)}
                  onPriority={(t, level) => setDialog({ kind: 'priority', token: t, level })}
                  onTransfer={(t) => setDialog({ kind: 'transfer', token: t })}
                  onRecall={recall}
                  canOperate={canOperate}
                />
              </div>
              <div className="console-stage">
                <NowServingCard
                  token={nowServing}
                  canIssueLinked={linkedAllowed}
                  servicePointType={servicePoint.type}
                  roomName={servicePoint.name}
                  waitingCount={waiting.length}
                  skipped={skipped}
                  busy={busy}
                  avgConsultMinutes={summary ? summary.avgConsultMinutes : null}
                  startedAt={nowServing ? startedAt[nowServing.id] || null : null}
                  canOperate={canOperate}
                  onCallNext={callNext}
                  onStart={() => start(nowServing)}
                  onComplete={() => complete(nowServing)}
                  onSkip={() => setDialog({ kind: 'skip', token: nowServing })}
                  onTransfer={() => setDialog({ kind: 'transfer', token: nowServing })}
                  onIssueLinked={() => setDialog({ kind: 'linked', token: nowServing })}
                  onRecall={recall}
                />
                <SummaryTiles summary={summary} servicePointType={servicePoint.type} />
                <RecentlyCompletedList
                  tokens={recentlyCompleted}
                  servicePointType={servicePoint.type}
                  busy={busy}
                  canIssueLinked={linkedAllowed}
                  onIssueLinked={(t) => setDialog({ kind: 'linked', token: t })}
                />
              </div>
            </div>
          </>
        )}
      </main>

      {dialog && dialog.kind === 'skip' && (
        <ConfirmDialog
          title={`Skip ${dialog.token.displayNumber}?`}
          message={`Mark ${dialog.token.patientName || 'this patient'} as absent. The token moves to the Skipped tab and can be recalled later if the patient arrives.`}
          confirmLabel="Skip patient"
          tone="danger"
          busy={busy === 'skip'}
          onConfirm={() => skip(dialog.token)}
          onCancel={closeDialog}
        />
      )}
      {dialog && dialog.kind === 'transfer' && (
        <TransferModal
          token={dialog.token}
          servicePointId={servicePointId}
          onClose={closeDialog}
          onDone={onTransferred}
        />
      )}
      {dialog && dialog.kind === 'priority' && (
        <PriorityModal token={dialog.token} initialLevel={dialog.level} onClose={closeDialog} onDone={onPrioritySet} />
      )}
      {dialog && dialog.kind === 'linked' && linkedAllowed && (
        <LinkedTokenModal
          token={dialog.token}
          servicePointId={servicePointId}
          onClose={closeDialog}
          onDone={onLinkedIssued}
        />
      )}
      {dialog && dialog.kind === 'help' && <ShortcutHelp onClose={closeDialog} />}
    </div>
  );
}
