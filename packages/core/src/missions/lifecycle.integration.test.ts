import {
  MissionActionSchema,
  MissionStatusSchema,
  type Mission,
  type MissionAction,
  type MissionStatus,
} from '@mc/contracts';
import { newId, schema } from '@mc/db';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createHarness, missionWorld, type Harness, type MissionWorld } from '../testing/index.js';
import { actionsFor, transitionFor } from './state-machine.js';

const urls = inject('dbUrls');
let h: Harness;
let admin: AdminDb;

beforeAll(async () => {
  h = await createHarness(urls);
  admin = openAdminDb(urls.migrator);
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

const holdsOf = (x: MissionWorld, missionId: string) =>
  h.db.withTenant(x.org.orgId, (tx) =>
    tx
      .select({
        crewMemberId: schema.holds.crewMemberId,
        releasedAt: schema.holds.releasedAt,
        releaseReason: schema.holds.releaseReason,
        period: sql<string>`${schema.holds.period}::text`,
        assignmentId: schema.holds.assignmentId,
      })
      .from(schema.holds)
      .where(eq(schema.holds.missionId, missionId)),
  );

const inboxOf = async (
  x: MissionWorld,
  who: { actor: Parameters<Harness['notifications']['list']>[0] },
) => (await h.notifications.list(who.actor, { limit: 100 })).items;

/** A mission in each state, each in its own organisation so date-driven transitions do not interfere. */
async function missionIn(status: MissionStatus): Promise<{ x: MissionWorld; mission: Mission }> {
  const x = await missionWorld(h, `State ${status}`);
  const run = (today: string) =>
    h.db.withTenant(x.org.orgId, (tx) => h.missions.runSystemTransitions(tx, today));
  switch (status) {
    case 'draft':
      return { x, mission: await x.draft() };
    case 'crewing':
      return { x, mission: await x.crewing({ crew: [x.ann.userId] }) };
    case 'pending_approval':
      return { x, mission: await x.pending() };
    case 'approved':
      return { x, mission: await x.approved() };
    case 'active': {
      const m = await x.approved({ startDate: '2027-05-01', endDate: '2027-05-20' });
      await run('2027-05-02');
      return { x, mission: (await h.missions.get(x.lead.actor, m.id)) as Mission };
    }
    case 'completed': {
      const m = await x.approved({ startDate: '2027-04-01', endDate: '2027-04-02' });
      await run('2027-04-03');
      return { x, mission: (await h.missions.get(x.lead.actor, m.id)) as Mission };
    }
    case 'cancelled':
      return { x, mission: await x.act(await x.draft(), 'cancel') };
  }
}

describe('every (state, action, role) combination that is not allowed (DESIGN.md §7.2)', () => {
  const actions = MissionActionSchema.options;

  for (const status of MissionStatusSchema.options) {
    it(`is refused on a ${status} mission`, async () => {
      const { x, mission } = await missionIn(status);
      expect(mission.status).toBe(status);
      const actors = {
        owner: { who: x.lead, kind: 'owner' as const },
        otherLead: { who: x.lead2, kind: 'other' as const },
        director: { who: x.director, kind: 'director' as const },
        crew: { who: x.ann, kind: 'other' as const },
      };
      let checked = 0;
      for (const action of actions) {
        const def = transitionFor(action);
        for (const [name, { who, kind }] of Object.entries(actors)) {
          // The role or ownership can never do this: 403, whatever the state.
          const permitted =
            (name === 'owner' && def.by === 'owner') ||
            (name === 'director' && def.by === 'director');
          const attempt = () =>
            h.missions.transition(
              who.actor,
              mission.id,
              { action, comment: 'because' },
              mission.version,
            );
          if (!permitted) {
            await expect(attempt(), `${name} ${action} on ${status}`).rejects.toMatchObject({
              code: 'FORBIDDEN',
              status: 403,
            });
            checked++;
            continue;
          }
          // An allowed combination: the effect tests below cover it, and running it here would change the mission.
          if (def.from.includes(status)) continue;
          // Allowed for this actor in general, but not in this state: 409 listing what they can do now.
          await expect(attempt(), `${name} ${action} on ${status}`).rejects.toMatchObject({
            code: 'MISSION_INVALID_TRANSITION',
            status: 409,
            extra: {
              missionStatus: status,
              allowedActions: actionsFor(kind === 'owner' ? 'owner' : 'director', status),
            },
          });
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(20);
      // None of the refusals changed anything.
      const after = (await h.missions.get(x.lead.actor, mission.id)) as Mission;
      expect([after.status, after.version]).toEqual([status, mission.version]);
    });
  }

  it('names the allowed actions for the actor, which differ by role', async () => {
    const { x, mission } = await missionIn('pending_approval');
    await expect(
      h.missions.transition(x.lead.actor, mission.id, { action: 'start_crewing' }, mission.version),
    ).rejects.toMatchObject({
      extra: { allowedActions: ['withdraw', 'cancel'] },
    });
    await expect(
      h.missions.transition(x.director.actor, mission.id, { action: 'approve' }, mission.version),
    ).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('start_crewing', () => {
  it('moves Draft to Crewing when there is a requirement', async () => {
    const x = await missionWorld(h, 'Start');
    let m = await x.draft();
    m = await h.missions.setRequirements(
      x.lead.actor,
      m.id,
      { requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }] },
      m.version,
    );
    h.audit.clear();
    const crewing = await x.act(m, 'start_crewing');
    expect(crewing).toMatchObject({
      status: 'crewing',
      version: m.version + 1,
      allowedActions: ['reopen', 'submit', 'cancel'],
    });
    expect(crewing.crewValidation).toBeDefined();
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.start_crewing',
        before: { status: 'draft', version: m.version },
        after: { status: 'crewing', version: m.version + 1 },
        actorId: x.lead.userId,
      }),
    ]);
  });

  it('needs at least one requirement', async () => {
    const x = await missionWorld(h, 'Start none');
    const m = await x.draft();
    await expect(x.act(m, 'start_crewing')).rejects.toMatchObject({
      code: 'MISSION_REQUIREMENTS_REQUIRED',
      status: 409,
    });
  });

  it("needs a start date that is not in the past, in the organisation's time zone", async () => {
    const t = await createHarness(urls); // its own clock: 2026-10-02T10:00Z
    try {
      const x = await missionWorld(t, 'Start dates');
      const prep = async (startDate: string) => {
        let m = await x.draft({ startDate, endDate: '2027-01-01' });
        m = await t.missions.setRequirements(
          x.lead.actor,
          m.id,
          { requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }] },
          m.version,
        );
        return m;
      };
      const today = await prep('2026-10-02');
      expect(
        (
          await t.missions.transition(
            x.lead.actor,
            today.id,
            { action: 'start_crewing' },
            today.version,
          )
        ).status,
      ).toBe('crewing');
      const yesterday = await prep('2026-10-01');
      await expect(
        t.missions.transition(
          x.lead.actor,
          yesterday.id,
          { action: 'start_crewing' },
          yesterday.version,
        ),
      ).rejects.toMatchObject({
        code: 'MISSION_START_IN_PAST',
        status: 409,
      });

      // In Kiritimati (UTC+14) it is already 2026-10-03, so today's UTC date is the past there.
      await t.settings.update(x.director.actor, { timeZone: 'Pacific/Kiritimati' });
      const east = await prep('2026-10-02');
      await expect(
        t.missions.transition(x.lead.actor, east.id, { action: 'start_crewing' }, east.version),
      ).rejects.toMatchObject({ code: 'MISSION_START_IN_PAST' });
      // In Pago Pago (UTC-11) it is still 2026-10-01.
      await t.settings.update(x.director.actor, { timeZone: 'Pacific/Pago_Pago' });
      const west = await prep('2026-10-01');
      expect(
        (
          await t.missions.transition(
            x.lead.actor,
            west.id,
            { action: 'start_crewing' },
            west.version,
          )
        ).status,
      ).toBe('crewing');
    } finally {
      await t.close();
    }
  });
});

