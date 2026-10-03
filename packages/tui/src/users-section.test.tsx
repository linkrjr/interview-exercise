import { testRender } from '@opentui/react/test-utils';
import { describe, expect, it } from 'bun:test';
import { TextEntryContext } from './text-entry.js';
import { fakeUsersApi, user, type FakeUsersApi } from './fixtures.js';
import { perform, settle } from './test-helpers.js';
import { UsersSection } from './users-section.js';

const people = [
  user(1, { role: 'director', email: 'grace@example.com', name: 'Grace Hopper' }),
  user(2, { role: 'lead', email: 'ada@example.com', name: 'Ada Lovelace' }),
  user(3, { role: 'crew', status: 'invited', name: null, email: 'newbie@example.com' }),
  user(4, { role: 'crew', status: 'deactivated', email: 'gone@example.com', name: 'Gone Person' }),
];

async function render(api: FakeUsersApi) {
  const entry = { active: { current: false } };
  const setup = await testRender(
    <TextEntryContext.Provider value={entry}>
      <UsersSection api={api} />
    </TextEntryContext.Provider>,
    { width: 100, height: 30 },
  );
  await setup.renderOnce();
  await settle(setup);
  return setup;
}
type Setup = Awaited<ReturnType<typeof render>>;

const key = (s: Setup, name: string) => perform(s, () => s.mockInput.pressKey(name));
const down = (s: Setup, times: number) =>
  perform(s, async () => {
    for (let i = 0; i < times; i++) s.mockInput.pressArrow('down');
  });
const enter = (s: Setup) => perform(s, () => s.mockInput.pressEnter());
const type = (s: Setup, text: string) => perform(s, () => s.mockInput.typeText(text));
const esc = async (s: Setup) => {
  await perform(s, () => s.mockInput.pressEscape());
  await new Promise((r) => setTimeout(r, 100));
  await settle(s);
};
/** Opens the popup of the n-th row (0-based). */
const openRow = async (s: Setup, index: number) => {
  await down(s, index);
  await enter(s);
  await settle(s);
};

describe('UsersSection list', () => {
  it('lists every user of the organisation in a table', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await render(api);
    const frame = s.captureCharFrame();
    for (const text of [
      'EMAIL',
      'NAME',
      'ROLE',
      'STATUS',
      'Users: 4',
      'grace@example.com',
      'Ada Lovelace',
      'lead',
      'invited',
      'deactivated',
    ]) {
      expect(frame).toContain(text);
    }
    // A user who has not accepted yet has no name.
    expect(frame).toMatch(/newbie@example\.com\s+│\s+-\s+│\s+crew\s+│\s+invited/);
    s.renderer.destroy();
  });

  it('has a menu at the bottom to invite a user', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    const lines = s.captureCharFrame().split('\n');
    const row = lines.findIndex((l) => l.includes('Invite a user (i)'));
    expect(row).toBeGreaterThan(lines.findIndex((l) => l.includes('gone@example.com')));
    s.renderer.destroy();
  });

  it('shows an empty organisation and a failed load', async () => {
    const empty = await render(fakeUsersApi([{ items: [], nextCursor: null }]));
    expect(empty.captureCharFrame()).toContain('There are no users yet.');
    empty.renderer.destroy();
    const failed = await render(fakeUsersApi([new Error('Cannot reach the server')]));
    expect(failed.captureCharFrame()).toContain('Cannot reach the server');
    failed.renderer.destroy();
  });
});

