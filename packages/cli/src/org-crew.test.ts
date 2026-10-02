import { describe, expect, it } from 'vitest';
import { runCli } from './program.js';
import { SESSION, makeCli, problem, type RecordedCall, type Responder } from './test-support.js';

const ORG = SESSION.orgId;
const SKILL = {
  id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0010',
  name: 'Medicine',
  createdAt: '2026-10-02T10:00:00.000Z',
};
const PILOT = {
  id: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0011',
  name: 'Orbital Piloting',
  createdAt: '2026-10-02T10:00:00.000Z',
};

async function signedIn(respond: Responder, userId?: string) {
  const cli = await makeCli(respond);
  await cli.store.setCredentials({
    orgId: ORG,
    accessToken: 'tok',
    refreshToken: 'ref',
    ...(userId ? { userId } : {}),
  });
  return cli;
}

const path = (call: RecordedCall) => call.url.replace('http://api.test', '');
const catalogue = (call: RecordedCall) =>
  path(call).startsWith('/v1/skills')
    ? { status: 200, body: { items: [PILOT, SKILL], nextCursor: null } }
    : undefined;

describe('mc org settings', () => {
  it('shows the settings', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { timeZone: 'Europe/London', maxUpcomingMissions: 4 },
    }));
    expect(await runCli(['org', 'settings', 'show'], cli.deps)).toBe(0);
    expect(cli.out.join('')).toContain('Europe/London');
    expect(cli.out.join('')).toContain('4');
    expect(cli.calls[0]).toMatchObject({ method: 'GET', url: 'http://api.test/v1/org/settings' });
  });

  it('sends only the flags it was given', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { timeZone: 'UTC', maxUpcomingMissions: 7 },
    }));
    expect(await runCli(['org', 'settings', 'set', '--max-upcoming', '7'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({ method: 'PATCH', body: { maxUpcomingMissions: 7 } });
    expect(
      await runCli(
        ['org', 'settings', 'set', '--timezone', 'Europe/London', '--max-upcoming', '3'],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls[1]!.body).toEqual({ timeZone: 'Europe/London', maxUpcomingMissions: 3 });
  });

  it('needs something to change and a whole number', async () => {
    const cli = await signedIn(() => ({ status: 200 }));
    expect(await runCli(['org', 'settings', 'set'], cli.deps)).toBe(1);
    expect(await runCli(['org', 'settings', 'set', '--max-upcoming', 'many'], cli.deps)).toBe(1);
    expect(await runCli(['org', 'settings', 'set', '--max-upcoming', '2.5'], cli.deps)).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it("shows the server's field errors", async () => {
    const cli = await signedIn(() => ({
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid',
        errors: [
          {
            field: 'timeZone',
            code: 'custom',
            message: 'Not a valid IANA time zone, e.g. Europe/London',
          },
        ],
      },
    }));
    expect(await runCli(['org', 'settings', 'set', '--timezone', 'Mars/Base'], cli.deps)).toBe(1);
    expect(cli.err.join('')).toContain('timeZone: Not a valid IANA time zone');
  });
});

describe('mc skills', () => {
  it('adds, lists and renames', async () => {
    const cli = await signedIn((call) =>
      call.method === 'GET'
        ? { status: 200, body: { items: [SKILL], nextCursor: 'NEXT' } }
        : { status: call.method === 'POST' ? 201 : 200, body: SKILL },
    );
    expect(await runCli(['skills', 'add', 'Medicine'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/skills',
      body: { name: 'Medicine' },
    });
    expect(await runCli(['skills', 'list', '--limit', '1'], cli.deps)).toBe(0);
    expect(cli.calls[1]!.url).toBe('http://api.test/v1/skills?limit=1');
    expect(cli.out.join('')).toContain('mc skills list --cursor NEXT');
    expect(await runCli(['skills', 'rename', SKILL.id, 'Medical Care'], cli.deps)).toBe(0);
    expect(cli.calls[2]).toMatchObject({
      method: 'PATCH',
      url: `http://api.test/v1/skills/${SKILL.id}`,
      body: { name: 'Medical Care' },
    });
  });

  it('exits 4 for a taken name and 2 for a Lead', async () => {
    expect(
      await runCli(
        ['skills', 'add', 'Medicine'],
        (await signedIn(() => problem(409, 'SKILL_NAME_TAKEN'))).deps,
      ),
    ).toBe(4);
    expect(
      await runCli(
        ['skills', 'add', 'Medicine'],
        (await signedIn(() => problem(403, 'FORBIDDEN'))).deps,
      ),
    ).toBe(2);
  });
});

describe('mc audit list', () => {
  const event = {
    id: 'e1',
    action: 'skill.created',
    entityType: 'skill',
    entityId: SKILL.id,
    actorId: null,
    before: null,
    after: { name: 'Medicine' },
    occurredAt: '2026-10-02T10:00:00.000Z',
  };

  it('passes the filters through and prints a table with the system actor named', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { items: [event], nextCursor: 'CUR' },
    }));
    expect(
      await runCli(
        [
          'audit',
          'list',
          '--entity',
          `mission:${SKILL.id}`,
          '--since',
          '2026-09-01',
          '--until',
          '2026-10-01',
          '--actor',
          'system',
          '--limit',
          '5',
        ],
        cli.deps,
      ),
    ).toBe(0);
    const url = new URL(cli.calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      entity: `mission:${SKILL.id}`,
      since: '2026-09-01',
      until: '2026-10-01',
      actor: 'system',
      limit: '5',
    });
    const text = cli.out.join('');
    expect(text.split('\n')[1]).toMatch(/TIME \(UTC\)\s+│\s+ACTION\s+│\s+ENTITY\s+│\s+ACTOR/);
    expect(text).toContain(`skill.created`);
    expect(text).toContain('system');
    expect(text).toContain('mc audit list --cursor CUR');
  });

  it('omits filters that were not given, and prints JSON on request', async () => {
    const cli = await signedIn(() => ({ status: 200, body: { items: [event], nextCursor: null } }));
    await runCli(['--json', 'audit', 'list'], cli.deps);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/audit');
    expect(JSON.parse(cli.out.join('')).items[0].action).toBe('skill.created');
  });

  it('exits 2 when the caller is not a Director', async () => {
    expect(
      await runCli(['audit', 'list'], (await signedIn(() => problem(403, 'FORBIDDEN'))).deps),
    ).toBe(2);
  });
});

