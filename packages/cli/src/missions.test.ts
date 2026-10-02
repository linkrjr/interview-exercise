import { describe, expect, it } from 'vitest';
import { parseRequirement } from './commands/missions.js';
import { runCli } from './program.js';
import { SESSION, makeCli, problem, type RecordedCall, type Responder } from './test-support.js';

const ORG = SESSION.orgId;
const MISSION_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0020';
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

const mission = (over: object = {}) => ({
  id: MISSION_ID,
  name: 'Artemis Relay',
  description: '',
  startDate: '2027-03-01',
  endDate: '2027-03-10',
  status: 'draft',
  version: 3,
  leadId: SESSION.userId,
  leadName: 'Lee',
  createdAt: '2026-10-02T10:00:00.000Z',
  requirements: [],
  crew: [],
  decisions: [],
  allowedActions: ['start_crewing', 'cancel'],
  ...over,
});

async function signedIn(respond: Responder, userId: string = SESSION.userId) {
  const cli = await makeCli(respond);
  await cli.store.setCredentials({ orgId: ORG, accessToken: 'tok', refreshToken: 'ref', userId });
  return cli;
}
const path = (c: RecordedCall) => c.url.replace('http://api.test', '');
const catalogue = (c: RecordedCall) =>
  path(c).startsWith('/v1/skills')
    ? { status: 200, body: { items: [PILOT, SKILL], nextCursor: null } }
    : undefined;

describe('requirement syntax', () => {
  it.each([
    ['Orbital Piloting:4:1', { name: 'Orbital Piloting', minLevel: 4, count: 1 }],
    ['Medicine:3:2', { name: 'Medicine', minLevel: 3, count: 2 }],
    ['  Nav: Systems :5:10', { name: 'Nav: Systems', minLevel: 5, count: 10 }],
  ])('parses %s', (text, expected) => {
    expect(parseRequirement(text)).toEqual(expected);
  });

  it.each([
    'Medicine',
    'Medicine:3',
    'Medicine:0:1',
    'Medicine:6:1',
    'Medicine:3:0',
    'Medicine:x:1',
    ':3:1',
    'Medicine:3:1.5',
  ])('rejects %s', (text) => {
    expect(() => parseRequirement(text)).toThrow(/Invalid --req/);
  });
});

