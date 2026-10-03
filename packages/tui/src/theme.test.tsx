import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { App } from './app.js';
import {
  fakeApis,
  fakeApi,
  fakeSettingsApi,
  fakeSkillsApi,
  fakeUsersApi,
  manyMissions,
  mission,
  pageOf,
  summary,
  user,
} from './fixtures.js';
import type { SessionInfo } from './session.js';
import { FIELD, PALETTES } from './theme.js';
import { perform, settle } from './test-helpers.js';

type Rgb = [number, number, number];
const BLUE: Rgb = [10, 0, 178];
const CYAN: Rgb = [81, 179, 180];
const GREY: Rgb = [178, 180, 177];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const hex = (rgb: Rgb) =>
  `#${rgb
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;

describe('the Clipper palette', () => {
  it('is the three colours of the spec', () => {
    expect(PALETTES.screen.bg).toBe(hex(BLUE));
    expect(PALETTES.screen.fg).toBe(hex(WHITE));
    expect(PALETTES.popup.bg).toBe(hex(CYAN));
    expect(PALETTES.popup.fg).toBe(hex(BLUE));
    expect(FIELD.bg as string).toBe(hex(GREY));
    expect(FIELD.fg as string).toBe(hex(BLACK));
  });
});

const signedIn: SessionInfo = {
  apiUrl: 'http://x',
  orgId: 'org-1',
  role: 'director',
  signedIn: true,
};
const signedOut: SessionInfo = {
  apiUrl: 'http://x',
  orgId: 'org-1',
  role: undefined,
  signedIn: false,
};

async function render(session: SessionInfo, users = fakeUsersApi()) {
  const waiting = mission({
    ...summary(1),
    status: 'pending_approval',
    allowedActions: ['approve', 'reject'],
    crewValidation: undefined,
  });
  const setup = await testRender(
    <App
      session={session}
      apis={fakeApis({
        missions: fakeApi([pageOf(manyMissions(6))], waiting),
        users: users,
        skills: fakeSkillsApi(),
        settings: fakeSettingsApi(),
      })}
      onLogin={async () => signedIn}
      onAcceptInvite={() => Promise.reject(new Error('unused'))}
      onSignOut={async () => signedOut}
    />,
    { width: 100, height: 30 },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;

/** The colours of the cells that show `text`. */
function colorsOf(setup: Setup, text: string): { fg: Rgb; bg: Rgb } {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    for (const span of line.spans) {
      const at = span.text.indexOf(text);
      if (at >= 0) {
        const [fr, fg, fb] = span.fg.toInts();
        const [br, bg, bb] = span.bg.toInts();
        return { fg: [fr, fg, fb], bg: [br, bg, bb] };
      }
    }
  }
  throw new Error(`"${text}" is not on the screen:\n${setup.captureCharFrame()}`);
}

describe('the screens are white on blue', () => {
  it('colours the login screen, the navigation bar and the list', async () => {
    const login = await render(signedOut);
    expect(colorsOf(login, 'Organisation').bg).toEqual(BLUE);
    expect(colorsOf(login, 'Tab next field').bg).toEqual(BLUE);
    login.renderer.destroy();

    const main = await render(signedIn);
    expect(colorsOf(main, 'Missions').bg).toEqual(BLUE); // the navigation bar
    expect(colorsOf(main, 'Missions').fg).toEqual(WHITE);
    expect(colorsOf(main, '←/→ or Tab section').bg).toEqual(BLUE);
    expect(colorsOf(main, 'Mission 02').bg).toEqual(BLUE); // a list row
    expect(colorsOf(main, 'Mission 02').fg).toEqual(WHITE);
    main.renderer.destroy();
  });

  it('fills the whole screen, not just the text', async () => {
    const main = await render(signedIn);
    const frame = main.captureSpans();
    const seen = new Set(
      frame.lines.flatMap((l) => l.spans.map((s) => s.bg.toInts().slice(0, 3).join(','))),
    );
    // Blue everywhere, but for the selected row and navigation item (cyan).
    expect([...seen].sort()).toEqual(['10,0,178', '81,179,180']);
    main.renderer.destroy();
  });

  it('shows the selected row and the selected navigation item inverted', async () => {
    const main = await render(signedIn);
    expect(colorsOf(main, 'Mission 01')).toEqual({ fg: BLUE, bg: CYAN });
    expect(colorsOf(main, 'Approvals')).toEqual({ fg: BLUE, bg: CYAN });
    main.renderer.destroy();
  });
});

describe('popups are blue on cyan', () => {
  it('colours the mission popup', async () => {
    const main = await render(signedIn);
    await perform(main, () => main.mockInput.pressEnter());
    await settle(main);
    expect(colorsOf(main, 'Status: pending_approval')).toEqual({ fg: BLUE, bg: CYAN });
    expect(colorsOf(main, 'PgUp/PgDn scroll').bg).toEqual(CYAN);
    // The list behind it is still blue.
    expect(colorsOf(main, 'Waiting for approval').bg).toEqual(BLUE);
    main.renderer.destroy();
  });

  it('colours the user popup and the invite popup', async () => {
    const users = fakeUsersApi([
      { items: [user(1, { email: 'grace@example.com' })], nextCursor: null },
    ]);
    const main = await render(signedIn, users);
    await perform(main, () => main.mockInput.pressArrow('right'));
    await perform(main, () => main.mockInput.pressArrow('right'));
    await settle(main);
    await perform(main, () => main.mockInput.pressEnter());
    await settle(main);
    expect(colorsOf(main, 'Email').bg).toEqual(CYAN);
    expect(colorsOf(main, 'Status').fg).not.toEqual(WHITE);
    await perform(main, async () => {
      main.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 100));
    });
    await settle(main);
    await perform(main, () => main.mockInput.pressKey('i'));
    expect(colorsOf(main, 'Tab next field').bg).toEqual(CYAN);
    main.renderer.destroy();
  });
});

describe('form fields are black on grey', () => {
  it('colours the login fields and the invite and decision forms', async () => {
    const login = await render({ ...signedOut, orgId: undefined });
    await perform(login, () => login.mockInput.typeText('lee@example.com'));
    expect(colorsOf(login, 'lee@example.com')).toEqual({ fg: BLACK, bg: GREY });
    expect(colorsOf(login, 'organisation id').bg).toEqual(GREY);
    expect(colorsOf(login, 'password').bg).toEqual(GREY);
    login.renderer.destroy();

    const main = await render(signedIn);
    await perform(main, () => main.mockInput.pressEnter());
    await settle(main);
    await perform(main, () => main.mockInput.pressKey('a'));
    await perform(main, () => main.mockInput.typeText('Go ahead'));
    expect(colorsOf(main, 'Go ahead')).toEqual({ fg: BLACK, bg: GREY });
    main.renderer.destroy();
  });
});
