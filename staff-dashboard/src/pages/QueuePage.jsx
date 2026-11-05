// "My Queue" — the single-screen staff view (Section 4.12, Table 4.19): now serving with one-click
// actions, call next, waiting list (priority highlighted), skipped list with recall, recently completed
// consultations (linked tokens after the consultation) and today's summary.
// FR-04 linked tokens, FR-05 live updates, FR-12 queue operations, FR-13 priority handling.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AppHeader from '../components/AppHeader.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import ConnectionStatus from '../components/ConnectionStatus.jsx';
import LinkedTokenModal from '../components/LinkedTokenModal.jsx';
import NowServingCard from '../components/NowServingCard.jsx';
import PriorityModal from '../components/PriorityModal.jsx';
import RecentlyCompletedList from '../components/RecentlyCompletedList.jsx';
import SkippedList from '../components/SkippedList.jsx';
import Spinner from '../components/Spinner.jsx';
import SummaryTiles from '../components/SummaryTiles.jsx';
import TransferModal from '../components/TransferModal.jsx';
import WaitingList from '../components/WaitingList.jsx';
import { useToast } from '../components/Toast.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useServicePoints } from '../auth/ServicePointsContext.jsx';
import { useNow } from '../hooks/useNow.js';
import { useQueue } from '../hooks/useQueue.js';
import { api } from '../api.js';
import { PRIORITY_LEVELS, formatInstantClock, servicePointTypeLabel } from '../utils/format.js';
import { canIssueLinkedTokens } from '../utils/servicePoints.js';

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
        <main className="page page--narrow">
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
  const [dialog, setDialog] = useState(null); // { kind: 'skip'|'transfer'|'priority'|'linked', token }

  const servicePoint = {
    id: servicePointId,
    ...(pointInfo || {}),
    ...((data && data.servicePoint) || {}),
  };
  const nowServing = (data && data.nowServing) || null;
  const waiting = (data && Array.isArray(data.waiting) && data.waiting) || [];
  const skipped = (data && Array.isArray(data.skipped) && data.skipped) || [];
  const recentlyCompleted = (data && Array.isArray(data.recentlyCompleted) && data.recentlyCompleted) || [];
  const linkedAllowed = canIssueLinkedTokens(servicePoint.type, user);
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

  const start = (t) =>
    run('start', () => api.start(t.id), { success: `Consultation started for ${t.displayNumber}.` });

  const complete = (t) => run('complete', () => api.complete(t.id), { success: `${t.displayNumber} completed.` });

  const skip = async (t) => {
    await run('skip', () => api.skip(t.id), {
      success: `${t.displayNumber} skipped. You can recall it from the Skipped list.`,
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

  const forbidden = error && error.status === 403;

  return (
    <div className="app-shell">
      <AppHeader servicePoint={servicePoint.name ? servicePoint : null} />
      <main className="page" aria-busy={loading && !data ? 'true' : undefined}>
        <div className="queue-toolbar">
          <div className="queue-heading">
            <h1 className="page-title">My queue</h1>
            <p className="muted">
              {[servicePoint.name, doctorName, servicePointTypeLabel(servicePoint.type), servicePoint.branchName]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="toolbar-right">
            <ConnectionStatus status={connection} />
            {lastUpdated && (
              <span className="muted small" aria-live="off">
                Updated {formatInstantClock(lastUpdated)}
              </span>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => refresh()}
              disabled={Boolean(busy)}
              aria-label="Refresh queue now"
            >
              Refresh
            </button>
          </div>
        </div>

        {forbidden ? (
          <NotAssignedNotice />
        ) : !data ? (
          error ? (
            <div className="card notice-card notice-card--error" role="alert">
              <h2 className="section-title">Could not load the queue</h2>
              <p>{error.message}</p>
              <button type="button" className="btn btn--primary" onClick={() => refresh()}>
                Try again
              </button>
            </div>
          ) : (
            <Spinner label="Loading queue…" />
          )
        ) : (
          <>
            {error && (
              <div className="banner banner--warning" role="alert">
                <span>
                  Could not refresh the queue ({error.message}). Showing the last known state.
                </span>
                <button type="button" className="btn btn--outline btn--sm" onClick={() => refresh()}>
                  Retry
                </button>
              </div>
            )}

            <div className="queue-layout">
              <div className="queue-main">
                <NowServingCard
                  token={nowServing}
                  canIssueLinked={linkedAllowed}
                  waitingCount={waiting.length}
                  busy={busy}
                  now={now}
                  onCallNext={callNext}
                  onStart={() => start(nowServing)}
                  onComplete={() => complete(nowServing)}
                  onSkip={() => setDialog({ kind: 'skip', token: nowServing })}
                  onTransfer={() => setDialog({ kind: 'transfer', token: nowServing })}
                  onIssueLinked={() => setDialog({ kind: 'linked', token: nowServing })}
                />
                <WaitingList
                  tokens={waiting}
                  busy={busy}
                  now={now}
                  onPriority={(t) => setDialog({ kind: 'priority', token: t })}
                  onTransfer={(t) => setDialog({ kind: 'transfer', token: t })}
                />
              </div>
              <aside className="queue-side" aria-label="Summary and skipped tokens">
                <SummaryTiles summary={summary} servicePointType={servicePoint.type} />
                <SkippedList
                  tokens={skipped}
                  busy={busy}
                  hasOpenToken={Boolean(nowServing)}
                  onRecall={recall}
                  onPriority={(t) => setDialog({ kind: 'priority', token: t })}
                />
                <RecentlyCompletedList
                  tokens={recentlyCompleted}
                  servicePointType={servicePoint.type}
                  busy={busy}
                  canIssueLinked={linkedAllowed}
                  onIssueLinked={(t) => setDialog({ kind: 'linked', token: t })}
                />
              </aside>
            </div>
          </>
        )}
      </main>

      {dialog && dialog.kind === 'skip' && (
        <ConfirmDialog
          title={`Skip ${dialog.token.displayNumber}?`}
          message={`Mark ${dialog.token.patientName || 'this patient'} as missed. The token moves to the Skipped list and can be recalled later if the patient arrives.`}
          confirmLabel="Skip patient"
          tone="warning"
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
        <PriorityModal token={dialog.token} onClose={closeDialog} onDone={onPrioritySet} />
      )}
      {dialog && dialog.kind === 'linked' && linkedAllowed && (
        <LinkedTokenModal
          token={dialog.token}
          servicePointId={servicePointId}
          onClose={closeDialog}
          onDone={onLinkedIssued}
        />
      )}
    </div>
  );
}
