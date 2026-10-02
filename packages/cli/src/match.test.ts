import { describe, expect, it } from 'vitest';
import { proposalText } from './commands/match.js';
import { runCli } from './program.js';
import { SESSION, makeCli, problem, type Responder } from './test-support.js';

const MISSION = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0020';
const ANN = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0030';
const HASH = 'a'.repeat(64);

const proposal = (over: object = {}) => ({
  proposalId: 'p1',
  missionId: MISSION,
  method: 'exact',
  complete: false,
  team: [
    {
      crewMemberId: ANN,
      name: 'Ann',
      email: 'ann@lrl.space',
      upcomingMissions: 1,
      covers: [{ skillId: 's1', skill: 'Medicine', level: 4, required: 3 }],
    },
  ],
  coverage: [
    {
      skillId: 's1',
      skill: 'Medicine',
      minLevel: 3,
      required: 2,
      met: 1,
      gap: {
        qualifiedTotal: 4,
        blocked: { UNAVAILABLE: 2, COMMITTED: 1, AT_CAPACITY: 0, EXCLUDED: 0 },
      },
    },
    { skillId: 's2', skill: 'Piloting', minLevel: 4, required: 1, met: 1 },
  ],
  alternates: [
    {
      skillId: 's1',
      skill: 'Medicine',
      candidates: [
        { crewMemberId: 'c2', name: 'Bob', email: 'bob@lrl.space', upcomingMissions: 0, level: 5 },
      ],
    },
    { skillId: 's2', skill: 'Piloting', candidates: [] },
  ],
  teamHash: HASH,
  missionVersion: 4,
  expiresAt: '2026-10-02T10:30:00.000Z',
  ...over,
});

async function signedIn(respond: Responder) {
  const cli = await makeCli(respond);
  await cli.store.setCredentials({
    orgId: SESSION.orgId,
    accessToken: 'tok',
    refreshToken: 'ref',
    userId: SESSION.userId,
  });
  return cli;
}

