import { addAssignment, addHold, addMission, openAdminDb, type AdminDb } from '@mc/db/testing';
import { schema } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { getOrgSettings } from './org-settings-service.js';
import {
  createHarness,
  onboardUser,
  provisionOrganisation,
  type Harness,
  type ProvisionedOrg,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: Harness;
let admin: AdminDb;
let org: ProvisionedOrg;

beforeAll(async () => {
  h = await createHarness(urls);
  admin = openAdminDb(urls.migrator);
  org = await provisionOrganisation(h, 'Settings Org');
});

afterAll(async () => {
  await h.close();
  await admin.end();
});

describe('get', () => {
  it('returns the defaults to every role', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    for (const actor of [org.director.actor, lead.actor, crew.actor]) {
      expect(await h.settings.get(actor)).toEqual({ timeZone: 'UTC', maxUpcomingMissions: 3 });
    }
  });

  it('is exposed to later specs as getOrgSettings(tx)', async () => {
    expect(await h.db.withTenant(org.orgId, (tx) => getOrgSettings(tx))).toEqual({
      timeZone: 'UTC',
      maxUpcomingMissions: 3,
    });
  });
});

describe('update', () => {
  it('lets only Directors change settings', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    for (const actor of [lead.actor, crew.actor]) {
      await expect(h.settings.update(actor, { maxUpcomingMissions: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }
    expect(await h.settings.get(org.director.actor)).toMatchObject({ maxUpcomingMissions: 3 });
  });

  it('changes one or both settings, takes effect immediately and audits only what changed', async () => {
    const mine = await provisionOrganisation(h, 'Changing');
    h.audit.clear();
    const first = await h.settings.update(mine.director.actor, { maxUpcomingMissions: 7 });
    expect(first).toEqual({ timeZone: 'UTC', maxUpcomingMissions: 7 });
    const second = await h.settings.update(mine.director.actor, {
      timeZone: 'Europe/London',
      maxUpcomingMissions: 7,
    });
    expect(second).toEqual({ timeZone: 'Europe/London', maxUpcomingMissions: 7 });
    expect(await h.settings.get(mine.director.actor)).toEqual(second);

    expect(h.audit.events).toEqual([
      expect.objectContaining({
        action: 'org.settings_updated',
        entityType: 'organisation',
        entityId: mine.orgId,
        before: { maxUpcomingMissions: 3 },
        after: { maxUpcomingMissions: 7 },
        actorId: mine.director.userId,
      }),
      expect.objectContaining({
        before: { timeZone: 'UTC' },
        after: { timeZone: 'Europe/London' },
      }),
    ]);
  });

  it('writes no audit event when nothing changes', async () => {
    const mine = await provisionOrganisation(h, 'Unchanged');
    h.audit.clear();
    await h.settings.update(mine.director.actor, { maxUpcomingMissions: 3, timeZone: 'UTC' });
    expect(h.audit.events).toEqual([]);
  });

  it('scopes settings to the organisation', async () => {
    const a = await provisionOrganisation(h, 'A');
    const b = await provisionOrganisation(h, 'B');
    await h.settings.update(a.director.actor, { maxUpcomingMissions: 11 });
    expect(await h.settings.get(b.director.actor)).toMatchObject({ maxUpcomingMissions: 3 });
  });

  it('never releases existing holds when the cap is lowered (§5.2 invariant 6)', async () => {
    const mine = await provisionOrganisation(h, 'Holds');
    const lead = await onboardUser(h, mine, 'lead');
    const crew = await onboardUser(h, mine, 'crew');
    const tenant = { orgId: mine.orgId, leadId: lead.userId };
    const missions = [];
    for (const [from, to] of [
      ['2031-01-01', '2031-01-10'],
      ['2031-02-01', '2031-02-10'],
      ['2031-03-01', '2031-03-10'],
    ]) {
      const mission = await addMission(admin, tenant, from!, to!);
      const assignment = await addAssignment(admin, tenant, mission, crew.userId);
      missions.push(await addHold(admin, tenant, assignment, mission, crew.userId, from!, to!));
    }
    await h.settings.update(mine.director.actor, { maxUpcomingMissions: 1 });
    const holds = await h.db.withTenant(mine.orgId, (tx) => tx.select().from(schema.holds));
    expect(holds).toHaveLength(3);
    expect(holds.every((hold) => hold.releasedAt === null)).toBe(true);
  });
});