describe('reopen', () => {
  it('returns to Draft and clears the tentative crew', async () => {
    const x = await missionWorld(h, 'Reopen');
    const m = await x.crewing({ crew: [x.ann.userId, x.bob.userId] });
    const draft = await x.act(m, 'reopen');
    expect(draft).toMatchObject({ status: 'draft', crew: [] });
    expect(draft.requirements).toHaveLength(1); // the requirements stay
    expect(draft.crewValidation).toBeUndefined();
  });

  it('keeps released holds as history when the crew of a rejected mission is cleared', async () => {
    const x = await missionWorld(h, 'Reopen history');
    const m = await x.act(await x.pending(), 'reject', x.director, 'Try again');
    await x.act(m, 'reopen');
    const holds = await holdsOf(x, m.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ assignmentId: null, releaseReason: 'rejected' });
  });
});

describe('submit', () => {
  it('moves to Pending approval, takes one hold per assignee over the inclusive dates, and notifies Directors', async () => {
    const x = await missionWorld(h, 'Submit');
    const m = await x.crewing({
      crew: [x.ann.userId, x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 2 }],
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    const pending = await x.act(m, 'submit');
    expect(pending).toMatchObject({
      status: 'pending_approval',
      allowedActions: ['withdraw', 'cancel'],
    });
    expect(pending.crewValidation).toBeUndefined();

    const holds = await holdsOf(x, m.id);
    expect(holds.map((hold) => hold.crewMemberId).sort()).toEqual(
      [x.ann.userId, x.bob.userId].sort(),
    );
    for (const hold of holds) {
      expect(hold).toMatchObject({
        releasedAt: null,
        releaseReason: null,
        period: '[2027-03-01,2027-03-11)',
      }); // 03-01..03-10 inclusive
      expect(hold.assignmentId).not.toBeNull();
    }
    expect((await inboxOf(x, x.director)).map((n) => [n.type, n.payload.missionId])).toEqual([
      ['mission.submitted', m.id],
    ]);
  });

  it('refuses an empty crew', async () => {
    const x = await missionWorld(h, 'Submit empty');
    const m = await x.crewing();
    await expect(x.act(m, 'submit')).rejects.toMatchObject({
      code: 'MISSION_CREW_EMPTY',
      status: 409,
    });
    expect(await holdsOf(x, m.id)).toEqual([]);
  });

  it('refuses a crew that does not meet every requirement, listing what is unmet', async () => {
    const x = await missionWorld(h, 'Submit unmet');
    const m = await x.crewing({
      crew: [x.bob.userId],
      requirements: [
        { skillId: x.medicine.id, minLevel: 3, count: 1 },
        { skillId: x.piloting.id, minLevel: 1, count: 1 },
      ],
    });
    await expect(x.act(m, 'submit')).rejects.toMatchObject({
      code: 'REQUIREMENTS_NOT_MET',
      status: 409,
      extra: {
        unmetRequirements: [
          { skillId: x.medicine.id, minLevel: 3, required: 1, met: 0 },
          { skillId: x.piloting.id, minLevel: 1, required: 1, met: 0 },
        ].sort((a, b) => a.skillId.localeCompare(b.skillId)),
      },
    });
    expect(await holdsOf(x, m.id)).toEqual([]);
    expect(((await h.missions.get(x.lead.actor, m.id)) as Mission).status).toBe('crewing');
  });

  it('lets one person cover several requirements (the sum may exceed the crew)', async () => {
    const x = await missionWorld(h, 'Submit overlap');
    const m = await x.crewing({
      crew: [x.ann.userId],
      requirements: [
        { skillId: x.medicine.id, minLevel: 4, count: 1 },
        { skillId: x.piloting.id, minLevel: 5, count: 1 },
      ],
    });
    expect((await x.act(m, 'submit')).status).toBe('pending_approval');
  });

  it('names the failure kind and the people, in order of precedence, listing every kind', async () => {
    const x = await missionWorld(h, 'Submit kinds');
    await x.approved({ startDate: '2027-03-05', endDate: '2027-03-06' }); // holds Ann
    const m = await x.crewing({
      crew: [x.ann.userId, x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 2 }],
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    await h.crew.addUnavailability(x.bob.actor, { from: '2027-03-08', to: '2027-03-09' });
    await expect(x.act(m, 'submit')).rejects.toMatchObject({
      code: 'CREW_UNAVAILABLE', // precedence: not active, unavailable, double-booked, at capacity
      status: 409,
      extra: {
        issues: [
          { code: 'CREW_UNAVAILABLE', crewMemberIds: [x.bob.userId] },
          { code: 'CREW_DOUBLE_BOOKED', crewMemberIds: [x.ann.userId] },
        ],
      },
    });
    expect(await holdsOf(x, m.id)).toEqual([]);
  });

  it('refuses people who are no longer active Crew Members', async () => {
    const x = await missionWorld(h, 'Submit inactive');
    const m = await x.crewing({
      crew: [x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    });
    await h.users.update(x.director.actor, x.bob.userId, { status: 'deactivated' });
    await expect(x.act(m, 'submit')).rejects.toMatchObject({
      code: 'CREW_NOT_ACTIVE',
      extra: { issues: [{ code: 'CREW_NOT_ACTIVE', crewMemberIds: [x.bob.userId] }] },
    });
  });

  it('enforces the workload cap at its boundary, and lowering it later releases nothing', async () => {
    const x = await missionWorld(h, 'Submit cap');
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 1 });
    const first = await x.pending({ startDate: '2027-03-01', endDate: '2027-03-05' });
    const second = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-06-01',
      endDate: '2027-06-05',
    });
    await expect(x.act(second, 'submit')).rejects.toMatchObject({
      code: 'WORKLOAD_CAP_EXCEEDED',
      status: 409,
      extra: { issues: [{ code: 'WORKLOAD_CAP_EXCEEDED', crewMemberIds: [x.ann.userId] }] },
    });
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 2 });
    expect((await x.act(second, 'submit')).status).toBe('pending_approval');

    // Lowering the cap applies to new submissions only (§5.2 invariant 6).
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 1 });
    expect((await holdsOf(x, first.id)).every((hold) => hold.releasedAt === null)).toBe(true);
    expect((await holdsOf(x, second.id)).every((hold) => hold.releasedAt === null)).toBe(true);
  });

  it('treats a shared day as double-booking and adjacent days as free', async () => {
    const x = await missionWorld(h, 'Submit edges');
    await x.pending({ startDate: '2027-03-01', endDate: '2027-03-10' });
    const sharedDay = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-03-10',
      endDate: '2027-03-12',
    });
    await expect(x.act(sharedDay, 'submit')).rejects.toMatchObject({ code: 'CREW_DOUBLE_BOOKED' });
    const adjacent = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-03-11',
      endDate: '2027-03-12',
    });
    expect((await x.act(adjacent, 'submit')).status).toBe('pending_approval');
    const before = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-02-20',
      endDate: '2027-02-28',
    });
    expect((await x.act(before, 'submit')).status).toBe('pending_approval');
  });

  it('refuses a start date that has passed (the mission stays in Crewing)', async () => {
    const t = await createHarness(urls);
    try {
      const x = await missionWorld(t, 'Submit late');
      const m = await x.crewing({
        crew: [x.ann.userId],
        startDate: '2026-10-05',
        endDate: '2026-10-09',
      });
      t.clock.advance(4 * 24 * 3600 * 1000); // 2026-10-06
      await expect(
        t.missions.transition(x.lead.actor, m.id, { action: 'submit' }, m.version),
      ).rejects.toMatchObject({ code: 'MISSION_START_IN_PAST' });
    } finally {
      await t.close();
    }
  });

  it('keeps the invariants once submitted (§5.2 4 and 7): the crew satisfies the requirements and has no unavailability in the dates', async () => {
    const x = await missionWorld(h, 'Submit invariants');
    const m = await x.pending({ startDate: '2027-03-01', endDate: '2027-03-10' });
    const view = (await h.missions.get(x.lead.actor, m.id)) as Mission;
    expect(view.crew.length).toBeGreaterThanOrEqual(1);
    // Ann cannot now declare herself unavailable in those dates (OQ-1)…
    await expect(
      h.crew.addUnavailability(x.ann.actor, { from: '2027-03-05', to: '2027-03-06' }),
    ).rejects.toMatchObject({
      code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
      extra: { missions: [expect.objectContaining({ id: m.id, status: 'pending_approval' })] },
    });
    // …and a mission cannot be submitted over dates she already declared unavailable.
    await h.crew.addUnavailability(x.ann.actor, { from: '2027-08-05', to: '2027-08-06' });
    const clash = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-08-01',
      endDate: '2027-08-10',
    });
    await expect(x.act(clash, 'submit')).rejects.toMatchObject({ code: 'CREW_UNAVAILABLE' });
  });
});

