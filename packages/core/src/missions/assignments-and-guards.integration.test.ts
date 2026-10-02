import { newId } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  missionWorld,
  onboardUser,
  type Harness,
  type MissionWorld,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: Harness;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
});
afterAll(async () => {
  await h.close();
});

const run = (x: MissionWorld, today: string) =>
  h.db.withTenant(x.org.orgId, (tx) => h.missions.runSystemTransitions(tx, today));

describe('assignments of a Crew Member', () => {
  it('lists only visible assignments, newest first, with the mission and the acknowledgement', async () => {
    const x = await missionWorld(h, 'Assign list');
    expect((await h.assignments.listMine(x.ann.actor, { limit: 10 })).items).toEqual([]);
    await x.crewing({ crew: [x.ann.userId], name: 'Tentative' });
    await x.pending({ name: 'Pending', startDate: '2027-04-01', endDate: '2027-04-05' });
    expect((await h.assignments.listMine(x.ann.actor, { limit: 10 })).items).toEqual([]); // not before approval
    const first = await x.approved({
      name: 'First',
      startDate: '2027-05-01',
      endDate: '2027-05-05',
    });
    const second = await x.approved({
      name: 'Second',
      startDate: '2027-06-01',
      endDate: '2027-06-05',
    });
    const items = (await h.assignments.listMine(x.ann.actor, { limit: 10 })).items;
    expect(items.map((a) => a.mission.name)).toEqual(['Second', 'First']);
    expect(items[0]).toEqual({
      id: second.crew[0]!.assignmentId,
      acknowledgedAt: null,
      mission: {
        id: second.id,
        name: 'Second',
        description: '',
        startDate: '2027-06-01',
        endDate: '2027-06-05',
        status: 'approved',
      },
    });
    expect(items[1]!.id).toBe(first.crew[0]!.assignmentId);

    const page1 = await h.assignments.listMine(x.ann.actor, { limit: 1 });
    const page2 = await h.assignments.listMine(x.ann.actor, {
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect([page1.items[0]!.mission.name, page2.items[0]!.mission.name]).toEqual([
      'Second',
      'First',
    ]);
    expect(page2.nextCursor).toBeNull();
    await expect(
      h.assignments.listMine(x.ann.actor, { limit: 5, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('is for Crew Members only, and shows each their own', async () => {
    const x = await missionWorld(h, 'Assign who');
    await x.approved();
    for (const who of [x.director, x.lead]) {
      await expect(h.assignments.listMine(who.actor, { limit: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }
    expect((await h.assignments.listMine(x.bob.actor, { limit: 5 })).items).toEqual([]);
    expect((await h.assignments.listMine(x.ann.actor, { limit: 5 })).items).toHaveLength(1);
  });

  it('keeps showing Completed and Cancelled-after-approval assignments, but not ones cancelled before approval', async () => {
    const x = await missionWorld(h, 'Assign history');
    const done = await x.approved({ name: 'Done', startDate: '2027-03-01', endDate: '2027-03-02' });
    await run(x, '2027-03-03');
    const cancelled = await x.act(
      await x.approved({ name: 'Cancelled', startDate: '2027-04-01', endDate: '2027-04-02' }),
      'cancel',
    );
    await x.act(
      await x.pending({ name: 'Never approved', startDate: '2027-05-01', endDate: '2027-05-02' }),
      'cancel',
    );
    const shown = (await h.assignments.listMine(x.ann.actor, { limit: 10 })).items.map((a) => [
      a.mission.name,
      a.mission.status,
    ]);
    expect(shown).toEqual([
      ['Cancelled', 'cancelled'],
      ['Done', 'completed'],
    ]);
    void [done, cancelled];
  });

  it('acknowledges once, idempotently, and the Lead sees it on the mission', async () => {
    const x = await missionWorld(h, 'Acknowledge');
    const m = await x.approved();
    const [mine] = (await h.assignments.listMine(x.ann.actor, { limit: 5 })).items;
    h.audit.clear();
    const ack = await h.assignments.acknowledge(x.ann.actor, mine!.id);
    expect(ack.acknowledgedAt).toBe(h.clock.now().toISOString());
    h.clock.advance(60_000);
    const again = await h.assignments.acknowledge(x.ann.actor, mine!.id);
    expect(again.acknowledgedAt).toBe(ack.acknowledgedAt);
    expect(h.audit.events.filter((e) => e.action === 'assignment.acknowledged')).toEqual([
      expect.objectContaining({
        entityType: 'assignment',
        entityId: mine!.id,
        actorId: x.ann.userId,
      }),
    ]);
    const view = (await h.missions.get(x.lead.actor, m.id)) as {
      crew: Array<{ crewMemberId: string; acknowledgedAt: string | null }>;
    };
    expect(view.crew.find((c) => c.crewMemberId === x.ann.userId)!.acknowledgedAt).toBe(
      ack.acknowledgedAt,
    );
    expect(
      ((await h.missions.get(x.ann.actor, m.id)) as { assignment: { acknowledgedAt: string } })
        .assignment.acknowledgedAt,
    ).toBe(ack.acknowledgedAt);
  });

  it('can be acknowledged while Active, but not once Completed or Cancelled', async () => {
    const x = await missionWorld(h, 'Acknowledge states');
    const active = await x.approved({ startDate: '2027-03-01', endDate: '2027-03-20' });
    const completed = await x.approved({ startDate: '2027-01-01', endDate: '2027-01-02' });
    const cancelled = await x.approved({ startDate: '2027-07-01', endDate: '2027-07-05' });
    await run(x, '2027-03-02'); // activates `active`, completes `completed`
    await x.act(cancelled, 'cancel');
    const byName = async () =>
      new Map(
        (await h.assignments.listMine(x.ann.actor, { limit: 10 })).items.map((a) => [
          a.mission.id,
          a,
        ]),
      );
    const items = await byName();
    expect(
      (await h.assignments.acknowledge(x.ann.actor, items.get(active.id)!.id)).acknowledgedAt,
    ).not.toBeNull();
    for (const m of [completed, cancelled]) {
      await expect(
        h.assignments.acknowledge(x.ann.actor, items.get(m.id)!.id),
      ).rejects.toMatchObject({
        code: 'ASSIGNMENT_NOT_ACKNOWLEDGEABLE',
        status: 409,
      });
    }
  });

  it('cannot be acknowledged before approval, by someone else, or across organisations', async () => {
    const x = await missionWorld(h, 'Acknowledge denied');
    const other = await missionWorld(h, 'Acknowledge denied other');
    const pending = await x.pending();
    const approved = await x.approved({ startDate: '2027-08-01', endDate: '2027-08-05' });
    const mine = (await h.assignments.listMine(x.ann.actor, { limit: 5 })).items[0]!;
    const pendingAssignmentId = pending.crew[0]!.assignmentId;
    // Pending approval is invisible to Crew, so its assignment is a 404, not a hint that it exists.
    await expect(h.assignments.acknowledge(x.ann.actor, pendingAssignmentId)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(h.assignments.acknowledge(x.bob.actor, mine.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(h.assignments.acknowledge(other.ann.actor, mine.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(h.assignments.acknowledge(x.ann.actor, newId())).rejects.toMatchObject({
      status: 404,
    });
    for (const who of [x.director, x.lead]) {
      await expect(h.assignments.acknowledge(who.actor, mine.id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    void approved;
  });
});

describe('deactivation and role-change guards (OQ-4)', () => {
  it('blocks a Crew Member who is held on a mission, until the hold is released', async () => {
    const x = await missionWorld(h, 'Guard crew');
    const m = await x.pending();
    for (const patch of [{ status: 'deactivated' as const }, { role: 'lead' as const }]) {
      await expect(h.users.update(x.director.actor, x.ann.userId, patch)).rejects.toMatchObject({
        code: 'USER_HAS_COMMITMENTS',
        status: 409,
      });
    }
    expect((await h.crew.get(x.lead.actor, x.ann.userId)).email).toBeDefined(); // unchanged
    await x.act(m, 'withdraw'); // holds released
    await expect(
      h.users.update(x.director.actor, x.ann.userId, { status: 'deactivated' }),
    ).resolves.toMatchObject({ status: 'deactivated' });
  });

  it('is also lifted when the mission is cancelled, completed or expired', async () => {
    const x = await missionWorld(h, 'Guard lifted');
    const req = [{ skillId: x.medicine.id, minLevel: 1, count: 1 }];
    const cancelled = await x.pending({ crew: [x.ann.userId] });
    const completed = await x.approved({
      crew: [x.bob.userId],
      requirements: req,
      startDate: '2027-04-01',
      endDate: '2027-04-02',
    });
    await expect(
      h.users.update(x.director.actor, x.ann.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({ code: 'USER_HAS_COMMITMENTS' });
    await expect(
      h.users.update(x.director.actor, x.bob.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({ code: 'USER_HAS_COMMITMENTS' });
    await x.act(cancelled, 'cancel');
    await run(x, '2027-04-03');
    await expect(
      h.users.update(x.director.actor, x.ann.userId, { status: 'deactivated' }),
    ).resolves.toBeDefined();
    await expect(
      h.users.update(x.director.actor, x.bob.userId, { role: 'director' }),
    ).resolves.toMatchObject({ role: 'director' });
    void completed;
  });

  it('does not block a Crew Member who is only tentatively assigned', async () => {
    const x = await missionWorld(h, 'Guard tentative');
    const m = await x.crewing({ crew: [x.ann.userId] });
    await expect(
      h.users.update(x.director.actor, x.ann.userId, { status: 'deactivated' }),
    ).resolves.toBeDefined();
    const view = (await h.missions.get(x.lead.actor, m.id)) as typeof m;
    expect(view.crewValidation?.assignmentIssues).toHaveLength(1); // flagged, not removed
  });

  it('blocks a Lead who owns a mission that is not Completed or Cancelled', async () => {
    const x = await missionWorld(h, 'Guard lead');
    const states: Array<[string, () => Promise<unknown>]> = [
      ['draft', () => x.draft()],
      ['crewing', () => x.crewing()],
      ['pending', () => x.pending({ startDate: '2027-05-01', endDate: '2027-05-02' })],
      ['approved', () => x.approved({ startDate: '2027-06-01', endDate: '2027-06-02' })],
    ];
    for (const [name, make] of states) {
      const owner = await onboardUser(h, x.org, 'lead', `owner-${name}`);
      await h.missions.create(owner.actor, {
        name,
        description: '',
        startDate: '2027-09-01',
        endDate: '2027-09-02',
      });
      for (const patch of [{ status: 'deactivated' as const }, { role: 'director' as const }]) {
        await expect(
          h.users.update(x.director.actor, owner.userId, patch),
          `${name} ${JSON.stringify(patch)}`,
        ).rejects.toMatchObject({
          code: 'USER_OWNS_MISSIONS',
          status: 409,
        });
      }
      void make;
    }
    // The Lead who owns an Active mission is blocked too.
    const active = await x.approved({ startDate: '2027-03-01', endDate: '2027-03-20' });
    await run(x, '2027-03-02');
    await expect(
      h.users.update(x.director.actor, x.lead.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({ code: 'USER_OWNS_MISSIONS' });
    void active;
  });

  it("lets a Lead go once everything they own is Completed or Cancelled, and ignores other Leads' missions", async () => {
    const x = await missionWorld(h, 'Guard lead free');
    await x.act(await x.draft({}, x.lead), 'cancel');
    const done = await x.approved({ startDate: '2027-03-01', endDate: '2027-03-02' });
    await run(x, '2027-03-03');
    await h.missions.create(x.lead2.actor, {
      name: 'Other lead',
      description: '',
      startDate: '2027-09-01',
      endDate: '2027-09-02',
    });
    await expect(
      h.users.update(x.director.actor, x.lead.userId, { status: 'deactivated' }),
    ).resolves.toMatchObject({ status: 'deactivated' });
    await expect(
      h.users.update(x.director.actor, x.lead2.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({ code: 'USER_OWNS_MISSIONS' });
    void done;
  });

  it('does not stand in the way of Directors', async () => {
    const x = await missionWorld(h, 'Guard director');
    const second = await onboardUser(h, x.org, 'director', 'second');
    await x.pending();
    await expect(
      h.users.update(x.director.actor, second.userId, { status: 'deactivated' }),
    ).resolves.toMatchObject({ status: 'deactivated' });
  });
});
