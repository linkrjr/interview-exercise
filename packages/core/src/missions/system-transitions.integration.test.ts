import { schema } from '@mc/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { todayIn } from '../dates.js';
import { createHarness, missionWorld, type Harness, type MissionWorld } from '../testing/index.js';

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
const status = async (x: MissionWorld, id: string) =>
  (await h.missions.get(x.lead.actor, id)).status;
const holds = (x: MissionWorld, id: string) =>
  h.db.withTenant(x.org.orgId, (tx) =>
    tx.select().from(schema.holds).where(eq(schema.holds.missionId, id)),
  );

describe('expire (Pending approval whose start date passed)', () => {
  it('returns to Crewing, releases the holds as expired and tells the owner', async () => {
    const x = await missionWorld(h, 'Expire');
    const m = await x.pending({ startDate: '2027-03-01', endDate: '2027-03-10' });
    h.audit.clear();
    expect(await run(x, '2027-03-02')).toEqual({ expired: 1, activated: 0, completed: 0 });

    const after = await h.missions.get(x.lead.actor, m.id);
    expect(after).toMatchObject({ status: 'crewing', version: m.version + 1 });
    expect(
      (await holds(x, m.id)).every(
        (hold) => hold.releaseReason === 'expired' && hold.releasedAt !== null,
      ),
    ).toBe(true);
    const inbox = (await h.notifications.list(x.lead.actor, { limit: 10 })).items;
    expect(inbox[0]).toMatchObject({
      type: 'mission.expired',
      payload: { missionId: m.id, missionName: 'Artemis Relay', reason: 'start date passed' },
    });
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({
        action: 'mission.expire',
        actorId: null,
        before: { status: 'pending_approval', version: m.version },
        after: { status: 'crewing', version: m.version + 1, reason: 'start date passed' },
      }),
    ]);
    // The crew is free again, and the Lead may resubmit with new dates.
    expect((await h.crew.get(x.lead.actor, x.ann.userId)).load).toBe(0);
  });

  it('does not expire a mission that starts today, or one that starts later', async () => {
    const x = await missionWorld(h, 'Expire edges');
    const today = await x.pending({
      startDate: '2027-03-02',
      endDate: '2027-03-05',
      crew: [x.ann.userId],
    });
    const later = await x.pending({
      startDate: '2027-04-01',
      endDate: '2027-04-05',
      crew: [x.ann.userId],
    });
    expect(await run(x, '2027-03-02')).toEqual({ expired: 0, activated: 0, completed: 0 });
    expect(await status(x, today.id)).toBe('pending_approval');
    expect(await status(x, later.id)).toBe('pending_approval');
    expect(await run(x, '2027-03-03')).toMatchObject({ expired: 1 });
    expect(await status(x, today.id)).toBe('crewing');
    expect(await status(x, later.id)).toBe('pending_approval');
  });
});

describe('activate (Approved whose start date arrived)', () => {
  it('becomes Active on its start date, and not before', async () => {
    const x = await missionWorld(h, 'Activate');
    const m = await x.approved({ startDate: '2027-03-10', endDate: '2027-03-20' });
    expect(await run(x, '2027-03-09')).toEqual({ expired: 0, activated: 0, completed: 0 });
    expect(await status(x, m.id)).toBe('approved');
    h.audit.clear();
    expect(await run(x, '2027-03-10')).toEqual({ expired: 0, activated: 1, completed: 0 });
    expect(await status(x, m.id)).toBe('active');
    expect(h.audit.forEntity('mission', m.id)).toEqual([
      expect.objectContaining({ action: 'mission.activate', actorId: null }),
    ]);
    expect((await holds(x, m.id)).every((hold) => hold.releasedAt === null)).toBe(true); // still committed
  });
});

describe('complete (Active whose end date passed)', () => {
  it('becomes Completed the day after its end, releasing holds as history', async () => {
    const x = await missionWorld(h, 'Complete');
    const m = await x.approved({ startDate: '2027-03-10', endDate: '2027-03-20' });
    await run(x, '2027-03-10');
    expect(await run(x, '2027-03-20')).toEqual({ expired: 0, activated: 0, completed: 0 }); // the end date itself is still Active
    expect(await status(x, m.id)).toBe('active');
    expect(await run(x, '2027-03-21')).toEqual({ expired: 0, activated: 0, completed: 1 });
    expect(await status(x, m.id)).toBe('completed');
    const released = await holds(x, m.id);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ releaseReason: 'completed' });
    expect(released[0]!.releasedAt).not.toBeNull();
    expect((await h.crew.get(x.lead.actor, x.ann.userId)).load).toBe(0); // no longer counts towards the workload
  });

  it('catches up: a long-overdue Approved mission is activated and completed in one run', async () => {
    const x = await missionWorld(h, 'Catch up');
    const m = await x.approved({ startDate: '2027-03-10', endDate: '2027-03-12' });
    expect(await run(x, '2027-06-01')).toEqual({ expired: 0, activated: 1, completed: 1 });
    expect(await status(x, m.id)).toBe('completed');
  });
});

