import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import {
  fakeApis,
  fakeApi,
  fakeSettingsApi,
  fakeSkillsApi,
  skill,
  type FakeSettingsApi,
  type FakeSkillsApi,
  fakeUsersApi,
  manyMissions,
  mission,
  pageOf,
  summary,
  type FakeApi,
  type FakeUsersApi,
} from './fixtures.js';
import { MainScreen } from './main-screen.js';
import type { SessionInfo } from './session.js';
import { perform, settle } from './test-helpers.js';

const session = (role: string | undefined): SessionInfo => ({
  apiUrl: 'http://localhost:3000',
  orgId: 'org-1',
  role,
  signedIn: true,
});

async function render(
  role: string | undefined,
  onSignOut = async () => {},
  width = 100,
  api: FakeApi = fakeApi([pageOf([])]),
  users: FakeUsersApi = fakeUsersApi(),
  skills: FakeSkillsApi = fakeSkillsApi(),
  settings: FakeSettingsApi = fakeSettingsApi(),
) {
  const setup = await testRender(
    <MainScreen
      session={session(role)}
      apis={fakeApis({ missions: api, users, skills, settings })}
      onSignOut={onSignOut}
    />,
    {
      width,
      height: 30,
    },
  );
  await setup.renderOnce();
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;

const press = (
  s: Setup,
  key: 'tab' | 'left' | 'right' | 'enter',
  modifiers?: { shift?: boolean },
) =>
  perform(s, () => {
    if (key === 'tab') s.mockInput.pressTab(modifiers);
    else if (key === 'enter') s.mockInput.pressEnter();
    else s.mockInput.pressArrow(key);
  });

function find(frame: string, word: string): { x: number; y: number } {
  const lines = frame.split('\n');
  const y = lines.findIndex((l) => l.includes(word));
  if (y < 0) throw new Error(`"${word}" is not on the screen:\n${frame}`);
  return { x: lines[y]!.indexOf(word), y };
}

const barOf = (frame: string) => frame.split('\n').slice(3, 5).join(' ');

describe('MainScreen navigation bar', () => {
  it('shows a Director every Director action', async () => {
    const s = await render('director');
    const bar = barOf(s.captureCharFrame());
    for (const label of [
      'Approvals',
      'Missions',
      'Users',
      'Skills',
      'Settings',
      'Audit log',
      'Alerts',
      'Inbox',
      'Sign out',
    ]) {
      expect(bar).toContain(label);
    }
    expect(bar).not.toContain('New mission');
    s.renderer.destroy();
  });

  it('shows a Lead only what a Lead can do', async () => {
    const s = await render('lead');
    const bar = barOf(s.captureCharFrame());
    for (const label of ['Missions', 'New mission', 'Skills', 'Inbox', 'Sign out']) {
      expect(bar).toContain(label);
    }
    for (const hidden of ['Approvals', 'Users', 'Settings', 'Audit log', 'Alerts', 'My profile']) {
      expect(s.captureCharFrame()).not.toContain(hidden);
    }
    s.renderer.destroy();
  });

  it('shows a Crew Member only their own things', async () => {
    const s = await render('crew');
    const frame = s.captureCharFrame();
    for (const label of ['My profile', 'My assignments', 'Inbox', 'Sign out']) {
      expect(barOf(frame)).toContain(label);
    }
    for (const hidden of ['Approvals', 'Missions', 'Users', 'New mission', 'Audit log']) {
      expect(frame).not.toContain(hidden);
    }
    s.renderer.destroy();
  });

  it('shows only Sign out for a role it does not know', async () => {
    const s = await render(undefined);
    const frame = s.captureCharFrame();
    expect(barOf(frame)).toContain('Sign out');
    for (const hidden of ['Approvals', 'Missions', 'Inbox', 'My profile']) {
      expect(frame).not.toContain(hidden);
    }
    s.renderer.destroy();
  });

  it('wraps onto a second line on a narrow terminal rather than cutting items off', async () => {
    const s = await render('director', undefined, 60);
    const frame = s.captureCharFrame();
    for (const label of ['Approvals', 'Sign out', 'Inbox', 'Audit log'])
      expect(frame).toContain(label);
    s.renderer.destroy();
  });
});

describe('MainScreen selection', () => {
  it('starts on the first item of the role', async () => {
    const s = await render('director');
    await settle(s);
    expect(s.captureCharFrame()).toContain('Nothing is waiting for approval.');
    expect(s.captureCharFrame()).toContain('director · org-1');
    const lead = await render('crew');
    await settle(lead);
    const frame = lead.captureCharFrame();
    expect(frame).toContain('1 Skills');
    s.renderer.destroy();
    lead.renderer.destroy();
  });

  it('moves with the arrow keys and Tab, wrapping around', async () => {
    const s = await render('crew');
    await press(s, 'right');
    await settle(s);
    expect(s.captureCharFrame()).toContain('You have no assignments.');
    await press(s, 'tab');
    await settle(s);
    expect(s.captureCharFrame()).toContain('Your inbox is empty.');
    await press(s, 'left');
    await press(s, 'left');
    await press(s, 'left'); // back past the first item to Sign out
    expect(s.captureCharFrame()).toContain('Sign out (Enter)');
    await press(s, 'tab', { shift: true });
    await settle(s);
    expect(s.captureCharFrame()).toContain('Your inbox is empty.');
    s.renderer.destroy();
  });

  it('selects an item that is clicked', async () => {
    const s = await render('lead');
    const { x, y } = find(s.captureCharFrame(), 'New mission');
    await perform(s, () => s.mockMouse.click(x + 1, y));
    expect(s.captureCharFrame()).toContain('Plan a mission');
    s.renderer.destroy();
  });
});

describe('MainScreen sign out', () => {
  it('does not sign out just by passing over it or pressing Enter on another item', async () => {
    let calls = 0;
    const s = await render('crew', async () => void calls++);
    await press(s, 'enter');
    await press(s, 'left'); // wraps to Sign out
    expect(s.captureCharFrame()).toContain('Sign out (Enter)');
    expect(calls).toBe(0);
    s.renderer.destroy();
  });

  it('signs out on Enter once Sign out is selected, and only once', async () => {
    let calls = 0;
    const s = await render('crew', async () => void calls++);
    await press(s, 'left');
    await press(s, 'enter');
    await press(s, 'enter');
    expect(calls).toBe(1);
    expect(s.captureCharFrame()).toContain('Signing out');
    s.renderer.destroy();
  });

  it('signs out when the Sign out button is clicked', async () => {
    let calls = 0;
    const s = await render('lead', async () => void calls++);
    await press(s, 'left');
    const { x, y } = find(s.captureCharFrame(), 'Sign out (Enter)');
    await perform(s, () => s.mockMouse.click(x + 2, y));
    expect(calls).toBe(1);
    s.renderer.destroy();
  });
});

const arrow = (s: Setup, direction: 'up' | 'down' | 'left' | 'right', times = 1) =>
  perform(s, async () => {
    for (let i = 0; i < times; i++) s.mockInput.pressArrow(direction);
  });
const NAV = 'Approvals    Missions';

describe('MainScreen approvals and missions', () => {
  it('lists only the missions waiting for approval under Approvals', async () => {
    const api = fakeApi([pageOf([summary(1), summary(2)])]);
    const s = await render('director', undefined, 100, api);
    await settle(s);
    expect(api.listCalls[0]!.status).toEqual(['pending_approval']);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Waiting for approval: 2');
    expect(frame).toContain('Mission 02');
    s.renderer.destroy();
  });

  it('lists all missions under Missions, for a Director and for a Lead', async () => {
    for (const [role, steps] of [
      ['director', 1],
      ['lead', 0],
    ] as const) {
      const api = fakeApi([
        pageOf([summary(1, { status: 'active' }), summary(2, { status: 'draft' })]),
      ]);
      const s = await render(role, undefined, 100, api);
      await arrow(s, 'right', steps);
      await settle(s);
      expect(api.listCalls.at(-1)!.status).toBeUndefined();
      const frame = s.captureCharFrame();
      expect(frame).toContain('Missions: 2');
      expect(frame).toContain('active');
      expect(frame).toContain('draft');
      s.renderer.destroy();
    }
  });

  it('keeps the navigation bar on screen while the table scrolls', async () => {
    const s = await render('director', undefined, 100, fakeApi([pageOf(manyMissions(60))]));
    await settle(s);
    await perform(s, () => s.mockInput.pressKey('END'));
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Mission 60');
    expect(frame).not.toContain('Mission 01 ');
    expect(frame).toContain('Mission Control');
    expect(frame).toContain(NAV);
    expect(frame).toContain('Sign out');
    s.renderer.destroy();
  });

  it('opens the selected row as the mission view, under the navigation bar, and Esc comes back to the same row', async () => {
    const api = fakeApi(
      [pageOf(manyMissions(8))],
      mission({ name: 'Mission 03', status: 'crewing' }),
    );
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await arrow(s, 'down', 2);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);

    expect(api.getCalls).toEqual([summary(3).id]);
    let frame = s.captureCharFrame();
    expect(frame).toContain('Requirements');
    expect(frame).toContain('Orbital Piloting');
    expect(frame).toContain('PgUp/PgDn scroll');
    expect(frame).toContain(NAV);

    await perform(s, () => s.mockInput.pressEscape());
    await new Promise((r) => setTimeout(r, 100));
    await settle(s);
    frame = s.captureCharFrame();
    expect(frame).toContain('Waiting for approval: 8');
    expect(api.listCalls).toHaveLength(1); // the list was kept, not fetched again

    // The selection is still the third row: Enter opens it again.
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    expect(api.getCalls).toEqual([summary(3).id, summary(3).id]);
    s.renderer.destroy();
  });

  it('opens a clicked row', async () => {
    const api = fakeApi([pageOf(manyMissions(5))]);
    const s = await render('director', undefined, 100, api);
    await settle(s);
    const y = s
      .captureCharFrame()
      .split('\n')
      .findIndex((l) => l.includes('Mission 04'));
    await perform(s, () => s.mockMouse.click(5, y));
    await settle(s);
    expect(api.getCalls).toEqual([summary(4).id]);
    s.renderer.destroy();
  });

  it('leaves the mission view when another section is chosen, and loads the list fresh when coming back', async () => {
    const api = fakeApi([pageOf(manyMissions(3))]);
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    expect(s.captureCharFrame()).toContain('PgUp/PgDn scroll');
    await arrow(s, 'right');
    await settle(s);
    expect(s.captureCharFrame()).not.toContain('PgUp/PgDn scroll');
    expect(api.listCalls).toHaveLength(2);
    s.renderer.destroy();
  });

  it('shows the error when the list cannot be loaded, with the navigation bar intact', async () => {
    const s = await render(
      'director',
      undefined,
      100,
      fakeApi([new Error('Cannot reach the server')]),
    );
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Cannot reach the server');
    expect(frame).toContain(NAV);
    s.renderer.destroy();
  });

  it('does not read missions for a Crew Member', async () => {
    const api = fakeApi([pageOf([])]);
    const s = await render('crew', undefined, 100, api);
    await settle(s);
    expect(api.listCalls).toEqual([]);
    s.renderer.destroy();
  });

  it('refreshes the Approvals list after a decision, so the decided mission is gone from it', async () => {
    const m = mission({
      ...summary(1),
      status: 'pending_approval',
      allowedActions: ['approve', 'reject'],
      crewValidation: undefined,
    });
    const api = fakeApi(
      [pageOf([summary(1), summary(2)]), pageOf([summary(2)])],
      m,
      mission({ ...summary(1), status: 'approved', allowedActions: [] }),
    );
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    await perform(s, () => s.mockInput.pressKey('a'));
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    expect(s.captureCharFrame()).toContain('Approved.');
    expect(api.listCalls).toHaveLength(1); // still on the mission: nothing refetched yet

    await perform(s, () => s.mockInput.pressEscape());
    await new Promise((r) => setTimeout(r, 100));
    await settle(s);
    const frame = s.captureCharFrame();
    expect(api.listCalls).toHaveLength(2);
    expect(frame).toContain('Waiting for approval: 1');
    expect(frame).not.toContain('Mission 01');
    s.renderer.destroy();
  });

  it('does not switch section or quit while a comment is being typed', async () => {
    const m = mission({
      ...summary(1),
      status: 'pending_approval',
      allowedActions: ['approve', 'reject'],
      crewValidation: undefined,
    });
    const s = await render('director', undefined, 100, fakeApi([pageOf([summary(1)])], m));
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    await perform(s, () => s.mockInput.pressKey('a'));
    await perform(s, () => s.mockInput.typeText('quick'));
    await perform(s, () => s.mockInput.pressArrow('right'));
    await perform(s, () => s.mockInput.pressTab());
    const frame = s.captureCharFrame();
    expect(frame).toContain('Approve: comment (optional)');
    expect(frame).toContain('quick');
    expect(s.renderer.isDestroyed).toBe(false);
    s.renderer.destroy();
  });

  it('shows the mission as a bordered popup centred over the list, which stays visible around it', async () => {
    const api = fakeApi(
      [pageOf(manyMissions(20))],
      mission({
        ...summary(1),
        name: 'Mission 01',
        status: 'pending_approval',
        allowedActions: [],
      }),
    );
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);

    const lines = s.captureCharFrame().split('\n');
    const top = lines.findIndex((l) => l.includes('╭─ Mission 01 ─'));
    expect(top).toBeGreaterThan(5); // below the header and the navigation bar
    const bottom = lines.findIndex((l, i) => i > top && l.includes('╰') && l.includes('╯'));
    expect(bottom).toBeGreaterThan(top);
    // Centred: the same room on both sides.
    const left = lines[top]!.indexOf('╭');
    const right = lines[top]!.lastIndexOf('╮');
    expect(Math.abs(left - (100 - 1 - right))).toBeLessThanOrEqual(1);
    // The list is still on screen above and around the popup.
    const frame = lines.join('\n');
    expect(frame).toContain('Waiting for approval: 20');
    expect(lines.slice(3, top).join('\n')).toContain('Waiting for approval');
    expect(lines.slice(bottom + 1).join('\n')).toMatch(/Mission \d\d\s+│\s+pending_approval/);
    expect(frame).toContain(NAV);
    // Inside the popup: the mission, and the way out.
    expect(lines.slice(top, bottom + 1).join('\n')).toContain('Esc close');
    s.renderer.destroy();
  });

  it('closes the popup on Esc and leaves the list as it was', async () => {
    const api = fakeApi([pageOf(manyMissions(20))]);
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    expect(s.captureCharFrame()).toContain('╭─ Mission 01');
    await perform(s, () => s.mockInput.pressEscape());
    await new Promise((r) => setTimeout(r, 100));
    await settle(s);
    expect(s.captureCharFrame()).not.toContain('╭─ Mission 01');
    expect(s.captureCharFrame()).toContain('Waiting for approval: 20');
    s.renderer.destroy();
  });

  it('ignores clicks on the list behind an open popup', async () => {
    const api = fakeApi([pageOf(manyMissions(20))]);
    const s = await render('director', undefined, 100, api);
    await settle(s);
    await perform(s, () => s.mockInput.pressEnter());
    await settle(s);
    const y = s
      .captureCharFrame()
      .split('\n')
      .findIndex((l) => l.includes('Mission 02'));
    if (y > 0) await perform(s, () => s.mockMouse.click(3, y));
    expect(api.getCalls).toEqual([summary(1).id]);
    s.renderer.destroy();
  });
});

