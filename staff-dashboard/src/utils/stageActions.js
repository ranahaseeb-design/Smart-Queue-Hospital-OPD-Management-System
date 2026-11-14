// Pure model of the consultation-stage action bar: which actions are available for the token in the
// room and, when one is not, a short reason shown on the button (NFR-03: disabled states explain why).
// Follows the token lifecycle of the contract (FR-12): call-next 409s while a CALLED / IN_SERVICE token is
// open; start CALLED -> IN_SERVICE; skip CALLED -> SKIPPED; recall SKIPPED -> CALLED (409 if a token is
// open); transfer WAITING / CALLED; complete CALLED / IN_SERVICE; linked tokens need the token's visit.
import { parseLocalDateTime } from './format.js';

/** Keyboard shortcut per action (documented in the README and the in-app shortcut list). */
export const ACTION_KEYS = {
  'call-next': 'N',
  start: 'S',
  skip: 'K',
  recall: 'R',
  transfer: 'T',
  linked: 'L',
  complete: 'C',
};

/**
 * The skipped token the action-bar "Recall" brings back: the most recently called one that this user may
 * operate. Per-row Recall in the Skipped tab covers the others.
 */
export function recallCandidate(skipped, canOperate = () => true) {
  const list = (Array.isArray(skipped) ? skipped : []).filter((t) => canOperate(t));
  if (list.length === 0) return null;
  const time = (t) => {
    const d = parseLocalDateTime(t.calledAt);
    return d ? d.getTime() : 0;
  };
  return list.reduce((best, t) => (time(t) > time(best) ? t : best), list[0]);
}

/**
 * @param {{ token: object|null, waitingCount: number, skipped: object[], busy: string|null,
 *           canIssueLinked: boolean, servicePointType?: string, canOperate?: (t: object) => boolean }} s
 * @returns {Array<{ id: string, label: string, enabled: boolean, reason: string|null, next: boolean,
 *                   target?: object|null }>} in display order; `next` marks the obvious next step
 */
export function stageActions({
  token,
  waitingCount = 0,
  skipped = [],
  busy = null,
  canIssueLinked = false,
  servicePointType = 'OPD',
  canOperate = () => true,
}) {
  const isOpd = servicePointType === 'OPD';
  const status = token ? token.status : null;
  const called = status === 'CALLED';
  const inService = status === 'IN_SERVICE';
  const operable = !token || canOperate(token);
  const otherDoctor = token && !operable ? 'Another doctor’s patient' : null;
  const anyBusy = Boolean(busy);
  const recallTarget = recallCandidate(skipped, canOperate);

  // While a request runs every button is disabled; the spinner on the active one explains it.
  const gate = (ok, reason) => ({ enabled: !anyBusy && ok, reason: anyBusy || ok ? null : reason });

  const actions = [];

  actions.push({
    id: 'call-next',
    label: 'Call next',
    ...gate(!token, 'Complete the current patient first'),
    hint: !token && waitingCount === 0 ? 'No patients are waiting right now' : null,
    next: !token && waitingCount > 0,
  });

  actions.push({
    id: 'start',
    label: 'Start service',
    ...gate(called && operable, !token ? 'Call a patient first' : otherDoctor || 'Already in service'),
    next: called && operable,
  });

  actions.push({
    id: 'skip',
    label: 'Skip (absent)',
    ...gate(
      called && operable,
      !token ? 'Call a patient first' : otherDoctor || `${isOpd ? 'Consultation' : 'Service'} already started`,
    ),
    next: false,
  });

  actions.push({
    id: 'recall',
    label: recallTarget ? `Recall ${recallTarget.displayNumber}` : 'Recall',
    ...gate(!token && Boolean(recallTarget), token ? 'Complete the current patient first' : 'No skipped patients'),
    next: false,
    target: recallTarget,
  });

  actions.push({
    id: 'transfer',
    label: 'Transfer',
    ...gate(
      called && operable,
      !token ? 'Call a patient first' : otherDoctor || `Cannot transfer during ${isOpd ? 'the consultation' : 'service'}`,
    ),
    next: false,
  });

  if (canIssueLinked) {
    actions.push({
      id: 'linked',
      label: 'Issue linked token',
      ...gate(
        Boolean(token) && token.visitId != null && operable,
        !token ? 'Call a patient first, or use Recently completed' : otherDoctor || 'Not linked to a visit',
      ),
      next: false,
    });
  }

  actions.push({
    id: 'complete',
    label: isOpd ? 'Complete consultation' : 'Complete service',
    ...gate(Boolean(token) && operable, !token ? 'No patient in the room' : otherDoctor),
    next: inService && operable,
  });

  return actions;
}
