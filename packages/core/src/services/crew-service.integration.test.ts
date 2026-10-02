import { newId } from '@mc/db';
import { addAssignment, addHold, addMission, openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  onboardUser,
  provisionOrganisation,
  type Harness,
} from '../testing/index.js';

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

/** An organisation with a Lead, two Crew Members and two skills. */
async function world(label: string) {
  const org = await provisionOrganisation(h, label);
  const lead = await onboardUser(h, org, 'lead');
  const ann = await onboardUser(h, org, 'crew', 'ann');
  const bob = await onboardUser(h, org, 'crew', 'bob');
  const medicine = await h.skills.create(org.director.actor, { name: 'Medicine' });
  const piloting = await h.skills.create(org.director.actor, { name: 'Piloting' });
  return {
    org,
    lead,
    ann,
    bob,
    medicine,
    piloting,
    tenant: { orgId: org.orgId, leadId: lead.userId },
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Gives a crew member a live hold on a new mission, over an inclusive date range. */
async function hold(w: World, crewId: string, from: string, to: string, status = 'approved') {
  const mission = await addMission(admin, w.tenant, from, to);
  await admin.query('UPDATE missions SET status = $2 WHERE id = $1', [mission, status]);
  const assignment = await addAssignment(admin, w.tenant, mission, crewId);
  const holdId = await addHold(admin, w.tenant, assignment, mission, crewId, from, to);
  return { mission, holdId };
}

describe('crew skills', () => {
  it('lets a Crew Member set, change and remove their own skill levels, with audit', async () => {
    const w = await world('Skills');
    h.audit.clear();
    expect(await h.crew.setSkill(w.ann.actor, w.medicine.id, 3)).toEqual({
      skillId: w.medicine.id,
      name: 'Medicine',
      level: 3,
    });
    await h.crew.setSkill(w.ann.actor, w.medicine.id, 5);
    await h.crew.setSkill(w.ann.actor, w.piloting.id, 1);
    expect((await h.crew.get(w.ann.actor, w.ann.userId)).skills).toEqual([
      { skillId: w.medicine.id, name: 'Medicine', level: 5 },
      { skillId: w.piloting.id, name: 'Piloting', level: 1 },
    ]);
    await h.crew.removeSkill(w.ann.actor, w.piloting.id);
    expect((await h.crew.get(w.ann.actor, w.ann.userId)).skills).toHaveLength(1);

    expect(
      h.audit.forEntity('crew_profile', w.ann.userId).map((e) => [e.action, e.before, e.after]),
    ).toEqual([
      ['crew.skill_set', null, { skillId: w.medicine.id, level: 3 }],
      [
        'crew.skill_set',
        { skillId: w.medicine.id, level: 3 },
        { skillId: w.medicine.id, level: 5 },
      ],
      ['crew.skill_set', null, { skillId: w.piloting.id, level: 1 }],
      ['crew.skill_removed', { skillId: w.piloting.id, level: 1 }, undefined],
    ]);
  });

  it('treats setting the same level again as a no-op', async () => {
    const w = await world('Same');
    await h.crew.setSkill(w.ann.actor, w.medicine.id, 2);
    h.audit.clear();
    await h.crew.setSkill(w.ann.actor, w.medicine.id, 2);
    expect(h.audit.events).toEqual([]);
  });

  it('is for Crew Members only: Directors and Leads get 403', async () => {
    const w = await world('Roles');
    for (const actor of [w.org.director.actor, w.lead.actor]) {
      await expect(h.crew.setSkill(actor, w.medicine.id, 3)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
      await expect(h.crew.removeSkill(actor, w.medicine.id)).rejects.toMatchObject({ status: 403 });
    }
  });

  it('answers 404 for an unknown skill, a foreign skill, and removing a level never set', async () => {
    const w = await world('Missing');
    const other = await provisionOrganisation(h, 'Elsewhere');
    const foreign = await h.skills.create(other.director.actor, { name: 'Foreign' });
    await expect(h.crew.setSkill(w.ann.actor, newId(), 3)).rejects.toMatchObject({ status: 404 });
    await expect(h.crew.setSkill(w.ann.actor, foreign.id, 3)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(h.crew.removeSkill(w.ann.actor, w.medicine.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it("only ever touches the caller's own profile", async () => {
    const w = await world('Own');
    await h.crew.setSkill(w.ann.actor, w.medicine.id, 4);
    await expect(h.crew.removeSkill(w.bob.actor, w.medicine.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await h.crew.get(w.ann.actor, w.ann.userId)).skills).toHaveLength(1);
  });

  it('can be edited while held on a mission (OQ-5) and leaves the hold alone', async () => {
    const w = await world('Held');
    const { holdId } = await hold(w, w.ann.userId, '2031-05-01', '2031-05-10');
    await expect(h.crew.setSkill(w.ann.actor, w.medicine.id, 5)).resolves.toMatchObject({
      level: 5,
    });
    const { rows } = await admin.query('SELECT released_at FROM holds WHERE id = $1', [holdId]);
    expect(rows[0].released_at).toBeNull();
  });
});

describe('profile visibility', () => {
  it('shows any profile to Directors and Leads, but a Crew Member only their own', async () => {
    const w = await world('Visibility');
    for (const actor of [w.org.director.actor, w.lead.actor, w.ann.actor]) {
      expect((await h.crew.get(actor, w.ann.userId)).email).toBe(w.ann.email);
    }
    expect((await h.crew.get(w.lead.actor, w.bob.userId)).email).toBe(w.bob.email);
    await expect(h.crew.get(w.ann.actor, w.bob.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it("never lists or returns leads, directors, invited or deactivated users, or other organisations' crew", async () => {
    const w = await world('Hidden');
    const other = await world('Hidden Other');
    const invited = await h.users.invite(w.org.director.actor, {
      email: `inv-${newId()}@test.space`,
      role: 'crew',
    });
    const gone = await onboardUser(h, w.org, 'crew', 'gone');
    await h.users.update(w.org.director.actor, gone.userId, { status: 'deactivated' });
    const formerCrew = await onboardUser(h, w.org, 'crew', 'former');
    await h.users.update(w.org.director.actor, formerCrew.userId, { role: 'lead' });

    const listed = (await h.crew.list(w.lead.actor, { limit: 100, skill: [] })).items
      .map((p) => p.id)
      .sort();
    expect(listed).toEqual([w.ann.userId, w.bob.userId].sort());
    for (const id of [
      w.lead.userId,
      w.org.director.userId,
      invited.user.id,
      gone.userId,
      formerCrew.userId,
      other.ann.userId,
    ]) {
      await expect(h.crew.get(w.lead.actor, id)).rejects.toMatchObject({ status: 404 });
    }
    await expect(h.crew.get(w.lead.actor, newId())).rejects.toMatchObject({ status: 404 });
  });

  it('gives a Crew Member a list of just themself', async () => {
    const w = await world('Self');
    const page = await h.crew.list(w.ann.actor, { limit: 100, skill: [] });
    expect(page.items.map((p) => p.id)).toEqual([w.ann.userId]);
  });

  it('keeps unavailability notes private to their owner', async () => {
    const w = await world('Notes');
    await h.crew.addUnavailability(w.ann.actor, {
      from: '2031-06-01',
      to: '2031-06-05',
      note: 'Medical appointment',
    });
    const own = (await h.crew.get(w.ann.actor, w.ann.userId)).unavailability;
    expect(own).toEqual([
      expect.objectContaining({
        from: '2031-06-01',
        to: '2031-06-05',
        note: 'Medical appointment',
      }),
    ]);
    for (const actor of [w.lead.actor, w.org.director.actor]) {
      const seen = (await h.crew.get(actor, w.ann.userId)).unavailability;
      expect(seen).toEqual([{ id: own[0]!.id, from: '2031-06-01', to: '2031-06-05' }]);
      expect(JSON.stringify(seen)).not.toContain('Medical');
      expect(JSON.stringify(await h.crew.list(actor, { limit: 50, skill: [] }))).not.toContain(
        'Medical',
      );
    }
  });

  it('reports the current load: live holds only', async () => {
    const w = await world('Load');
    expect((await h.crew.get(w.lead.actor, w.ann.userId)).load).toBe(0);
    await hold(w, w.ann.userId, '2031-07-01', '2031-07-05', 'pending_approval');
    await hold(w, w.ann.userId, '2031-08-01', '2031-08-05', 'active');
    const released = await hold(w, w.ann.userId, '2031-09-01', '2031-09-05', 'completed');
    await admin.query(
      "UPDATE holds SET released_at = now(), release_reason = 'completed' WHERE id = $1",
      [released.holdId],
    );
    expect((await h.crew.get(w.lead.actor, w.ann.userId)).load).toBe(2);
    expect((await h.crew.get(w.lead.actor, w.bob.userId)).load).toBe(0);
  });
});

describe('crew search', () => {
  it('filters by skill level, inclusive at the boundary, and combines filters with AND', async () => {
    const w = await world('Search');
    await h.crew.setSkill(w.ann.actor, w.medicine.id, 3);
    await h.crew.setSkill(w.ann.actor, w.piloting.id, 5);
    await h.crew.setSkill(w.bob.actor, w.medicine.id, 2);
    const ids = async (skill: string[]) =>
      (await h.crew.list(w.lead.actor, { limit: 50, skill })).items.map((p) => p.id).sort();
    const both = [w.ann.userId, w.bob.userId].sort();
    expect(await ids([`${w.medicine.id}:1`])).toEqual(both);
    expect(await ids([`${w.medicine.id}:2`])).toEqual(both);
    expect(await ids([`${w.medicine.id}:3`])).toEqual([w.ann.userId]);
    expect(await ids([`${w.medicine.id}:4`])).toEqual([]);
    expect(await ids([`${w.medicine.id}:3`, `${w.piloting.id}:5`])).toEqual([w.ann.userId]);
    expect(await ids([`${w.medicine.id}:2`, `${w.piloting.id}:1`])).toEqual([w.ann.userId]);
    expect(await ids([`${newId()}:1`])).toEqual([]);
  });

  it('filters by availability: no overlapping unavailability and no live hold, days inclusive', async () => {
    const w = await world('Available');
    await h.crew.addUnavailability(w.ann.actor, { from: '2031-10-10', to: '2031-10-20' });
    await hold(w, w.bob.userId, '2031-10-15', '2031-10-25');
    const free = async (window: string) =>
      (await h.crew.list(w.lead.actor, { limit: 50, skill: [], available: window })).items
        .map((p) => p.id)
        .sort();
    const both = [w.ann.userId, w.bob.userId].sort();

    expect(await free('2031-10-01:2031-10-09')).toEqual(both);
    expect(await free('2031-10-26:2031-11-30')).toEqual(both);
    expect(await free('2031-10-01:2031-10-10')).toEqual([w.bob.userId]); // shares Ann's first day
    expect(await free('2031-10-20:2031-10-30')).toEqual([]); // Ann's last day, Bob's hold
    expect(await free('2031-10-21:2031-10-24')).toEqual([w.ann.userId]); // only Bob's hold
    expect(await free('2031-10-01:2031-10-14')).toEqual([w.bob.userId]); // adjacent to Bob's hold: free
    expect(await free('2031-10-25:2031-10-25')).toEqual([w.ann.userId]); // Bob's last day
    expect(await free('2031-10-26:2031-10-26')).toEqual(both);
  });

  it('ignores released holds when checking availability', async () => {
    const w = await world('Released');
    const { holdId } = await hold(w, w.ann.userId, '2031-11-01', '2031-11-10');
    const free = async () =>
      (
        await h.crew.list(w.lead.actor, {
          limit: 50,
          skill: [],
          available: '2031-11-05:2031-11-06',
        })
      ).items.map((p) => p.id);
    expect(await free()).not.toContain(w.ann.userId);
    await admin.query(
      "UPDATE holds SET released_at = now(), release_reason = 'rejected' WHERE id = $1",
      [holdId],
    );
    expect(await free()).toContain(w.ann.userId);
  });

  it('does not consider the workload cap when searching for availability', async () => {
    const w = await world('Cap');
    await h.settings.update(w.org.director.actor, { maxUpcomingMissions: 1 });
    await hold(w, w.ann.userId, '2032-01-01', '2032-01-05');
    const free = (
      await h.crew.list(w.lead.actor, { limit: 50, skill: [], available: '2032-02-01:2032-02-05' })
    ).items.map((p) => p.id);
    expect(free).toContain(w.ann.userId);
  });

  it('pages and combines filters with the cursor', async () => {
    const w = await world('Pages');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.crew.list(w.lead.actor, { limit: 1, skill: [], cursor });
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual([w.ann.userId, w.bob.userId].sort());
  });
});

describe('unavailability', () => {
  it('records an inclusive range and returns it with its note', async () => {
    const w = await world('Add');
    h.audit.clear();
    const added = await h.crew.addUnavailability(w.ann.actor, {
      from: '2031-12-20',
      to: '2032-01-03',
      note: 'Leave',
    });
    expect(added).toEqual({
      id: expect.any(String),
      from: '2031-12-20',
      to: '2032-01-03',
      note: 'Leave',
    });
    expect((await h.crew.get(w.ann.actor, w.ann.userId)).unavailability).toEqual([added]);
    expect(h.audit.forEntity('unavailability', added.id)).toEqual([
      expect.objectContaining({
        action: 'crew.unavailability_added',
        after: { crewMemberId: w.ann.userId, from: '2031-12-20', to: '2032-01-03' },
        actorId: w.ann.userId,
      }),
    ]);
    expect(JSON.stringify(h.audit.events)).not.toContain('Leave');
  });

  it('accepts a single day and returns ranges in date order', async () => {
    const w = await world('Order');
    await h.crew.addUnavailability(w.ann.actor, { from: '2032-03-10', to: '2032-03-10' });
    await h.crew.addUnavailability(w.ann.actor, { from: '2032-02-01', to: '2032-02-05' });
    expect((await h.crew.get(w.ann.actor, w.ann.userId)).unavailability.map((u) => u.from)).toEqual(
      ['2032-02-01', '2032-03-10'],
    );
  });

  it('is for Crew Members only', async () => {
    const w = await world('Who');
    for (const actor of [w.org.director.actor, w.lead.actor]) {
      await expect(
        h.crew.addUnavailability(actor, { from: '2032-01-01', to: '2032-01-02' }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(h.crew.removeUnavailability(actor, newId())).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  describe('dates in the past (organisation time zone)', () => {
    it('rejects a range that ended before today, accepts one ending today or later, and one that began earlier', async () => {
      const w = await world('Past'); // clock: 2026-10-02T10:00Z, org time zone UTC
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2026-09-20', to: '2026-10-01' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_IN_PAST',
        status: 400,
        extra: { errors: [expect.objectContaining({ field: 'to' })] },
      });
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2026-10-02', to: '2026-10-02' }),
      ).resolves.toBeDefined();
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2026-09-25', to: '2026-10-06' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_OVERLAPS_EXISTING', // it began earlier and runs into the future, so it passes the date check
      });
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2026-09-25', to: '2026-10-01' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_IN_PAST',
      });
    });

    it("uses the organisation's date, not UTC's, around midnight", async () => {
      const east = await world('East'); // UTC+14: it is already 2026-10-03 there
      await h.settings.update(east.org.director.actor, { timeZone: 'Pacific/Kiritimati' });
      await expect(
        h.crew.addUnavailability(east.ann.actor, { from: '2026-10-02', to: '2026-10-02' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_IN_PAST',
      });
      await expect(
        h.crew.addUnavailability(east.ann.actor, { from: '2026-10-03', to: '2026-10-03' }),
      ).resolves.toBeDefined();

      const west = await world('West'); // UTC-11: it is still 2026-10-01 there
      await h.settings.update(west.org.director.actor, { timeZone: 'Pacific/Pago_Pago' });
      await expect(
        h.crew.addUnavailability(west.ann.actor, { from: '2026-10-01', to: '2026-10-01' }),
      ).resolves.toBeDefined();
    });
  });

  describe("overlap with the crew member's own ranges", () => {
    it('rejects any overlap, including one shared day, and lists what it overlaps', async () => {
      const w = await world('Overlap');
      const first = await h.crew.addUnavailability(w.ann.actor, {
        from: '2032-04-10',
        to: '2032-04-20',
      });
      for (const [from, to] of [
        ['2032-04-05', '2032-04-10'],
        ['2032-04-15', '2032-04-16'],
        ['2032-04-20', '2032-04-25'],
        ['2032-04-01', '2032-04-30'],
      ] as const) {
        await expect(h.crew.addUnavailability(w.ann.actor, { from, to })).rejects.toMatchObject({
          code: 'UNAVAILABILITY_OVERLAPS_EXISTING',
          status: 409,
          extra: { unavailability: [{ id: first.id, from: '2032-04-10', to: '2032-04-20' }] },
        });
      }
    });

    it('allows touching ranges and the same dates for another crew member', async () => {
      const w = await world('Touching');
      await h.crew.addUnavailability(w.ann.actor, { from: '2032-05-10', to: '2032-05-20' });
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-05-21', to: '2032-05-25' }),
      ).resolves.toBeDefined();
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-05-01', to: '2032-05-09' }),
      ).resolves.toBeDefined();
      await expect(
        h.crew.addUnavailability(w.bob.actor, { from: '2032-05-10', to: '2032-05-20' }),
      ).resolves.toBeDefined();
    });

    it('lets only one of two concurrent overlapping requests succeed', async () => {
      const w = await world('Race');
      const results = await Promise.allSettled([
        h.crew.addUnavailability(w.ann.actor, { from: '2032-06-01', to: '2032-06-10' }),
        h.crew.addUnavailability(w.ann.actor, { from: '2032-06-05', to: '2032-06-15' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'UNAVAILABILITY_OVERLAPS_EXISTING' });
    });
  });

  describe('overlap with missions the crew member is held on (OQ-1)', () => {
    it('is rejected with every conflicting mission listed in full, including Pending approval', async () => {
      const w = await world('Holds');
      const pending = await hold(w, w.ann.userId, '2032-07-01', '2032-07-10', 'pending_approval');
      const active = await hold(w, w.ann.userId, '2032-07-20', '2032-07-30', 'active');
      await hold(w, w.ann.userId, '2032-09-01', '2032-09-05'); // outside the range
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-07-05', to: '2032-07-25' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
        status: 409,
        extra: {
          missions: [
            {
              id: pending.mission,
              name: 'Extra',
              startDate: '2032-07-01',
              endDate: '2032-07-10',
              status: 'pending_approval',
            },
            {
              id: active.mission,
              name: 'Extra',
              startDate: '2032-07-20',
              endDate: '2032-07-30',
              status: 'active',
            },
          ],
        },
      });
      expect((await h.crew.get(w.ann.actor, w.ann.userId)).unavailability).toEqual([]);
    });

    it('treats a single shared day as a conflict, and adjacent days as free', async () => {
      const w = await world('Edges');
      await hold(w, w.ann.userId, '2032-08-10', '2032-08-20');
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-08-20', to: '2032-08-25' }),
      ).rejects.toMatchObject({
        code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
      });
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-08-21', to: '2032-08-25' }),
      ).resolves.toBeDefined();
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-08-01', to: '2032-08-09' }),
      ).resolves.toBeDefined();
    });

    it("ignores released holds and other people's holds", async () => {
      const w = await world('Released');
      const mine = await hold(w, w.ann.userId, '2032-10-01', '2032-10-10');
      await hold(w, w.bob.userId, '2032-11-01', '2032-11-10');
      await admin.query(
        "UPDATE holds SET released_at = now(), release_reason = 'cancelled' WHERE id = $1",
        [mine.holdId],
      );
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-10-05', to: '2032-10-06' }),
      ).resolves.toBeDefined();
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2032-11-05', to: '2032-11-06' }),
      ).resolves.toBeDefined();
    });
  });

  describe('removal', () => {
    it("removes the caller's own range and audits it", async () => {
      const w = await world('Remove');
      const added = await h.crew.addUnavailability(w.ann.actor, {
        from: '2032-12-01',
        to: '2032-12-05',
        note: 'x',
      });
      h.audit.clear();
      await h.crew.removeUnavailability(w.ann.actor, added.id);
      expect((await h.crew.get(w.ann.actor, w.ann.userId)).unavailability).toEqual([]);
      expect(h.audit.events).toEqual([
        expect.objectContaining({
          action: 'crew.unavailability_removed',
          entityId: added.id,
          before: { crewMemberId: w.ann.userId, from: '2032-12-01', to: '2032-12-05' },
        }),
      ]);
    });

    it("answers 404 for another crew member's range, an unknown id and another organisation's range", async () => {
      const w = await world('Foreign');
      const other = await world('Foreign Other');
      const annsRange = await h.crew.addUnavailability(w.ann.actor, {
        from: '2033-01-01',
        to: '2033-01-05',
      });
      const foreignRange = await h.crew.addUnavailability(other.ann.actor, {
        from: '2033-01-01',
        to: '2033-01-05',
      });
      for (const id of [annsRange.id, newId(), foreignRange.id]) {
        await expect(h.crew.removeUnavailability(w.bob.actor, id)).rejects.toMatchObject({
          code: 'NOT_FOUND',
          status: 404,
        });
      }
      expect((await h.crew.get(w.ann.actor, w.ann.userId)).unavailability).toHaveLength(1);
      expect((await h.crew.get(other.ann.actor, other.ann.userId)).unavailability).toHaveLength(1);
    });

    it('frees the dates again', async () => {
      const w = await world('Free');
      const added = await h.crew.addUnavailability(w.ann.actor, {
        from: '2033-02-01',
        to: '2033-02-10',
      });
      await h.crew.removeUnavailability(w.ann.actor, added.id);
      await expect(
        h.crew.addUnavailability(w.ann.actor, { from: '2033-02-05', to: '2033-02-06' }),
      ).resolves.toBeDefined();
    });
  });
});
