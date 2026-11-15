// Static rendering checks for the queue components (no DOM needed).
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NowServingCard from '../components/NowServingCard.jsx';
import WaitingList from '../components/WaitingList.jsx';
import SkippedList from '../components/SkippedList.jsx';
import SummaryTiles from '../components/SummaryTiles.jsx';
import RecentlyCompletedList from '../components/RecentlyCompletedList.jsx';
import QueuePanel from '../components/QueuePanel.jsx';
import { REASON_MAX_LENGTH } from '../components/PriorityModal.jsx';

const noop = () => {};
const handlers = {
  onCallNext: noop,
  onStart: noop,
  onComplete: noop,
  onSkip: noop,
  onTransfer: noop,
  onIssueLinked: noop,
};

const calledToken = {
  id: 42,
  tokenNumber: 7,
  displayNumber: 'OPD-007',
  status: 'CALLED',
  priorityLevel: 2,
  priorityCategory: 'NONE',
  patientName: 'Ali Khan',
  issuedAt: '2026-10-29T09:12:00',
  calledAt: '2026-10-29T09:40:00',
  visitId: 17,
  doctorId: 2,
  estimateMinutes: null,
  fromAppointment: false,
};

const render = (el) => renderToStaticMarkup(el);

/** Find the <button> carrying `aria-label="<label>"` and report whether it is disabled. */
function isDisabled(html, label) {
  const buttons = html.match(/<button[^>]*>/g) || [];
  const tag = buttons.find((b) => b.includes(`aria-label="${label}"`));
  if (!tag) throw new Error(`No button labelled "${label}"`);
  return tag.includes('disabled=""');
}

/** Same for a <select> labelled `label`. */
function isSelectDisabled(html, label) {
  const selects = html.match(/<select[^>]*>/g) || [];
  const tag = selects.find((b) => b.includes(`aria-label="${label}"`));
  if (!tag) throw new Error(`No select labelled "${label}"`);
  return tag.includes('disabled=""');
}

