import { AlertCodes } from '@mc/contracts';
import { createHarness, missionWorld, type Harness, type MissionWorld } from '@mc/core/testing';
import { newId, schema } from '@mc/db';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { silentSchedulerLogger } from './logger.js';
import { ALERT_RETENTION_DAYS, runPass, type SchedulerDeps } from './run-pass.js';

const urls = inject('dbUrls');
let h: Harness;
let admin: AdminDb;
let deps: SchedulerDeps;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
  admin = openAdminDb(urls.migrator);
  deps = { db: h.db, missions: h.missions, clock: h.clock, logger: silentSchedulerLogger };
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

const outcomeOf = (result: Awaited<ReturnType<typeof runPass>>, orgId: string) => {
  if (!result.ran) throw new Error('the pass did not run');
  return result.organisations.find((o) => o.organisationId === orgId);
};
const statusOf = async (x: MissionWorld, id: string) =>
  (await h.missions.get(x.lead.actor, id)).status;
const setTimeZone = (orgId: string, timeZone: string) =>
  admin.query('UPDATE organisations SET time_zone = $1 WHERE id = $2', [timeZone, orgId]);
const auditCount = async (orgId: string) =>
  Number(
    (await admin.query('SELECT count(*)::int AS n FROM audit_events WHERE org_id = $1', [orgId]))
      .rows[0].n,
  );
const alertsOf = (x: MissionWorld) => h.alerts.list(x.director.actor, { limit: 100 });

describe('a pass', () => {
  it('uses each organisation’s own date (east and west of UTC around midnight)', async () => {
    // 2026-10-02T10:00Z is already the 2nd in Auckland (23:00) but still the 1st in Pago Pago (23:00).
    const east = await missionWorld(h, 'Auckland');
    const west = await missionWorld(h, 'Pago Pago');
    await setTimeZone(east.org.orgId, 'Pacific/Auckland');
    await setTimeZone(west.org.orgId, 'Pacific/Pago_Pago');
    const m1 = await east.approved({ startDate: '2026-10-02', endDate: '2026-10-04' });
    const m2 = await west.approved({ startDate: '2026-10-02', endDate: '2026-10-04' });

    const result = await runPass(deps);

    expect(outcomeOf(result, east.org.orgId)).toMatchObject({ status: 'ok', today: '2026-10-02' });
    expect(outcomeOf(result, west.org.orgId)).toMatchObject({ status: 'ok', today: '2026-10-01' });
    expect(await statusOf(east, m1.id)).toBe('active');
    expect(await statusOf(west, m2.id)).toBe('approved');
  });

  it('catches up on a missed run, and is idempotent and audited as the system', async () => {
    const x = await missionWorld(h, 'Catch up');
    const m = await x.approved({ startDate: '2026-10-05', endDate: '2026-10-06' });

    h.clock.advance(10 * 24 * 60 * 60 * 1000); // the scheduler was down for ten days
    await runPass(deps); // activates and completes in the one run
    expect(await statusOf(x, m.id)).toBe('completed');

    const before = await auditCount(x.org.orgId);
    const again = await runPass(deps);
    expect(outcomeOf(again, x.org.orgId)).toMatchObject({
      result: { expired: 0, activated: 0, completed: 0 },
    });
    expect(await auditCount(x.org.orgId)).toBe(before);

    const events = await h.auditLog.list(x.director.actor, {
      entity: `mission:${m.id}`,
      limit: 100,
    });
    expect(
      events.items.filter(
        (e) => e.action === 'mission.activate' || e.action === 'mission.complete',
      ),
    ).toEqual([
      expect.objectContaining({ action: 'mission.complete', actorId: null }),
      expect.objectContaining({ action: 'mission.activate', actorId: null }),
    ]);
    h.clock.advance(-10 * 24 * 60 * 60 * 1000);
  });

  it('processes every organisation as of a supplied date when asked to', async () => {
    const x = await missionWorld(h, 'Override');
    const m = await x.approved({ startDate: '2031-01-10', endDate: '2031-01-12' });
    const result = await runPass(deps, { today: '2031-01-11' });
    expect(outcomeOf(result, x.org.orgId)).toMatchObject({ status: 'ok', today: '2031-01-11' });
    expect(await statusOf(x, m.id)).toBe('active');
    await runPass(deps, { today: '2031-01-13' });
    expect(await statusOf(x, m.id)).toBe('completed');
  });

  it('does nothing while another instance holds the lock', async () => {
    const x = await missionWorld(h, 'Locked out');
    const m = await x.approved({ startDate: '2031-02-10', endDate: '2031-02-12' });
    const held = await h.db.withSchedulerLock(() => runPass(deps, { today: '2031-02-11' }));
    expect(held).toEqual({ value: { ran: false } });
    expect(await statusOf(x, m.id)).toBe('approved');
  });
});

