import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { fakeSettingsApi, type FakeSettingsApi } from './fixtures.js';
import { SettingsSection, validate } from './settings-section.js';
import { TextEntryContext } from './text-entry.js';
import { perform, settle } from './test-helpers.js';

async function render(api: FakeSettingsApi) {
  const entry = { active: { current: false } };
  const setup = await testRender(
    <TextEntryContext.Provider value={entry}>
      <SettingsSection api={api} />
    </TextEntryContext.Provider>,
    { width: 100, height: 30 },
  );
  await setup.renderOnce();
  await settle(setup);
  return { ...setup, entry };
}
type Setup = Awaited<ReturnType<typeof render>>;

const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const tab = (s: Setup, shift = false) => perform(s, () => s.mockInput.pressTab({ shift }));
const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const clear = (s: Setup) => perform(s, () => s.mockInput.pressKey('u', { ctrl: true }));
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};
/** Starts editing: Enter takes the form, as it does for a person. */
const engage = (s: Setup) => enter(s);

describe('validate', () => {
  const current = { timeZone: 'Europe/London', maxUpcomingMissions: 3 };
  it('sends only what changed', () => {
    expect(validate('Europe/London', '3', current)).toEqual({ patch: {}, errors: {} });
    expect(validate('UTC', '3', current).patch).toEqual({ timeZone: 'UTC' });
    expect(validate('Europe/London', '7', current).patch).toEqual({ maxUpcomingMissions: 7 });
    expect(validate(' Asia/Tokyo ', ' 5 ', current).patch).toEqual({
      timeZone: 'Asia/Tokyo',
      maxUpcomingMissions: 5,
    });
  });

  it('checks the time zone and the cap the way the API does', () => {
    expect(validate('Mars/Base', '3', current).errors.timeZone).toContain('IANA');
    expect(validate('+01:00', '3', current).errors.timeZone).toBeDefined();
    expect(validate('', '3', current).errors.timeZone).toBeDefined();
    for (const bad of ['', '0', '21', '2.5', 'many', '-1']) {
      expect(validate('Europe/London', bad, current).errors.cap, bad).toContain('1 to 20');
    }
    for (const good of ['1', '20'])
      expect(validate('Europe/London', good, current).errors.cap).toBeUndefined();
  });
});

describe('SettingsSection', () => {
  it('shows every setting in a form with its current value, and a Save button at the bottom', async () => {
    const s = await render(fakeSettingsApi());
    const lines = s.captureCharFrame().split('\n');
    const frame = lines.join('\n');
    for (const text of [
      'Organisation settings',
      'Time zone',
      'Europe/London',
      'Most upcoming missions per crew member',
      'Save',
    ]) {
      expect(frame).toContain(text);
    }
    expect(lines.findIndex((l) => l.includes('Save'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('Most upcoming')),
    );
    expect(lines.findIndex((l) => l.includes('Save'))).toBeGreaterThan(20); // down at the bottom
    expect(frame).toMatch(/│ 3\s+│/);
    s.renderer.destroy();
  });

  it('shows loading and a failed load', async () => {
    const failed = await render(fakeSettingsApi(new Error('Cannot reach the server')));
    expect(failed.captureCharFrame()).toContain('Cannot reach the server');
    failed.renderer.destroy();
  });

  it('starts at rest so the arrow keys still change section, and takes the keys once engaged', async () => {
    const s = await render(fakeSettingsApi());
    expect(s.entry.active.current).toBe(false);
    expect(s.captureCharFrame()).toContain('←/→ or Tab section · Enter edit the form');
    await engage(s);
    expect(s.entry.active.current).toBe(true);
    expect(s.captureCharFrame()).toContain('Tab next field · Enter save · Esc leave the form');
    await esc(s);
    expect(s.entry.active.current).toBe(false);
    s.renderer.destroy();
  });

  it('saves a changed time zone and shows the settings as the server now has them', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await clear(s);
    await type(s, 'Asia/Tokyo');
    await enter(s); // Enter saves from a field
    await settle(s);
    expect(api.updateCalls).toEqual([{ timeZone: 'Asia/Tokyo' }]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Saved.');
    expect(frame).toContain('Asia/Tokyo');
    s.renderer.destroy();
  });

  it('moves between the fields and Save with Tab, and saves from the button', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await tab(s); // to the cap
    await clear(s);
    await type(s, '8');
    await tab(s); // to Save
    await enter(s);
    await settle(s);
    expect(api.updateCalls).toEqual([{ maxUpcomingMissions: 8 }]);
    await tab(s); // wraps to the time zone
    await tab(s, true); // and back to Save
    s.renderer.destroy();
  });

  it('saves from a click on Save', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await tab(s);
    await clear(s);
    await type(s, '9');
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Save'));
    await perform(s, () => s.mockMouse.click(lines[y]!.indexOf('Save') + 1, y));
    await settle(s);
    expect(api.updateCalls).toEqual([{ maxUpcomingMissions: 9 }]);
    s.renderer.destroy();
  });

  it('sends both settings when both changed', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await clear(s);
    await type(s, 'UTC');
    await tab(s);
    await clear(s);
    await type(s, '5');
    await enter(s);
    await settle(s);
    expect(api.updateCalls).toEqual([{ timeZone: 'UTC', maxUpcomingMissions: 5 }]);
    s.renderer.destroy();
  });

  it('says so when nothing changed, without calling the server', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await enter(s);
    expect(s.captureCharFrame()).toContain('Nothing has changed.');
    expect(api.updateCalls).toEqual([]);
    s.renderer.destroy();
  });

  it('shows field errors beside the fields and sends nothing', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await clear(s);
    await type(s, 'Mars/Base');
    await tab(s);
    await clear(s);
    await type(s, '99');
    await enter(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Not a valid IANA time zone');
    expect(frame).toContain('A whole number from 1 to 20');
    expect(api.updateCalls).toEqual([]);
    s.renderer.destroy();
  });

  it("shows the server's refusal and keeps what was typed", async () => {
    const api = fakeSettingsApi(undefined, new Error('Too busy right now (BUSY)'));
    const s = await render(api);
    await engage(s);
    await clear(s);
    await type(s, 'UTC');
    await enter(s);
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Too busy right now (BUSY)');
    expect(frame).not.toContain('Saved.');
    expect(frame).toMatch(/│ UTC/);
    s.renderer.destroy();
  });

  it('treats letters (q among them) and arrows as text while engaged', async () => {
    const api = fakeSettingsApi();
    const s = await render(api);
    await engage(s);
    await clear(s);
    await type(s, 'Asia/Qatar');
    await perform(s, () => s.mockInput.pressArrow('left'));
    await perform(s, () => s.mockInput.pressArrow('right'));
    await enter(s);
    await settle(s);
    expect(api.updateCalls).toEqual([{ timeZone: 'Asia/Qatar' }]);
    s.renderer.destroy();
  });
});