describe('mc missions create / show / list', () => {
  it('creates a mission', async () => {
    const cli = await signedIn(() => ({ status: 201, body: mission({ version: 1 }) }));
    expect(
      await runCli(
        [
          'missions',
          'create',
          '--name',
          'Artemis Relay',
          '--start',
          '2027-03-01',
          '--end',
          '2027-03-10',
          '--description',
          'Relay',
        ],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/missions',
      body: {
        name: 'Artemis Relay',
        startDate: '2027-03-01',
        endDate: '2027-03-10',
        description: 'Relay',
      },
    });
    expect(cli.out.join('')).toContain(MISSION_ID);
  });

  it('needs a name and both dates, before calling the server', async () => {
    const cli = await signedIn(() => ({ status: 201 }));
    expect(
      await runCli(['missions', 'create', '--name', 'X', '--start', '2027-03-01'], cli.deps),
    ).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('shows a mission in full for staff', async () => {
    const full = mission({
      status: 'crewing',
      requirements: [{ skillId: SKILL.id, skillName: 'Medicine', minLevel: 3, count: 2 }],
      crew: [
        {
          assignmentId: 'a1',
          crewMemberId: 'c1',
          name: 'Ann',
          email: 'ann@lrl.space',
          acknowledgedAt: null,
        },
      ],
      decisions: [
        {
          id: 'd1',
          directorId: 'dd',
          decision: 'rejected',
          comment: 'Not yet',
          decidedAt: '2026-10-02T10:00:00.000Z',
        },
      ],
      crewValidation: {
        valid: false,
        assignmentIssues: [{ assignmentId: 'a1', crewMemberId: 'c1', code: 'NOT_ELIGIBLE' }],
        unmetRequirements: [{ skillId: SKILL.id, minLevel: 3, required: 2, met: 1 }],
      },
      allowedActions: ['reopen', 'submit', 'cancel'],
    });
    const cli = await signedIn(() => ({ status: 200, body: full }));
    expect(await runCli(['missions', 'show', MISSION_ID], cli.deps)).toBe(0);
    const text = cli.out.join('');
    for (const part of [
      'Artemis Relay',
      'Version: 3',
      'Medicine  level 3+  x2',
      'Ann <ann@lrl.space>',
      'NOT ready to submit',
      'c1 is NOT_ELIGIBLE',
      'needs 2, has 1',
      'rejected: Not yet',
      'You can: reopen, submit, cancel',
    ]) {
      expect(text).toContain(part);
    }
  });

  it('shows a mission in the reduced shape for Crew', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: {
        id: MISSION_ID,
        name: 'Artemis Relay',
        description: '',
        startDate: '2027-03-01',
        endDate: '2027-03-10',
        status: 'approved',
        assignment: { id: 'as1', acknowledgedAt: null },
      },
    }));
    expect(await runCli(['missions', 'show', MISSION_ID], cli.deps)).toBe(0);
    expect(cli.out.join('')).toContain('Your assignment: as1  (not acknowledged yet)');
  });

  it('lists with repeated statuses, --mine from the stored user id, and windows', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { items: [mission()], nextCursor: 'NEXT' },
    }));
    expect(
      await runCli(
        [
          'missions',
          'list',
          '--status',
          'draft',
          '--status',
          'crewing',
          '--mine',
          '--from',
          '2027-01-01',
          '--to',
          '2027-02-01',
          '--limit',
          '5',
        ],
        cli.deps,
      ),
    ).toBe(0);
    const url = new URL(cli.calls[0]!.url);
    expect(url.searchParams.getAll('status')).toEqual(['draft', 'crewing']);
    expect(url.searchParams.get('leadId')).toBe(SESSION.userId);
    expect(url.searchParams.get('from')).toBe('2027-01-01');
    expect(url.searchParams.get('limit')).toBe('5');
    const text = cli.out.join('');
    expect(text.split('\n')[0]).toMatch(/^ID\s+NAME\s+STATUS\s+START\s+END\s+LEAD\s+VERSION$/);
    expect(text).toContain('mc missions list --cursor NEXT');
  });

  it('lists the reduced shape for Crew with the acknowledgement', async () => {
    const item = {
      id: MISSION_ID,
      name: 'M',
      description: '',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      status: 'approved',
      assignment: { id: 'as1', acknowledgedAt: '2026-10-02T10:00:00.000Z' },
    };
    const cli = await signedIn(() => ({ status: 200, body: { items: [item], nextCursor: null } }));
    await runCli(['missions', 'list'], cli.deps);
    expect(cli.out.join('')).toMatch(/ACKNOWLEDGED/);
    expect(cli.out.join('')).toContain('yes');
  });

  it('rejects an unknown status and combining --mine with --lead', async () => {
    const cli = await signedIn(() => ({ status: 200 }));
    expect(await runCli(['missions', 'list', '--status', 'nope'], cli.deps)).toBe(1);
    expect(await runCli(['missions', 'list', '--mine', '--lead', 'x'], cli.deps)).toBe(1);
    expect(cli.calls).toEqual([]);
  });
});