describe('a failing organisation', () => {
  it('is alerted on and skipped, while the others are still processed', async () => {
    const broken = await missionWorld(h, 'Broken zone');
    const healthy = await missionWorld(h, 'Healthy');
    const m1 = await broken.approved({ startDate: '2031-03-10', endDate: '2031-03-12' });
    const m2 = await healthy.approved({ startDate: '2031-03-10', endDate: '2031-03-12' });
    await setTimeZone(broken.org.orgId, 'Mars/Olympus_Mons');
    try {
      const warn = vi.fn();
      const logger = { ...silentSchedulerLogger, error: warn };
      const result = await runPass({ ...deps, logger });

      expect(outcomeOf(result, broken.org.orgId)).toEqual({
        organisationId: broken.org.orgId,
        status: 'failed',
        alertWritten: true,
      });
      expect(outcomeOf(result, healthy.org.orgId)?.status).toBe('ok');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ organisationId: broken.org.orgId, stage: 'time_zone' }),
        expect.any(String),
      );

      const alerts = (await alertsOf(broken)).items;
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        source: 'scheduler',
        code: AlertCodes.SCHEDULER_RUN_FAILED,
        details: {
          stage: 'time_zone',
          timeZone: 'Mars/Olympus_Mons',
          error: { name: 'RangeError' },
        },
      });
      expect((await alertsOf(healthy)).items).toEqual([]);
      expect(await statusOf(broken, m1.id)).toBe('approved');
      expect(await statusOf(healthy, m2.id)).toBe('approved'); // 2031 is in the future
    } finally {
      await setTimeZone(broken.org.orgId, 'UTC');
    }
  });

  it('is rolled back as a whole, alerted on, and retried by the next run', async () => {
    const failing = await missionWorld(h, 'Rolled back');
    const fine = await missionWorld(h, 'Unaffected');
    const m1 = await failing.approved({ startDate: '2031-04-10', endDate: '2031-04-12' });
    const m2 = await fine.approved({ startDate: '2031-04-10', endDate: '2031-04-12' });
    const auditBefore = await auditCount(failing.org.orgId);

    let broken = true;
    const missions = {
      // The real transitions run (and write) first, then the failure strikes: all of it must go.
      runSystemTransitions: async (
        ...args: Parameters<Harness['missions']['runSystemTransitions']>
      ) => {
        const result = await h.missions.runSystemTransitions(...args);
        const org = await args[0].execute(sql`SELECT current_setting('app.org_id', true) AS org`);
        if (broken && org.rows[0]?.org === failing.org.orgId) {
          throw Object.assign(new Error('disk on fire: secret@example.com'), { code: '53100' });
        }
        return result;
      },
    };
    const first = await runPass({ ...deps, missions }, { today: '2031-04-11' });

    expect(outcomeOf(first, failing.org.orgId)).toMatchObject({
      status: 'failed',
      alertWritten: true,
    });
    expect(outcomeOf(first, fine.org.orgId)?.status).toBe('ok');
    expect(await statusOf(failing, m1.id)).toBe('approved');
    expect(await auditCount(failing.org.orgId)).toBe(auditBefore);
    expect(await statusOf(fine, m2.id)).toBe('active');

    // The alert says what failed, never the error text (which could hold personal data).
    const alert = (await alertsOf(failing)).items[0]!;
    expect(alert.details).toMatchObject({
      stage: 'transitions',
      today: '2031-04-11',
      error: { name: 'Error', code: '53100' },
    });
    expect(JSON.stringify(alert)).not.toContain('secret@example.com');

    broken = false;
    await runPass({ ...deps, missions }, { today: '2031-04-11' });
    expect(await statusOf(failing, m1.id)).toBe('active');
  });

  it('raises one alert per failed run, with no deduplication', async () => {
    const x = await missionWorld(h, 'Repeat offender');
    await setTimeZone(x.org.orgId, 'Not/AZone');
    try {
      await runPass(deps);
      h.clock.advance(5 * 60 * 1000);
      await runPass(deps);
      h.clock.advance(5 * 60 * 1000);
      await runPass(deps);
      const alerts = (await alertsOf(x)).items;
      expect(alerts).toHaveLength(3);
      // Newest first.
      expect(alerts.map((a) => a.occurredAt)).toEqual(
        [...alerts.map((a) => a.occurredAt)].sort().reverse(),
      );
    } finally {
      await setTimeZone(x.org.orgId, 'UTC');
      h.clock.advance(-10 * 60 * 1000);
    }
  });

  it('still finishes the run when the alert cannot be written', async () => {
    const x = await missionWorld(h, 'No alert');
    await setTimeZone(x.org.orgId, 'Nope/Nope');
    try {
      const real = h.db.withScheduler.bind(h.db);
      let calls = 0;
      const db = {
        ...h.db,
        withSchedulerLock: h.db.withSchedulerLock.bind(h.db),
        withTenant: h.db.withTenant.bind(h.db),
        // Call 1 lists the organisations, call 2 is the alert insert (it fails), call 3 the purge.
        withScheduler: ((fn: Parameters<typeof real>[0]) =>
          ++calls === 2 ? Promise.reject(new Error('no')) : real(fn)) as typeof real,
      };
      const result = await runPass({ ...deps, db });
      expect(outcomeOf(result, x.org.orgId)).toMatchObject({
        status: 'failed',
        alertWritten: false,
      });
    } finally {
      await setTimeZone(x.org.orgId, 'UTC');
    }
  });
});