describe('every run', () => {
  it('is idempotent: running again with the same date changes nothing', async () => {
    const x = await missionWorld(h, 'Idempotent');
    const pending = await x.pending({ startDate: '2027-03-01', endDate: '2027-03-02' });
    const approved = await x.approved({
      startDate: '2027-04-01',
      endDate: '2027-04-02',
      crew: [x.bob.userId],
      requirements: [{ skillId: x.medicine.id, minLevel: 1, count: 1 }],
    });
    expect(await run(x, '2027-04-01')).toEqual({ expired: 1, activated: 1, completed: 0 });
    const events = h.audit.events.length;
    const inbox = (await h.notifications.list(x.lead.actor, { limit: 50 })).items.length;
    const versions = [
      ((await h.missions.get(x.lead.actor, pending.id)) as { version: number }).version,
      ((await h.missions.get(x.lead.actor, approved.id)) as { version: number }).version,
    ];
    for (let i = 0; i < 3; i++)
      expect(await run(x, '2027-04-01')).toEqual({ expired: 0, activated: 0, completed: 0 });
    expect(h.audit.events.length).toBe(events);
    expect((await h.notifications.list(x.lead.actor, { limit: 50 })).items.length).toBe(inbox);
    expect([
      ((await h.missions.get(x.lead.actor, pending.id)) as { version: number }).version,
      ((await h.missions.get(x.lead.actor, approved.id)) as { version: number }).version,
    ]).toEqual(versions);
  });

  it('leaves Draft, Crewing and Cancelled missions alone, whatever their dates', async () => {
    const x = await missionWorld(h, 'Untouched');
    const draft = await x.draft({ startDate: '2027-01-01', endDate: '2027-01-02' });
    const crewing = await x.crewing({ startDate: '2027-01-01', endDate: '2027-01-02' });
    const cancelled = await x.act(
      await x.draft({ startDate: '2027-01-01', endDate: '2027-01-02' }),
      'cancel',
    );
    expect(await run(x, '2030-01-01')).toEqual({ expired: 0, activated: 0, completed: 0 });
    expect(await status(x, draft.id)).toBe('draft');
    expect(await status(x, crewing.id)).toBe('crewing');
    expect(await status(x, cancelled.id)).toBe('cancelled');
  });

  it('only touches the organisation of the transaction it runs in', async () => {
    const a = await missionWorld(h, 'Scope A');
    const b = await missionWorld(h, 'Scope B');
    const ma = await a.approved({ startDate: '2027-03-01', endDate: '2027-03-10' });
    const mb = await b.approved({ startDate: '2027-03-01', endDate: '2027-03-10' });
    expect(await run(a, '2027-03-05')).toEqual({ expired: 0, activated: 1, completed: 0 });
    expect(await status(a, ma.id)).toBe('active');
    expect(await status(b, mb.id)).toBe('approved');
  });

  it("follows each organisation's own date: the same instant is a different day in different time zones", async () => {
    const t = await createHarness(urls); // clock: 2026-10-02T10:00Z
    try {
      const utc = await missionWorld(t, 'Zone UTC');
      const east = await missionWorld(t, 'Zone East');
      const west = await missionWorld(t, 'Zone West');
      const ids = {
        utc: (await utc.approved({ startDate: '2026-10-03', endDate: '2026-10-05' })).id,
        east: (await east.approved({ startDate: '2026-10-03', endDate: '2026-10-05' })).id,
        west: (await west.approved({ startDate: '2026-10-03', endDate: '2026-10-05' })).id,
      };
      await t.settings.update(east.director.actor, { timeZone: 'Pacific/Kiritimati' }); // already 2026-10-03
      await t.settings.update(west.director.actor, { timeZone: 'Pacific/Pago_Pago' }); // still 2026-10-01

      // What the scheduler does for each organisation.
      for (const [x, key] of [
        [utc, 'utc'],
        [east, 'east'],
        [west, 'west'],
      ] as const) {
        await t.db.withTenant(x.org.orgId, async (tx) => {
          const { timeZone } = await t.db.withTenant(x.org.orgId, (inner) =>
            import('../services/org-settings-service.js').then((m) => m.getOrgSettings(inner)),
          );
          await t.missions.runSystemTransitions(tx, todayIn(t.clock.now(), timeZone));
        });
        void key;
      }
      expect((await t.missions.get(utc.lead.actor, ids.utc)).status).toBe('approved'); // 2026-10-02: not yet
      expect((await t.missions.get(east.lead.actor, ids.east)).status).toBe('active'); // 2026-10-03: started
      expect((await t.missions.get(west.lead.actor, ids.west)).status).toBe('approved'); // 2026-10-01
    } finally {
      await t.close();
    }
  });
});