describe('versions on every change', () => {
  it('fetches the current version and sends it in If-Match', async () => {
    const cli = await signedIn((c) =>
      c.method === 'GET'
        ? { status: 200, body: mission({ version: 7 }) }
        : { status: 200, body: mission({ status: 'crewing', version: 8 }) },
    );
    expect(await runCli(['missions', 'start-crewing', MISSION_ID], cli.deps)).toBe(0);
    expect(cli.calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      `GET /v1/missions/${MISSION_ID}`,
      `POST /v1/missions/${MISSION_ID}/transitions`,
    ]);
    expect(cli.calls[1]!.headers['If-Match']).toBe('"7"');
    expect(cli.calls[1]!.body).toEqual({ action: 'start_crewing' });
    expect(cli.out.join('')).toContain('is now being crewed (now crewing)');
  });

  it('uses --version without fetching', async () => {
    const cli = await signedIn(() => ({ status: 200, body: mission({ version: 5 }) }));
    expect(await runCli(['missions', 'submit', MISSION_ID, '--version', '4'], cli.deps)).toBe(0);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]!.headers['If-Match']).toBe('"4"');
    expect(await runCli(['missions', 'submit', MISSION_ID, '--version', 'x'], cli.deps)).toBe(1);
  });

  it('exits 4 on a stale version and says which version it is at', async () => {
    const cli = await signedIn(() => ({
      status: 412,
      body: {
        type: 'about:blank',
        title: 'Precondition Failed',
        status: 412,
        code: 'MISSION_VERSION_MISMATCH',
        detail: 'The mission was changed by someone else; reload it',
        currentVersion: 9,
      },
    }));
    expect(await runCli(['missions', 'cancel', MISSION_ID, '--version', '1'], cli.deps)).toBe(4);
    expect(cli.err.join('')).toContain('MISSION_VERSION_MISMATCH');
    expect(cli.err.join('')).toContain('version 9');
  });

  it('maps each lifecycle command to its action', async () => {
    const cli = await signedIn((c) =>
      c.method === 'GET' ? { status: 200, body: mission() } : { status: 200, body: mission() },
    );
    const cases: Array<[string[], object]> = [
      [['reopen'], { action: 'reopen' }],
      [['submit'], { action: 'submit' }],
      [['withdraw'], { action: 'withdraw' }],
      [['cancel'], { action: 'cancel' }],
      [['approve'], { action: 'approve' }],
      [['approve', '--comment', 'Go'], { action: 'approve', comment: 'Go' }],
      [['reject', '--reason', 'Too risky'], { action: 'reject', comment: 'Too risky' }],
    ];
    for (const [args, body] of cases) {
      cli.calls.length = 0;
      expect(
        await runCli(['missions', args[0]!, MISSION_ID, ...args.slice(1)], cli.deps),
        args.join(' '),
      ).toBe(0);
      expect(cli.calls.at(-1)!.body).toEqual(body);
    }
  });

  it('needs a reason to reject, before calling the server', async () => {
    const cli = await signedIn(() => ({ status: 200 }));
    expect(await runCli(['missions', 'reject', MISSION_ID], cli.deps)).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('explains a refused transition with what the user can do instead', async () => {
    const cli = await signedIn((c) =>
      c.method === 'GET'
        ? { status: 200, body: mission() }
        : {
            status: 409,
            body: {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'MISSION_INVALID_TRANSITION',
              detail: 'Cannot submit a mission that is draft',
              missionStatus: 'draft',
              allowedActions: ['start_crewing', 'cancel'],
            },
          },
    );
    expect(await runCli(['missions', 'submit', MISSION_ID], cli.deps)).toBe(4);
    expect(cli.err.join('')).toContain('you can now: start_crewing, cancel');
  });

  it('names the people and the kind when a submit fails', async () => {
    const cli = await signedIn((c) =>
      c.method === 'GET'
        ? { status: 200, body: mission({ status: 'crewing', version: 4 }) }
        : {
            status: 409,
            body: {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'CREW_DOUBLE_BOOKED',
              detail: 'Some assigned people are already committed',
              issues: [
                { code: 'CREW_UNAVAILABLE', crewMemberIds: ['c1'] },
                { code: 'CREW_DOUBLE_BOOKED', crewMemberIds: ['c2', 'c3'] },
              ],
            },
          },
    );
    expect(await runCli(['missions', 'submit', MISSION_ID], cli.deps)).toBe(4);
    expect(cli.err.join('')).toContain('- CREW_UNAVAILABLE: c1');
    expect(cli.err.join('')).toContain('- CREW_DOUBLE_BOOKED: c2, c3');
  });

  it('exits 3 for a mission that does not exist, and 2 for a Director trying to cancel', async () => {
    expect(
      await runCli(
        ['missions', 'cancel', MISSION_ID],
        (await signedIn(() => problem(404, 'NOT_FOUND'))).deps,
      ),
    ).toBe(3);
    const cli = await signedIn((c) =>
      c.method === 'GET' ? { status: 200, body: mission() } : problem(403, 'FORBIDDEN'),
    );
    expect(await runCli(['missions', 'cancel', MISSION_ID], cli.deps)).toBe(2);
  });
});

