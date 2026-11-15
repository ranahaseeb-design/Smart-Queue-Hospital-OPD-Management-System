// Pure logic behind the staff console: badge mapping, pace gauge, row transitions, live-region
// announcements, action availability and keyboard shortcuts.
import { describe, expect, it } from 'vitest';
import { formatElapsed, paceState, queueBadge, secondsSince } from '../utils/format.js';
import { mergeTransition, settleTransition } from '../hooks/useListTransition.js';
import { describeQueueChange } from '../utils/queueDiff.js';
import { recallCandidate, stageActions } from '../utils/stageActions.js';
import { shortcutAction } from '../utils/shortcuts.js';

describe('queueBadge (Decision 2 badge mapping)', () => {
  it('maps level, category and appointment to the five badges', () => {
    expect(queueBadge({ priorityLevel: 2, priorityCategory: 'ELDERLY', fromAppointment: true })).toMatchObject({
      kind: 'EMERGENCY',
      tone: 'emergency',
    });
    expect(queueBadge({ priorityLevel: 1, priorityCategory: 'ELDERLY' })).toMatchObject({ kind: 'ELDERLY', tone: 'elevated' });
    expect(queueBadge({ priorityLevel: 1, priorityCategory: 'DIFFERENTLY_ABLED' })).toMatchObject({
      kind: 'DIFFERENTLY_ABLED',
      label: 'Differently-abled',
    });
    expect(queueBadge({ priorityLevel: 1, priorityCategory: 'NONE' })).toMatchObject({ kind: 'PRIORITY', tone: 'elevated' });
    expect(queueBadge({ priorityLevel: 0, fromAppointment: true })).toMatchObject({ kind: 'APPOINTMENT', tone: 'appointment' });
    expect(queueBadge({ priorityLevel: 0 })).toMatchObject({ kind: 'NORMAL', tone: 'normal', label: 'Normal' });
    expect(queueBadge(null).kind).toBe('NORMAL');
  });
});

describe('pace gauge helpers', () => {
  it('counts seconds since a contract datetime in hospital time', () => {
    const now = new Date(Date.UTC(2026, 9, 29, 5, 7, 32)); // 10:07:32 in Asia/Karachi
    expect(secondsSince('2026-10-29T10:00:00', now, 'Asia/Karachi')).toBe(452);
    expect(secondsSince('2026-10-29T10:30:00', now, 'Asia/Karachi')).toBe(0);
    expect(secondsSince(null, now)).toBeNull();
  });

  it('formats a stopwatch', () => {
    expect(formatElapsed(452)).toBe('07:32');
    expect(formatElapsed(3725)).toBe('1:02:05');
    expect(formatElapsed(null)).toBe('—');
  });

  it('turns amber at the average and crimson at 1.5x', () => {
    expect(paceState(5 * 60, 10).level).toBe('ok');
    expect(paceState(10 * 60, 10).level).toBe('over');
    expect(paceState(14 * 60, 10).level).toBe('over');
    expect(paceState(15 * 60, 10).level).toBe('critical');
    expect(paceState(15 * 60, null).level).toBe('unknown');
    expect(paceState(15 * 60, 0).level).toBe('unknown');
    expect(paceState(null, 10).level).toBe('unknown');
    expect(paceState(6 * 60, 12).ratio).toBeCloseTo(0.5);
  });
});