describe('mc missions match', () => {
  it('posts the excluded people and prints the team, coverage, gaps, alternates and the hash', async () => {
    const cli = await signedIn(() => ({ status: 200, body: proposal() }));
    expect(
      await runCli(
        ['missions', 'match', MISSION, '--exclude', ANN, '--exclude', SESSION.userId],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: `http://api.test/v1/missions/${MISSION}/match`,
      body: { exclude: [ANN, SESSION.userId] },
    });
    const text = cli.out.join('');
    for (const part of [
      'Proposal p1  (exact)',
      'NOT every requirement can be met.',
      'Ann <ann@lrl.space>',
      'covers: Medicine (level 4, needs 3)',
      'Medicine level 3+: 1 of 2',
      '4 qualified in the organisation; blocked: UNAVAILABLE 2, COMMITTED 1',
      'Piloting level 4+: 1 of 1',
      'Next best:',
      'Bob <bob@lrl.space> (level 5, upcoming 0)',
      `Team hash: ${HASH}`,
      `mc missions match apply ${MISSION} p1 --team-hash ${HASH}`,
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('Piloting: '); // no alternates listed for a requirement that has none
  });

  it('proposes without exclusions by default, and prints JSON on request', async () => {
    const cli = await signedIn(() => ({ status: 200, body: proposal({ complete: true }) }));
    expect(await runCli(['--json', 'missions', 'match', MISSION], cli.deps)).toBe(0);
    expect(cli.calls[0]!.body).toEqual({ exclude: [] });
    expect(JSON.parse(cli.out.join('')).teamHash).toBe(HASH);
  });

  it('has no --pin, and refuses a malformed --exclude before calling the server', async () => {
    const cli = await signedIn(() => ({ status: 200, body: proposal() }));
    expect(await runCli(['missions', 'match', MISSION, '--pin', ANN], cli.deps)).toBe(1);
    expect(
      await runCli(['missions', 'match', MISSION, '--exclude', 'ann@lrl.space'], cli.deps),
    ).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('says when the heuristic answered, and when nobody can be proposed', () => {
    expect(proposalText(proposal({ method: 'heuristic' }) as never, MISSION)).toContain(
      'the solver timed out',
    );
    const text = proposalText(
      proposal({ team: [], complete: false, alternates: [] }) as never,
      MISSION,
    );
    expect(text).toContain('Team (0):');
    expect(text).toContain('(nobody)');
    expect(text).not.toContain('Next best:');
  });

  it('maps failures to exit codes: 3 unknown mission, 2 not the owner, 4 not Crewing, 5 rate limited', async () => {
    const cases: Array<[number, string, number]> = [
      [404, 'NOT_FOUND', 3],
      [403, 'FORBIDDEN', 2],
      [409, 'MISSION_NOT_EDITABLE', 4],
      [429, 'RATE_LIMITED', 5],
      [400, 'CREW_MEMBER_NOT_ASSIGNABLE', 1],
    ];
    for (const [status, code, exit] of cases) {
      const cli = await signedIn(() => problem(status, code));
      expect(await runCli(['missions', 'match', MISSION], cli.deps), code).toBe(exit);
      expect(cli.err.join('')).toContain(code);
    }
  });
});

describe('mc missions match apply', () => {
  const mission = {
    id: MISSION,
    name: 'Artemis Relay',
    description: '',
    startDate: '2027-03-01',
    endDate: '2027-03-10',
    status: 'crewing',
    version: 5,
    leadId: SESSION.userId,
    leadName: 'Lee',
    createdAt: '2026-10-02T10:00:00.000Z',
    requirements: [],
    crew: [],
    decisions: [],
    allowedActions: [],
  };

  it('sends the hash, with the current version fetched unless --version is given', async () => {
    const cli = await signedIn((c) => ({
      status: 200,
      body: c.method === 'GET' ? { ...mission, version: 7 } : { ...mission, version: 8 },
    }));
    expect(
      await runCli(['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH], cli.deps),
    ).toBe(0);
    expect(cli.calls.map((c) => `${c.method} ${c.url.replace('http://api.test', '')}`)).toEqual([
      `GET /v1/missions/${MISSION}`,
      `POST /v1/missions/${MISSION}/match/p1/apply`,
    ]);
    expect(cli.calls[1]).toMatchObject({ body: { teamHash: HASH } });
    expect(cli.calls[1]!.headers['If-Match']).toBe('"7"');
    expect(cli.out.join('')).toContain('Applied.');

    cli.calls.length = 0;
    expect(
      await runCli(
        ['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH, '--version', '3'],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0]!.headers['If-Match']).toBe('"3"');
  });

  it('needs the team hash and a valid version, before calling the server', async () => {
    const cli = await signedIn(() => ({ status: 200, body: mission }));
    expect(await runCli(['missions', 'match', 'apply', MISSION, 'p1'], cli.deps)).toBe(1);
    expect(
      await runCli(
        ['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH, '--version', 'x'],
        cli.deps,
      ),
    ).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('explains each refusal and exits 4: stale proposal, expired, hash mismatch, stale version', async () => {
    const codes = [
      'MATCH_PROPOSAL_STALE',
      'MATCH_PROPOSAL_EXPIRED',
      'MATCH_TEAM_HASH_MISMATCH',
      'MISSION_VERSION_MISMATCH',
    ];
    for (const code of codes) {
      const cli = await signedIn(() =>
        problem(code === 'MISSION_VERSION_MISMATCH' ? 412 : 409, code),
      );
      expect(
        await runCli(
          ['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH, '--version', '1'],
          cli.deps,
        ),
        code,
      ).toBe(4);
      expect(cli.err.join('')).toContain(code);
    }
  });

  it('exits 3 for a proposal that does not exist and 2 for someone who is not the owner', async () => {
    expect(
      await runCli(
        ['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH, '--version', '1'],
        (await signedIn(() => problem(404, 'NOT_FOUND'))).deps,
      ),
    ).toBe(3);
    expect(
      await runCli(
        ['missions', 'match', 'apply', MISSION, 'p1', '--team-hash', HASH, '--version', '1'],
        (await signedIn(() => problem(403, 'FORBIDDEN'))).deps,
      ),
    ).toBe(2);
  });
});