describe('concurrent submissions (invariants 5 and 6)', () => {
  it('lets exactly one of two missions sharing a crew member over overlapping dates win', async () => {
    for (let round = 0; round < 3; round++) {
      const x = await missionWorld(h, `Race dates ${round}`);
      const a = await x.crewing({
        crew: [x.ann.userId],
        name: 'A',
        startDate: '2027-03-01',
        endDate: '2027-03-10',
      });
      const b = await x.crewing({
        crew: [x.ann.userId],
        name: 'B',
        startDate: '2027-03-05',
        endDate: '2027-03-15',
        owner: x.lead2,
      });
      const results = await Promise.allSettled([x.act(a, 'submit'), x.act(b, 'submit', x.lead2)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toMatchObject({ code: 'CREW_DOUBLE_BOOKED', status: 409 });

      const live = await h.db.withTenant(x.org.orgId, (tx) =>
        tx
          .select()
          .from(schema.holds)
          .where(
            sql`${schema.holds.crewMemberId} = ${x.ann.userId} and ${schema.holds.releasedAt} is null`,
          ),
      );
      expect(live).toHaveLength(1);
    }
  });

  it('lets exactly one of two non-overlapping missions win when the cap leaves room for one', async () => {
    const x = await missionWorld(h, 'Race cap');
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 1 });
    const a = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-03-01',
      endDate: '2027-03-05',
    });
    const b = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-06-01',
      endDate: '2027-06-05',
      owner: x.lead2,
    });
    const results = await Promise.allSettled([x.act(a, 'submit'), x.act(b, 'submit', x.lead2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'WORKLOAD_CAP_EXCEEDED' });
  });

  it('lets both win when the people and dates differ', async () => {
    const x = await missionWorld(h, 'Race independent');
    const req = [{ skillId: x.medicine.id, minLevel: 1, count: 1 }];
    const a = await x.crewing({ crew: [x.ann.userId], requirements: req });
    const b = await x.crewing({ crew: [x.bob.userId], requirements: req, owner: x.lead2 });
    const results = await Promise.allSettled([x.act(a, 'submit'), x.act(b, 'submit', x.lead2)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('does not let a person be unavailable and held at once when the two race', async () => {
    const x = await missionWorld(h, 'Race unavailability');
    const m = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    const results = await Promise.allSettled([
      x.act(m, 'submit'),
      h.crew.addUnavailability(x.ann.actor, { from: '2027-03-05', to: '2027-03-06' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const ranges = (await h.crew.get(x.lead.actor, x.ann.userId)).unavailability;
    const holds = (await holdsOf(x, m.id)).filter((hold) => hold.releasedAt === null);
    expect(ranges.length + holds.length).toBe(1);
  });
});

describe('approve and reject', () => {
  it('approves: records the decision, locks the mission, and any Director may do it', async () => {
    const x = await missionWorld(h, 'Approve');
    const second = await h.users.invite(x.director.actor, {
      email: `d2-${newId()}@test.space`,
      role: 'director',
    });
    const m = await x.pending();
    h.audit.clear();
    const approved = await x.act(m, 'approve', x.director, 'Looks good');
    expect(approved).toMatchObject({
      status: 'approved',
      allowedActions: [],
      crew: [expect.objectContaining({ crewMemberId: x.ann.userId })],
    });
    expect(approved.decisions).toEqual([
      {
        id: expect.any(String),
        directorId: x.director.userId,
        decision: 'approved',
        comment: 'Looks good',
        decidedAt: expect.any(String),
      },
    ]);
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.approve',
        after: { status: 'approved', version: m.version + 1, comment: 'Looks good' },
        actorId: x.director.userId,
      }),
    ]);
    // The holds stay live through Approved.
    expect((await holdsOf(x, m.id)).every((hold) => hold.releasedAt === null)).toBe(true);
    void second;
  });

  it('approves without a comment', async () => {
    const x = await missionWorld(h, 'Approve silent');
    const approved = await x.act(await x.pending(), 'approve', x.director);
    expect(approved.decisions[0]).toMatchObject({ decision: 'approved', comment: null });
  });

  it('lets a second Director approve what the first left pending', async () => {
    const x = await missionWorld(h, 'Approve second');
    const email = `second-${newId()}@test.space`;
    const invited = await h.users.invite(x.director.actor, { email, role: 'director' });
    const session = await h.auth.acceptInvite({
      code: invited.invite.inviteCode,
      name: 'Second',
      password: 'correct horse battery staple',
    });
    const m = await x.pending();
    const second = {
      actor: {
        kind: 'user' as const,
        userId: session.userId,
        orgId: x.org.orgId,
        role: 'director' as const,
      },
    };
    expect(
      (await h.missions.transition(second.actor, m.id, { action: 'approve' }, m.version))
        .decisions[0]!.directorId,
    ).toBe(session.userId);
  });

  it('rejects: needs a reason, releases the holds, returns to Crewing and keeps the decision', async () => {
    const x = await missionWorld(h, 'Reject');
    const m = await x.pending();
    for (const comment of [undefined, '', '   ']) {
      await expect(x.act(m, 'reject', x.director, comment)).rejects.toMatchObject({
        code: 'REJECTION_REASON_REQUIRED',
        status: 400,
        extra: { errors: [expect.objectContaining({ field: 'comment' })] },
      });
    }
    expect(((await h.missions.get(x.lead.actor, m.id)) as Mission).status).toBe('pending_approval');

    const rejected = await x.act(m, 'reject', x.director, 'Too risky this quarter');
    // The response is the Director's view (nothing to do on a Crewing mission); the Lead's view has the actions.
    expect(rejected).toMatchObject({ status: 'crewing', allowedActions: [] });
    expect(((await h.missions.get(x.lead.actor, m.id)) as Mission).allowedActions).toEqual([
      'reopen',
      'submit',
      'cancel',
    ]);
    expect(rejected.decisions).toEqual([
      expect.objectContaining({ decision: 'rejected', comment: 'Too risky this quarter' }),
    ]);
    expect(rejected.crew).toHaveLength(1); // the crew stays, tentative again
    expect(rejected.crewValidation?.valid).toBe(true);
    const holds = await holdsOf(x, m.id);
    expect(
      holds.every((hold) => hold.releasedAt !== null && hold.releaseReason === 'rejected'),
    ).toBe(true);
  });

  it('can be resubmitted after a rejection, taking fresh holds, and then approved', async () => {
    const x = await missionWorld(h, 'Reject resubmit');
    const rejected = await x.act(await x.pending(), 'reject', x.director, 'Not yet');
    const again = await x.act(rejected, 'submit');
    const approved = await x.act(again, 'approve', x.director);
    expect(approved.decisions.map((d) => d.decision)).toEqual(['rejected', 'approved']);
    const holds = await holdsOf(x, approved.id);
    expect(holds).toHaveLength(2);
    expect(holds.filter((hold) => hold.releasedAt === null)).toHaveLength(1);
    expect(holds.filter((hold) => hold.releaseReason === 'rejected')).toHaveLength(1);
  });

  it('refuses to approve once the start date has passed', async () => {
    const t = await createHarness(urls);
    try {
      const x = await missionWorld(t, 'Approve late');
      const m = await x.pending({ startDate: '2026-10-05', endDate: '2026-10-09' });
      t.clock.advance(4 * 24 * 3600 * 1000);
      await expect(
        t.missions.transition(x.director.actor, m.id, { action: 'approve' }, m.version),
      ).rejects.toMatchObject({ code: 'MISSION_START_IN_PAST' });
      // It can still be rejected, or withdrawn by its owner.
      await expect(
        t.missions.transition(
          x.director.actor,
          m.id,
          { action: 'reject', comment: 'late' },
          m.version,
        ),
      ).resolves.toMatchObject({ status: 'crewing' });
    } finally {
      await t.close();
    }
  });

  it('asserts that a Director never decides on a mission they own (invariant 8)', async () => {
    const x = await missionWorld(h, 'Approve own');
    const m = await x.pending();
    await admin.query('UPDATE missions SET lead_id = $2 WHERE id = $1', [m.id, x.director.userId]);
    await expect(
      h.missions.transition(x.director.actor, m.id, { action: 'approve' }, m.version),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      h.missions.transition(x.director.actor, m.id, { action: 'reject', comment: 'x' }, m.version),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('withdraw and cancel', () => {
  it('withdraws: releases the holds as withdrawn and returns to Crewing', async () => {
    const x = await missionWorld(h, 'Withdraw');
    const m = await x.pending();
    h.audit.clear();
    const crewing = await x.act(m, 'withdraw');
    expect(crewing.status).toBe('crewing');
    expect(
      (await holdsOf(x, m.id)).every(
        (hold) => hold.releaseReason === 'withdrawn' && hold.releasedAt !== null,
      ),
    ).toBe(true);
    expect(h.audit.forEntity('mission', m.id).map((e) => e.action)).toEqual(['mission.withdraw']);
    // Withdrawing made the person free again.
    expect((await h.crew.get(x.lead.actor, x.ann.userId)).load).toBe(0);
  });

  it('cancels from Draft, Crewing, Pending approval and Approved, releasing the holds as cancelled', async () => {
    const x = await missionWorld(h, 'Cancel');
    const draft = await x.act(await x.draft(), 'cancel');
    const crewing = await x.act(await x.crewing({ crew: [x.ann.userId] }), 'cancel');
    const pending = await x.pending({ startDate: '2027-04-01', endDate: '2027-04-05' });
    const cancelledPending = await x.act(pending, 'cancel');
    const approved = await x.approved({ startDate: '2027-05-01', endDate: '2027-05-05' });
    const cancelledApproved = await x.act(approved, 'cancel');
    for (const m of [draft, crewing, cancelledPending, cancelledApproved]) {
      expect(m).toMatchObject({ status: 'cancelled', allowedActions: [] });
    }
    for (const id of [pending.id, approved.id]) {
      const holds = await holdsOf(x, id);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ releaseReason: 'cancelled' });
      expect(holds[0]!.releasedAt).not.toBeNull();
    }
    expect((await h.crew.get(x.lead.actor, x.ann.userId)).load).toBe(0);
  });

  it("is the owning Lead's alone: Directors and other Leads cannot cancel, and Active missions cannot be cancelled", async () => {
    const { x, mission } = await missionIn('approved');
    await expect(x.act(mission, 'cancel', x.director)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(x.act(mission, 'cancel', x.lead2)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const active = await missionIn('active');
    await expect(active.x.act(active.mission, 'cancel')).rejects.toMatchObject({
      code: 'MISSION_INVALID_TRANSITION',
      status: 409,
      extra: { missionStatus: 'active', allowedActions: [] },
    });
    const done = await missionIn('completed');
    await expect(done.x.act(done.mission, 'cancel')).rejects.toMatchObject({
      code: 'MISSION_INVALID_TRANSITION',
    });
  });
});

describe('an audit event for every transition', () => {
  it('records exactly one event per action, with the actor and the before and after status', async () => {
    const x = await missionWorld(h, 'Audit');
    h.audit.clear();
    let m = await x.draft();
    m = await h.missions.setRequirements(
      x.lead.actor,
      m.id,
      { requirements: [{ skillId: x.medicine.id, minLevel: 3, count: 1 }] },
      m.version,
    );
    m = await x.act(m, 'start_crewing');
    m = await h.missions.replaceCrew(x.lead.actor, m.id, [x.ann.userId], { version: m.version });
    m = await x.act(m, 'submit');
    m = await x.act(m, 'withdraw');
    m = await x.act(m, 'submit');
    m = await x.act(m, 'reject', x.director, 'no');
    m = await x.act(m, 'submit');
    m = await x.act(m, 'approve', x.director);
    m = await x.act(m, 'cancel');
    const events = h.audit.forEntity('mission', m.id);
    expect(events.map((e) => e.action)).toEqual([
      'mission.created',
      'mission.requirements_set',
      'mission.start_crewing',
      'mission.crew_set',
      'mission.submit',
      'mission.withdraw',
      'mission.submit',
      'mission.reject',
      'mission.submit',
      'mission.approve',
      'mission.cancel',
    ]);
    for (const e of events.filter(
      (e) =>
        !['mission.created', 'mission.requirements_set', 'mission.crew_set'].includes(e.action),
    )) {
      expect(e.actorId).toBeTruthy();
      expect(e.before).toMatchObject({ status: expect.any(String), version: expect.any(Number) });
      expect(e.after).toMatchObject({ status: expect.any(String), version: expect.any(Number) });
    }
    expect(events.find((e) => e.action === 'mission.reject')).toMatchObject({
      after: expect.objectContaining({ comment: 'no' }),
      actorId: x.director.userId,
    });
  });

  it('records nothing when the transition fails', async () => {
    const x = await missionWorld(h, 'Audit failed');
    const m = await x.crewing();
    h.audit.clear();
    await expect(x.act(m, 'submit')).rejects.toMatchObject({ code: 'MISSION_CREW_EMPTY' });
    await expect(
      h.missions.transition(x.director.actor, m.id, { action: 'approve' }, m.version),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.audit.events).toEqual([]);
  });
});

describe('invariants of §5.2 around the lifecycle', () => {
  it("keeps a mission's dates ordered (invariant 2), even for rows written around the service", async () => {
    const m = await (await missionWorld(h, 'Inv2')).draft();
    await expect(
      admin.query("UPDATE missions SET end_date = '2000-01-01' WHERE id = $1", [m.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('has at least one requirement from Crewing onward (invariant 3)', async () => {
    const x = await missionWorld(h, 'Inv3');
    for (const status of ['crewing', 'pending_approval', 'approved'] as const) {
      const { mission } = await missionIn(status);
      expect(
        ((await h.missions.get(x.director.actor, mission.id).catch(() => undefined)) ?? mission)
          .status,
      ).toBeDefined();
      expect(mission.requirements.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('never leaves holds that belong to a missed mission status (live holds only while Pending approval, Approved or Active)', async () => {
    for (const status of [
      'draft',
      'crewing',
      'pending_approval',
      'approved',
      'active',
      'completed',
      'cancelled',
    ] as const) {
      const { x, mission } = await missionIn(status);
      const live = (await holdsOf(x, mission.id)).filter((hold) => hold.releasedAt === null);
      expect(live.length > 0, status).toBe(
        ['pending_approval', 'approved', 'active'].includes(status),
      );
    }
  });
});

void [MissionActionSchema as unknown as MissionAction];
