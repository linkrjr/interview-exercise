import { createHighsSolver } from '@mc/matcher/highs';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { createHarness, type Harness } from '../testing/index.js';
import { DEMO_PASSWORD, seedDemo } from './demo.js';

const urls = inject('dbUrls');
let h: Harness;
let admin: AdminDb;
const now = new Date('2026-10-02T10:00:00.000Z');

beforeAll(async () => {
  h = await createHarness(urls);
  admin = openAdminDb(urls.migrator);
});
afterAll(async () => {
  await h.close();
  await admin.end();
});

describe('the demo scenario', () => {
  it('seeds two organisations with missions in every state, and refuses to seed twice', async () => {
    const config = {
      db: h.db,
      accessTokens: h.accessTokens,
      solver: await createHighsSolver(),
      logger: silentLogger,
      now,
    };
    const result = await seedDemo(config);

    expect(result.password).toBe(DEMO_PASSWORD);
    expect(result.organisations.map((o) => o.name)).toEqual([
      'Lunar Gateway Operations',
      'Mars Transit Authority',
    ]);
    const statuses = (name: string) =>
      Object.fromEntries(
        result.organisations.find((o) => o.name === name)!.missions.map((m) => [m.name, m.status]),
      );
    expect(statuses('Lunar Gateway Operations')).toEqual({
      'Gateway Resupply Run': 'completed',
      'Surface Survey Alpha': 'active',
      'Orbital Relay Install': 'approved',
      'Medical Rotation': 'pending_approval',
      'Deep Field Prospecting': 'crewing',
      'Comms Array Calibration': 'draft',
      'Cancelled Test Flight': 'cancelled',
    });
    expect(statuses('Mars Transit Authority')).toEqual({
      'Phobos Approach': 'active',
      'Habitat Assembly': 'approved',
      'Orbit Insertion Rehearsal': 'pending_approval',
      'Greenhouse Trial': 'draft',
    });
    for (const org of result.organisations) {
      expect(new Set(org.users.map((u) => u.role))).toEqual(new Set(['director', 'lead', 'crew']));
    }

    await expect(seedDemo(config)).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED' });
  });

  it('lets every seeded person sign in with the demo password', async () => {
    const lunar = (
      await admin.query(`SELECT id FROM organisations WHERE name = $1`, [
        'Lunar Gateway Operations',
      ])
    ).rows[0].id as string;
    const emails = (
      await admin.query(`SELECT email FROM users WHERE org_id = $1`, [lunar])
    ).rows.map((r) => r.email as string);
    expect(emails.length).toBe(9);
    for (const email of emails) {
      const session = await h.auth.login({ orgId: lunar, email, password: DEMO_PASSWORD });
      expect(session.orgId).toBe(lunar);
    }
  });

  it('gives Completed and Active missions a history, and a live hold only to the Active one', async () => {
    const lunar = (
      await admin.query(`SELECT id FROM organisations WHERE name = $1`, [
        'Lunar Gateway Operations',
      ])
    ).rows[0].id as string;
    const director = (
      await admin.query(`SELECT id FROM users WHERE org_id = $1 AND email = $2`, [
        lunar,
        'director@lunar-gateway.example',
      ])
    ).rows[0].id as string;
    const actor = { kind: 'user', userId: director, orgId: lunar, role: 'director' } as const;

    const events = (await h.auditLog.list(actor, { limit: 100 })).items;
    const byName = async (name: string) =>
      (await admin.query(`SELECT id FROM missions WHERE org_id = $1 AND name = $2`, [lunar, name]))
        .rows[0].id as string;
    const completedId = await byName('Gateway Resupply Run');
    const trail = events.filter((e) => e.entityId === completedId).map((e) => e.action);
    expect(trail).toEqual(
      expect.arrayContaining([
        'mission.created',
        'mission.submit',
        'mission.approve',
        'mission.activate',
        'mission.complete',
      ]),
    );
    // The history is in the past: the system moved through time, not just the dates.
    const created = events.find(
      (e) => e.entityId === completedId && e.action === 'mission.created',
    )!;
    expect(new Date(created.occurredAt).getTime()).toBeLessThan(
      now.getTime() - 10 * 24 * 3600 * 1000,
    );

    const holds = async (id: string) =>
      (
        await admin.query(`SELECT released_at, release_reason FROM holds WHERE mission_id = $1`, [
          id,
        ])
      ).rows;
    expect((await holds(completedId)).every((r) => r.release_reason === 'completed')).toBe(true);
    const activeHolds = await holds(await byName('Surface Survey Alpha'));
    expect(activeHolds).toHaveLength(2);
    expect(activeHolds.every((r) => r.released_at === null)).toBe(true);
  });

  it('keeps the two organisations apart: a user of one cannot read the other’s missions by id', async () => {
    const orgId = async (name: string) =>
      (await admin.query(`SELECT id FROM organisations WHERE name = $1`, [name])).rows[0]
        .id as string;
    const lunar = await orgId('Lunar Gateway Operations');
    const mars = await orgId('Mars Transit Authority');
    const mission = (
      await admin.query(`SELECT id FROM missions WHERE org_id = $1 AND name = $2`, [
        lunar,
        'Surface Survey Alpha',
      ])
    ).rows[0].id as string;
    const marsDirector = (
      await admin.query(`SELECT id FROM users WHERE org_id = $1 AND email = $2`, [
        mars,
        'director@mars-transit.example',
      ])
    ).rows[0].id as string;
    const actor = { kind: 'user', userId: marsDirector, orgId: mars, role: 'director' } as const;
    await expect(h.missions.get(actor, mission)).rejects.toMatchObject({ status: 404 });
  });
});