describe('NowServingCard', () => {
  it('enables "Call next" when nothing is open', () => {
    const html = render(<NowServingCard token={null} servicePointType="OPD" waitingCount={3} busy={null} {...handlers} />);
    expect(html).toContain('No patient is being served');
    expect(html).toContain('3 waiting');
    expect(isDisabled(html, 'Call next patient')).toBe(false);
  });

  it('disables "Call next" while a token is open and shows the emergency styling', () => {
    const html = render(
      <NowServingCard token={calledToken} canIssueLinked waitingCount={2} busy={null} {...handlers} />,
    );
    expect(isDisabled(html, 'Call next patient')).toBe(true);
    expect(html).toContain('serving--emergency');
    expect(html).toContain('OPD-007');
    expect(html).toContain('Ali Khan');
    expect(html).toContain('Emergency');
    expect(html).toContain('>Start service<');
    expect(isDisabled(html, 'Start consultation for OPD-007')).toBe(false);
    expect(html).toContain('Issue linked token');
    // The disabled Call next says why (NFR-03).
    expect(html).toContain('Complete the current patient first');
  });

  it('shows the stage (CALLED / IN SERVICE), the pace gauge and the obvious next step', () => {
    const now = new Date(2026, 9, 29, 9, 52, 30);
    const called = render(
      <NowServingCard token={calledToken} waitingCount={1} busy={null} avgConsultMinutes={10} now={now} {...handlers} />,
    );
    expect(called).toContain('CALLED');
    expect(called).toMatch(/stage-step is-current[^>]*aria-current="step"/);
    expect(called).toContain('role="meter"');
    expect(called).toContain('since called');
    expect(called).toMatch(/class="action action--start is-next/);

    const inService = render(
      <NowServingCard
        token={{ ...calledToken, status: 'IN_SERVICE' }}
        waitingCount={1}
        busy={null}
        avgConsultMinutes={10}
        startedAt={new Date(now.getTime() - 16 * 60000)}
        now={now}
        {...handlers}
      />,
    );
    expect(inService).toContain('IN SERVICE');
    expect(inService).toContain('since start');
    expect(inService).toContain('pace--critical'); // 16 min against a 10 min average
    expect(inService).toContain('Well over average');
    expect(inService).toMatch(/class="action action--complete is-next/);
    expect(inService).toContain('>Complete consultation<');
  });

  it('explains every disabled action when the room is empty', () => {
    const html = render(
      <NowServingCard token={null} canIssueLinked waitingCount={0} skipped={[]} busy={null} {...handlers} />,
    );
    expect(html).toContain('No patients are waiting right now');
    expect(html).toContain('Call a patient first');
    expect(html).toContain('No skipped patients');
    expect(html).toContain('No patient in the room');
    expect(html).toMatch(/aria-describedby="stage-why-start"/);
  });

  it('recalls the most recently skipped token from the action bar', () => {
    const skipped = [
      { ...calledToken, id: 5, displayNumber: 'OPD-002', status: 'SKIPPED', calledAt: '2026-10-29T09:10:00' },
      { ...calledToken, id: 6, displayNumber: 'OPD-004', status: 'SKIPPED', calledAt: '2026-10-29T09:30:00' },
    ];
    const html = render(<NowServingCard token={null} waitingCount={0} skipped={skipped} busy={null} {...handlers} />);
    expect(isDisabled(html, 'Recall OPD-004')).toBe(false);
    const open = render(<NowServingCard token={calledToken} waitingCount={0} skipped={skipped} busy={null} {...handlers} />);
    expect(isDisabled(open, 'Recall OPD-004')).toBe(true);
  });

  it('uses counter wording at laboratory / pharmacy points', () => {
    const html = render(
      <NowServingCard token={{ ...calledToken, status: 'IN_SERVICE' }} servicePointType="LAB" waitingCount={0} busy={null} {...handlers} />,
    );
    expect(html).toContain('>Complete service<');
    expect(html).not.toContain('Complete consultation');
  });

  it('hides "Issue linked token" unless a doctor works in an OPD room (FR-04)', () => {
    const html = render(
      <NowServingCard token={calledToken} canIssueLinked={false} waitingCount={0} busy={null} {...handlers} />,
    );
    expect(html).not.toContain('Issue linked token');
  });

  it('allows Complete but not Skip / Transfer once the consultation has started', () => {
    const html = render(
      <NowServingCard
        token={{ ...calledToken, status: 'IN_SERVICE' }}
        servicePointType="OPD"
        waitingCount={0}
        busy={null}
        {...handlers}
      />,
    );
    expect(html).not.toContain('>Start<');
    expect(isDisabled(html, 'Mark OPD-007 as completed')).toBe(false);
    expect(isDisabled(html, 'Skip OPD-007 (patient did not respond)')).toBe(true);
    expect(isDisabled(html, 'Transfer OPD-007 to another doctor or service point')).toBe(true);
  });

  it('disables every action while a request is in progress', () => {
    const html = render(
      <NowServingCard token={calledToken} servicePointType="OPD" waitingCount={0} busy="start" {...handlers} />,
    );
    expect(html).toContain('Starting…');
    expect(isDisabled(html, 'Mark OPD-007 as completed')).toBe(true);
    expect(isDisabled(html, 'Skip OPD-007 (patient did not respond)')).toBe(true);
  });

  it('offers no Priority action for CALLED / IN_SERVICE tokens (backend allows WAITING or SKIPPED only)', () => {
    for (const status of ['CALLED', 'IN_SERVICE']) {
      const html = render(
        <NowServingCard token={{ ...calledToken, status }} servicePointType="OPD" waitingCount={0} busy={null} {...handlers} />,
      );
      expect(html).not.toContain('Change priority of OPD-007');
      expect(html).not.toContain('>Priority<');
    }
  });
});

describe('PriorityModal', () => {
  it('limits the reason to the backend maximum (200 characters)', () => {
    expect(REASON_MAX_LENGTH).toBe(200);
  });
});

describe('WaitingList', () => {
  it('keeps the backend order and highlights priority tokens', () => {
    const tokens = [
      { ...calledToken, id: 1, displayNumber: 'OPD-009', status: 'WAITING', priorityLevel: 2, patientName: 'Emergency Pt' },
      {
        ...calledToken,
        id: 2,
        displayNumber: 'OPD-003',
        status: 'WAITING',
        priorityLevel: 1,
        priorityCategory: 'ELDERLY',
        patientName: 'Elder Pt',
      },
      { ...calledToken, id: 3, displayNumber: 'OPD-001', status: 'WAITING', priorityLevel: 0, patientName: 'Normal Pt' },
    ];
    const html = render(<WaitingList tokens={tokens} busy={null} onPriority={noop} onTransfer={noop} />);
    const order = ['OPD-009', 'OPD-003', 'OPD-001'].map((n) => html.indexOf(n));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    expect(html).toContain('token-row--emergency');
    expect(html).toContain('token-row--priority');
    expect(html).toContain('Elderly');
    expect(isDisabled(html, 'Transfer OPD-001')).toBe(false);
  });

  it('labels every row with the queue badge (EMERGENCY / ELDERLY / APPOINTMENT / NORMAL)', () => {
    const tokens = [
      { ...calledToken, id: 1, displayNumber: 'OPD-009', status: 'WAITING', priorityLevel: 2 },
      { ...calledToken, id: 2, displayNumber: 'OPD-003', status: 'WAITING', priorityLevel: 1, priorityCategory: 'DIFFERENTLY_ABLED' },
      { ...calledToken, id: 3, displayNumber: 'OPD-005', status: 'WAITING', priorityLevel: 0, fromAppointment: true },
      { ...calledToken, id: 4, displayNumber: 'OPD-001', status: 'WAITING', priorityLevel: 0 },
    ];
    const html = render(<WaitingList tokens={tokens} busy={null} onPriority={noop} onTransfer={noop} />);
    expect(html).toMatch(/badge badge--emergency[^"]*" [^>]*data-kind="EMERGENCY"/);
    expect(html).toContain('data-kind="DIFFERENTLY_ABLED"');
    expect(html).toContain('Differently-abled');
    expect(html).toContain('badge badge--appointment');
    expect(html).toContain('token-row--appointment');
    expect(html).toContain('badge badge--normal');
    expect(html).toContain('>Normal<');
  });

  it('offers a quick priority-escalation selector on each operable row', () => {
    const tokens = [
      { ...calledToken, id: 3, displayNumber: 'OPD-001', status: 'WAITING', priorityLevel: 0, doctorId: 2 },
      { ...calledToken, id: 4, displayNumber: 'OPD-002', status: 'WAITING', priorityLevel: 1, doctorId: 9 },
    ];
    const html = render(
      <WaitingList tokens={tokens} busy={null} onPriority={noop} onTransfer={noop} canOperate={(t) => t.doctorId === 2} />,
    );
    expect(isSelectDisabled(html, 'Set priority of OPD-001')).toBe(false);
    expect(isSelectDisabled(html, 'Set priority of OPD-002')).toBe(true);
    expect(html).toContain('Another doctor’s patient');
    expect(html).toContain('>Emergency</option>');
    const busy = render(<WaitingList tokens={tokens} busy="call-next" onPriority={noop} onTransfer={noop} />);
    expect(isSelectDisabled(busy, 'Set priority of OPD-001')).toBe(true);
  });

  it('shows an empty state', () => {
    expect(render(<WaitingList tokens={[]} busy={null} onPriority={noop} onTransfer={noop} />)).toContain(
      'No patients are waiting.',
    );
  });
});

describe('SkippedList', () => {
  it('disables Recall while another token is open', () => {
    const tokens = [{ ...calledToken, status: 'SKIPPED', priorityLevel: 0 }];
    const html = render(<SkippedList tokens={tokens} busy={null} hasOpenToken onRecall={noop} />);
    expect(isDisabled(html, 'Recall OPD-007')).toBe(true);
    const free = render(<SkippedList tokens={tokens} busy={null} hasOpenToken={false} onRecall={noop} />);
    expect(isDisabled(free, 'Recall OPD-007')).toBe(false);
  });

  it('offers Priority for skipped tokens, disabled only while a request is in progress', () => {
    const tokens = [{ ...calledToken, status: 'SKIPPED', priorityLevel: 0 }];
    const html = render(<SkippedList tokens={tokens} busy={null} hasOpenToken onRecall={noop} onPriority={noop} />);
    expect(isDisabled(html, 'Change priority of OPD-007')).toBe(false);
    const busy = render(<SkippedList tokens={tokens} busy="call-next" hasOpenToken={false} onRecall={noop} onPriority={noop} />);
    expect(isDisabled(busy, 'Change priority of OPD-007')).toBe(true);
  });
});

describe('SummaryTiles', () => {
  it('renders the summary values from the queue response', () => {
    const html = render(
      <SummaryTiles
        summary={{ completedToday: 12, skippedToday: 1, waiting: 4, avgWaitMinutes: 23.6, avgConsultMinutes: 9 }}
      />,
    );
    expect(html).toContain('>12<');
    expect(html).toContain('24 min');
    expect(html).toContain('9 min');
  });
});

describe('RecentlyCompletedList (FR-04 linked tokens after the consultation)', () => {
  const completed = [
    { ...calledToken, id: 51, displayNumber: 'OPD-011', status: 'COMPLETED', priorityLevel: 0, patientName: 'Latest Pt', completedAt: '2026-10-29T10:05:00' },
    { ...calledToken, id: 50, displayNumber: 'OPD-010', status: 'COMPLETED', priorityLevel: 1, priorityCategory: 'ELDERLY', patientName: 'Earlier Pt', completedAt: '2026-10-29T09:50:00' },
  ];

  it('lists the completed tokens newest first with completion time and an "Issue linked token" action', () => {
    const html = render(<RecentlyCompletedList tokens={completed} busy={null} canIssueLinked onIssueLinked={noop} />);
    expect(html).toContain('Recently completed');
    expect(html.indexOf('OPD-011')).toBeLessThan(html.indexOf('OPD-010'));
    expect(html).toContain('Completed 10:05');
    expect(html).toContain('Elderly');
    expect(isDisabled(html, 'Issue a linked laboratory or pharmacy token for OPD-011')).toBe(false);
    expect(isDisabled(html, 'Issue a linked laboratory or pharmacy token for OPD-010')).toBe(false);
  });

  it('hides the action outside OPD rooms and disables it while busy or without a visit', () => {
    const lab = render(<RecentlyCompletedList tokens={completed} busy={null} canIssueLinked={false} onIssueLinked={noop} />);
    expect(lab).toContain('OPD-011');
    expect(lab).not.toContain('Issue linked token');

    const busy = render(<RecentlyCompletedList tokens={completed} busy="call-next" canIssueLinked onIssueLinked={noop} />);
    expect(isDisabled(busy, 'Issue a linked laboratory or pharmacy token for OPD-011')).toBe(true);

    const noVisit = render(
      <RecentlyCompletedList tokens={[{ ...completed[0], visitId: null }]} busy={null} canIssueLinked onIssueLinked={noop} />,
    );
    expect(isDisabled(noVisit, 'Issue a linked laboratory or pharmacy token for OPD-011')).toBe(true);
  });

  it('shows an empty state and tolerates a missing list (older backends)', () => {
    expect(render(<RecentlyCompletedList tokens={undefined} busy={null} canIssueLinked onIssueLinked={noop} />)).toContain(
      'No consultations completed yet today.',
    );
  });
});

describe('Service-point type wording (LAB / PHARMACY counters)', () => {
  it('labels the average as service time at counters and shows "< 1 min" for very short averages', () => {
    const html = render(
      <SummaryTiles
        servicePointType="LAB"
        summary={{ completedToday: 1, skippedToday: 0, waiting: 1, avgWaitMinutes: 2, avgConsultMinutes: 0.3 }}
      />,
    );
    expect(html).toContain('Avg. service');
    expect(html).not.toContain('Avg. consult');
    expect(html).toContain('&lt; 1 min');
    expect(render(<SummaryTiles servicePointType="OPD" summary={{ avgConsultMinutes: null }} />)).toContain('Avg. consult');
  });

  it('uses counter wording in the empty Recently completed list', () => {
    const lab = render(<RecentlyCompletedList tokens={[]} servicePointType="PHARMACY" busy={null} onIssueLinked={noop} />);
    expect(lab).toContain('No patients completed here yet today.');
    expect(lab).not.toContain('consultations');
  });
});

describe('QueuePanel (tabs "Waiting queue" / "Skipped (recallable)")', () => {
  const waiting = [
    { ...calledToken, id: 1, displayNumber: 'OPD-010', status: 'WAITING', priorityLevel: 0 },
    { ...calledToken, id: 2, displayNumber: 'OPD-011', status: 'WAITING', priorityLevel: 0 },
  ];
  const skipped = [{ ...calledToken, id: 3, displayNumber: 'OPD-003', status: 'SKIPPED', priorityLevel: 0 }];
  const props = { waiting, skipped, busy: null, onTabChange: noop, onPriority: noop, onTransfer: noop, onRecall: noop };

  it('shows both tabs with counts and the selected list', () => {
    const html = render(<QueuePanel tab="waiting" hasOpenToken={false} {...props} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Waiting queue');
    expect(html).toContain('Skipped (recallable)');
    expect(html).toContain('aria-label="2 patients waiting"');
    expect(html).toContain('aria-label="1 skipped tokens"');
    expect(html).toMatch(/id="queue-tab-waiting"[^>]*aria-selected="true"/);
    expect(html).toContain('OPD-010');
    expect(html).not.toContain('OPD-003');
  });

  it('switches to the skipped list with Recall', () => {
    const html = render(<QueuePanel tab="skipped" hasOpenToken={false} {...props} />);
    expect(html).toMatch(/id="queue-tab-skipped"[^>]*aria-selected="true"/);
    expect(html).toContain('OPD-003');
    expect(isDisabled(html, 'Recall OPD-003')).toBe(false);
    const open = render(<QueuePanel tab="skipped" hasOpenToken {...props} />);
    expect(isDisabled(open, 'Recall OPD-003')).toBe(true);
    expect(open).toContain('Complete the current patient first');
  });
});