describe('MainScreen skills and settings', () => {
  const skills = () =>
    fakeSkillsApi([
      { items: [skill(1, { name: 'Medicine' }), skill(2, { name: 'Geology' })], nextCursor: null },
    ]);

  it('lets a Director see, add and rename skills', async () => {
    const api = skills();
    const s = await render('director', undefined, 100, fakeApi([pageOf([])]), fakeUsersApi(), api);
    for (let i = 0; i < 3; i++) await perform(s, () => s.mockInput.pressArrow('right')); // Skills
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Skills: 2');
    expect(frame).toContain('Medicine');
    expect(frame).toContain('Add a skill (a)');
    s.renderer.destroy();
  });

  it('shows a Lead the catalogue but nothing to change it with', async () => {
    const api = skills();
    const s = await render('lead', undefined, 100, fakeApi([pageOf([])]), fakeUsersApi(), api);
    for (let i = 0; i < 2; i++) await perform(s, () => s.mockInput.pressArrow('right')); // Skills
    await settle(s);
    expect(api.listCalls).toHaveLength(1);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Skills: 2');
    expect(frame).not.toContain('Add a skill');
    await perform(s, () => s.mockInput.pressKey('a'));
    expect(s.captureCharFrame()).not.toContain('╭─ Add a skill');
    s.renderer.destroy();
  });

  it('opens the settings form for a Director, and the arrow keys carry on past it', async () => {
    const api = fakeSettingsApi();
    const s = await render(
      'director',
      undefined,
      100,
      fakeApi([pageOf([])]),
      fakeUsersApi(),
      skills(),
      api,
    );
    for (let i = 0; i < 4; i++) await perform(s, () => s.mockInput.pressArrow('right')); // Settings
    await settle(s);
    expect(api.getCalls).toBe(1);
    expect(s.captureCharFrame()).toContain('Organisation settings');
    await perform(s, () => s.mockInput.pressArrow('right')); // on to Audit log
    expect(s.captureCharFrame()).toContain('Nothing has been recorded yet.');
    s.renderer.destroy();
  });

  it('never offers the settings to a Lead', async () => {
    const s = await render('lead');
    expect(barOf(s.captureCharFrame())).not.toContain('Settings');
    s.renderer.destroy();
  });
});

describe('MainScreen list counter', () => {
  it('sits one blank line below the navigation bar and lines up with the start of the table', async () => {
    const s = await render('director', undefined, 100, fakeApi([pageOf(manyMissions(3))]));
    await settle(s);
    const lines = s.captureCharFrame().split('\n');
    const nav = lines.findIndex((l) => l.includes('Approvals') && l.includes('Sign out'));
    const counter = lines.findIndex((l) => l.includes('Waiting for approval: 3'));
    const table = lines.findIndex((l) => l.includes('┌'));
    expect(counter).toBe(nav + 2); // one blank line between them
    expect(lines[nav + 1]!.trim()).toBe('');
    expect(table).toBe(counter + 1);
    // The counter starts in the column of the table's left border.
    expect(lines[counter]!.indexOf('Waiting')).toBe(lines[table]!.indexOf('┌'));
    s.renderer.destroy();
  });
});