describe('mc missions requirements set / crew set', () => {
  it('turns skill names into ids and sends the whole set', async () => {
    const cli = await signedIn(
      (c) => catalogue(c) ?? { status: 200, body: mission({ version: 3 }) },
    );
    expect(
      await runCli(
        [
          'missions',
          'requirements',
          'set',
          MISSION_ID,
          '--req',
          'Orbital Piloting:4:1',
          '--req',
          'medicine:3:2',
        ],
        cli.deps,
      ),
    ).toBe(0);
    const put = cli.calls.find((c) => c.method === 'PUT')!;
    expect(path(put)).toBe(`/v1/missions/${MISSION_ID}/requirements`);
    expect(put.body).toEqual({
      requirements: [
        { skillId: PILOT.id, minLevel: 4, count: 1 },
        { skillId: SKILL.id, minLevel: 3, count: 2 },
      ],
    });
    expect(put.headers['If-Match']).toBe('"3"');
  });

  it('needs --req or --clear, and not both, and a known skill', async () => {
    const cli = await signedIn((c) => catalogue(c) ?? { status: 200, body: mission() });
    expect(await runCli(['missions', 'requirements', 'set', MISSION_ID], cli.deps)).toBe(1);
    expect(
      await runCli(
        ['missions', 'requirements', 'set', MISSION_ID, '--clear', '--req', 'Medicine:3:1'],
        cli.deps,
      ),
    ).toBe(1);
    expect(
      await runCli(
        ['missions', 'requirements', 'set', MISSION_ID, '--req', 'Medicine:9:1'],
        cli.deps,
      ),
    ).toBe(1);
    expect(
      await runCli(
        ['missions', 'requirements', 'set', MISSION_ID, '--req', 'Basket Weaving:3:1'],
        cli.deps,
      ),
    ).toBe(3);
    expect(cli.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(await runCli(['missions', 'requirements', 'set', MISSION_ID, '--clear'], cli.deps)).toBe(
      0,
    );
    expect(cli.calls.at(-1)!.body).toEqual({ requirements: [] });
  });

  it('sets the crew by member id, and only clears it on request', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: mission({
        status: 'crewing',
        crew: [
          { assignmentId: 'a', crewMemberId: 'c1', name: 'A', email: 'a@x', acknowledgedAt: null },
        ],
        crewValidation: { valid: true, assignmentIssues: [], unmetRequirements: [] },
      }),
    }));
    expect(
      await runCli(['missions', 'crew', 'set', MISSION_ID, 'c1', 'c2', '--version', '3'], cli.deps),
    ).toBe(0);
    expect(cli.calls[0]!.body).toEqual({ crewMemberIds: ['c1', 'c2'] });
    expect(cli.out.join('')).toContain('ready to submit');
    expect(await runCli(['missions', 'crew', 'set', MISSION_ID, '--version', '3'], cli.deps)).toBe(
      1,
    );
    expect(
      await runCli(
        ['missions', 'crew', 'set', MISSION_ID, 'c1', '--clear', '--version', '3'],
        cli.deps,
      ),
    ).toBe(1);
    expect(
      await runCli(['missions', 'crew', 'set', MISSION_ID, '--clear', '--version', '3'], cli.deps),
    ).toBe(0);
    expect(cli.calls.at(-1)!.body).toEqual({ crewMemberIds: [] });
  });

  it('lists the people the server refuses', async () => {
    const cli = await signedIn(() => ({
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'CREW_MEMBER_NOT_ASSIGNABLE',
        detail: 'Only active Crew Members can be assigned',
        crewMemberIds: ['x1'],
      },
    }));
    expect(
      await runCli(['missions', 'crew', 'set', MISSION_ID, 'x1', '--version', '1'], cli.deps),
    ).toBe(1);
    expect(cli.err.join('')).toContain('not assignable: x1');
  });
});