describe('row transitions', () => {
  const key = (t) => t.id;
  const rows = (ids) => ids.map((id) => ({ key: String(id), item: { id }, phase: 'idle' }));

  it('marks new rows as entering and keeps removed rows in place while they leave', () => {
    const merged = mergeTransition(rows([1, 2, 3]), [{ id: 1 }, { id: 3 }, { id: 4 }], key);
    expect(merged.map((r) => `${r.key}:${r.phase}`)).toEqual(['1:idle', '2:exit', '3:idle', '4:enter']);
    expect(settleTransition(merged).map((r) => `${r.key}:${r.phase}`)).toEqual(['1:idle', '3:idle', '4:idle']);
  });

  it('puts a removed first row back at the top and takes fresh item data', () => {
    const merged = mergeTransition(rows([1, 2]), [{ id: 2, priorityLevel: 2 }], key);
    expect(merged.map((r) => r.key)).toEqual(['1', '2']);
    expect(merged[0].phase).toBe('exit');
    expect(merged[1].item.priorityLevel).toBe(2);
  });

  it('does not animate under reduced motion', () => {
    const merged = mergeTransition(rows([1, 2]), [{ id: 3 }], key, { animate: false });
    expect(merged).toEqual([{ key: '3', item: { id: 3 }, phase: 'idle' }]);
  });
});

describe('describeQueueChange (aria-live announcements)', () => {
  const t = (id, extra = {}) => ({ id, displayNumber: `OPD-00${id}`, priorityLevel: 0, ...extra });

  it('announces nothing on the first load', () => {
    expect(describeQueueChange(null, { waiting: [t(1)] })).toBe('');
  });

  it('announces calls, joins, departures and priority changes', () => {
    const prev = { nowServing: null, waiting: [t(1), t(2), t(3)] };
    const next = { nowServing: t(1, { status: 'CALLED' }), waiting: [t(3, { priorityLevel: 2 }), t(4)] };
    const text = describeQueueChange(prev, next);
    expect(text).toContain('Now serving OPD-001.');
    expect(text).toContain('OPD-004 joined the queue.');
    expect(text).toContain('OPD-002 left the waiting queue.');
    expect(text).not.toContain('OPD-001 left');
    expect(text).toContain('OPD-003 is now Emergency.');
  });

  it('summarises several new tokens and the start of service', () => {
    const prev = { nowServing: t(1, { status: 'CALLED' }), waiting: [] };
    const next = { nowServing: t(1, { status: 'IN_SERVICE' }), waiting: [t(5), t(6), t(7), t(8)] };
    const text = describeQueueChange(prev, next);
    expect(text).toContain('OPD-001 is in service.');
    expect(text).toContain('4 patients joined the queue: OPD-005, OPD-006, OPD-007 and 1 more.');
  });
});

