import { MATCH_PROPOSAL_TTL_MINUTES, type Mission } from '@mc/contracts';
import { newId, schema } from '@mc/db';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  missionWorld,
  onboardUser,
  type Harness,
  type MissionWorld,
} from '../testing/index.js';
import { createHighsSolver } from '@mc/matcher/highs';
import type { Db } from '@mc/db';
import { MatchService, teamHashOf } from './match-service.js';

const urls = inject('dbUrls');
let h: Harness;
let admin: AdminDb;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
  admin = openAdminDb(urls.migrator);
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

type Crew = Awaited<ReturnType<typeof onboardUser>>;

/** An organisation with a Lead and `n` extra Crew Members holding the given skill levels. */
async function world(
  label: string,
  crew: Array<Record<'medicine' | 'piloting', number | undefined>> = [],
) {
  const w = await missionWorld(h, label);
  const people: Crew[] = [];
  for (const [i, levels] of crew.entries()) {
    const c = await onboardUser(h, w.org, 'crew', `p${i}`);
    if (levels.medicine) await h.crew.setSkill(c.actor, w.medicine.id, levels.medicine);
    if (levels.piloting) await h.crew.setSkill(c.actor, w.piloting.id, levels.piloting);
    people.push(c);
  }
  return { ...w, people };
}

const inbox = async (who: { actor: Parameters<Harness['notifications']['list']>[0] }) =>
  (await h.notifications.list(who.actor, { limit: 100 })).items;
const memberIds = (p: { team: Array<{ crewMemberId: string }> }) =>
  p.team.map((m) => m.crewMemberId);
const view = async (w: MissionWorld, id: string) =>
  (await h.missions.get(w.lead.actor, id)) as Mission;

