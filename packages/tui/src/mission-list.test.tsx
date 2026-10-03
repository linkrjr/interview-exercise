import { testRender } from '@opentui/react/test-utils';
import type { MissionSummary } from '@mc/contracts';
import { describe, expect, it } from 'bun:test';
import { fakeApi, manyMissions, pageOf, summary, type FakeApi } from './fixtures.js';
import { MissionList } from './mission-list.js';
import { perform, settle } from './test-helpers.js';

async function render(
  api: FakeApi,
  options: {
    height?: number;
    status?: string[];
    active?: boolean;
    onOpen?: (m: MissionSummary) => void;
  } = {},
) {
  const setup = await testRender(
    <MissionList
      api={api}
      title="Missions"
      status={options.status}
      emptyText="There are no missions yet."
      active={options.active ?? true}
      onOpen={options.onOpen ?? (() => {})}
    />,
    { width: 100, height: options.height ?? 14 },
  );
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;

const key = (s: Setup, name: string) => perform(s, () => s.mockInput.pressKey(name));
const down = (s: Setup, times = 1) =>
  perform(s, async () => {
    for (let i = 0; i < times; i++) s.mockInput.pressArrow('down');
  });

describe('MissionList', () => {
  it('shows a header and one row per mission, with the table columns', async () => {
    const s = await render(
      fakeApi([pageOf([summary(1), summary(2, { status: 'crewing', leadName: null })])]),
    );
    const frame = s.captureCharFrame();
    for (const text of [
      'NAME',
      'STATUS',
      'START',
      'END',
      'LEAD',
      'Mission 01',
      'pending_approval',
      '2027-03-01',
      'Lee Lead',
      'Mission 02',
      'crewing',
    ]) {
      expect(frame).toContain(text);
    }
    expect(frame).toContain('Missions: 2');
    // A lead without a name falls back to the id.
    expect(frame).toContain('0199aaaa-bbbb-7ccc-8ddd-000000000900');
    s.renderer.destroy();
  });

  it('asks for only the given statuses, or for everything', async () => {
    const waiting = fakeApi([pageOf([summary(1)])]);
    (await render(waiting, { status: ['pending_approval'] })).renderer.destroy();
    expect(waiting.listCalls[0]!.status).toEqual(['pending_approval']);
    const all = fakeApi([pageOf([summary(1)])]);
    (await render(all)).renderer.destroy();
    expect(all.listCalls[0]!.status).toBeUndefined();
  });

  it('says so when there is nothing to list', async () => {
    const s = await render(fakeApi([pageOf([])]));
    expect(s.captureCharFrame()).toContain('There are no missions yet.');
    s.renderer.destroy();
  });

  it('shows the error and retries on r', async () => {
    const api = fakeApi([new Error('Cannot reach the server'), pageOf([summary(1)])]);
    const s = await render(api);
    expect(s.captureCharFrame()).toContain('Cannot reach the server');
    await key(s, 'r');
    await s.waitForFrame((f) => f.includes('Mission 01'));
    expect(api.listCalls).toHaveLength(2);
    s.renderer.destroy();
  });

  it('moves the selection with the arrow keys and opens the selected row on Enter', async () => {
    const opened: string[] = [];
    const s = await render(fakeApi([pageOf(manyMissions(5))]), {
      onOpen: (m) => void opened.push(m.name),
    });
    await perform(s, () => s.mockInput.pressEnter());
    await down(s, 2);
    await perform(s, () => s.mockInput.pressEnter());
    await perform(s, () => s.mockInput.pressArrow('up'));
    await perform(s, () => s.mockInput.pressEnter());
    expect(opened).toEqual(['Mission 01', 'Mission 03', 'Mission 02']);
    s.renderer.destroy();
  });

  it('opens a row that is clicked', async () => {
    const opened: string[] = [];
    const s = await render(fakeApi([pageOf(manyMissions(5))]), {
      onOpen: (m) => void opened.push(m.name),
    });
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Mission 04'));
    await perform(s, () => s.mockMouse.click(5, y));
    expect(opened).toEqual(['Mission 04']);
    s.renderer.destroy();
  });

  it('stays within the first and last row', async () => {
    const opened: string[] = [];
    const s = await render(fakeApi([pageOf(manyMissions(3))]), {
      onOpen: (m) => void opened.push(m.name),
    });
    await perform(s, () => s.mockInput.pressArrow('up'));
    await perform(s, () => s.mockInput.pressEnter());
    await down(s, 10);
    await perform(s, () => s.mockInput.pressEnter());
    expect(opened).toEqual(['Mission 01', 'Mission 03']);
    s.renderer.destroy();
  });

  it('scrolls a long list under a header that stays put, keeping the selected row in view', async () => {
    const s = await render(fakeApi([pageOf(manyMissions(40))]), { height: 12 });
    let frame = s.captureCharFrame();
    expect(frame).toContain('Mission 01');
    expect(frame).not.toContain('Mission 30');

    await key(s, 'END');
    frame = s.captureCharFrame();
    expect(frame).toContain('Mission 40');
    expect(frame).not.toContain('Mission 01');
    expect(frame).toContain('NAME'); // the header is still there

    await key(s, 'HOME');
    expect(s.captureCharFrame()).toContain('Mission 01');

    // Walking down past the bottom of the viewport brings the next rows into view.
    await down(s, 12);
    frame = s.captureCharFrame();
    expect(frame).toContain('Mission 13');
    expect(frame).toContain('NAME');
    s.renderer.destroy();
  });

  it('pages with PageDown and PageUp', async () => {
    const s = await render(fakeApi([pageOf(manyMissions(40))]), { height: 12 });
    await key(s, '\x1b[6~');
    expect(s.captureCharFrame()).toMatch(/Mission 0[6-9]|Mission 1\d/);
    await key(s, '\x1b[5~');
    expect(s.captureCharFrame()).toContain('Mission 01');
    s.renderer.destroy();
  });

  it('fetches the next page as the end is reached and appends it', async () => {
    const api = fakeApi([pageOf(manyMissions(25), 'cursor-2'), pageOf(manyMissions(10, 26))]);
    const s = await render(api, { height: 12 });
    expect(s.captureCharFrame()).toContain('Missions: 25+');
    expect(api.listCalls).toHaveLength(1);
    await key(s, 'END');
    await s.waitForFrame((f) => f.includes('Missions: 35'));
    expect(api.listCalls.map((c) => c.cursor)).toEqual([undefined, 'cursor-2']);
    await key(s, 'END');
    expect(s.captureCharFrame()).toContain('Mission 35');
    expect(api.listCalls).toHaveLength(2); // no more pages to ask for
    s.renderer.destroy();
  });

  it('reads no keys while something else is on top of it', async () => {
    const opened: string[] = [];
    const s = await render(fakeApi([pageOf(manyMissions(3))]), {
      active: false,
      onOpen: (m) => void opened.push(m.name),
    });
    await perform(s, () => s.mockInput.pressEnter());
    expect(opened).toEqual([]);
    s.renderer.destroy();
  });
});
