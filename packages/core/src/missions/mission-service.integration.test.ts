import { newId, schema } from '@mc/db';
import { addAssignment, addHold, addMission, openAdminDb, type AdminDb } from '@mc/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createHarness,
  missionWorld,
  onboardUser,
  provisionOrganisation,
  type Harness,
  type MissionWorld,
} from '../testing/index.js';

const urls = inject('dbUrls');
/** Marks every promise as handled, so one that rejects before it is awaited is not reported as unhandled. */
const handled = <T>(promises: Promise<T>[]): Promise<T>[] => {
  for (const p of promises) p.catch(() => undefined);
  return promises;
};

let h: Harness;
let admin: AdminDb;
let w: MissionWorld;

beforeAll(async () => {
  h = await createHarness(urls);
  admin = openAdminDb(urls.migrator);
  w = await missionWorld(h, 'Missions A');
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

describe('creating and reading missions', () => {
  it('lets a Lead create a Draft owned by them, at version 1, and audits it', async () => {
    const m = await w.draft({
      name: 'Artemis Relay',
      description: 'Relay station',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
    });
    expect(m).toMatchObject({
      name: 'Artemis Relay',
      description: 'Relay station',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      status: 'draft',
      version: 1,
      leadId: w.lead.userId,
      requirements: [],
      crew: [],
      decisions: [],
      allowedActions: ['start_crewing', 'cancel'],
    });
    expect(m.crewValidation).toBeUndefined();
    expect(m.leadName).toBe('lead person');
  });

  it('is for Leads only', async () => {
    const input = { name: 'X', description: '', startDate: '2027-03-01', endDate: '2027-03-02' };
    for (const who of [w.director, w.ann]) {
      await expect(h.missions.create(who.actor, input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }
  });

  it("shows Directors and Leads every mission, including other Leads' drafts", async () => {
    const m = await w.draft({ name: 'Lead2 Draft' }, w.lead2);
    for (const who of [w.director, w.lead, w.lead2]) {
      expect(await h.missions.get(who.actor, m.id)).toMatchObject({
        id: m.id,
        leadId: w.lead2.userId,
      });
    }
    expect(
      ((await h.missions.get(w.lead.actor, m.id)) as { allowedActions: string[] }).allowedActions,
    ).toEqual([]);
    expect(
      ((await h.missions.get(w.lead2.actor, m.id)) as { allowedActions: string[] }).allowedActions,
    ).toEqual(['start_crewing', 'cancel']);
  });

  it("answers 404 for unknown missions and for another organisation's missions", async () => {
    const other = await missionWorld(h, 'Missions A Other');
    const theirs = await other.draft();
    for (const id of [newId(), theirs.id]) {
      await expect(h.missions.get(w.director.actor, id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    const ids = (await h.missions.list(w.director.actor, { limit: 100, status: [] })).items.map(
      (i) => i.id,
    );
    expect(ids).not.toContain(theirs.id);
  });
});

describe('listing', () => {
  it('filters by status, lead and date window, newest first, and pages', async () => {
    const x = await missionWorld(h, 'Listing');
    const a = await x.draft({ name: 'A', startDate: '2027-01-01', endDate: '2027-01-10' });
    const b = await x.draft({ name: 'B', startDate: '2027-02-01', endDate: '2027-02-10' }, x.lead2);
    const c = await x.crewing({ name: 'C', startDate: '2027-03-01', endDate: '2027-03-10' });
    const list = async (query: Partial<Parameters<Harness['missions']['list']>[1]>) =>
      (await h.missions.list(x.director.actor, { limit: 50, status: [], ...query })).items.map(
        (i) => (i as { name: string }).name,
      );

    expect(await list({})).toEqual(['C', 'B', 'A']);
    expect(await list({ status: ['draft'] })).toEqual(['B', 'A']);
    expect(await list({ status: ['draft', 'crewing'] })).toEqual(['C', 'B', 'A']);
    expect(await list({ status: ['approved'] })).toEqual([]);
    expect(await list({ leadId: x.lead2.userId })).toEqual(['B']);
    // Date windows select missions that overlap them, days inclusive.
    expect(await list({ from: '2027-01-10', to: '2027-01-10' })).toEqual(['A']);
    expect(await list({ from: '2027-01-11', to: '2027-01-31' })).toEqual([]);
    expect(await list({ from: '2027-02-10' })).toEqual(['C', 'B']);
    expect(await list({ to: '2027-02-01' })).toEqual(['B', 'A']);
    expect(await list({ from: '2027-01-05', to: '2027-02-05' })).toEqual(['B', 'A']);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.missions.list(x.lead.actor, { limit: 1, status: [], cursor });
      seen.push(...page.items.map((i) => (i as { name: string }).name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['C', 'B', 'A']);
    void [a, b, c];
    await expect(
      h.missions.list(x.lead.actor, { limit: 5, status: [], cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it("gives Leads and Directors summaries with the lead's name", async () => {
    const x = await missionWorld(h, 'Summaries');
    await x.draft({ name: 'S' });
    const [item] = (await h.missions.list(x.lead2.actor, { limit: 5, status: [] })).items;
    expect(item).toMatchObject({
      name: 'S',
      status: 'draft',
      version: 1,
      leadName: 'lead person',
      leadId: x.lead.userId,
    });
    expect(item).not.toHaveProperty('requirements');
  });
});

describe('what Crew Members see (OQ-3)', () => {
  it('shows nothing before approval, then the mission and only their own assignment', async () => {
    const x = await missionWorld(h, 'Crew view');
    const ids = async (who = x.ann) =>
      (await h.missions.list(who.actor, { limit: 50, status: [] })).items.map((i) => i.id);

    let m = await x.crewing({ crew: [x.ann.userId, x.bob.userId] });
    expect(await ids()).toEqual([]);
    m = await x.act(m, 'submit');
    expect(await ids()).toEqual([]); // pending approval: assignments are tentative to Crew
    await expect(h.missions.get(x.ann.actor, m.id)).rejects.toMatchObject({ status: 404 });
    m = await x.act(m, 'approve', x.director);

    expect(await ids()).toEqual([m.id]);
    const view = await h.missions.get(x.ann.actor, m.id);
    expect(view).toEqual({
      id: m.id,
      name: 'Artemis Relay',
      description: '',
      startDate: '2027-03-01',
      endDate: '2027-03-10',
      status: 'approved',
      assignment: { id: expect.any(String), acknowledgedAt: null },
    });
    // No co-assignees, requirements, decisions, version or owner.
    for (const key of [
      'crew',
      'requirements',
      'decisions',
      'version',
      'leadId',
      'allowedActions',
      'crewValidation',
    ]) {
      expect(view).not.toHaveProperty(key);
    }
    // Bob sees his own assignment, not Ann's.
    const bobs = (await h.missions.get(x.bob.actor, m.id)) as { assignment: { id: string } };
    expect(bobs.assignment.id).not.toBe((view as { assignment: { id: string } }).assignment.id);
  });

  it('keeps showing the mission as Active, Completed and Cancelled-after-approval, but never cancelled-before-approval', async () => {
    const x = await missionWorld(h, 'Crew history');
    const seen = async () =>
      new Set(
        (await h.missions.list(x.ann.actor, { limit: 50, status: [] })).items.map((i) => i.id),
      );

    const active = await x.approved({
      name: 'Goes active',
      startDate: '2027-04-01',
      endDate: '2027-04-05',
    });
    const completed = await x.approved({
      name: 'Completes',
      startDate: '2027-05-01',
      endDate: '2027-05-05',
    });
    const cancelledLater = await x.approved({
      name: 'Cancelled later',
      startDate: '2027-06-01',
      endDate: '2027-06-05',
    });
    await x.act(cancelledLater, 'cancel');

    const beforeApproval = await x.pending({
      name: 'Cancelled while pending',
      startDate: '2027-07-01',
      endDate: '2027-07-05',
    });
    await x.act(beforeApproval, 'cancel');
    const crewingCancel = await x.crewing({
      crew: [x.ann.userId],
      name: 'Cancelled while crewing',
      startDate: '2027-08-01',
      endDate: '2027-08-05',
    });
    await x.act(crewingCancel, 'cancel');

    await h.db.withTenant(x.org.orgId, (tx) => h.missions.runSystemTransitions(tx, '2027-04-02'));
    await h.db.withTenant(x.org.orgId, (tx) => h.missions.runSystemTransitions(tx, '2027-05-06'));

    const visible = await seen();
    expect(visible.has(active.id)).toBe(true);
    expect(visible.has(completed.id)).toBe(true);
    expect(visible.has(cancelledLater.id)).toBe(true);
    expect(visible.has(beforeApproval.id)).toBe(false);
    expect(visible.has(crewingCancel.id)).toBe(false);
    expect((await h.missions.get(x.ann.actor, cancelledLater.id)).status).toBe('cancelled');
    await expect(h.missions.get(x.ann.actor, beforeApproval.id)).rejects.toMatchObject({
      status: 404,
    });
    expect((await h.missions.get(x.ann.actor, completed.id)).status).toBe('completed');
  });

  it('shows Crew nothing of missions they are not assigned to', async () => {
    const x = await missionWorld(h, 'Not mine');
    const m = await x.approved();
    await expect(h.missions.get(x.bob.actor, m.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await h.missions.list(x.bob.actor, { limit: 50, status: [] })).items).toEqual([]);
  });

  it("applies the list filters to a Crew Member's missions too", async () => {
    const x = await missionWorld(h, 'Crew filters');
    const a = await x.approved({ name: 'A', startDate: '2027-04-01', endDate: '2027-04-05' });
    await x.approved({ name: 'B', startDate: '2027-09-01', endDate: '2027-09-05' });
    const names = async (q: object) =>
      (await h.missions.list(x.ann.actor, { limit: 50, status: [], ...q })).items.map(
        (i) => (i as { name: string }).name,
      );
    expect(await names({})).toEqual(['B', 'A']);
    expect(await names({ to: '2027-05-01' })).toEqual(['A']);
    expect(await names({ status: ['approved'] })).toEqual(['B', 'A']);
    expect(await names({ status: ['active'] })).toEqual([]);
    void a;
  });
});

describe('editing details', () => {
  it('changes name, description and dates in Draft and Crewing, bumping the version and auditing', async () => {
    const m = await w.draft();
    h.audit.clear();
    const edited = await h.missions.update(
      w.lead.actor,
      m.id,
      { name: 'Renamed', endDate: '2027-03-12' },
      m.version,
    );
    expect(edited).toMatchObject({
      name: 'Renamed',
      endDate: '2027-03-12',
      startDate: '2027-03-01',
      version: 2,
      status: 'draft',
    });
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.updated',
        before: { name: 'Artemis Relay', endDate: '2027-03-10' },
        after: { name: 'Renamed', endDate: '2027-03-12' },
        actorId: w.lead.userId,
      }),
    ]);
    const crewing = await w.crewing();
    expect(
      (
        await h.missions.update(
          w.lead.actor,
          crewing.id,
          { description: 'Now crewing' },
          crewing.version,
        )
      ).version,
    ).toBe(crewing.version + 1);
  });

  it('treats an unchanged edit as a no-op: same version, no audit event', async () => {
    const m = await w.draft();
    h.audit.clear();
    const same = await h.missions.update(w.lead.actor, m.id, { name: m.name }, m.version);
    expect(same.version).toBe(m.version);
    expect(h.audit.events).toEqual([]);
  });

  it('refuses a range that ends before it starts, including against the stored dates', async () => {
    const m = await w.draft({ startDate: '2027-03-01', endDate: '2027-03-10' });
    for (const patch of [{ endDate: '2027-02-28' }, { startDate: '2027-03-11' }]) {
      await expect(h.missions.update(w.lead.actor, m.id, patch, m.version)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 400,
        extra: { errors: [expect.objectContaining({ field: 'endDate' })] },
      });
    }
    expect(((await h.missions.get(w.lead.actor, m.id)) as { version: number }).version).toBe(
      m.version,
    );
  });

  it('is for the owning Lead only', async () => {
    const m = await w.draft();
    for (const who of [w.lead2, w.director, w.ann]) {
      await expect(
        h.missions.update(who.actor, m.id, { name: 'Hijack' }, m.version),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
    expect((await h.missions.get(w.lead.actor, m.id)).name).toBe('Artemis Relay');
  });

  it('answers 404 for unknown and foreign missions', async () => {
    const other = await missionWorld(h, 'Edit Other');
    const theirs = await other.draft();
    for (const id of [newId(), theirs.id]) {
      await expect(h.missions.update(w.lead.actor, id, { name: 'X' }, 1)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('is locked once the mission is Pending approval, Approved, Active, Completed or Cancelled (invariant 9)', async () => {
    // One organisation per state, so the date-driven transitions of one do not touch another.
    const states: Array<[string, () => Promise<{ x: MissionWorld; id: string }>]> = [
      [
        'pending_approval',
        async () => {
          const x = await missionWorld(h, 'Locked pending');
          return { x, id: (await x.pending()).id };
        },
      ],
      [
        'approved',
        async () => {
          const x = await missionWorld(h, 'Locked approved');
          return { x, id: (await x.approved()).id };
        },
      ],
      [
        'cancelled',
        async () => {
          const x = await missionWorld(h, 'Locked cancelled');
          return { x, id: (await x.act(await x.draft(), 'cancel')).id };
        },
      ],
      [
        'active',
        async () => {
          const x = await missionWorld(h, 'Locked active');
          const m = await x.approved({ startDate: '2027-05-01', endDate: '2027-05-20' });
          await h.db.withTenant(x.org.orgId, (tx) =>
            h.missions.runSystemTransitions(tx, '2027-05-02'),
          );
          return { x, id: m.id };
        },
      ],
      [
        'completed',
        async () => {
          const x = await missionWorld(h, 'Locked completed');
          const m = await x.approved({ startDate: '2027-04-01', endDate: '2027-04-02' });
          await h.db.withTenant(x.org.orgId, (tx) =>
            h.missions.runSystemTransitions(tx, '2027-04-03'),
          );
          return { x, id: m.id };
        },
      ],
    ];

    for (const [status, make] of states) {
      const { x, id } = await make();
      const current = (await h.missions.get(x.lead.actor, id)) as {
        status: string;
        version: number;
        name: string;
      };
      expect(current.status, status).toBe(status);
      const v = current.version;
      const attempts = handled([
        h.missions.update(x.lead.actor, id, { name: 'Edited' }, v),
        h.missions.setRequirements(x.lead.actor, id, { requirements: [] }, v),
        h.missions.replaceCrew(x.lead.actor, id, [x.ann.userId], { version: v }),
      ]);
      for (const attempt of attempts) {
        await expect(attempt, status).rejects.toMatchObject({
          code: 'MISSION_NOT_EDITABLE',
          status: 409,
          extra: { missionStatus: status },
        });
      }
      const after = (await h.missions.get(x.lead.actor, id)) as { name: string; version: number };
      expect(after.name).toBe('Artemis Relay');
      expect(after.version).toBe(v);
    }
  });
});

describe('requirements', () => {
  it('replaces the whole set, in Draft and Crewing, with skill names and an audit trail', async () => {
    const m = await w.draft();
    h.audit.clear();
    const set = await h.missions.setRequirements(
      w.lead.actor,
      m.id,
      {
        requirements: [
          { skillId: w.piloting.id, minLevel: 4, count: 1 },
          { skillId: w.medicine.id, minLevel: 3, count: 2 },
        ],
      },
      m.version,
    );
    expect(set.requirements).toEqual([
      { skillId: w.medicine.id, skillName: 'Medicine', minLevel: 3, count: 2 },
      { skillId: w.piloting.id, skillName: 'Piloting', minLevel: 4, count: 1 },
    ]);
    expect(set.version).toBe(m.version + 1);
    const replaced = await h.missions.setRequirements(
      w.lead.actor,
      m.id,
      { requirements: [{ skillId: w.medicine.id, minLevel: 5, count: 1 }] },
      set.version,
    );
    expect(replaced.requirements).toHaveLength(1);
    expect(h.audit.forEntity('mission', m.id).map((e) => e.action)).toEqual([
      'mission.requirements_set',
      'mission.requirements_set',
    ]);
    expect(h.audit.forEntity('mission', m.id)[1]).toMatchObject({
      before: [
        { skillId: w.medicine.id, minLevel: 3, count: 2 },
        { skillId: w.piloting.id, minLevel: 4, count: 1 },
      ],
      after: [{ skillId: w.medicine.id, minLevel: 5, count: 1 }],
    });
  });

  it('allows an empty set in Draft but not in Crewing (invariant 3)', async () => {
    const draft = await w.draft();
    await expect(
      h.missions.setRequirements(w.lead.actor, draft.id, { requirements: [] }, draft.version),
    ).resolves.toMatchObject({ requirements: [] });
    const crewing = await w.crewing();
    await expect(
      h.missions.setRequirements(w.lead.actor, crewing.id, { requirements: [] }, crewing.version),
    ).rejects.toMatchObject({
      code: 'MISSION_REQUIREMENTS_REQUIRED',
      status: 409,
    });
    expect(
      ((await h.missions.get(w.lead.actor, crewing.id)) as { requirements: unknown[] })
        .requirements,
    ).toHaveLength(1);
  });

  it('rejects unknown and foreign skills with a field error', async () => {
    const other = await missionWorld(h, 'Req Other');
    const m = await w.draft();
    for (const skillId of [newId(), other.medicine.id]) {
      await expect(
        h.missions.setRequirements(
          w.lead.actor,
          m.id,
          {
            requirements: [
              { skillId: w.medicine.id, minLevel: 1, count: 1 },
              { skillId, minLevel: 1, count: 1 },
            ],
          },
          m.version,
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        extra: { errors: [expect.objectContaining({ field: 'requirements.1.skillId' })] },
      });
    }
  });

  it('is for the owning Lead only, and unchanged sets keep the version', async () => {
    const m = await w.draft();
    const set = await h.missions.setRequirements(
      w.lead.actor,
      m.id,
      { requirements: [{ skillId: w.medicine.id, minLevel: 3, count: 1 }] },
      m.version,
    );
    for (const who of [w.lead2, w.director]) {
      await expect(
        h.missions.setRequirements(who.actor, m.id, { requirements: [] }, set.version),
      ).rejects.toMatchObject({ status: 403 });
    }
    const same = await h.missions.setRequirements(
      w.lead.actor,
      m.id,
      { requirements: [{ skillId: w.medicine.id, minLevel: 3, count: 1 }] },
      set.version,
    );
    expect(same.version).toBe(set.version);
  });
});

describe('optimistic concurrency (DESIGN.md §13)', () => {
  it('rejects a stale version with 412 and the current version, on every mutation', async () => {
    const m = await w.crewing();
    const stale = m.version - 1;
    const attempts = handled([
      h.missions.update(w.lead.actor, m.id, { name: 'Late' }, stale),
      h.missions.setRequirements(
        w.lead.actor,
        m.id,
        { requirements: [{ skillId: w.medicine.id, minLevel: 1, count: 1 }] },
        stale,
      ),
      h.missions.replaceCrew(w.lead.actor, m.id, [w.ann.userId], { version: stale }),
      h.missions.transition(w.lead.actor, m.id, { action: 'submit' }, stale),
      h.missions.transition(w.director.actor, m.id, { action: 'approve' }, stale),
    ]);
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: 'MISSION_VERSION_MISMATCH',
        status: 412,
        extra: { currentVersion: m.version },
      });
    }
    expect(((await h.missions.get(w.lead.actor, m.id)) as { version: number }).version).toBe(
      m.version,
    );
  });

  it('lets exactly one of two concurrent changes with the same version win', async () => {
    const m = await w.crewing({ crew: [w.ann.userId] });
    const results = await Promise.allSettled([
      h.missions.update(w.lead.actor, m.id, { name: 'First' }, m.version),
      h.missions.update(w.lead.actor, m.id, { name: 'Second' }, m.version),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ code: 'MISSION_VERSION_MISMATCH' });
  });

  it('checks the version before the state, so a stale request is a 412 even if it is also invalid', async () => {
    const m = await w.draft();
    await expect(
      h.missions.transition(w.lead.actor, m.id, { action: 'submit' }, m.version + 5),
    ).rejects.toMatchObject({ status: 412 });
  });
});

describe('the tentative crew', () => {
  it('replaces the crew by difference, keeping unchanged assignments and their ids', async () => {
    const m = await w.crewing({ crew: [w.ann.userId] });
    const annsAssignment = m.crew[0]!.assignmentId;
    const next = await h.missions.replaceCrew(w.lead.actor, m.id, [w.ann.userId, w.bob.userId], {
      version: m.version,
    });
    expect(next.crew.map((c) => c.crewMemberId).sort()).toEqual(
      [w.ann.userId, w.bob.userId].sort(),
    );
    expect(next.crew.find((c) => c.crewMemberId === w.ann.userId)!.assignmentId).toBe(
      annsAssignment,
    );
    expect(next.crew[0]).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
      acknowledgedAt: null,
    });
    const cleared = await h.missions.replaceCrew(w.lead.actor, m.id, [], { version: next.version });
    expect(cleared.crew).toEqual([]);
    expect(cleared.crewValidation?.valid).toBe(false);
  });

  it('is Crewing only: Draft, Pending approval and Approved missions refuse it', async () => {
    const x = await missionWorld(h, 'Crew states');
    const draft = await x.draft();
    const pending = await x.pending();
    const approved = await x.approved({ startDate: '2027-04-01', endDate: '2027-04-05' });
    for (const m of [draft, pending, approved]) {
      const v = ((await h.missions.get(x.lead.actor, m.id)) as { version: number }).version;
      await expect(
        h.missions.replaceCrew(x.lead.actor, m.id, [x.ann.userId], { version: v }),
      ).rejects.toMatchObject({
        code: 'MISSION_NOT_EDITABLE',
        status: 409,
      });
    }
  });

  it('only accepts active Crew Members of the organisation, naming the ones it refuses', async () => {
    const x = await missionWorld(h, 'Assignable');
    const other = await missionWorld(h, 'Assignable Other');
    const gone = await onboardUser(h, x.org, 'crew', 'gone');
    await h.users.update(x.director.actor, gone.userId, { status: 'deactivated' });
    const invited = await h.users.invite(x.director.actor, {
      email: `inv-${newId()}@test.space`,
      role: 'crew',
    });
    const m = await x.crewing();
    const refused = [
      x.lead2.userId,
      x.director.userId.toString(),
      gone.userId,
      invited.user.id,
      other.ann.userId,
      newId(),
    ];
    for (const id of refused) {
      await expect(
        h.missions.replaceCrew(x.lead.actor, m.id, [x.ann.userId, id], { version: m.version }),
      ).rejects.toMatchObject({
        code: 'CREW_MEMBER_NOT_ASSIGNABLE',
        status: 400,
        extra: { crewMemberIds: [id] },
      });
    }
    expect(((await h.missions.get(x.lead.actor, m.id)) as { crew: unknown[] }).crew).toEqual([]);
  });

  it('is for the owning Lead only', async () => {
    const m = await w.crewing();
    for (const who of [w.lead2, w.director, w.ann]) {
      await expect(
        h.missions.replaceCrew(who.actor, m.id, [w.ann.userId], { version: m.version }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('ignores a repeated id, and audits the before and after', async () => {
    const m = await w.crewing();
    h.audit.clear();
    await h.missions.replaceCrew(w.lead.actor, m.id, [w.ann.userId, w.ann.userId], {
      version: m.version,
    });
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.crew_set',
        before: { crewMemberIds: [] },
        after: { crewMemberIds: [w.ann.userId] },
      }),
    ]);
  });

  it("keeps released holds as history when a rejected mission's crew is changed (hold history decision)", async () => {
    const x = await missionWorld(h, 'History');
    const m = await x.pending();
    const rejected = await x.act(m, 'reject', x.director, 'Not now');
    expect(rejected.status).toBe('crewing');
    const holdsBefore = await h.db.withTenant(x.org.orgId, (tx) =>
      tx.select().from(schema.holds).where(eq(schema.holds.missionId, m.id)),
    );
    expect(holdsBefore).toHaveLength(1);
    expect(holdsBefore[0]).toMatchObject({
      releaseReason: 'rejected',
      assignmentId: expect.any(String),
    });

    const cleared = await h.missions.replaceCrew(x.lead.actor, m.id, [x.bob.userId], {
      version: rejected.version,
    });
    expect(cleared.crew.map((c) => c.crewMemberId)).toEqual([x.bob.userId]);
    const holdsAfter = await h.db.withTenant(x.org.orgId, (tx) =>
      tx.select().from(schema.holds).where(eq(schema.holds.missionId, m.id)),
    );
    expect(holdsAfter).toHaveLength(1);
    expect(holdsAfter[0]).toMatchObject({
      id: holdsBefore[0]!.id,
      assignmentId: null,
      releaseReason: 'rejected',
      crewMemberId: x.ann.userId,
    });
  });
});

describe('crew validation of a Crewing mission (DESIGN.md §7.1)', () => {
  it('is present only while Crewing, and valid when the requirements are met by eligible people', async () => {
    const x = await missionWorld(h, 'Validation');
    const draft = await x.draft();
    expect(draft.crewValidation).toBeUndefined();
    const m = await x.crewing({ crew: [x.ann.userId] });
    expect(m.crewValidation).toEqual({ valid: true, assignmentIssues: [], unmetRequirements: [] });
    const pending = await x.act(m, 'submit');
    expect(pending.crewValidation).toBeUndefined();
  });

  it('reports unmet requirements with counts, and counts a person once per requirement they satisfy', async () => {
    const x = await missionWorld(h, 'Unmet');
    const reqs = [
      { skillId: x.medicine.id, minLevel: 3, count: 2 },
      { skillId: x.piloting.id, minLevel: 5, count: 1 },
    ];
    const m = await x.crewing({ requirements: reqs, crew: [x.ann.userId, x.bob.userId] });
    // Ann has Medicine 4 and Piloting 5; Bob has Medicine 2 only.
    expect(m.crewValidation).toEqual({
      valid: false,
      assignmentIssues: [],
      unmetRequirements: [{ skillId: x.medicine.id, minLevel: 3, required: 2, met: 1 }],
    });
    const none = await h.missions.replaceCrew(x.lead.actor, m.id, [], { version: m.version });
    expect(none.crewValidation?.unmetRequirements.map((u) => u.met)).toEqual([0, 0]);
  });

  it('flags people who became ineligible, with one generic code, and never removes them', async () => {
    const x = await missionWorld(h, 'Flags');
    const m = await x.crewing({
      crew: [x.ann.userId, x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    });
    const annId = m.crew.find((c) => c.crewMemberId === x.ann.userId)!.assignmentId;
    expect(m.crewValidation?.valid).toBe(true);

    // Ann declares herself unavailable in the dates (after being assigned).
    await h.crew.addUnavailability(x.ann.actor, { from: '2027-03-05', to: '2027-03-06' });
    // Bob is deactivated.
    await h.users.update(x.director.actor, x.bob.userId, { status: 'deactivated' });

    const view = (await h.missions.get(x.lead.actor, m.id)) as typeof m;
    expect(view.crewValidation).toEqual({
      valid: false,
      assignmentIssues: [
        { assignmentId: annId, crewMemberId: x.ann.userId, code: 'NOT_ELIGIBLE' },
        { assignmentId: expect.any(String), crewMemberId: x.bob.userId, code: 'NOT_ELIGIBLE' },
      ].sort((a, b) => a.crewMemberId.localeCompare(b.crewMemberId)),
      unmetRequirements: [],
    });
    expect(view.crew).toHaveLength(2); // nothing was removed
    expect(JSON.stringify(view.crewValidation)).not.toMatch(
      /UNAVAILABLE|DOUBLE|CAPACITY|NOT_ACTIVE|unavailab/i,
    );
  });

  it('flags a person committed elsewhere in the dates, and one at the workload cap', async () => {
    const x = await missionWorld(h, 'Flags 2');
    const first = await x.approved({ startDate: '2027-03-01', endDate: '2027-03-10' }); // Ann is held
    const overlapping = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-03-05',
      endDate: '2027-03-15',
    });
    expect(overlapping.crewValidation?.assignmentIssues.map((i) => i.crewMemberId)).toEqual([
      x.ann.userId,
    ]);

    // Same person, dates that do not overlap: fine until the cap is reached.
    const later = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-06-01',
      endDate: '2027-06-10',
    });
    expect(later.crewValidation?.valid).toBe(true);
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 1 });
    const atCap = (await h.missions.get(x.lead.actor, later.id)) as typeof later;
    expect(atCap.crewValidation?.assignmentIssues).toHaveLength(1);
    await h.settings.update(x.director.actor, { maxUpcomingMissions: 2 });
    expect(
      ((await h.missions.get(x.lead.actor, later.id)) as typeof later).crewValidation?.valid,
    ).toBe(true);
    void first;
  });

  it('reflects a change of dates or requirements, without blocking the edit or removing anyone', async () => {
    const x = await missionWorld(h, 'Edits');
    await x.approved({ startDate: '2027-03-01', endDate: '2027-03-10' }); // holds Ann in March
    const m = await x.crewing({
      crew: [x.ann.userId],
      startDate: '2027-05-01',
      endDate: '2027-05-10',
    });
    expect(m.crewValidation?.valid).toBe(true);

    const moved = await h.missions.update(
      x.lead.actor,
      m.id,
      { startDate: '2027-03-08', endDate: '2027-03-12' },
      m.version,
    );
    expect(moved.crewValidation?.assignmentIssues).toHaveLength(1);
    expect(moved.crew).toHaveLength(1);

    const demanding = await h.missions.setRequirements(
      x.lead.actor,
      m.id,
      { requirements: [{ skillId: x.piloting.id, minLevel: 5, count: 3 }] },
      moved.version,
    );
    expect(demanding.crewValidation?.unmetRequirements).toEqual([
      { skillId: x.piloting.id, minLevel: 5, required: 3, met: 1 },
    ]);
    expect(demanding.crew).toHaveLength(1);
    const back = await h.missions.update(
      x.lead.actor,
      m.id,
      { startDate: '2027-05-01', endDate: '2027-05-10' },
      demanding.version,
    );
    expect(back.crewValidation?.assignmentIssues).toEqual([]);
  });

  it("judges requirements by skills only, and not by the crew member's current availability", async () => {
    const x = await missionWorld(h, 'Skills only');
    const m = await x.crewing({ crew: [x.ann.userId] });
    await h.crew.addUnavailability(x.ann.actor, { from: '2027-03-02', to: '2027-03-03' });
    const view = (await h.missions.get(x.lead.actor, m.id)) as typeof m;
    expect(view.crewValidation?.unmetRequirements).toEqual([]);
    expect(view.crewValidation?.assignmentIssues).toHaveLength(1);
  });

  it('flags a former Crew Member whose role changed', async () => {
    const x = await missionWorld(h, 'Role');
    const m = await x.crewing({
      crew: [x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    });
    await h.users.update(x.director.actor, x.bob.userId, { role: 'lead' });
    const view = (await h.missions.get(x.lead.actor, m.id)) as typeof m;
    expect(view.crewValidation?.assignmentIssues.map((i) => i.crewMemberId)).toEqual([
      x.bob.userId,
    ]);
    expect(view.crewValidation?.unmetRequirements).toHaveLength(1); // a Lead no longer counts towards the requirement
  });
});

describe('tenant isolation on every mission operation', () => {
  it("answers 404 for another organisation's mission, however it is addressed", async () => {
    const other = await missionWorld(h, 'Iso Other');
    const theirs = await other.crewing({ crew: [other.ann.userId] });
    const mine = w;
    const calls = handled([
      h.missions.get(mine.director.actor, theirs.id),
      h.missions.update(mine.lead.actor, theirs.id, { name: 'X' }, theirs.version),
      h.missions.setRequirements(mine.lead.actor, theirs.id, { requirements: [] }, theirs.version),
      h.missions.replaceCrew(mine.lead.actor, theirs.id, [mine.ann.userId], {
        version: theirs.version,
      }),
      h.missions.transition(mine.lead.actor, theirs.id, { action: 'submit' }, theirs.version),
      h.missions.transition(mine.director.actor, theirs.id, { action: 'approve' }, theirs.version),
    ]);
    for (const call of calls)
      await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // And their data is untouched.
    expect((await h.missions.get(other.lead.actor, theirs.id)).status).toBe('crewing');
  });

  it("cannot assign another organisation's crew member or use its skills", async () => {
    const other = await missionWorld(h, 'Iso Crew');
    const m = await w.crewing();
    await expect(
      h.missions.replaceCrew(w.lead.actor, m.id, [other.ann.userId], { version: m.version }),
    ).rejects.toMatchObject({ code: 'CREW_MEMBER_NOT_ASSIGNABLE' });
    await expect(
      h.missions.setRequirements(
        w.lead.actor,
        m.id,
        { requirements: [{ skillId: other.medicine.id, minLevel: 1, count: 1 }] },
        m.version,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

void [addAssignment, addHold, addMission, provisionOrganisation];