describe('proposing a team', () => {
  it('proposes from the mission and the organisation, and stores the proposal for 30 minutes', async () => {
    const x = await world('Match basic', [
      { medicine: 4, piloting: undefined },
      { medicine: 3, piloting: undefined },
    ]);
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 2 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });

    expect(proposal).toMatchObject({
      missionId: m.id,
      method: 'exact',
      complete: true,
      missionVersion: m.version,
      proposalId: expect.any(String),
      expiresAt: new Date(
        h.clock.now().getTime() + MATCH_PROPOSAL_TTL_MINUTES * 60_000,
      ).toISOString(),
    });
    // Ann (Medicine 4) and Bob (Medicine 2) are in the organisation too; the two that qualify are chosen.
    expect(memberIds(proposal).length).toBe(2);
    expect(proposal.coverage).toEqual([
      { skillId: x.medicine.id, skill: 'Medicine', minLevel: 3, required: 2, met: 2 },
    ]);
    expect(proposal.team[0]).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      upcomingMissions: 0,
      covers: [expect.objectContaining({ skill: 'Medicine' })],
    });
    expect(proposal.teamHash).toBe(teamHashOf(proposal.team.map((t) => t.email)));

    const rows = await h.db.withTenant(x.org.orgId, (tx) =>
      tx
        .select()
        .from(schema.matchProposals)
        .where(eq(schema.matchProposals.id, proposal.proposalId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ missionId: m.id, teamHash: proposal.teamHash });
  });

  it('is advisory: it changes nothing about the mission, notifies nobody, and writes no audit event', async () => {
    const x = await world('Match advisory', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing();
    const before = await view(x, m.id);
    h.audit.clear();
    await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const after = await view(x, m.id);
    expect(after).toEqual(before);
    expect(after.crew).toEqual(before.crew);
    expect(h.audit.events).toEqual([]);
    for (const who of [x.lead, x.director, x.ann])
      expect((await inbox(who)).filter((n) => n.type.startsWith('mission.')).length).toBe(0);
  });

  it('ignores the current tentative crew: it proposes from scratch, and the tentative crew is an ordinary candidate', async () => {
    const x = await world('Match scratch', [{ medicine: 3, piloting: undefined }]);
    const m = await x.crewing({ crew: [x.bob.userId] }); // Bob only has Medicine 2: not enough
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    expect(memberIds(proposal)).not.toContain(x.bob.userId);
    expect(proposal.complete).toBe(true);
  });

  it('prefers the lighter load, and a smaller team', async () => {
    const x = await world('Match load', [
      { medicine: 3, piloting: undefined },
      { medicine: 3, piloting: undefined },
    ]);
    // Ann already holds one mission elsewhere, so one load; the two new people have none.
    await x.approved({ startDate: '2027-02-01', endDate: '2027-02-05' });
    const m = await x.crewing({
      startDate: '2027-06-01',
      endDate: '2027-06-05',
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    expect(proposal.team).toHaveLength(1);
    expect(proposal.team[0]!.upcomingMissions).toBe(0);
    expect(proposal.team[0]!.crewMemberId).not.toBe(x.ann.userId);
    const alt = proposal.alternates[0]!.candidates.find((c) => c.crewMemberId === x.ann.userId);
    expect(alt).toMatchObject({ upcomingMissions: 1 });
  });

  it('counts blocked people by reason without naming them, and returns the best partial team', async () => {
    const x = await world('Match blocked', [
      { medicine: 5, piloting: undefined }, // p0: will be unavailable
      { medicine: 5, piloting: undefined }, // p1: will be committed
      { medicine: 5, piloting: undefined }, // p2: at the cap
      { medicine: 5, piloting: undefined }, // p3: excluded
      { medicine: 3, piloting: undefined }, // p4: free
    ]);
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 1 });
    await h.crew.addUnavailability(x.people[0]!.actor, { from: '2027-03-04', to: '2027-03-05' });
    await x.approved({
      crew: [x.people[1]!.userId],
      startDate: '2027-03-08',
      endDate: '2027-03-12',
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    }); // committed in the dates (and now at the cap too)
    await x.approved({
      crew: [x.people[2]!.userId],
      startDate: '2027-09-01',
      endDate: '2027-09-05',
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    }); // holds p2 elsewhere: at the cap, not committed

    const m = await x.crewing({
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 5 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, {
      exclude: [x.people[3]!.userId],
    });

    expect(proposal.complete).toBe(false);
    // Everyone eligible who qualifies is taken: the free person and Ann (Medicine 4), who holds nothing.
    expect(memberIds(proposal).sort()).toEqual([x.people[4]!.userId, x.ann.userId].sort());
    // Qualified at level 3+: p0..p3 (level 5), p4 (level 3) and Ann (level 4); Bob (2) does not qualify.
    expect(proposal.coverage[0]).toEqual({
      skillId: x.medicine.id,
      skill: 'Medicine',
      minLevel: 3,
      required: 5,
      met: 2,
      gap: {
        qualifiedTotal: 6,
        blocked: { UNAVAILABLE: 1, COMMITTED: 1, AT_CAPACITY: 1, EXCLUDED: 1 },
      },
    });
    // Qualified (6) = contributing (2) + blocked (4), so nobody eligible was left out.
    const text = JSON.stringify(proposal);
    for (const blocked of x.people.slice(0, 4)) {
      expect(text).not.toContain(blocked.userId);
      expect(text).not.toContain(blocked.email);
    }
  });

  it('only considers active Crew Members: not invited, deactivated or former Crew', async () => {
    const x = await world('Match active', [
      { medicine: 5, piloting: undefined },
      { medicine: 5, piloting: undefined },
      { medicine: 5, piloting: undefined },
    ]);
    await h.users.update(x.director.actor, x.people[0]!.userId, { status: 'deactivated' });
    await h.users.update(x.director.actor, x.people[1]!.userId, { role: 'lead' });
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 5, count: 3 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    expect(memberIds(proposal)).toEqual([x.people[2]!.userId]);
    // They are not even counted as qualified: only p2 qualifies at level 5.
    expect(proposal.coverage[0]!.gap!.qualifiedTotal).toBe(1);
  });

  it('falls back to the heuristic when the solver times out, and says so', async () => {
    const t = await createHarness(urls, { solver: { solve: () => ({ status: 'time_limit' }) } });
    try {
      const x = await missionWorld(t, 'Match timeout');
      const m = await x.crewing();
      const proposal = await t.matching.propose(x.lead.actor, m.id, { exclude: [] });
      expect(proposal).toMatchObject({ method: 'heuristic', complete: true });
      expect(memberIds(proposal)).toEqual([x.ann.userId]);
    } finally {
      await t.close();
    }
  });

  it('is deterministic: the same mission gives the same proposal and the same hash', async () => {
    const x = await world('Match determinism', [
      { medicine: 4, piloting: undefined },
      { medicine: 4, piloting: undefined },
      { medicine: 4, piloting: undefined },
    ]);
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 2 }],
    });
    const a = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const b = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    expect({ ...a, proposalId: '', expiresAt: '' }).toEqual({
      ...b,
      proposalId: '',
      expiresAt: '',
    });
    expect(b.proposalId).not.toBe(a.proposalId);
  });

  it('never proposes an excluded person, and an exclusion changes the proposal', async () => {
    const x = await world('Match exclude', [
      { medicine: 5, piloting: undefined },
      { medicine: 3, piloting: undefined },
    ]);
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const first = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const without = await h.matching.propose(x.lead.actor, m.id, { exclude: memberIds(first) });
    expect(memberIds(without)).not.toContain(memberIds(first)[0]);
    expect(memberIds(without)).toHaveLength(1);
    const everyone = [x.ann.userId, ...x.people.map((p) => p.userId)];
    const none = await h.matching.propose(x.lead.actor, m.id, { exclude: everyone });
    expect(none).toMatchObject({ complete: false, team: [] });
    expect(none.coverage[0]!.gap!.blocked.EXCLUDED).toBe(3);
  });

  it('refuses to exclude someone who is not an active Crew Member of the organisation, naming them', async () => {
    const x = await world('Match exclude bad', [{ medicine: 4, piloting: undefined }]);
    const other = await missionWorld(h, 'Match exclude bad other');
    const m = await x.crewing();
    for (const id of [x.lead2.userId, x.director.userId, other.ann.userId, newId()]) {
      await expect(
        h.matching.propose(x.lead.actor, m.id, { exclude: [x.ann.userId, id] }),
      ).rejects.toMatchObject({
        code: 'CREW_MEMBER_NOT_ASSIGNABLE',
        status: 400,
        extra: { crewMemberIds: [id] },
      });
    }
  });

  it('is for the owning Lead of a Crewing mission only', async () => {
    const x = await world('Match access', [{ medicine: 4, piloting: undefined }]);
    const other = await missionWorld(h, 'Match access other');
    const m = await x.crewing();
    for (const who of [x.lead2, x.director, x.ann]) {
      await expect(h.matching.propose(who.actor, m.id, { exclude: [] })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }
    for (const id of [newId(), (await other.crewing()).id]) {
      await expect(h.matching.propose(x.lead.actor, id, { exclude: [] })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    const draft = await x.draft();
    const pending = await x.pending({ startDate: '2027-07-01', endDate: '2027-07-05' });
    for (const status of [draft, pending]) {
      await expect(
        h.matching.propose(x.lead.actor, status.id, { exclude: [] }),
      ).rejects.toMatchObject({
        code: 'MISSION_NOT_EDITABLE',
        status: 409,
        extra: { missionStatus: status.status },
      });
    }
  });

  it('tidies up expired proposals of the mission when it makes a new one', async () => {
    const x = await world('Match tidy', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing();
    const old = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    h.clock.advance((MATCH_PROPOSAL_TTL_MINUTES + 1) * 60_000);
    const fresh = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const rows = await h.db.withTenant(x.org.orgId, (tx) =>
      tx.select().from(schema.matchProposals).where(eq(schema.matchProposals.missionId, m.id)),
    );
    expect(rows.map((r) => r.id)).toEqual([fresh.proposalId]);
    expect(rows.map((r) => r.id)).not.toContain(old.proposalId);
  });
});

describe('applying a proposal', () => {
  async function proposed(
    label: string,
    crew: Array<Record<'medicine' | 'piloting', number | undefined>> = [
      { medicine: 4, piloting: undefined },
    ],
  ) {
    const x = await world(label, crew);
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    return { x, m, proposal };
  }
  const apply = (
    x: MissionWorld,
    m: Pick<Mission, 'id' | 'version'>,
    proposalId: string,
    teamHash: string,
    version = m.version,
    who = x.lead,
  ) => h.matching.apply(who.actor, m.id, proposalId, { teamHash, version });

  it('replaces the tentative crew with the proposed team, valid and ready to submit, and audits it', async () => {
    const { x, m, proposal } = await proposed('Apply ok');
    h.audit.clear();
    const applied = await apply(x, m, proposal.proposalId, proposal.teamHash);
    expect(applied.crew.map((c) => c.crewMemberId).sort()).toEqual(memberIds(proposal).sort());
    expect(applied.version).toBe(m.version + 1);
    expect(applied.crewValidation).toEqual({
      valid: true,
      assignmentIssues: [],
      unmetRequirements: [],
    });
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.crew_set',
        after: {
          crewMemberIds: [...memberIds(proposal)].sort(),
          matchProposalId: proposal.proposalId,
        },
        actorId: x.lead.userId,
      }),
    ]);
    // …and the Lead can submit it as it is.
    expect((await x.act(applied, 'submit')).status).toBe('pending_approval');
  });

  it('replaces people who were there before, and keeps those who stay', async () => {
    const x = await world('Apply replace', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({
      crew: [x.bob.userId, x.ann.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [x.ann.userId] });
    const applied = await apply(x, m, proposal.proposalId, proposal.teamHash);
    expect(applied.crew.map((c) => c.crewMemberId)).toEqual(memberIds(proposal));
    expect(applied.crew.map((c) => c.crewMemberId)).not.toContain(x.bob.userId);
    expect(applied.crew.map((c) => c.crewMemberId)).not.toContain(x.ann.userId);
  });

  it('applies an empty proposal (nobody qualifies) by clearing the crew', async () => {
    const x = await missionWorld(h, 'Apply empty');
    const m = await x.crewing({
      crew: [x.bob.userId],
      requirements: [{ skillId: x.piloting.id, minLevel: 5, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [x.ann.userId] });
    expect(proposal.team).toEqual([]);
    const applied = await apply(x, m, proposal.proposalId, proposal.teamHash);
    expect(applied.crew).toEqual([]);
    expect(proposal.teamHash).toBe(teamHashOf([]));
  });

  it('is repeatable while nothing changes: applying the crew already in place is a no-op', async () => {
    const x = await world('Apply twice', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({
      crew: [x.ann.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    if (memberIds(proposal)[0] !== x.ann.userId) return; // only meaningful when Ann is the proposed team
    h.audit.clear();
    const first = await apply(x, m, proposal.proposalId, proposal.teamHash);
    const second = await apply(x, first, proposal.proposalId, proposal.teamHash, first.version);
    expect(second.version).toBe(first.version);
    expect(h.audit.events).toEqual([]);
  });

  it('refuses a stale mission version before anything else, with 412', async () => {
    const { x, m, proposal } = await proposed('Apply 412');
    await expect(
      apply(x, m, proposal.proposalId, 'f'.repeat(64), m.version - 1),
    ).rejects.toMatchObject({
      code: 'MISSION_VERSION_MISMATCH',
      status: 412,
      extra: { currentVersion: m.version },
    });
    await expect(apply(x, m, newId(), proposal.teamHash, m.version + 3)).rejects.toMatchObject({
      status: 412,
    });
  });

  it('answers 404 for an unknown proposal, one for another mission, and one from another organisation', async () => {
    const { x, m, proposal } = await proposed('Apply 404');
    const sibling = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const foreign = await proposed('Apply 404 other');
    for (const id of [newId(), proposal.proposalId, foreign.proposal.proposalId]) {
      await expect(apply(x, sibling, id, proposal.teamHash)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    await expect(apply(x, m, foreign.proposal.proposalId, proposal.teamHash)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      h.matching.apply(foreign.x.lead.actor, m.id, proposal.proposalId, {
        teamHash: proposal.teamHash,
        version: m.version,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an expired proposal', async () => {
    const { x, m, proposal } = await proposed('Apply expired');
    h.clock.advance(MATCH_PROPOSAL_TTL_MINUTES * 60_000 - 1000);
    await expect(apply(x, m, proposal.proposalId, proposal.teamHash)).resolves.toBeDefined(); // still valid just before the deadline
    const second = await proposed('Apply expired 2');
    h.clock.advance((MATCH_PROPOSAL_TTL_MINUTES + 1) * 60_000);
    await expect(
      apply(second.x, second.m, second.proposal.proposalId, second.proposal.teamHash),
    ).rejects.toMatchObject({
      code: 'MATCH_PROPOSAL_EXPIRED',
      status: 409,
    });
  });

  it('refuses a proposal made for an earlier version of the mission (stale), whatever the hash', async () => {
    const { x, m, proposal } = await proposed('Apply stale');
    const edited = await h.missions.update(
      x.lead.actor,
      m.id,
      { description: 'Dates or requirements changed' },
      m.version,
    );
    await expect(
      apply(x, edited, proposal.proposalId, proposal.teamHash, edited.version),
    ).rejects.toMatchObject({
      code: 'MATCH_PROPOSAL_STALE',
      status: 409,
      extra: { proposalVersion: m.version, currentVersion: edited.version },
    });
    expect((await view(x, m.id)).crew).toEqual([]);
    // Running the matcher again on the current version works.
    const again = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    await expect(
      apply(x, edited, again.proposalId, again.teamHash, edited.version),
    ).resolves.toMatchObject({ status: 'crewing' });
  });

  it('refuses when the hash does not match the one stored, or is not the team the Lead was shown', async () => {
    const { x, m, proposal } = await proposed('Apply hash');
    for (const hash of [
      '0'.repeat(64),
      teamHashOf(['someone@else.space']),
      proposal.teamHash.replace(/.$/, proposal.teamHash.endsWith('a') ? 'b' : 'a'),
    ]) {
      await expect(apply(x, m, proposal.proposalId, hash)).rejects.toMatchObject({
        code: 'MATCH_TEAM_HASH_MISMATCH',
        status: 409,
      });
    }
    expect((await view(x, m.id)).crew).toEqual([]);
  });

  it("refuses when a team member's email changed since the proposal, because the recomputed hash differs", async () => {
    const { x, m, proposal } = await proposed('Apply email');
    await admin.query('UPDATE users SET email = $2 WHERE id = $1', [
      memberIds(proposal)[0],
      `moved-${newId()}@test.space`,
    ]);
    await expect(apply(x, m, proposal.proposalId, proposal.teamHash)).rejects.toMatchObject({
      code: 'MATCH_TEAM_HASH_MISMATCH',
    });
    expect((await view(x, m.id)).crew).toEqual([]);
  });

  it('refuses to assign a proposed member who has since stopped being an active Crew Member', async () => {
    const { x, m, proposal } = await proposed('Apply inactive');
    await h.users.update(x.director.actor, memberIds(proposal)[0]!, { status: 'deactivated' });
    await expect(apply(x, m, proposal.proposalId, proposal.teamHash)).rejects.toMatchObject({
      code: 'CREW_MEMBER_NOT_ASSIGNABLE',
      status: 400,
    });
  });

  it('is for the owning Lead only, and the mission must still be Crewing', async () => {
    const { x, m, proposal } = await proposed('Apply access');
    for (const who of [x.lead2, x.director, x.ann]) {
      await expect(
        apply(x, m, proposal.proposalId, proposal.teamHash, m.version, who),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const reopened = await x.act(m, 'reopen');
    await expect(
      apply(x, reopened, proposal.proposalId, proposal.teamHash, reopened.version),
    ).rejects.toMatchObject({ code: 'MATCH_PROPOSAL_STALE' });
  });

  it('refuses a mission that has left Crewing even with a fresh proposal at that version', async () => {
    const x = await world('Apply locked', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({
      crew: [x.ann.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const pending = await x.act(m, 'submit');
    await expect(
      apply(x, pending, proposal.proposalId, proposal.teamHash, pending.version),
    ).rejects.toMatchObject({ code: 'MATCH_PROPOSAL_STALE' });
  });
});

describe('the team hash (DESIGN.md §9.5)', () => {
  it('is a SHA-256 over the lower-cased, sorted emails joined by newlines', () => {
    expect(teamHashOf([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); // SHA-256 of the empty string
    expect(teamHashOf(['a@x.space'])).toBe(teamHashOf(['A@X.SPACE']));
    expect(teamHashOf(['b@x.space', 'a@x.space'])).toBe(teamHashOf(['a@x.space', 'b@x.space']));
    expect(teamHashOf(['a@x.space', 'b@x.space'])).not.toBe(teamHashOf(['a@x.space']));
    expect(teamHashOf(['a@x.space', 'b@x.space'])).not.toBe(teamHashOf(['a@x.spaceb@x.space']));
    expect(teamHashOf(['a@x.space'])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('proposing does not hold a transaction while the solver works', () => {
  /** A database that records how many transactions are open, and can act just before one starts. */
  function watched(real: Db, beforeTransaction?: (n: number) => Promise<void>) {
    const state = { open: 0, started: 0 };
    const db: Db = {
      ...real,
      withTenant: async (orgId, fn) => {
        state.started++;
        await beforeTransaction?.(state.started);
        state.open++;
        try {
          return await real.withTenant(orgId, fn);
        } finally {
          state.open--;
        }
      },
    };
    return { db, state };
  }

  it('calls the solver with no transaction open, using two short ones around it', async () => {
    const x = await world('Match no tx', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing();
    const real = await createHighsSolver();
    const { db, state } = watched(h.db);
    const openDuringSolve: number[] = [];
    const service = new MatchService({
      db,
      clock: h.clock,
      policy: h.policy,
      missions: h.missions,
      solver: {
        solve: (model, options) => (openDuringSolve.push(state.open), real.solve(model, options)),
      },
    });
    const proposal = await service.propose(x.lead.actor, m.id, { exclude: [] });
    expect(proposal.complete).toBe(true);
    expect(openDuringSolve.length).toBeGreaterThanOrEqual(4); // coverage, workload, fit and rank passes
    expect(openDuringSolve.every((n) => n === 0)).toBe(true);
    expect(state.started).toBe(2); // one to read the facts, one to store the proposal
  });

  it('refuses to store a proposal when the mission changed while it was being solved', async () => {
    const x = await world('Match changed', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing();
    // Just before the second transaction (the one that stores the proposal), the Lead edits the mission.
    const { db } = watched(h.db, async (n) => {
      if (n === 2)
        await h.missions.update(
          x.lead.actor,
          m.id,
          { description: 'Edited while matching' },
          m.version,
        );
    });
    const service = new MatchService({
      db,
      clock: h.clock,
      policy: h.policy,
      missions: h.missions,
      solver: await createHighsSolver(),
    });
    await expect(service.propose(x.lead.actor, m.id, { exclude: [] })).rejects.toMatchObject({
      code: 'MATCH_PROPOSAL_STALE',
      status: 409,
      extra: { proposalVersion: m.version, currentVersion: m.version + 1 },
    });
    const rows = await h.db.withTenant(x.org.orgId, (tx) =>
      tx.select().from(schema.matchProposals).where(eq(schema.matchProposals.missionId, m.id)),
    );
    expect(rows).toEqual([]);
  });

  it('also refuses when the mission left Crewing while it was being solved', async () => {
    const x = await world('Match left crewing', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({ crew: [x.ann.userId] });
    const { db } = watched(h.db, async (n) => {
      if (n === 2) await h.missions.transition(x.lead.actor, m.id, { action: 'cancel' }, m.version);
    });
    const service = new MatchService({
      db,
      clock: h.clock,
      policy: h.policy,
      missions: h.missions,
      solver: await createHighsSolver(),
    });
    await expect(service.propose(x.lead.actor, m.id, { exclude: [] })).rejects.toMatchObject({
      code: 'MATCH_PROPOSAL_STALE',
    });
  });
});

describe('keeping match_proposals small', () => {
  const rowsOf = (x: { org: { orgId: string } }) =>
    h.db.withTenant(x.org.orgId, (tx) => tx.select().from(schema.matchProposals));

  it('purges expired proposals of every mission in the organisation, not only the one being matched', async () => {
    const x = await world('Tidy org', [{ medicine: 4, piloting: undefined }]);
    const a = await x.crewing({ name: 'A' });
    const b = await x.crewing({ name: 'B', startDate: '2027-05-01', endDate: '2027-05-05' });
    const old = await h.matching.propose(x.lead.actor, a.id, { exclude: [] });
    h.clock.advance((MATCH_PROPOSAL_TTL_MINUTES + 1) * 60_000);
    const fresh = await h.matching.propose(x.lead.actor, b.id, { exclude: [] }); // a different mission
    const ids = (await rowsOf(x)).map((r) => r.id);
    expect(ids).toEqual([fresh.proposalId]);
    expect(ids).not.toContain(old.proposalId);
  });

  it('purges earlier proposals of the mission made for an older version, and keeps valid ones of the current version', async () => {
    const x = await world('Tidy version', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing();
    const first = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    const second = await h.matching.propose(x.lead.actor, m.id, { exclude: [x.ann.userId] });
    expect((await rowsOf(x)).map((r) => r.id).sort()).toEqual(
      [first.proposalId, second.proposalId].sort(),
    ); // same version: both stay usable
    const edited = await h.missions.update(
      x.lead.actor,
      m.id,
      { description: 'New version' },
      m.version,
    );
    const third = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    expect(third.missionVersion).toBe(edited.version);
    expect((await rowsOf(x)).map((r) => r.id)).toEqual([third.proposalId]);
  });

  it("never touches another organisation's proposals", async () => {
    const x = await world('Tidy mine', [{ medicine: 4, piloting: undefined }]);
    const other = await world('Tidy theirs', [{ medicine: 4, piloting: undefined }]);
    const theirsMission = await other.crewing();
    const theirs = await h.matching.propose(other.lead.actor, theirsMission.id, { exclude: [] });
    h.clock.advance((MATCH_PROPOSAL_TTL_MINUTES + 1) * 60_000); // theirs is expired now
    await h.matching.propose(x.lead.actor, (await x.crewing()).id, { exclude: [] });
    expect((await rowsOf(other)).map((r) => r.id)).toEqual([theirs.proposalId]);
  });
});

describe('applying is one transaction', () => {
  it('lets exactly one of two concurrent applies of the same proposal win', async () => {
    for (let round = 0; round < 3; round++) {
      const x = await world(`Atomic ${round}`, [{ medicine: 4, piloting: undefined }]);
      const m = await x.crewing({
        crew: [x.bob.userId],
        requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
      });
      const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
      const apply = () =>
        h.matching.apply(x.lead.actor, m.id, proposal.proposalId, {
          teamHash: proposal.teamHash,
          version: m.version,
        });
      const results = await Promise.allSettled([apply(), apply()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ code: 'MISSION_VERSION_MISMATCH', status: 412 });
      const crew = (await view(x, m.id)).crew.map((c) => c.crewMemberId).sort();
      expect(crew).toEqual(memberIds(proposal).sort());
    }
  });

  it('changes nothing when any check fails: the crew, the version and the audit log stay as they were', async () => {
    const x = await world('Atomic failure', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({
      crew: [x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    await h.users.update(x.director.actor, memberIds(proposal)[0]!, { status: 'deactivated' }); // the replacement will be refused
    h.audit.clear();
    await expect(
      h.matching.apply(x.lead.actor, m.id, proposal.proposalId, {
        teamHash: proposal.teamHash,
        version: m.version,
      }),
    ).rejects.toMatchObject({
      code: 'CREW_MEMBER_NOT_ASSIGNABLE',
    });
    const after = await view(x, m.id);
    expect(after.version).toBe(m.version);
    expect(after.crew.map((c) => c.crewMemberId)).toEqual([x.bob.userId]);
    expect(h.audit.events).toEqual([]);
  });

  it('checks expiry and the hash in the same transaction as the replacement', async () => {
    const x = await world('Atomic expiry', [{ medicine: 4, piloting: undefined }]);
    const m = await x.crewing({
      requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }],
    });
    const proposal = await h.matching.propose(x.lead.actor, m.id, { exclude: [] });
    h.clock.advance(MATCH_PROPOSAL_TTL_MINUTES * 60_000 + 1000);
    await expect(
      h.matching.apply(x.lead.actor, m.id, proposal.proposalId, {
        teamHash: proposal.teamHash,
        version: m.version,
      }),
    ).rejects.toMatchObject({
      code: 'MATCH_PROPOSAL_EXPIRED',
    });
    expect((await view(x, m.id)).crew).toEqual([]);
  });
});
