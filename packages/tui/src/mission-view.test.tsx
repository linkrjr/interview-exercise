import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { fakeApi, mission, pageOf } from './fixtures.js';
import { MissionView, missionLines } from './mission-view.js';
import { perform, settle } from './test-helpers.js';

async function render(api = fakeApi([pageOf([])]), onBack = () => {}, height = 40) {
  const setup = await testRender(
    <MissionView api={api} missionId={mission().id} name="Mission 01" onBack={onBack} />,
    { width: 100, height },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}

describe('MissionView', () => {
  it('shows the mission fields, requirements and crew', async () => {
    const api = fakeApi(
      [pageOf([])],
      mission({ status: 'pending_approval', crewValidation: undefined }),
    );
    const s = await render(api);
    const frame = s.captureCharFrame();
    expect(api.getCalls).toEqual([mission().id]);
    for (const text of [
      'Mission 01',
      'Status: pending_approval',
      'Version: 3',
      'Dates: 2027-03-01 to 2027-03-10',
      'Lead: Lee Lead',
      'Relay station for the far side.',
      'Requirements',
      'Orbital Piloting  level 4+  x1',
      'Medicine  level 3+  x2',
      'Crew',
      'Ann Crew <ann@example.com>  not acknowledged',
      '(no name) <bob@example.com>  acknowledged 2026-10-03T08:00:00.000Z',
      'Decisions',
      'rejected: Confirm the second pilot',
    ]) {
      expect(frame).toContain(text);
    }
    s.renderer.destroy();
  });

  it('shows the crew check of a Crewing mission with names instead of ids', async () => {
    const s = await render(fakeApi([pageOf([])], mission()));
    const frame = s.captureCharFrame();
    expect(frame).toContain('NOT ready to submit');
    expect(frame).toContain('Ann Crew is NOT_ELIGIBLE');
    expect(frame).toContain('Medicine (level 3+): needs 2, has 1');
    s.renderer.destroy();
  });

  it('says "(none)" for a mission with no description, requirements or crew', async () => {
    const lines = missionLines(
      mission({
        description: '',
        requirements: [],
        crew: [],
        decisions: [],
        crewValidation: undefined,
      }),
    ).map((l) => l.text);
    expect(lines.filter((t) => t.trim() === '(none)')).toHaveLength(3);
    expect(lines).not.toContain('Decisions');
  });

  it('shows what the person may do next', () => {
    const lines = missionLines(mission({ allowedActions: ['approve', 'reject'] })).map(
      (l) => l.text,
    );
    expect(lines.at(-1)).toBe('You can: approve, reject');
  });

  it('shows loading, then the error when the mission cannot be read', async () => {
    let fail!: (e: Error) => void;
    const api = fakeApi([pageOf([])], () => new Promise((_, reject) => void (fail = reject)));
    const s = await render(api);
    expect(s.captureCharFrame()).toContain('Loading Mission 01…');
    await perform(s, () => fail(new Error('Mission not found (NOT_FOUND)')));
    await settle(s);
    expect(s.captureCharFrame()).toContain('Mission not found (NOT_FOUND)');
    s.renderer.destroy();
  });

  it('goes back on Esc', async () => {
    let backs = 0;
    const s = await render(fakeApi([pageOf([])]), () => void backs++);
    await perform(s, () => s.mockInput.pressEscape());
    // A lone Esc is held back briefly, in case it starts an escape sequence.
    await new Promise((r) => setTimeout(r, 100));
    await settle(s);
    expect(backs).toBe(1);
    s.renderer.destroy();
  });

  it('scrolls when the mission is taller than the screen', async () => {
    const s = await render(fakeApi([pageOf([])], mission()), undefined, 12);
    expect(s.captureCharFrame()).not.toContain('Decisions');
    await perform(s, () => s.mockInput.pressKey('END'));
    expect(s.captureCharFrame()).toContain('You can:');
    await perform(s, () => s.mockInput.pressKey('HOME'));
    expect(s.captureCharFrame()).toContain('Status: crewing');
    s.renderer.destroy();
  });
});

const waiting = (over = {}) =>
  mission({
    status: 'pending_approval',
    allowedActions: ['approve', 'reject'],
    crewValidation: undefined,
    ...over,
  });

async function renderDeciding(
  api: ReturnType<typeof fakeApi>,
  extra: { onDecided?: () => void; onBack?: () => void } = {},
) {
  const setup = await testRender(<App api={api} extra={extra} />, { width: 100, height: 30 });
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof renderDeciding>>;

function App({
  api,
  extra,
}: {
  api: ReturnType<typeof fakeApi>;
  extra: { onDecided?: () => void; onBack?: () => void };
}) {
  return (
    <MissionView
      api={api}
      missionId={mission().id}
      name="Mission 01"
      onBack={extra.onBack ?? (() => {})}
      onDecided={extra.onDecided}
    />
  );
}

const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const press = (s: Setup, key: string) => perform(s, () => s.mockInput.pressKey(key));
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};

describe('MissionView approve and reject', () => {
  it('shows the buttons only when the mission can be approved and rejected', async () => {
    const s = await renderDeciding(fakeApi([pageOf([])], waiting()));
    expect(s.captureCharFrame()).toContain('Approve (a)');
    expect(s.captureCharFrame()).toContain('Reject (r)');
    s.renderer.destroy();

    for (const allowedActions of [[], ['cancel'], ['start_crewing', 'submit']] as const) {
      const other = await renderDeciding(
        fakeApi([pageOf([])], waiting({ allowedActions: [...allowedActions] })),
      );
      const frame = other.captureCharFrame();
      expect(frame).not.toContain('Approve');
      expect(frame).not.toContain('Reject');
      // The keys do nothing either.
      await press(other, 'a');
      await press(other, 'r');
      expect(other.captureCharFrame()).not.toContain('comment (optional)');
      expect(other.captureCharFrame()).not.toContain('reason (required)');
      other.renderer.destroy();
    }
  });

  it('approves with an optional comment and stays on the updated mission, with the buttons gone', async () => {
    const decided: string[] = [];
    const api = fakeApi(
      [pageOf([])],
      waiting(),
      mission({ status: 'approved', version: 4, allowedActions: [], decisions: [] }),
    );
    const s = await renderDeciding(api, { onDecided: () => void decided.push('yes') });
    await press(s, 'a');
    expect(s.captureCharFrame()).toContain('Approve: comment (optional)');
    await type(s, 'Go for it');
    await enter(s);
    await settle(s);

    expect(api.decideCalls).toEqual([
      { id: mission().id, action: 'approve', comment: 'Go for it', version: 3 },
    ]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Approved.');
    expect(frame).toContain('Status: approved');
    expect(frame).toContain('Version: 4');
    expect(frame).not.toContain('Approve (a)');
    expect(frame).not.toContain('Reject (r)');
    expect(frame).toContain('Esc close');
    expect(decided).toEqual(['yes']);
    s.renderer.destroy();
  });

  it('approves without a comment', async () => {
    const api = fakeApi([pageOf([])], waiting());
    const s = await renderDeciding(api);
    await press(s, 'a');
    await enter(s);
    await settle(s);
    expect(api.decideCalls[0]).toEqual({
      id: mission().id,
      action: 'approve',
      comment: '',
      version: 3,
    });
    s.renderer.destroy();
  });

  it('rejects with the reason it was given', async () => {
    const api = fakeApi(
      [pageOf([])],
      waiting(),
      mission({ status: 'crewing', allowedActions: [] }),
    );
    const s = await renderDeciding(api);
    await press(s, 'r');
    expect(s.captureCharFrame()).toContain('Reject: reason (required)');
    await type(s, 'Needs a second pilot');
    await enter(s);
    await settle(s);
    expect(api.decideCalls[0]).toEqual({
      id: mission().id,
      action: 'reject',
      comment: 'Needs a second pilot',
      version: 3,
    });
    const frame = s.captureCharFrame();
    expect(frame).toContain('Rejected.');
    expect(frame).not.toContain('Reject (r)');
    s.renderer.destroy();
  });

  it('refuses a blank reason without asking the server, and lets the person fix it', async () => {
    const api = fakeApi([pageOf([])], waiting());
    const s = await renderDeciding(api);
    await press(s, 'r');
    await type(s, '   ');
    await enter(s);
    expect(s.captureCharFrame()).toContain('A reason is required');
    expect(api.decideCalls).toEqual([]);
    await type(s, 'because');
    await enter(s);
    await settle(s);
    expect(api.decideCalls).toHaveLength(1);
    s.renderer.destroy();
  });

  it('opens the form from a click on a button', async () => {
    const s = await renderDeciding(fakeApi([pageOf([])], waiting()));
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Reject (r)'));
    await perform(s, () => s.mockMouse.click(lines[y]!.indexOf('Reject') + 1, y));
    expect(s.captureCharFrame()).toContain('Reject: reason (required)');
    s.renderer.destroy();
  });

  it('shows why a decision failed and keeps the form, the mission and the buttons', async () => {
    const api = fakeApi(
      [pageOf([])],
      waiting(),
      new Error('The mission is now at version 4 (MISSION_VERSION_MISMATCH)'),
    );
    const decided: string[] = [];
    const s = await renderDeciding(api, { onDecided: () => void decided.push('yes') });
    await press(s, 'a');
    await type(s, 'ok');
    await enter(s);
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('MISSION_VERSION_MISMATCH');
    expect(frame).toContain('Approve: comment (optional)');
    expect(frame).not.toContain('Approved.');
    expect(decided).toEqual([]);

    // Esc closes the form, and the buttons are back.
    await esc(s);
    expect(s.captureCharFrame()).toContain('Approve (a)');
    s.renderer.destroy();
  });

  it('sends a decision once, even if Enter is hit twice', async () => {
    let release!: (m: ReturnType<typeof mission>) => void;
    const api = fakeApi([pageOf([])], waiting(), (() => undefined) as never);
    api.decide = (id, decision) =>
      new Promise((resolve) => {
        api.decideCalls.push({ id, ...decision });
        release = resolve;
      });
    const s = await renderDeciding(api);
    await press(s, 'a');
    await enter(s);
    await enter(s);
    expect(api.decideCalls).toHaveLength(1);
    expect(s.captureCharFrame()).toContain('Sending…');
    release(mission({ status: 'approved', allowedActions: [] }));
    await settle(s);
    s.renderer.destroy();
  });

  it('closes the form on Esc without leaving the mission, and leaves the mission on the next Esc', async () => {
    let backs = 0;
    const s = await renderDeciding(fakeApi([pageOf([])], waiting()), {
      onBack: () => void backs++,
    });
    await press(s, 'r');
    await esc(s);
    expect(backs).toBe(0);
    expect(s.captureCharFrame()).not.toContain('reason (required)');
    await esc(s);
    expect(backs).toBe(1);
    s.renderer.destroy();
  });

  it('treats a, r and arrow keys as text while a form is open', async () => {
    const api = fakeApi([pageOf([])], waiting());
    const s = await renderDeciding(api);
    await press(s, 'a');
    await type(s, 'rar');
    await enter(s);
    await settle(s);
    expect(api.decideCalls[0]!.comment).toBe('rar');
    s.renderer.destroy();
  });
});