describe('alerts', () => {
  it(`are deleted after ${ALERT_RETENTION_DAYS} days, on every run`, async () => {
    const x = await missionWorld(h, 'Retention');
    const day = 24 * 60 * 60 * 1000;
    const insert = (ageDays: number) =>
      admin.query(
        `INSERT INTO alerts (id, org_id, source, code, message, occurred_at) VALUES ($1, $2, 'scheduler', 'OLD', 'm', $3)`,
        [newId(), x.org.orgId, new Date(h.clock.now().getTime() - ageDays * day)],
      );
    await insert(31);
    await insert(ALERT_RETENTION_DAYS + 0.01);
    await insert(29);
    await insert(1);

    const result = await runPass(deps);
    expect(result.ran && result.alertsPurged).toBeGreaterThanOrEqual(2);
    const left = (await alertsOf(x)).items;
    expect(left).toHaveLength(2);
    expect(
      left.every((a) => new Date(a.occurredAt).getTime() > h.clock.now().getTime() - 30 * day),
    ).toBe(true);
  });

  it('cannot be read through the scheduler role beyond their time, nor changed', async () => {
    const x = await missionWorld(h, 'Grants');
    await admin.query(
      `INSERT INTO alerts (id, org_id, source, code, message) VALUES ($1, $2, 'scheduler', 'X', 'm')`,
      [newId(), x.org.orgId],
    );
    await expect(
      h.db.withScheduler((tx) => tx.select({ message: schema.alerts.message }).from(schema.alerts)),
    ).rejects.toThrow();
    await expect(
      h.db.withScheduler((tx) =>
        tx
          .update(schema.alerts)
          .set({ message: 'changed' })
          .where(eq(schema.alerts.orgId, x.org.orgId)),
      ),
    ).rejects.toThrow();
  });
});