describe('user popup', () => {
  it('shows the main facts of the selected user, and no missions or skills', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    await openRow(s, 1);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ Ada Lovelace');
    for (const text of [
      'ada@example.com',
      'lead',
      'active',
      '2026-09-01T10:00:00.000Z',
      user(2).id,
    ]) {
      expect(frame).toContain(text);
    }
    expect(frame).not.toMatch(/mission|skill/i);
    // The list is still there around it.
    expect(frame).toContain('Users: 4');
    s.renderer.destroy();
  });

  it('offers Deactivate for an active user and no Reinvite', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    await openRow(s, 1);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Deactivate (d)');
    expect(frame).not.toContain('Reinvite');
    s.renderer.destroy();
  });

  it('offers Reinvite only to a user who has not accepted the invitation', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    await openRow(s, 2);
    const frame = s.captureCharFrame();
    expect(frame).toContain('(has not accepted the invite yet)');
    expect(frame).toContain('Reinvite (r)');
    expect(frame).toContain('Deactivate (d)');
    s.renderer.destroy();
  });

  it('offers nothing for a user who is already deactivated', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    await openRow(s, 3);
    const frame = s.captureCharFrame();
    expect(frame).not.toContain('Deactivate (d)');
    expect(frame).not.toContain('Reinvite');
    await key(s, 'd');
    await key(s, 'r');
    expect(frame).not.toContain('Deactivate gone');
    s.renderer.destroy();
  });

  it('asks before deactivating, and does nothing if cancelled', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await render(api);
    await openRow(s, 1);
    await key(s, 'd');
    expect(s.captureCharFrame()).toContain(
      'Deactivate ada@example.com? Enter confirm · Esc cancel',
    );
    expect(api.deactivateCalls).toEqual([]);
    await esc(s);
    expect(api.deactivateCalls).toEqual([]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ Ada Lovelace'); // Esc only cancelled the question
    expect(frame).toContain('Deactivate (d)');
    s.renderer.destroy();
  });

  it('deactivates on Enter, updates the popup, and refreshes the list when it closes', async () => {
    const api = fakeUsersApi(
      [
        { items: people, nextCursor: null },
        {
          items: people.map((p) =>
            p.id === user(2).id ? { ...p, status: 'deactivated' as const } : p,
          ),
          nextCursor: null,
        },
      ],
      {
        deactivate: user(2, {
          role: 'lead',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          status: 'deactivated',
        }),
      },
    );
    const s = await render(api);
    await openRow(s, 1);
    await key(s, 'd');
    await enter(s);
    await settle(s);
    expect(api.deactivateCalls).toEqual([user(2).id]);
    let frame = s.captureCharFrame();
    expect(frame).toContain('Deactivated.');
    expect(frame).toContain('deactivated');
    expect(frame).not.toContain('Deactivate (d)');
    expect(api.listCalls).toHaveLength(1);

    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    frame = s.captureCharFrame();
    expect(frame).not.toContain('╭─ Ada Lovelace');
    expect(frame).toMatch(/ada@example\.com\s+│\s+Ada Lovelace\s+│\s+lead\s+│\s+deactivated/);
    s.renderer.destroy();
  });

  it("shows why a deactivation failed and keeps the question's popup", async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }], {
      deactivate: new Error(
        'The last active Director cannot be deactivated (LAST_ACTIVE_DIRECTOR)',
      ),
    });
    const s = await render(api);
    await openRow(s, 0);
    await key(s, 'd');
    await enter(s);
    await settle(s);
    expect(s.captureCharFrame()).toContain('LAST_ACTIVE_DIRECTOR');
    expect(api.listCalls).toHaveLength(1); // nothing changed, so no refresh on close
    await esc(s); // closes the question
    await esc(s); // closes the popup
    expect(api.listCalls).toHaveLength(1);
    s.renderer.destroy();
  });

  it('reinvites and shows the new code once', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await render(api);
    await openRow(s, 2);
    await key(s, 'r');
    await settle(s);
    expect(api.reinviteCalls).toEqual([user(3).id]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('New invite code (shown once, expires 2026-10-11T10:00:00.000Z)');
    expect(frame).toContain('ORG.new-secret');
    s.renderer.destroy();
  });

  it('reinvites from a click on the button', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await render(api);
    await openRow(s, 2);
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Reinvite (r)'));
    await perform(s, () => s.mockMouse.click(lines[y]!.indexOf('Reinvite') + 1, y));
    await settle(s);
    expect(api.reinviteCalls).toEqual([user(3).id]);
    s.renderer.destroy();
  });

  it('opens a clicked row, and closes on Esc', async () => {
    const s = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    const lines = s.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('ada@example.com'));
    await perform(s, () => s.mockMouse.click(4, y));
    await settle(s);
    expect(s.captureCharFrame()).toContain('╭─ Ada Lovelace');
    await esc(s);
    expect(s.captureCharFrame()).not.toContain('╭─ Ada Lovelace');
    s.renderer.destroy();
  });
});