describe('mc profile', () => {
  const me = {
    user: { id: SESSION.userId, email: 'ann@lrl.space', name: 'Ann', role: 'crew' },
    org: { id: ORG, name: 'Org' },
  };
  const profile = {
    id: SESSION.userId,
    name: 'Ann',
    email: 'ann@lrl.space',
    load: 1,
    skills: [{ skillId: SKILL.id, name: 'Medicine', level: 4 }],
    unavailability: [{ id: 'r1', from: '2026-12-20', to: '2027-01-03', note: 'Leave' }],
  };

  it('shows the profile using the stored user id', async () => {
    const cli = await signedIn(() => ({ status: 200, body: profile }), SESSION.userId);
    expect(await runCli(['profile', 'show'], cli.deps)).toBe(0);
    expect(cli.calls).toHaveLength(1);
    expect(path(cli.calls[0]!)).toBe(`/v1/crew/${SESSION.userId}`);
    const text = cli.out.join('');
    expect(text).toContain('Medicine  level 4');
    expect(text).toContain('2026-12-20 to 2027-01-03  (Leave)');
    expect(text).toContain('Upcoming missions: 1');
  });

  it('asks the server who you are when the user id was not stored', async () => {
    const cli = await signedIn((call) =>
      path(call) === '/v1/me' ? { status: 200, body: me } : { status: 200, body: profile },
    );
    expect(await runCli(['profile', 'show'], cli.deps)).toBe(0);
    expect(cli.calls.map(path)).toEqual(['/v1/me', `/v1/crew/${SESSION.userId}`]);
  });

  it('sets a skill level by name, resolving the name case-insensitively', async () => {
    const cli = await signedIn(
      (call) =>
        catalogue(call) ?? { status: 200, body: { skillId: SKILL.id, name: 'Medicine', level: 4 } },
    );
    expect(await runCli(['profile', 'skill', 'set', ' medicine ', '4'], cli.deps)).toBe(0);
    expect(cli.calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      'GET /v1/skills?limit=100',
      `PUT /v1/crew/me/skills/${SKILL.id}`,
    ]);
    expect(cli.calls[1]!.body).toEqual({ level: 4 });
    expect(cli.out.join('')).toContain('Medicine: level 4');
  });

  it('follows catalogue pages to find the skill', async () => {
    const cli = await signedIn((call) => {
      if (path(call).startsWith('/v1/skills')) {
        return path(call).includes('cursor=P2')
          ? { status: 200, body: { items: [SKILL], nextCursor: null } }
          : { status: 200, body: { items: [PILOT], nextCursor: 'P2' } };
      }
      return { status: 200, body: { skillId: SKILL.id, name: 'Medicine', level: 2 } };
    });
    expect(await runCli(['profile', 'skill', 'set', 'Medicine', '2'], cli.deps)).toBe(0);
    expect(cli.calls.map(path)).toEqual([
      '/v1/skills?limit=100',
      '/v1/skills?limit=100&cursor=P2',
      `/v1/crew/me/skills/${SKILL.id}`,
    ]);
  });

  it('exits 3 for an unknown skill name and 1 for a bad level, without writing', async () => {
    const cli = await signedIn((call) => catalogue(call) ?? { status: 200 });
    expect(
      await runCli(['profile', 'skill', 'set', 'Underwater Basket Weaving', '3'], cli.deps),
    ).toBe(3);
    expect(cli.err.join('')).toContain('No skill named');
    for (const level of ['0', '6', '2.5', 'high']) {
      expect(await runCli(['profile', 'skill', 'set', 'Medicine', level], cli.deps)).toBe(1);
    }
    expect(cli.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('removes a skill by name', async () => {
    const cli = await signedIn((call) => catalogue(call) ?? { status: 204 });
    expect(await runCli(['profile', 'skill', 'remove', 'Medicine'], cli.deps)).toBe(0);
    expect(cli.calls[1]).toMatchObject({
      method: 'DELETE',
      url: `http://api.test/v1/crew/me/skills/${SKILL.id}`,
    });
  });

  it('adds, lists and removes unavailable ranges', async () => {
    const cli = await signedIn((call) => {
      if (call.method === 'POST')
        return {
          status: 201,
          body: { id: 'r1', from: '2026-12-20', to: '2027-01-03', note: 'Leave' },
        };
      if (call.method === 'DELETE') return { status: 204 };
      return { status: 200, body: profile };
    }, SESSION.userId);
    expect(
      await runCli(
        ['profile', 'unavailable', 'add', '2026-12-20', '2027-01-03', '--note', 'Leave'],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      url: 'http://api.test/v1/crew/me/unavailability',
      body: { from: '2026-12-20', to: '2027-01-03', note: 'Leave' },
    });
    expect(
      await runCli(['profile', 'unavailable', 'add', '2026-12-20', '2027-01-03'], cli.deps),
    ).toBe(0);
    expect(cli.calls[1]!.body).toEqual({ from: '2026-12-20', to: '2027-01-03' });
    expect(await runCli(['profile', 'unavailable', 'list'], cli.deps)).toBe(0);
    expect(cli.out.join('')).toMatch(/ID\s+│\s+FROM\s+│\s+TO\s+│\s+NOTE/);
    expect(await runCli(['profile', 'unavailable', 'remove', 'r1'], cli.deps)).toBe(0);
    expect(cli.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: 'http://api.test/v1/crew/me/unavailability/r1',
    });
  });

  it('shows the blocking missions when a range conflicts, and exits 4', async () => {
    const cli = await signedIn(() => ({
      status: 409,
      body: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
        detail: 'You are committed to missions in that period; speak to the Mission Lead',
        missions: [
          {
            id: 'm1',
            name: 'Artemis Relay',
            startDate: '2026-11-02',
            endDate: '2026-11-20',
            status: 'approved',
          },
        ],
      },
    }));
    expect(
      await runCli(['profile', 'unavailable', 'add', '2026-11-05', '2026-11-06'], cli.deps),
    ).toBe(4);
    const err = cli.err.join('');
    expect(err).toContain('UNAVAILABILITY_CONFLICTS_WITH_MISSIONS');
    expect(err).toContain('mission Artemis Relay (2026-11-02 to 2026-11-20, approved) [m1]');
  });

  it('shows the overlapping ranges when a range overlaps your own', async () => {
    const cli = await signedIn(() => ({
      status: 409,
      body: {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'UNAVAILABILITY_OVERLAPS_EXISTING',
        detail: 'overlap',
        unavailability: [{ id: 'r1', from: '2026-12-20', to: '2027-01-03' }],
      },
    }));
    expect(
      await runCli(['profile', 'unavailable', 'add', '2026-12-25', '2026-12-26'], cli.deps),
    ).toBe(4);
    expect(cli.err.join('')).toContain('existing range 2026-12-20 to 2027-01-03 [r1]');
  });
});

