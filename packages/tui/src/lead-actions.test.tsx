import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import {
  crewProfile,
  fakeApi,
  fakeCrewApi,
  fakeSkillsApi,
  mission,
  onePage,
  pageOf,
  skill,
} from './fixtures.js';
import { allowedEdits, MissionView } from './mission-view.js';
import { parseRequirement, resolveRequirements } from './mission-edit-popups.js';
import { NewMissionSection } from './new-mission-section.js';
import { perform, settle } from './test-helpers.js';

const draft = (over = {}) =>
  mission({
    status: 'draft',
    crew: [],
    crewValidation: undefined,
    allowedActions: ['start_crewing', 'cancel'],
    ...over,
  });

async function view(api: ReturnType<typeof fakeApi>, extra: { changed?: () => void } = {}) {
  const crew = fakeCrewApi([onePage([crewProfile(1), crewProfile(2)])]);
  const skills = fakeSkillsApi([onePage([skill(1, { name: 'Orbital Piloting' })])]);
  const setup = await testRender(
    <MissionView
      api={api}
      skills={skills}
      crew={crew}
      missionId={mission().id}
      name="Mission 01"
      onBack={() => {}}
      onChanged={extra.changed}
    />,
    { width: 110, height: 40 },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof view>>;
const press = (s: Setup, key: string) =>
  perform(s, () => {
    if (key === 'down') s.mockInput.pressArrow('down');
    else if (key === 'backspace') s.mockInput.pressBackspace();
    else s.mockInput.pressKey(key);
  });
const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};

describe('the Lead moves on a mission', () => {
  it('shows only the moves the server allows, and nothing for a Director deciding', async () => {
    const s = await view(fakeApi([pageOf([])], draft()));
    const frame = s.captureCharFrame();
    expect(frame).toContain('Start crewing (s)');
    expect(frame).toContain('Cancel mission (x)');
    expect(frame).not.toContain('Submit (u)');
    expect(frame).not.toContain('Approve (a)');
    s.renderer.destroy();
  });

  it('asks first, then moves with the version seen and shows the updated mission', async () => {
    const changed: string[] = [];
    const api = fakeApi(
      [pageOf([])],
      draft(),
      undefined,
      mission({ status: 'crewing', version: 4, allowedActions: ['reopen', 'submit', 'cancel'] }),
    );
    const s = await view(api, { changed: () => void changed.push('yes') });
    await press(s, 's');
    expect(s.captureCharFrame()).toContain('Start crewing this mission? Enter confirm');
    expect(api.changeCalls).toEqual([]);
    await enter(s);
    await settle(s);
    expect(api.changeCalls).toEqual([
      { call: 'transition', id: mission().id, args: ['start_crewing', 3] },
    ]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Now being crewed.');
    expect(frame).toContain('Submit (u)');
    expect(frame).not.toContain('Start crewing (s)');
    expect(changed).toEqual(['yes']);
    s.renderer.destroy();
  });

  it('Esc cancels the question without moving, and the mission stays open', async () => {
    const api = fakeApi([pageOf([])], draft());
    const s = await view(api);
    await press(s, 'x');
    expect(s.captureCharFrame()).toContain('Cancel this mission?');
    await esc(s);
    expect(s.captureCharFrame()).not.toContain('Cancel this mission?');
    expect(s.captureCharFrame()).toContain('Cancel mission (x)');
    expect(api.changeCalls).toEqual([]);
    s.renderer.destroy();
  });

  it("shows the server's refusal and keeps the question open", async () => {
    const api = fakeApi([pageOf([])], draft(), undefined, new Error('Mission changed (CONFLICT)'));
    const s = await view(api);
    await press(s, 's');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('Mission changed (CONFLICT)');
    s.renderer.destroy();
  });

  it('ignores a move the server did not allow', async () => {
    const api = fakeApi([pageOf([])], draft());
    const s = await view(api);
    await press(s, 'u');
    await enter(s);
    expect(api.changeCalls).toEqual([]);
    s.renderer.destroy();
  });
});

describe('editing a mission', () => {
  it('offers edits by what the server allows: none to a Director, requirements in Draft, crew in Crewing', () => {
    expect(allowedEdits(['approve', 'reject'])).toEqual([]);
    expect(allowedEdits(['start_crewing', 'cancel'])).toEqual(['edit', 'requirements']);
    expect(allowedEdits(['reopen', 'submit', 'cancel'])).toEqual(['edit', 'requirements', 'crew']);
  });

  it('sends only the fields that changed', async () => {
    const api = fakeApi([pageOf([])], draft(), undefined, draft({ name: 'Renamed', version: 4 }));
    const s = await view(api);
    await press(s, 'e');
    expect(s.captureCharFrame()).toContain('Edit mission');
    await press(s, 'backspace');
    await type(s, 'X');
    await enter(s);
    await settle(s);
    expect(api.changeCalls).toHaveLength(1);
    expect(api.changeCalls[0]!.call).toBe('update');
    expect(Object.keys(api.changeCalls[0]!.args[0] as object)).toEqual(['name']);
    expect(api.changeCalls[0]!.args[1]).toBe(3);
    expect(s.captureCharFrame()).toContain('Renamed');
    s.renderer.destroy();
  });

  it('says so, without calling the server, when nothing changed', async () => {
    const api = fakeApi([pageOf([])], draft());
    const s = await view(api);
    await press(s, 'e');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('Nothing changed');
    expect(api.changeCalls).toEqual([]);
    s.renderer.destroy();
  });

  it('Esc closes the editor first and the mission stays', async () => {
    const api = fakeApi([pageOf([])], draft());
    const s = await view(api);
    await press(s, 'e');
    await esc(s);
    const frame = s.captureCharFrame();
    expect(frame).not.toContain('Edit mission');
    expect(frame).toContain('Mission 01');
    s.renderer.destroy();
  });

  it('sets requirements by skill name, and refuses an unknown skill locally', async () => {
    const api = fakeApi(
      [pageOf([])],
      draft({ requirements: [] }),
      undefined,
      draft({ version: 4 }),
    );
    const s = await view(api);
    await press(s, 'p');
    await type(s, 'Nonexistent:3:1');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('There is no skill called "Nonexistent"');
    expect(api.changeCalls).toEqual([]);
    for (let i = 0; i < 15; i++) await press(s, 'backspace');
    await type(s, 'orbital piloting:4:2');
    await enter(s);
    await settle(s);
    expect(api.changeCalls).toEqual([
      {
        call: 'setRequirements',
        id: mission().id,
        args: [[{ skillId: skill(1).id, minLevel: 4, count: 2 }], 3],
      },
    ]);
    expect(s.captureCharFrame()).toContain('Requirements saved.');
    s.renderer.destroy();
  });

  it('picks the crew with Space and saves with Enter', async () => {
    const api = fakeApi(
      [pageOf([])],
      mission({ allowedActions: ['reopen', 'submit', 'cancel'], crew: [] }),
      undefined,
      mission({ version: 4 }),
    );
    const s = await view(api);
    await press(s, 'c');
    expect(s.captureCharFrame()).toContain('Crew 01');
    await press(s, ' ');
    await press(s, 'down');
    await press(s, ' ');
    expect(s.captureCharFrame()).toContain('[x] Crew 01');
    expect(s.captureCharFrame()).toContain('[x] Crew 02');
    await press(s, ' '); // Crew 02 again: unticked
    await enter(s);
    await settle(s);
    expect(api.changeCalls).toEqual([
      { call: 'setCrew', id: mission().id, args: [[crewProfile(1).id], 3] },
    ]);
    expect(s.captureCharFrame()).toContain('Crew saved.');
    s.renderer.destroy();
  });
});

describe('requirement text', () => {
  it('splits from the right so a skill name may contain colons', () => {
    expect(parseRequirement('Zero-G: Basic:2:3')).toEqual({
      name: 'Zero-G: Basic',
      minLevel: 2,
      count: 3,
    });
  });

  it('refuses a level outside 1-5 or a count below 1', () => {
    expect(() => parseRequirement('A:6:1')).toThrow('Invalid');
    expect(() => parseRequirement('A:3:0')).toThrow('Invalid');
    expect(() => parseRequirement('3:1')).toThrow('Invalid');
  });

  it('resolves several, ignoring blanks', () => {
    const catalogue = [skill(1, { name: 'A' }), skill(2, { name: 'B' })];
    expect(resolveRequirements('a:1:1; ; B:5:2;', catalogue)).toEqual([
      { skillId: catalogue[0]!.id, minLevel: 1, count: 1 },
      { skillId: catalogue[1]!.id, minLevel: 5, count: 2 },
    ]);
  });
});

describe('New mission', () => {
  async function section(api = fakeApi([pageOf([])], draft(), undefined, draft())) {
    const setup = await testRender(
      <NewMissionSection api={api} skills={fakeSkillsApi()} crew={fakeCrewApi()} />,
      { width: 110, height: 40 },
    );
    await setup.renderOnce();
    await settle(setup);
    return { setup, api };
  }

  it('starts at rest with a button, and opens the form on n', async () => {
    const { setup, api } = await section();
    expect(setup.captureCharFrame()).toContain('Plan a mission (n)');
    expect(setup.captureCharFrame()).not.toContain('End (last day)');
    await perform(setup, () => setup.mockInput.pressKey('n'));
    expect(setup.captureCharFrame()).toContain('End (last day)');
    expect(api.changeCalls).toEqual([]);
    setup.renderer.destroy();
  });

  it('refuses bad input locally, then creates and shows the mission', async () => {
    const { setup, api } = await section();
    await perform(setup, () => setup.mockInput.pressKey('n'));
    await perform(setup, () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(api.changeCalls).toEqual([]);
    expect(setup.captureCharFrame()).toMatch(/Too small|Invalid|required/i);

    await perform(setup, () => setup.mockInput.typeText('Relay'));
    await perform(setup, () => setup.mockInput.pressTab());
    await perform(setup, () => setup.mockInput.typeText('2027-03-10'));
    await perform(setup, () => setup.mockInput.pressTab());
    await perform(setup, () => setup.mockInput.typeText('2027-03-01'));
    await perform(setup, () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(api.changeCalls).toEqual([]);
    expect(setup.captureCharFrame()).toContain('must not be before');

    // Fix the end date (the field is focused: select it by retyping from scratch).
    for (let i = 0; i < 12; i++) await perform(setup, () => setup.mockInput.pressBackspace());
    await perform(setup, () => setup.mockInput.typeText('2027-03-12'));
    await perform(setup, () => setup.mockInput.pressEnter());
    await settle(setup);
    expect(api.changeCalls).toHaveLength(1);
    expect(api.changeCalls[0]!.call).toBe('create');
    expect(api.changeCalls[0]!.args[0]).toEqual({
      name: 'Relay',
      startDate: '2027-03-10',
      endDate: '2027-03-12',
      description: '',
    });
    expect(setup.captureCharFrame()).toContain('Created');
    expect(setup.captureCharFrame()).toContain('Start crewing (s)');
    setup.renderer.destroy();
  });
});
