import { uniqueEmail } from '@mc/core/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { onboardDirector, onboardMember, startE2e, type E2e } from './e2e-support.js';

const urls = inject('dbUrls');
let e2e: E2e;

beforeAll(async () => {
  e2e = await startE2e(urls);
});
afterAll(async () => {
  await e2e.stop();
});

describe('the full manual mission workflow, through the real mc binary', () => {
  it('runs create → requirements → crewing → crew → submit → approve → crew acknowledges', async () => {
    const { director } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    const bob = await onboardMember(director, 'crew', uniqueEmail('bob'), 'Bob Crew');
    await director.run(['skills', 'add', 'Medicine']);
    await director.run(['skills', 'add', 'Orbital Piloting']);
    await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);
    await ann.machine.run(['profile', 'skill', 'set', 'Orbital Piloting', '5']);
    await bob.machine.run(['profile', 'skill', 'set', 'Medicine', '2']);

    // The Lead plans the mission.
    const created = await lead.machine.run([
      '--json',
      'missions',
      'create',
      '--name',
      'Artemis Relay',
      '--start',
      '2027-03-01',
      '--end',
      '2027-03-10',
      '--description',
      'Relay station',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ status: 'draft', version: 1 });

    const reqs = await lead.machine.run([
      '--json',
      'missions',
      'requirements',
      'set',
      id,
      '--req',
      'Orbital Piloting:4:1',
      '--req',
      'medicine:3:1',
    ]);
    expect(reqs.code, reqs.stderr).toBe(0);
    expect(reqs.json.requirements.map((r: { skillName: string }) => r.skillName)).toEqual([
      'Medicine',
      'Orbital Piloting',
    ]);
    expect((await lead.machine.run(['missions', 'start-crewing', id])).code).toBe(0);

    // Not ready: nobody is assigned yet.
    const empty = await lead.machine.run(['missions', 'submit', id]);
    expect(empty.code).toBe(4);
    expect(empty.stderr).toContain('MISSION_CREW_EMPTY');
    // Bob alone does not cover the requirements; the CLI shows the Lead why.
    const bobOnly = await lead.machine.run(['--json', 'missions', 'crew', 'set', id, bob.userId]);
    expect(bobOnly.json.crewValidation.valid).toBe(false);
    expect(bobOnly.json.crewValidation.unmetRequirements).toHaveLength(2);
    const unmet = await lead.machine.run(['missions', 'submit', id]);
    expect(unmet.code).toBe(4);
    expect(unmet.stderr).toContain('REQUIREMENTS_NOT_MET');

    const crewed = await lead.machine.run(['--json', 'missions', 'crew', 'set', id, ann.userId]);
    expect(crewed.json.crewValidation).toEqual({
      valid: true,
      assignmentIssues: [],
      unmetRequirements: [],
    });
    expect((await lead.machine.run(['missions', 'show', id])).stdout).toContain('ready to submit');
    expect((await lead.machine.run(['missions', 'submit', id])).code).toBe(0);

    // The Director sees it waiting, and the notification.
    const queue = await director.run(['--json', 'approvals', 'list']);
    expect(queue.json.items.map((m: { id: string }) => m.id)).toEqual([id]);
    expect((await director.run(['inbox', '--unread'])).stdout).toContain('mission.submitted');

    // Crew cannot see it yet; the Lead cannot approve; the Director approves.
    expect((await ann.machine.run(['missions', 'show', id])).code).toBe(3);
    expect((await lead.machine.run(['missions', 'approve', id])).code).toBe(2);
    const approved = await director.run([
      '--json',
      'missions',
      'approve',
      id,
      '--comment',
      'Good luck',
    ]);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.json).toMatchObject({
      status: 'approved',
      decisions: [expect.objectContaining({ decision: 'approved', comment: 'Good luck' })],
    });
    expect((await lead.machine.run(['inbox'])).stdout).toContain('mission.approved');

    // Locked: the Lead cannot edit it any more.
    const locked = await lead.machine.run(['missions', 'requirements', 'set', id, '--clear']);
    expect(locked.code).toBe(4);
    expect(locked.stderr).toContain('MISSION_NOT_EDITABLE');

    // The crew member finds it and acknowledges.
    const inbox = await ann.machine.run(['--json', 'inbox']);
    expect(inbox.json.items[0]).toMatchObject({
      type: 'mission.assigned',
      readAt: null,
      payload: { missionId: id },
    });
    const shown = await ann.machine.run(['--json', 'missions', 'show', id]);
    expect(shown.json).toMatchObject({ status: 'approved', assignment: { acknowledgedAt: null } });
    expect(shown.json).not.toHaveProperty('crew');
    const mine = await ann.machine.run(['--json', 'assignments', 'list']);
    expect(mine.json.items).toHaveLength(1);
    const ack = await ann.machine.run([
      '--json',
      'assignments',
      'acknowledge',
      mine.json.items[0].id,
    ]);
    expect(ack.code, ack.stderr).toBe(0);
    expect(ack.json.acknowledgedAt).toEqual(expect.any(String));
    expect(
      (await ann.machine.run(['--json', 'inbox', 'read', inbox.json.items[0].id])).json.readAt,
    ).toEqual(expect.any(String));
    expect((await ann.machine.run(['--json', 'inbox', '--unread'])).json.items).toEqual([]);
    expect((await bob.machine.run(['missions', 'show', id])).code).toBe(3);

    // The Lead sees the acknowledgement.
    expect((await lead.machine.run(['missions', 'show', id])).stdout).toContain('acknowledged');
  });

  it('handles rejection, resubmission, withdrawal and cancellation', async () => {
    const { director } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    await director.run(['skills', 'add', 'Medicine']);
    await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);

    const create = async (name: string, start: string, end: string) => {
      const m = (
        await lead.machine.run([
          '--json',
          'missions',
          'create',
          '--name',
          name,
          '--start',
          start,
          '--end',
          end,
        ])
      ).json.id as string;
      await lead.machine.run(['missions', 'requirements', 'set', m, '--req', 'Medicine:3:1']);
      await lead.machine.run(['missions', 'start-crewing', m]);
      await lead.machine.run(['missions', 'crew', 'set', m, ann.userId]);
      return m;
    };
    const m = await create('Reject me', '2027-04-01', '2027-04-05');
    expect((await lead.machine.run(['missions', 'submit', m])).code).toBe(0);
    const noReason = await director.run(['missions', 'reject', m]);
    expect(noReason.code).toBe(1); // --reason is required
    expect((await director.run(['missions', 'reject', m, '--reason', '  '])).code).toBe(1);
    const rejected = await director.run([
      '--json',
      'missions',
      'reject',
      m,
      '--reason',
      'Too risky',
    ]);
    expect(rejected.json.status).toBe('crewing');
    expect((await lead.machine.run(['inbox'])).stdout).toContain('Too risky');
    // The same crew member is free again, so a resubmission works.
    expect((await lead.machine.run(['missions', 'submit', m])).code).toBe(0);
    expect((await lead.machine.run(['missions', 'withdraw', m])).code).toBe(0);
    expect((await lead.machine.run(['missions', 'show', m])).stdout).toContain('Status: crewing');
    expect((await lead.machine.run(['missions', 'reopen', m])).code).toBe(0);
    expect((await lead.machine.run(['--json', 'missions', 'show', m])).json.crew).toEqual([]);
    expect((await lead.machine.run(['missions', 'cancel', m])).code).toBe(0);
    const again = await lead.machine.run(['missions', 'cancel', m]);
    expect(again.code).toBe(4);
    expect(again.stderr).toContain('MISSION_INVALID_TRANSITION');
    expect(again.stderr).toContain('nothing can be done');

    // Directors cannot cancel; a stale --version is a conflict.
    const m2 = await create('Director cannot cancel', '2027-05-01', '2027-05-05');
    expect((await director.run(['missions', 'cancel', m2])).code).toBe(2);
    const stale = await lead.machine.run(['missions', 'cancel', m2, '--version', '1']);
    expect(stale.code).toBe(4);
    expect(stale.stderr).toContain('MISSION_VERSION_MISMATCH');
    expect(stale.stderr).toMatch(/now at version \d+/);

    // Filters.
    const names = async (...args: string[]) =>
      (
        (await lead.machine.run(['--json', 'missions', 'list', ...args])).json.items as {
          name: string;
        }[]
      ).map((x) => x.name);
    expect(await names('--status', 'cancelled')).toEqual(['Reject me']);
    expect(await names('--status', 'crewing', '--mine')).toEqual(['Director cannot cancel']);
    expect(await names('--from', '2027-04-20')).toEqual(['Director cannot cancel']);
  });

  it('stops a Director from deactivating a crew member who is held on a mission', async () => {
    const { director } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    await director.run(['skills', 'add', 'Medicine']);
    await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);
    const m = (
      await lead.machine.run([
        '--json',
        'missions',
        'create',
        '--name',
        'Held',
        '--start',
        '2027-04-01',
        '--end',
        '2027-04-05',
      ])
    ).json.id as string;
    await lead.machine.run(['missions', 'requirements', 'set', m, '--req', 'Medicine:3:1']);
    await lead.machine.run(['missions', 'start-crewing', m]);
    await lead.machine.run(['missions', 'crew', 'set', m, ann.userId]);
    await lead.machine.run(['missions', 'submit', m]);

    const held = await director.run(['users', 'deactivate', ann.userId]);
    expect(held.code).toBe(4);
    expect(held.stderr).toContain('USER_HAS_COMMITMENTS');
    const owner = await director.run(['users', 'deactivate', lead.userId]);
    expect(owner.code).toBe(4);
    expect(owner.stderr).toContain('USER_OWNS_MISSIONS');
    // Ann cannot declare unavailable dates over the mission either (and learns which mission).
    const blocked = await ann.machine.run([
      'profile',
      'unavailable',
      'add',
      '2027-04-02',
      '2027-04-03',
    ]);
    expect(blocked.code).toBe(4);
    expect(blocked.stderr).toContain('mission Held (2027-04-01 to 2027-04-05, pending_approval)');
  });
});