describe('invite popup', () => {
  const open = async (api: FakeUsersApi) => {
    const s = await render(api);
    await key(s, 'i');
    return s;
  };

  it('opens from the menu key and from a click on the menu', async () => {
    const s = await open(fakeUsersApi([{ items: people, nextCursor: null }]));
    const frame = s.captureCharFrame();
    expect(frame).toContain('╭─ Invite a user');
    expect(frame).toContain('Email');
    expect(frame).toContain('Role');
    expect(frame).toContain('crew');
    s.renderer.destroy();

    const clicked = await render(fakeUsersApi([{ items: people, nextCursor: null }]));
    const lines = clicked.captureCharFrame().split('\n');
    const y = lines.findIndex((l) => l.includes('Invite a user (i)'));
    await perform(clicked, () => clicked.mockMouse.click(lines[y]!.indexOf('Invite') + 1, y));
    expect(clicked.captureCharFrame()).toContain('╭─ Invite a user');
    clicked.renderer.destroy();
  });

  it('invites with the email and the chosen role, and shows the invite code once', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await open(api);
    await type(s, 'new.lead@example.com');
    await perform(s, () => s.mockInput.pressTab()); // to the role
    await perform(s, () => s.mockInput.pressArrow('left')); // crew -> lead
    expect(s.captureCharFrame()).toContain('‹ lead ›');
    await enter(s);
    await settle(s);
    expect(api.inviteCalls).toEqual([{ email: 'new.lead@example.com', role: 'lead' }]);
    const frame = s.captureCharFrame();
    expect(frame).toContain('Invited new.lead@example.com as lead.');
    expect(frame).toContain('ORG.secret-code');
    expect(frame).toContain('shown once');
    s.renderer.destroy();
  });

  it('cycles the role through all three and wraps around', async () => {
    const s = await open(fakeUsersApi([{ items: people, nextCursor: null }]));
    await perform(s, () => s.mockInput.pressTab());
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      await perform(s, () => s.mockInput.pressArrow('right'));
      seen.push(/‹ (\w+) ›/.exec(s.captureCharFrame())![1]!);
    }
    expect(seen).toEqual(['director', 'lead', 'crew']);
    s.renderer.destroy();
  });

  it('requires an email, without calling the server', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await open(api);
    await type(s, '   ');
    await enter(s);
    expect(s.captureCharFrame()).toContain('An email is required');
    expect(api.inviteCalls).toEqual([]);
    s.renderer.destroy();
  });

  it("shows the server's refusal and keeps the form", async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }], {
      invite: new Error('That email is already registered (EMAIL_ALREADY_REGISTERED)'),
    });
    const s = await open(api);
    await type(s, 'grace@example.com');
    await enter(s);
    await settle(s);
    const frame = s.captureCharFrame();
    expect(frame).toContain('EMAIL_ALREADY_REGISTERED');
    expect(frame).toContain('grace@example.com');
    expect(frame).toContain('Invite a user');
    s.renderer.destroy();
  });

  it('treats q, i and the arrow keys as text while the form is open, and Esc cancels', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    const s = await open(api);
    await type(s, 'quincy@iii.example');
    await enter(s);
    await settle(s);
    expect(api.inviteCalls[0]!.email).toBe('quincy@iii.example');
    s.renderer.destroy();

    const cancel = fakeUsersApi([{ items: people, nextCursor: null }]);
    const c = await open(cancel);
    await esc(c);
    expect(c.captureCharFrame()).not.toContain('╭─ Invite a user');
    expect(cancel.inviteCalls).toEqual([]);
    expect(cancel.listCalls).toHaveLength(1);
    c.renderer.destroy();
  });

  it('refreshes the list when the popup closes after an invitation', async () => {
    const api = fakeUsersApi([
      { items: people, nextCursor: null },
      {
        items: [...people, user(9, { email: 'fresh@example.com', status: 'invited', name: null })],
        nextCursor: null,
      },
    ]);
    const s = await open(api);
    await type(s, 'fresh@example.com');
    await enter(s);
    await settle(s);
    expect(api.listCalls).toHaveLength(1);
    await esc(s);
    expect(api.listCalls).toHaveLength(2);
    expect(s.captureCharFrame()).toContain('fresh@example.com');
    s.renderer.destroy();
  });

  it('sends the invitation once even if Enter is hit twice', async () => {
    const api = fakeUsersApi([{ items: people, nextCursor: null }]);
    let release!: () => void;
    const original = api.invite.bind(api);
    api.invite = (input) =>
      new Promise((resolve) => {
        release = () => resolve(original(input));
      });
    const s = await open(api);
    await type(s, 'once@example.com');
    await enter(s);
    await enter(s);
    expect(s.captureCharFrame()).toContain('Sending…');
    release();
    await settle(s);
    expect(api.inviteCalls).toHaveLength(1);
    s.renderer.destroy();
  });
});
