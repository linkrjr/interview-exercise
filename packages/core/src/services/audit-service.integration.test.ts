import { newId, schema } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DbAuditWriter } from '../audit/db-audit-writer.js';
import {
  TEST_PASSWORD,
  createHarness,
  onboardUser,
  provisionOrganisation,
  type Harness,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: Harness;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
});

afterAll(async () => {
  await h.close();
});

const all = async (
  org: { director: { actor: Parameters<Harness['auditLog']['list']>[0] } },
  query = {},
) => {
  const events = [];
  let cursor: string | undefined;
  do {
    const page = await h.auditLog.list(org.director.actor, { limit: 3, cursor, ...query });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events;
};

describe('DbAuditWriter', () => {
  it('writes into the organisation of the transaction, with the supplied time', async () => {
    const org = await provisionOrganisation(h, 'Writer');
    const entityId = newId();
    await h.db.withTenant(org.orgId, (tx) =>
      new DbAuditWriter(h.clock).record(tx, {
        action: 'test.thing',
        entityType: 'thing',
        entityId,
        before: { a: 1 },
        after: { a: 2 },
        actorId: org.director.userId,
      }),
    );
    const [row] = await h.db.withTenant(org.orgId, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, entityId)),
    );
    expect(row).toMatchObject({
      orgId: org.orgId,
      action: 'test.thing',
      entityType: 'thing',
      before: { a: 1 },
      after: { a: 2 },
      actorId: org.director.userId,
      occurredAt: h.clock.now(),
    });
  });

  it('records the system actor as a null actor', async () => {
    const org = await provisionOrganisation(h, 'System');
    await h.db.withTenant(org.orgId, (tx) =>
      new DbAuditWriter(h.clock).record(tx, {
        action: 'sys.tick',
        entityType: 'thing',
        entityId: newId(),
        actorId: null,
      }),
    );
    const events = await all(org, { actor: 'system' });
    expect(events.map((e) => e.action)).toEqual(['sys.tick']);
    expect(events[0]).toMatchObject({ actorId: null, before: null, after: null });
  });

  it('is atomic with the change: a rolled-back transaction leaves no audit row', async () => {
    const org = await provisionOrganisation(h, 'Atomic');
    const entityId = newId();
    await expect(
      h.db.withTenant(org.orgId, async (tx) => {
        await new DbAuditWriter(h.clock).record(tx, {
          action: 'test.rolled_back',
          entityType: 'thing',
          entityId,
          actorId: null,
        });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    const rows = await h.db.withTenant(org.orgId, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, entityId)),
    );
    expect(rows).toEqual([]);
  });

  it('refuses payloads that look like secrets', async () => {
    const org = await provisionOrganisation(h, 'Secrets');
    const writer = new DbAuditWriter(h.clock);
    for (const payload of [
      { password: 'x' },
      { passwordHash: 'x' },
      { nested: { refreshToken: 'x' } },
      [{ codeHash: 'x' }],
      { inviteCode: 'x' },
    ]) {
      await expect(
        h.db.withTenant(org.orgId, (tx) =>
          writer.record(tx, {
            action: 'x',
            entityType: 'thing',
            entityId: newId(),
            after: payload,
            actorId: null,
          }),
        ),
      ).rejects.toThrow(/looks like a secret/);
    }
  });

  it('cannot be edited or deleted afterwards', async () => {
    const org = await provisionOrganisation(h, 'Immutable');
    await expect(
      h.db.withTenant(org.orgId, (tx) => tx.update(schema.auditEvents).set({ action: 'tampered' })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      h.db.withTenant(org.orgId, (tx) => tx.delete(schema.auditEvents)),
    ).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });
});

describe('the identity and org/crew call sites emit real audit events', () => {
  it('persists every audited action, in order, without secrets', async () => {
    const org = await provisionOrganisation(h, 'Sites');
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    h.clock.advance(1000);
    await h.auth
      .login({ orgId: org.orgId, email: lead.email, password: 'wrong password!!' })
      .catch(() => undefined);
    const session = await h.auth.login({
      orgId: org.orgId,
      email: lead.email,
      password: TEST_PASSWORD,
    });
    const rotated = await h.auth.refresh(session.refreshToken);
    await h.auth.refresh(session.refreshToken).catch(() => undefined); // replay: theft
    void rotated;
    await h.users.reinvite(
      org.director.actor,
      (await h.users.invite(org.director.actor, { email: `x-${newId()}@test.space`, role: 'crew' }))
        .user.id,
    );
    await h.users.update(org.director.actor, lead.userId, { role: 'director' });
    await h.users.update(org.director.actor, crew.userId, { status: 'deactivated' });
    await h.settings.update(org.director.actor, { maxUpcomingMissions: 4 });
    const skill = await h.skills.create(org.director.actor, { name: 'Welding' });
    await h.skills.rename(org.director.actor, skill.id, { name: 'Welding & Brazing' });
    const ann = await onboardUser(h, org, 'crew', 'ann');
    await h.crew.setSkill(ann.actor, skill.id, 2);
    const range = await h.crew.addUnavailability(ann.actor, {
      from: '2033-03-01',
      to: '2033-03-05',
      note: 'private',
    });
    await h.crew.removeUnavailability(ann.actor, range.id);
    await h.crew.removeSkill(ann.actor, skill.id);

    const actions = new Set((await all(org)).map((e) => e.action));
    for (const action of [
      'user.invited',
      'auth.invite_accepted',
      'auth.login_failed',
      'auth.refresh_token_reuse_detected',
      'user.invite_reissued',
      'user.role_changed',
      'user.deactivated',
      'org.settings_updated',
      'skill.created',
      'skill.renamed',
      'crew.skill_set',
      'crew.skill_removed',
      'crew.unavailability_added',
      'crew.unavailability_removed',
    ]) {
      expect(actions, action).toContain(action);
    }
    const text = JSON.stringify(await all(org));
    for (const secret of [
      TEST_PASSWORD,
      'wrong password',
      'private',
      session.refreshToken,
      lead.email,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('reading the audit log', () => {
  it('is for Directors only', async () => {
    const org = await provisionOrganisation(h, 'Perm');
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    for (const actor of [lead.actor, crew.actor]) {
      await expect(h.auditLog.list(actor, { limit: 10 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }
    await expect(h.auditLog.list({ kind: 'system' }, { limit: 10 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('lists newest first and pages without gaps or repeats', async () => {
    const org = await provisionOrganisation(h, 'Paging');
    for (let i = 0; i < 7; i++) {
      h.clock.advance(1000);
      await h.skills.create(org.director.actor, { name: `Skill ${i}` });
    }
    const events = await all(org); // pages of 3
    const created = events.filter((e) => e.action === 'skill.created');
    expect(created.map((e) => (e.after as { name: string }).name)).toEqual([
      'Skill 6',
      'Skill 5',
      'Skill 4',
      'Skill 3',
      'Skill 2',
      'Skill 1',
      'Skill 0',
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const times = events.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('breaks ties between events with the same timestamp by id, and pages across them', async () => {
    const org = await provisionOrganisation(h, 'Ties');
    for (let i = 0; i < 5; i++) await h.skills.create(org.director.actor, { name: `Tie ${i}` }); // same clock instant
    const events = await all(org);
    const created = events.filter((e) => e.action === 'skill.created');
    expect(created).toHaveLength(5);
    expect(new Set(created.map((e) => e.id)).size).toBe(5);
  });

  it('filters by entity, actor (user or system), and a time window', async () => {
    const org = await provisionOrganisation(h, 'Filters');
    const lead = await onboardUser(h, org, 'lead');
    const skillA = await h.skills.create(org.director.actor, { name: 'A' });
    h.clock.advance(86_400_000); // next day
    const cutoff = h.clock.now();
    await h.skills.rename(org.director.actor, skillA.id, { name: 'A2' });
    await h.db.withTenant(org.orgId, (tx) =>
      new DbAuditWriter(h.clock).record(tx, {
        action: 'sys.tick',
        entityType: 'thing',
        entityId: newId(),
        actorId: null,
      }),
    );

    expect((await all(org, { entity: `skill:${skillA.id}` })).map((e) => e.action)).toEqual([
      'skill.renamed',
      'skill.created',
    ]);
    expect((await all(org, { actor: lead.userId })).every((e) => e.actorId === lead.userId)).toBe(
      true,
    );
    expect((await all(org, { actor: 'system' })).map((e) => e.action)).toEqual(['sys.tick']);

    const since = (await all(org, { since: cutoff.toISOString() })).map((e) => e.action);
    expect(since).toEqual(['sys.tick', 'skill.renamed']);
    const until = (await all(org, { until: cutoff.toISOString() })).map((e) => e.action);
    expect(until).not.toContain('skill.renamed');
    expect(until).toContain('skill.created');
    // `until` is exclusive and `since` inclusive at the same instant.
    expect(await all(org, { since: cutoff.toISOString(), until: cutoff.toISOString() })).toEqual(
      [],
    );
  });

  it('reads a bare date as the start of that day in UTC', async () => {
    const org = await provisionOrganisation(h, 'Dates');
    const day = h.clock.now().toISOString().slice(0, 10);
    const events = await all(org, { since: day });
    expect(events.length).toBeGreaterThan(0);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 * 40)
      .toISOString()
      .slice(0, 10);
    expect(await all(org, { since: tomorrow })).toEqual([]);
    expect(await all(org, { until: '2000-01-01' })).toEqual([]);
  });

  it("only shows the Director's own organisation", async () => {
    const a = await provisionOrganisation(h, 'Iso A');
    const b = await provisionOrganisation(h, 'Iso B');
    const skill = await h.skills.create(b.director.actor, { name: 'Only B' });
    expect((await all(a)).map((e) => e.entityId)).not.toContain(skill.id);
    expect(await all(a, { entity: `skill:${skill.id}` })).toEqual([]);
    expect((await all(b, { entity: `skill:${skill.id}` })).length).toBe(1);
  });

  it('rejects a malformed cursor', async () => {
    const org = await provisionOrganisation(h, 'Cursor');
    const tampered = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [
      'garbage',
      Buffer.from('{"t":"nope","id":"x"}').toString('base64url'),
      Buffer.from('{}').toString('base64url'),
      // A valid time with a bad id used to reach Postgres as an invalid uuid and fail with a 500.
      tampered({ t: '2026-01-01T00:00:00.000Z', id: 'x' }),
      tampered({ t: '2026-01-01T00:00:00.000Z', id: '0199aaaa-bbbb-7ccc-8ddd-00000000000z' }),
      tampered({ t: '2026-13-45T00:00:00.000Z', id: '0199aaaa-bbbb-7ccc-8ddd-000000000001' }),
    ]) {
      await expect(h.auditLog.list(org.director.actor, { limit: 5, cursor })).rejects.toMatchObject(
        {
          code: 'INVALID_CURSOR',
          status: 400,
        },
      );
    }
  });
});