describe('the auto-matcher, through the real mc binary', () => {
  it('proposes a team, explains a shortfall, and applies the proposal', async () => {
    const { director } = await onboardDirector(e2e, uniqueEmail('director'));
    const lead = await onboardMember(director, 'lead', uniqueEmail('lead'), 'Lee Lead');
    const ann = await onboardMember(director, 'crew', uniqueEmail('ann'), 'Ann Crew');
    const bob = await onboardMember(director, 'crew', uniqueEmail('bob'), 'Bob Crew');
    const cat = await onboardMember(director, 'crew', uniqueEmail('cat'), 'Cat Crew');
    await director.run(['skills', 'add', 'Medicine']);
    await ann.machine.run(['profile', 'skill', 'set', 'Medicine', '5']);
    await bob.machine.run(['profile', 'skill', 'set', 'Medicine', '3']);
    await cat.machine.run(['profile', 'skill', 'set', 'Medicine', '4']);
    await cat.machine.run(['profile', 'unavailable', 'add', '2027-03-02', '2027-03-04']);

    const id = (
      await lead.machine.run([
        '--json',
        'missions',
        'create',
        '--name',
        'Match me',
        '--start',
        '2027-03-01',
        '--end',
        '2027-03-10',
      ])
    ).json.id as string;
    await lead.machine.run(['missions', 'requirements', 'set', id, '--req', 'Medicine:3:3']);
    await lead.machine.run(['missions', 'start-crewing', id]);

    // Three are needed but one is unavailable: a partial team, with the gap explained by counts, not names.
    const partial = await lead.machine.run(['missions', 'match', id]);
    expect(partial.code, partial.stderr).toBe(0);
    expect(partial.stdout).toContain('NOT every requirement can be met.');
    expect(partial.stdout).toContain('Medicine level 3+: 2 of 3');
    expect(partial.stdout).toContain('3 qualified in the organisation; blocked: UNAVAILABLE 1');
    expect(partial.stdout).not.toContain(cat.userId);
    expect(partial.stdout).not.toContain('Cat Crew');

    // Needing two instead of three, with Bob excluded.
    await lead.machine.run(['missions', 'requirements', 'set', id, '--req', 'Medicine:3:2']);
    const json = await lead.machine.run([
      '--json',
      'missions',
      'match',
      id,
      '--exclude',
      bob.userId,
    ]);
    expect(json.code, json.stderr).toBe(0);
    // Bob is excluded and Cat is away, so only Ann is left for two places: the best partial team.
    expect(json.json).toMatchObject({ method: 'exact', complete: false });
    expect(json.json.team.map((t: { crewMemberId: string }) => t.crewMemberId)).toEqual([
      ann.userId,
    ]);
    expect(json.json.coverage[0].gap).toMatchObject({
      qualifiedTotal: 3,
      blocked: { UNAVAILABLE: 1, EXCLUDED: 1 },
    });

    const ok = await lead.machine.run(['--json', 'missions', 'match', id]);
    expect(ok.json.complete).toBe(true);
    expect(ok.json.team).toHaveLength(2);
    const { proposalId, teamHash } = ok.json;

    // The hash confirms the team: a wrong one is refused, the right one applies.
    const wrong = await lead.machine.run([
      'missions',
      'match',
      'apply',
      id,
      proposalId,
      '--team-hash',
      '0'.repeat(64),
    ]);
    expect(wrong.code).toBe(4);
    expect(wrong.stderr).toContain('MATCH_TEAM_HASH_MISMATCH');
    expect((await lead.machine.run(['missions', 'match', 'apply', id, proposalId])).code).toBe(1); // --team-hash is required
    const applied = await lead.machine.run([
      '--json',
      'missions',
      'match',
      'apply',
      id,
      proposalId,
      '--team-hash',
      teamHash,
    ]);
    expect(applied.code, applied.stderr).toBe(0);
    expect(applied.json.crew.map((c: { crewMemberId: string }) => c.crewMemberId).sort()).toEqual(
      [ann.userId, bob.userId].sort(),
    );
    expect(applied.json.crewValidation.valid).toBe(true);

    // The proposal was for the earlier version of the mission, so it cannot be applied again.
    const again = await lead.machine.run([
      'missions',
      'match',
      'apply',
      id,
      proposalId,
      '--team-hash',
      teamHash,
    ]);
    expect(again.code).toBe(4);
    expect(again.stderr).toContain('MATCH_PROPOSAL_STALE');

    // Only the owning Lead can match, and the CLI has no way to pin.
    expect((await director.run(['missions', 'match', id])).code).toBe(2);
    expect((await lead.machine.run(['missions', 'match', id, '--pin', ann.userId])).code).toBe(1);
    expect((await lead.machine.run(['missions', 'submit', id])).code).toBe(0);
  });
});