describe('mc approvals', () => {
  it('lists the missions pending approval', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { items: [mission({ status: 'pending_approval' })], nextCursor: null },
    }));
    expect(await runCli(['approvals', 'list'], cli.deps)).toBe(0);
    expect(new URL(cli.calls[0]!.url).searchParams.getAll('status')).toEqual(['pending_approval']);
    expect(cli.out.join('')).toContain('pending_approval');
  });

  it('says so when nothing waits', async () => {
    const cli = await signedIn(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    await runCli(['approvals', 'list'], cli.deps);
    expect(cli.out.join('')).toContain('Nothing is waiting for approval');
  });
});

describe('mc assignments', () => {
  const assignment = {
    id: 'as1',
    acknowledgedAt: null,
    mission: {
      id: MISSION_ID,
      name: 'Artemis Relay',
      description: '',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      status: 'approved',
    },
  };

  it('lists and acknowledges', async () => {
    const cli = await signedIn((c) =>
      c.method === 'GET'
        ? { status: 200, body: { items: [assignment], nextCursor: null } }
        : { status: 200, body: { ...assignment, acknowledgedAt: '2026-10-02T10:00:00.000Z' } },
    );
    expect(await runCli(['assignments', 'list'], cli.deps)).toBe(0);
    expect(cli.out.join('')).toMatch(/ID\s+MISSION\s+STATUS\s+START\s+END\s+ACKNOWLEDGED/);
    expect(await runCli(['assignments', 'acknowledge', 'as1'], cli.deps)).toBe(0);
    expect(cli.calls[1]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/assignments/as1/acknowledge',
    });
    expect(cli.out.join('')).toContain('Acknowledged Artemis Relay');
  });

  it('says when there are none, and exits 4 when it cannot be acknowledged', async () => {
    const empty = await signedIn(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    await runCli(['assignments', 'list'], empty.deps);
    expect(empty.out.join('')).toContain('No assignments yet');
    expect(
      await runCli(
        ['assignments', 'acknowledge', 'as1'],
        (await signedIn(() => problem(409, 'ASSIGNMENT_NOT_ACKNOWLEDGEABLE'))).deps,
      ),
    ).toBe(4);
  });
});

describe('mc inbox', () => {
  const note = {
    id: 'n1',
    type: 'mission.rejected',
    payload: { missionId: MISSION_ID, missionName: 'Artemis Relay', reason: 'Too risky' },
    readAt: null,
    createdAt: '2026-10-02T10:00:00.000Z',
  };

  it('lists by default, and with --unread', async () => {
    const cli = await signedIn(() => ({ status: 200, body: { items: [note], nextCursor: null } }));
    expect(await runCli(['inbox'], cli.deps)).toBe(0);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/notifications');
    expect(cli.out.join('')).toContain('Artemis Relay (Too risky)');
    expect(cli.out.join('')).toContain('mission.rejected');
    expect(await runCli(['inbox', '--unread'], cli.deps)).toBe(0);
    expect(cli.calls[1]!.url).toBe('http://api.test/v1/notifications?unread=true');
    expect(await runCli(['inbox', 'list', '--unread', '--limit', '3'], cli.deps)).toBe(0);
    expect(cli.calls[2]!.url).toBe('http://api.test/v1/notifications?limit=3&unread=true');
  });

  it('marks one as read', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: { ...note, readAt: '2026-10-02T10:05:00.000Z' },
    }));
    expect(await runCli(['inbox', 'read', 'n1'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/notifications/n1/read',
    });
    expect(cli.out.join('')).toContain('Marked as read');
  });

  it("says when it is empty, and exits 3 for someone else's notification", async () => {
    const empty = await signedIn(() => ({ status: 200, body: { items: [], nextCursor: null } }));
    await runCli(['inbox'], empty.deps);
    expect(empty.out.join('')).toContain('Your inbox is empty');
    expect(
      await runCli(['inbox', 'read', 'x'], (await signedIn(() => problem(404, 'NOT_FOUND'))).deps),
    ).toBe(3);
  });
});