describe('mc crew', () => {
  const ann = {
    id: 'c1',
    name: 'Ann',
    email: 'ann@lrl.space',
    load: 2,
    skills: [{ skillId: SKILL.id, name: 'Medicine', level: 4 }],
    unavailability: [],
  };

  it('turns skill filters into ids and passes the window', async () => {
    const cli = await signedIn(
      (call) => catalogue(call) ?? { status: 200, body: { items: [ann], nextCursor: null } },
    );
    expect(
      await runCli(
        [
          'crew',
          'list',
          '--skill',
          'Medicine>=3',
          '--skill',
          'orbital piloting >= 5',
          '--available',
          '2026-11-02:2026-11-20',
        ],
        cli.deps,
      ),
    ).toBe(0);
    const url = new URL(cli.calls.at(-1)!.url);
    expect(url.searchParams.getAll('skill')).toEqual([`${SKILL.id}:3`, `${PILOT.id}:5`]);
    expect(url.searchParams.get('available')).toBe('2026-11-02:2026-11-20');
    expect(cli.out.join('')).toMatch(/ID\s+│\s+NAME\s+│\s+EMAIL\s+│\s+SKILLS\s+│\s+LOAD/);
    expect(cli.out.join('')).toContain('Medicine:4');
  });

  it('lists everyone with no filters, without touching the catalogue', async () => {
    const cli = await signedIn(() => ({ status: 200, body: { items: [ann], nextCursor: 'MORE' } }));
    await runCli(['crew', 'list', '--limit', '1'], cli.deps);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/crew?limit=1');
    expect(cli.out.join('')).toContain('mc crew list --cursor MORE');
  });

  it('rejects malformed skill filters before calling the server', async () => {
    const cli = await signedIn(() => ({ status: 200 }));
    for (const filter of ['Medicine', 'Medicine>3', 'Medicine>=0', 'Medicine>=6', '>=3']) {
      expect(await runCli(['crew', 'list', '--skill', filter], cli.deps), filter).toBe(1);
    }
    expect(cli.calls).toEqual([]);
  });

  it('exits 3 when the filter names an unknown skill', async () => {
    const cli = await signedIn((call) => catalogue(call) ?? { status: 200 });
    expect(await runCli(['crew', 'list', '--skill', 'Nope>=3'], cli.deps)).toBe(3);
  });

  it('shows one crew member', async () => {
    const cli = await signedIn(() => ({ status: 200, body: ann }));
    expect(await runCli(['crew', 'show', 'c1'], cli.deps)).toBe(0);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/crew/c1');
    expect(cli.out.join('')).toContain('ann@lrl.space');
    expect(
      await runCli(['crew', 'show', 'x'], (await signedIn(() => problem(404, 'NOT_FOUND'))).deps),
    ).toBe(3);
  });
});
