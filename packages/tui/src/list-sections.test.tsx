import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { AlertsSection } from './alerts-section.js';
import { AssignmentsSection } from './assignments-section.js';
import { AuditSection } from './audit-section.js';
import {
  alert,
  assignment,
  auditEvent,
  fakeAlertsApi,
  fakeAssignmentsApi,
  fakeAuditApi,
  fakeInboxApi,
  notification,
  onePage,
} from './fixtures.js';
import { InboxSection, aboutOf } from './inbox-section.js';
import { perform, settle } from './test-helpers.js';
import { TextEntryContext } from './text-entry.js';
import type { ReactNode } from 'react';

async function render(node: ReactNode) {
  const entry = { active: { current: false } };
  const setup = await testRender(
    <TextEntryContext.Provider value={entry}>{node}</TextEntryContext.Provider>,
    { width: 110, height: 30 },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const key = (s: Setup, name: string) => perform(s, () => s.mockInput.pressKey(name));
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};
const down = (s: Setup, n: number) =>
  perform(s, async () => {
    for (let i = 0; i < n; i++) s.mockInput.pressArrow('down');
  });

describe('AuditSection', () => {
  const events = [
    auditEvent(1),
    auditEvent(2, {
      action: 'mission.activate',
      actorId: null,
      before: null,
      after: { status: 'active' },
    }),
  ];

  it('lists the events in a framed table, system actions as "system"', async () => {
    const s = await render(<AuditSection api={fakeAuditApi([onePage(events)])} />);
    const frame = s.captureCharFrame();
    for (const text of [
      'Audit log: 2',
      'TIME (UTC)',
      'ACTION',
      'ENTITY',
      'ACTOR',
      '2026-10-03 14:07:01',
      'mission.approve',
      'mission:0199aaaa',
      'system',
      '┌',
      '└',
    ]) {
      expect(frame).toContain(text);
    }
    s.renderer.destroy();
  });

  it('opens an event with who did it and what it changed', async () => {
    const s = await render(<AuditSection api={fakeAuditApi([onePage(events)])} />);
    await enter(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ mission.approve');
    for (const text of ['Entity', 'mission 0199aaaa', 'Before', '"status": "pending_approval"']) {
      expect(frame).toContain(text);
    }
    // The change is longer than the popup: scroll down to the rest of it.
    await key(s, 'END');
    await settle(s);
    for (const text of ['After', '"comment": "Go"']) expect(s.captureCharFrame()).toContain(text);
    await esc(s);
    expect(s.captureCharFrame()).not.toContain('╭─ mission.approve');
    s.renderer.destroy();
  });

  it('shows "(none)" for the missing side of an event', async () => {
    const s = await render(<AuditSection api={fakeAuditApi([onePage(events)])} />);
    await down(s, 1);
    await enter(s);
    expect(s.captureCharFrame()).toContain('(none)');
    expect(s.captureCharFrame()).toContain('system');
    s.renderer.destroy();
  });

  it('shows an empty log and a refusal', async () => {
    const empty = await render(<AuditSection api={fakeAuditApi([onePage([])])} />);
    expect(empty.captureCharFrame()).toContain('Nothing has been recorded yet.');
    empty.renderer.destroy();
    const refused = await render(
      <AuditSection
        api={fakeAuditApi([new Error('You are not allowed to do this (FORBIDDEN)')])}
      />,
    );
    expect(refused.captureCharFrame()).toContain('FORBIDDEN');
    refused.renderer.destroy();
  });
});

describe('AlertsSection', () => {
  it('lists alerts and opens one with its details', async () => {
    const s = await render(<AlertsSection api={fakeAlertsApi([onePage([alert(1)])])} />);
    let frame = s.captureCharFrame();
    for (const text of ['Alerts: 1', 'SCHEDULER_RUN_FAILED', 'The scheduler could not process'])
      expect(frame).toContain(text);
    await enter(s);
    frame = s.captureCharFrame();
    expect(frame).toContain('╭─ SCHEDULER_RUN_FAILED');
    for (const text of ['scheduler', '"stage": "transitions"']) expect(frame).toContain(text);
    await key(s, 'END');
    await settle(s);
    expect(s.captureCharFrame()).toContain('"code": "53100"');
    s.renderer.destroy();
  });

  it('says so when there are none', async () => {
    const s = await render(<AlertsSection api={fakeAlertsApi([onePage([])])} />);
    expect(s.captureCharFrame()).toContain('No alerts.');
    s.renderer.destroy();
  });
});

describe('InboxSection', () => {
  const inbox = [
    notification(1, { payload: { missionName: 'Artemis Relay', comment: 'Go for it' } }),
    notification(2, {
      type: 'mission.rejected',
      readAt: '2026-10-03T10:00:00.000Z',
      payload: { missionName: 'Deep Field', reason: 'Needs a pilot' },
    }),
  ];

  it('words what a notification is about like the CLI', () => {
    expect(aboutOf(inbox[0]!)).toBe('Artemis Relay (Go for it)');
    expect(aboutOf(inbox[1]!)).toBe('Deep Field (Needs a pilot)');
    expect(aboutOf(notification(3, { payload: {} }))).toBe('');
  });

  it('lists notifications with a dot on the unread ones', async () => {
    const s = await render(<InboxSection api={fakeInboxApi([onePage(inbox)])} />);
    const lines = s.captureCharFrame().split('\n');
    expect(lines.find((l) => l.includes('Artemis Relay'))).toContain('●');
    expect(lines.find((l) => l.includes('Deep Field'))).not.toContain('●');
    expect(s.captureCharFrame()).toContain('Inbox: 2');
    s.renderer.destroy();
  });

  it('opens a notification, marks it read once, and refreshes the list when closed', async () => {
    const api = fakeInboxApi(
      [onePage(inbox), onePage([{ ...inbox[0]!, readAt: '2026-10-03T15:00:00.000Z' }, inbox[1]!])],
      { ...inbox[0]!, readAt: '2026-10-03T15:00:00.000Z' },
    );
    const s = await render(<InboxSection api={api} />);
    await enter(s);
    await settle(s);
    await settle(s);
    expect(api.markReadCalls).toEqual([inbox[0]!.id]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ mission.approved');
    expect(frame).toContain('comment: Go for it');
    expect(frame).toContain('2026-10-03T15:00:00.000Z'); // read at
    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    expect(
      s
        .captureCharFrame()
        .split('\n')
        .find((l) => l.includes('Artemis Relay')),
    ).not.toContain('●');
    s.renderer.destroy();
  });

  it('does not mark an already read notification again', async () => {
    const api = fakeInboxApi([onePage(inbox)]);
    const s = await render(<InboxSection api={api} />);
    await down(s, 1);
    await enter(s);
    await settle(s);
    expect(api.markReadCalls).toEqual([]);
    expect(api.listCalls).toHaveLength(1);
    s.renderer.destroy();
  });

  it('shows why a notification could not be marked read, and an empty inbox', async () => {
    const api = fakeInboxApi([onePage(inbox)], new Error('Notification not found (NOT_FOUND)'));
    const s = await render(<InboxSection api={api} />);
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('NOT_FOUND');
    s.renderer.destroy();
    const empty = await render(<InboxSection api={fakeInboxApi([onePage([])])} />);
    expect(empty.captureCharFrame()).toContain('Your inbox is empty.');
    empty.renderer.destroy();
  });
});

describe('AssignmentsSection', () => {
  const mine = [assignment(1), assignment(2, { acknowledgedAt: '2026-10-02T09:00:00.000Z' })];

  it('lists my assignments with whether I acknowledged them', async () => {
    const s = await render(<AssignmentsSection api={fakeAssignmentsApi([onePage(mine)])} />);
    const lines = s.captureCharFrame().split('\n');
    expect(s.captureCharFrame()).toContain('My assignments: 2');
    expect(lines.find((l) => l.includes('Mission 01'))).toMatch(
      /approved\s+│[^│]*│[^│]*│\s+no\s+│/,
    );
    expect(lines.find((l) => l.includes('Mission 02'))).toMatch(/\s+yes\s+│/);
    s.renderer.destroy();
  });

  it('acknowledges after a confirmation, then hides the button and refreshes the list', async () => {
    const api = fakeAssignmentsApi([
      onePage(mine),
      onePage([{ ...mine[0]!, acknowledgedAt: '2026-10-03T15:00:00.000Z' }, mine[1]!]),
    ]);
    const s = await render(<AssignmentsSection api={api} />);
    await enter(s);
    expect(s.captureCharFrame()).toContain('Acknowledge (a)');
    await key(s, 'a');
    expect(s.captureCharFrame()).toContain('It is binding and cannot be refused.');
    expect(api.acknowledgeCalls).toEqual([]);
    await esc(s); // cancels the question only
    expect(s.captureCharFrame()).toContain('╭─ Mission 01');
    await key(s, 'a');
    await enter(s);
    await settle(s);
    expect(api.acknowledgeCalls).toEqual([mine[0]!.id]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Acknowledged.');
    expect(frame).not.toContain('Acknowledge (a)');
    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    s.renderer.destroy();
  });

  it('offers nothing on an assignment already acknowledged', async () => {
    const api = fakeAssignmentsApi([onePage(mine)]);
    const s = await render(<AssignmentsSection api={api} />);
    await down(s, 1);
    await enter(s);
    expect(s.captureCharFrame()).not.toContain('Acknowledge (a)');
    await key(s, 'a');
    expect(api.acknowledgeCalls).toEqual([]);
    s.renderer.destroy();
  });

  it('shows why an acknowledgement was refused', async () => {
    const api = fakeAssignmentsApi(
      [onePage(mine)],
      new Error('That assignment cannot be acknowledged (ASSIGNMENT_NOT_ACKNOWLEDGEABLE)'),
    );
    const s = await render(<AssignmentsSection api={api} />);
    await enter(s);
    await key(s, 'a');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('ASSIGNMENT_NOT_ACKNOWLEDGEABLE');
    s.renderer.destroy();
  });
});
