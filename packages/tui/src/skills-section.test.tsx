import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { fakeSkillsApi, skill, type FakeSkillsApi } from './fixtures.js';
import { SkillsSection } from './skills-section.js';
import { TextEntryContext } from './text-entry.js';
import { perform, settle } from './test-helpers.js';

const catalogue = [
  skill(1, { name: 'Medicine' }),
  skill(2, { name: 'Orbital Piloting' }),
  skill(3, { name: 'Geology' }),
];

async function render(api: FakeSkillsApi, canManage = true) {
  const entry = { active: { current: false } };
  const setup = await testRender(
    <TextEntryContext.Provider value={entry}>
      <SkillsSection api={api} canManage={canManage} />
    </TextEntryContext.Provider>,
    { width: 100, height: 30 },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;

const key = (s: Setup, name: string) => perform(s, () => s.mockInput.pressKey(name));
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};
const openRow = async (s: Setup, index: number) => {
  await perform(s, async () => {
    for (let i = 0; i < index; i++) s.mockInput.pressArrow('down');
  });
  await enter(s);
  await settle(s);
};
const pages = (items = catalogue) => [{ items, nextCursor: null }];

describe('SkillsSection list', () => {
  it('lists all the skills in a bordered table', async () => {
    const s = await render(fakeSkillsApi(pages()));
    const frame = s.captureCharFrame();
    for (const text of [
      'Skills: 3',
      'NAME',
      'CREATED',
      'Medicine',
      'Orbital Piloting',
      'Geology',
      '2026-09-02',
      '┌',
      '└',
    ]) {
      expect(frame).toContain(text);
    }
    s.renderer.destroy();
  });

  it('has a menu at the bottom to add a skill, for a Director', async () => {
    const s = await render(fakeSkillsApi(pages()));
    const lines = s.captureCharFrame().split('\n');
    expect(lines.findIndex((l) => l.includes('Add a skill (a)'))).toBeGreaterThan(
      lines.findIndex((l) => l.includes('└')),
    );
    s.renderer.destroy();
  });

  it('shows an empty catalogue and a failed load', async () => {
    const empty = await render(fakeSkillsApi(pages([])));
    expect(empty.captureCharFrame()).toContain('There are no skills yet: add one below.');
    empty.renderer.destroy();
    const failed = await render(fakeSkillsApi([new Error('Cannot reach the server')]));
    expect(failed.captureCharFrame()).toContain('Cannot reach the server');
    failed.renderer.destroy();
  });
});

describe('skill popup', () => {
  it('shows the skill info of the selected row, with Rename for a Director', async () => {
    const s = await render(fakeSkillsApi(pages()));
    await openRow(s, 1);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ Orbital Piloting');
    for (const text of ['2026-09-02T10:00:00.000Z', skill(2).id, 'Rename (r)'])
      expect(frame).toContain(text);
    expect(frame).toContain('Skills: 3'); // the list is still there around it
    s.renderer.destroy();
  });

  it('is read-only for anyone who cannot manage the catalogue: no Rename, no Add', async () => {
    const api = fakeSkillsApi(pages());
    const s = await render(api, false);
    expect(s.captureCharFrame()).not.toContain('Add a skill');
    await key(s, 'a'); // nothing happens
    expect(s.captureCharFrame()).not.toContain('Add a skill');
    await openRow(s, 0);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ Medicine');
    expect(frame).not.toContain('Rename');
    await key(s, 'r');
    expect(s.captureCharFrame()).not.toContain('New name');
    expect(api.renameCalls).toEqual([]);
    s.renderer.destroy();
  });

  it('renames: the form starts with the current name, Enter saves, and the list refreshes on close', async () => {
    const api = fakeSkillsApi(
      [
        { items: catalogue, nextCursor: null },
        { items: [catalogue[0]!, skill(2, { name: 'Piloting' }), catalogue[2]!], nextCursor: null },
      ],
      { rename: skill(2, { name: 'Piloting' }) },
    );
    const s = await render(api);
    await openRow(s, 1);
    await key(s, 'r');
    let frame = s.captureCharFrame();
    expect(frame).toContain('New name');
    expect(frame).toContain('Orbital Piloting'); // prefilled
    await perform(s, () => s.mockInput.pressKey('u', { ctrl: true })); // clear the line
    await type(s, 'Piloting');
    await enter(s);
    await settle(s);
    expect(api.renameCalls).toEqual([{ id: skill(2).id, name: 'Piloting' }]);
    frame = s.captureCharFrame();
    expect(frame).toContain('Renamed.');
    expect(frame).toContain('╭─ Piloting');
    expect(api.listCalls).toHaveLength(1);
    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    expect(s.captureCharFrame()).toMatch(/Piloting\s+│\s+2026-09-02/);
    s.renderer.destroy();
  });

  it('refuses a blank name locally and shows the server refusal, keeping the form', async () => {
    const api = fakeSkillsApi(pages(), {
      rename: new Error('A skill with that name already exists (SKILL_NAME_TAKEN)'),
    });
    const s = await render(api);
    await openRow(s, 0);
    await key(s, 'r');
    await perform(s, () => s.mockInput.pressKey('u', { ctrl: true }));
    await enter(s);
    expect(s.captureCharFrame()).toContain('A name is required');
    expect(api.renameCalls).toEqual([]);
    await type(s, 'Geology');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('SKILL_NAME_TAKEN');
    expect(s.captureCharFrame()).toContain('New name');
    await esc(s); // closes the form
    await esc(s); // closes the popup
    expect(api.listCalls).toHaveLength(1); // nothing changed, so no refresh
    s.renderer.destroy();
  });

  it('treats r and q as text while renaming', async () => {
    const api = fakeSkillsApi(pages());
    const s = await render(api);
    await openRow(s, 0);
    await key(s, 'r');
    await perform(s, () => s.mockInput.pressKey('u', { ctrl: true }));
    await type(s, 'rq');
    await enter(s);
    await settle(s);
    expect(api.renameCalls[0]!.name).toBe('rq');
    s.renderer.destroy();
  });
});

describe('add skill popup', () => {
  it('opens from the menu key and from a click on the menu', async () => {
    const s = await render(fakeSkillsApi(pages()));
    await key(s, 'a');
    expect(s.captureCharFrame()).toContain('╭─ Add a skill');
    s.renderer.destroy();

    const clicked = await render(fakeSkillsApi(pages()));
    const lines = clicked.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Add a skill (a)'));
    await perform(clicked, () => clicked.mockMouse.click(lines[y]!.indexOf('Add') + 1, y));
    expect(clicked.captureCharFrame()).toContain('╭─ Add a skill');
    clicked.renderer.destroy();
  });

  it('adds a skill with a name, tidies the spacing, and refreshes the list on close', async () => {
    const api = fakeSkillsApi([
      { items: catalogue, nextCursor: null },
      { items: [...catalogue, skill(9, { name: 'Robotics' })], nextCursor: null },
    ]);
    const s = await render(api);
    await key(s, 'a');
    await type(s, '  Robotics  ');
    await enter(s);
    await settle(s);
    expect(api.createCalls).toEqual(['Robotics']);
    expect(s.captureCharFrame()).toContain('Added Robotics.');
    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    expect(s.captureCharFrame()).toContain('Robotics');
    s.renderer.destroy();
  });

  it('requires a name, shows the server refusal, and cancels on Esc', async () => {
    const api = fakeSkillsApi(pages(), {
      create: new Error('A skill with that name already exists (SKILL_NAME_TAKEN)'),
    });
    const s = await render(api);
    await key(s, 'a');
    await enter(s);
    expect(s.captureCharFrame()).toContain('A name is required');
    expect(api.createCalls).toEqual([]);
    await type(s, 'Medicine');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('SKILL_NAME_TAKEN');
    await esc(s);
    expect(s.captureCharFrame()).not.toContain('╭─ Add a skill');
    expect(api.listCalls).toHaveLength(1);
    s.renderer.destroy();
  });
});