describe('stageActions (action bar availability with reasons)', () => {
  const called = { id: 42, displayNumber: 'OPD-007', status: 'CALLED', visitId: 17, doctorId: 2 };
  const byId = (list) => Object.fromEntries(list.map((a) => [a.id, a]));

  it('only Call next (and Recall) work in an empty room', () => {
    const a = byId(stageActions({ token: null, waitingCount: 2, skipped: [], canIssueLinked: true }));
    expect(a['call-next']).toMatchObject({ enabled: true, next: true });
    expect(a.start).toMatchObject({ enabled: false, reason: 'Call a patient first' });
    expect(a.complete).toMatchObject({ enabled: false, reason: 'No patient in the room' });
    expect(a.recall).toMatchObject({ enabled: false, reason: 'No skipped patients' });
    expect(a.linked.reason).toMatch(/Recently completed/);
  });

  it('follows the token lifecycle', () => {
    const c = byId(stageActions({ token: called, waitingCount: 2, canIssueLinked: true }));
    expect(c['call-next']).toMatchObject({ enabled: false, reason: 'Complete the current patient first' });
    expect(c.start).toMatchObject({ enabled: true, next: true });
    expect(c.skip.enabled).toBe(true);
    expect(c.transfer.enabled).toBe(true);
    expect(c.linked.enabled).toBe(true);
    expect(c.complete.enabled).toBe(true);

    const s = byId(stageActions({ token: { ...called, status: 'IN_SERVICE' }, canIssueLinked: false }));
    expect(s.start).toMatchObject({ enabled: false, reason: 'Already in service' });
    expect(s.skip).toMatchObject({ enabled: false, reason: 'Consultation already started' });
    expect(s.transfer.enabled).toBe(false);
    expect(s.complete).toMatchObject({ enabled: true, next: true, label: 'Complete visit' });
    expect(s.linked).toBeUndefined();
    expect(s['refer-pharmacy']).toBeUndefined(); // only doctors (canIssueLinked) refer
  });

  it('doctors complete and refer to the pharmacy or lab in one step (OPD only)', () => {
    const c = byId(stageActions({ token: called, canIssueLinked: true }));
    expect(c['refer-pharmacy']).toMatchObject({ enabled: true, label: 'Complete & refer to Pharmacy' });
    expect(c['refer-lab']).toMatchObject({ enabled: true, label: 'Complete & refer to Lab' });
    expect(c.skip.label).toBe('Skip / No-show');
    const none = byId(stageActions({ token: null, canIssueLinked: true }));
    expect(none['refer-pharmacy']).toMatchObject({ enabled: false, reason: 'No patient in the room' });
    const counter = byId(stageActions({ token: called, canIssueLinked: true, servicePointType: 'PHARMACY' }));
    expect(counter['refer-pharmacy']).toBeUndefined();
    expect(counter.complete.label).toBe('Complete service');
  });

  it('disables everything without reasons while a request runs, and guards other doctors’ tokens', () => {
    const busy = stageActions({ token: called, busy: 'start' });
    expect(busy.every((a) => !a.enabled && a.reason === null)).toBe(true);
    const other = byId(stageActions({ token: called, canOperate: () => false }));
    expect(other.start).toMatchObject({ enabled: false, reason: 'Another doctor’s patient' });
    expect(other.complete.enabled).toBe(false);
  });

  it('recalls the most recently called skipped token the user may operate', () => {
    const skipped = [
      { id: 1, displayNumber: 'OPD-001', calledAt: '2026-10-29T09:00:00', doctorId: 2 },
      { id: 2, displayNumber: 'OPD-002', calledAt: '2026-10-29T09:20:00', doctorId: 9 },
      { id: 3, displayNumber: 'OPD-003', calledAt: '2026-10-29T09:10:00', doctorId: 2 },
    ];
    expect(recallCandidate(skipped).id).toBe(2);
    expect(recallCandidate(skipped, (t) => t.doctorId === 2).id).toBe(3);
    expect(recallCandidate([])).toBeNull();
    const a = byId(stageActions({ token: null, skipped }));
    expect(a.recall).toMatchObject({ enabled: true, label: 'Recall OPD-002' });
  });
});

describe('shortcutAction', () => {
  const ev = (key, extra = {}) => ({ key, target: { tagName: 'BODY' }, ...extra });

  it('maps single keys to console actions', () => {
    expect(shortcutAction(ev('n'))).toBe('call-next');
    expect(shortcutAction(ev('N'))).toBe('call-next');
    expect(shortcutAction(ev('c'))).toBe('complete');
    expect(shortcutAction(ev('?', { shiftKey: true }))).toBe('help');
    expect(shortcutAction(ev('2'))).toBe('tab-skipped');
    expect(shortcutAction(ev('z'))).toBeNull();
  });

  it('never fires while typing, with modifiers, on repeat or with a dialog open', () => {
    expect(shortcutAction(ev('n', { target: { tagName: 'INPUT' } }))).toBeNull();
    expect(shortcutAction(ev('n', { target: { tagName: 'TEXTAREA' } }))).toBeNull();
    expect(shortcutAction(ev('n', { target: { tagName: 'SELECT' } }))).toBeNull();
    expect(shortcutAction(ev('n', { target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
    expect(shortcutAction(ev('n', { ctrlKey: true }))).toBeNull();
    expect(shortcutAction(ev('n', { metaKey: true }))).toBeNull();
    expect(shortcutAction(ev('n', { repeat: true }))).toBeNull();
    expect(shortcutAction(ev('n'), { dialogOpen: true })).toBeNull();
    expect(shortcutAction(ev('n', { target: { tagName: 'BUTTON', closest: () => ({}) } }))).toBeNull();
  });
});
