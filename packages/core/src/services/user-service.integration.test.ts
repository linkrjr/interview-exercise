import { AppError } from '@mc/contracts';
import { newId, schema } from '@mc/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { INVITE_TTL_MS } from './invites.js';
import {
  TEST_PASSWORD,
  createHarness,
  onboardUser,
  provisionOrganisation,
  uniqueEmail,
  type Harness,
  type ProvisionedOrg,
} from '../testing/index.js';
import type { UserChange } from './guards.js';

const urls = inject('dbUrls');
let h: Harness;
let org: ProvisionedOrg;
let other: ProvisionedOrg;

beforeAll(async () => {
  h = await createHarness(urls);
  org = await provisionOrganisation(h, 'Org A');
  other = await provisionOrganisation(h, 'Org B');
});

afterAll(async () => {
  await h.close();
});

const profileExists = async (orgId: string, userId: string) =>
  (
    await h.db.withTenant(orgId, (tx) =>
      tx.select().from(schema.crewProfiles).where(eq(schema.crewProfiles.userId, userId)),
    )
  ).length === 1;

describe('permissions', () => {
  it('lets only Directors manage users; everyone else gets 403', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const crew = await onboardUser(h, org, 'crew');
    for (const caller of [lead.actor, crew.actor]) {
      const calls = [
        () => h.users.list(caller, { limit: 25 }),
        () => h.users.invite(caller, { email: uniqueEmail('x'), role: 'crew' }),
        () => h.users.update(caller, org.director.userId, { role: 'lead' }),
        () => h.users.reinvite(caller, org.director.userId),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      }
    }
  });

  it('refuses the system actor', async () => {
    await expect(h.users.list({ kind: 'system' }, { limit: 25 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(h.users.me({ kind: 'system' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('me', () => {
  it('returns the caller and their organisation, for every role', async () => {
    const crew = await onboardUser(h, org, 'crew');
    expect(await h.users.me(crew.actor)).toEqual({
      user: { id: crew.userId, email: crew.email, name: 'crew person', role: 'crew' },
      org: { id: org.orgId, name: 'Org A' },
    });
    expect((await h.users.me(org.director.actor)).user.role).toBe('director');
  });

  it('is 404 for a token whose user no longer exists in the organisation', async () => {
    await expect(
      h.users.me({ kind: 'user', userId: newId(), orgId: org.orgId, role: 'lead' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('invite', () => {
  it('creates an invited user without a name, plus a one-time code valid for 72 hours', async () => {
    const email = uniqueEmail('new');
    const result = await h.users.invite(org.director.actor, { email, role: 'lead' });
    expect(result.user).toMatchObject({ email, role: 'lead', status: 'invited', name: null });
    expect(result.invite.inviteCode.startsWith(`${org.orgId}.`)).toBe(true);
    expect(new Date(result.invite.expiresAt).getTime()).toBe(
      h.clock.now().getTime() + INVITE_TTL_MS,
    );
  });

  it('creates a crew profile for Crew Members only', async () => {
    const crew = await h.users.invite(org.director.actor, {
      email: uniqueEmail('c'),
      role: 'crew',
    });
    const lead = await h.users.invite(org.director.actor, {
      email: uniqueEmail('l'),
      role: 'lead',
    });
    const director = await h.users.invite(org.director.actor, {
      email: uniqueEmail('d'),
      role: 'director',
    });
    expect(await profileExists(org.orgId, crew.user.id)).toBe(true);
    expect(await profileExists(org.orgId, lead.user.id)).toBe(false);
    expect(await profileExists(org.orgId, director.user.id)).toBe(false);
  });

  it('audits the invite without the email address', async () => {
    const result = await h.users.invite(org.director.actor, {
      email: uniqueEmail('a'),
      role: 'crew',
    });
    const [event] = h.audit.forEntity('user', result.user.id);
    expect(event).toMatchObject({
      action: 'user.invited',
      actorId: org.director.userId,
      after: { role: 'crew', status: 'invited' },
    });
    expect(JSON.stringify(event)).not.toContain('@');
  });

  it('keeps email unique across the platform, ignoring case, and leaves nothing behind', async () => {
    const duplicate = (email: string, actor = org.director.actor) =>
      h.users.invite(actor, { email, role: 'crew' });
    await expect(duplicate(org.director.email.toUpperCase())).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
      status: 409,
    });
    // An address used in another organisation is just as taken.
    await expect(duplicate(other.director.email)).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
    });

    const before = (await h.users.list(org.director.actor, { limit: 100 })).items.length;
    await duplicate(other.director.email).catch(() => undefined);
    expect((await h.users.list(org.director.actor, { limit: 100 })).items).toHaveLength(before);
  });
});

describe('list', () => {
  it('pages through the organisation users only, with cursors', async () => {
    const small = await provisionOrganisation(h, 'Small');
    for (let i = 0; i < 4; i++) {
      await h.users.invite(small.director.actor, { email: uniqueEmail(`m${i}`), role: 'crew' });
    }
    const first = await h.users.list(small.director.actor, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.users.list(small.director.actor, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await h.users.list(small.director.actor, {
      limit: 2,
      cursor: second.nextCursor!,
    });
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((u) => u.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(ids);
    const tenants = await h.users.list(small.director.actor, { limit: 100 });
    expect(ids).not.toContain(org.director.userId);
    expect(tenants.items.map((u) => u.id)).not.toContain(other.director.userId);
  });

  it('rejects a malformed cursor', async () => {
    await expect(
      h.users.list(org.director.actor, { limit: 5, cursor: 'nonsense' }),
    ).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
      status: 400,
    });
  });
});

describe('update: role changes', () => {
  it('lets a Lead become a Director and back, revoking refresh tokens and auditing it', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const promoted = await h.users.update(org.director.actor, lead.userId, { role: 'director' });
    expect(promoted.role).toBe('director');
    await expect(h.auth.refresh(lead.session.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(
      h.audit.forEntity('user', lead.userId).find((e) => e.action === 'user.role_changed'),
    ).toMatchObject({
      action: 'user.role_changed',
      before: { role: 'lead' },
      after: { role: 'director' },
      actorId: org.director.userId,
    });
    // The user can sign in again and the new token carries the new role.
    const session = await h.auth.login({
      orgId: org.orgId,
      email: lead.email,
      password: TEST_PASSWORD,
    });
    expect(session.role).toBe('director');
    expect((await h.accessTokens.verify(session.accessToken)).role).toBe('director');
    expect((await h.users.update(org.director.actor, lead.userId, { role: 'lead' })).role).toBe(
      'lead',
    );
  });

  it('never allows a change to Crew', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const director = await onboardUser(h, org, 'director');
    for (const id of [lead.userId, director.userId]) {
      await expect(h.users.update(org.director.actor, id, { role: 'crew' })).rejects.toMatchObject({
        code: 'ROLE_CHANGE_TO_CREW_NOT_ALLOWED',
        status: 409,
      });
    }
  });

  it('lets Crew become Lead or Director and keeps the crew profile, dormant', async () => {
    const crew = await onboardUser(h, org, 'crew');
    expect(await profileExists(org.orgId, crew.userId)).toBe(true);
    const lead = await h.users.update(org.director.actor, crew.userId, { role: 'lead' });
    expect(lead.role).toBe('lead');
    expect(await profileExists(org.orgId, crew.userId)).toBe(true);
    await expect(
      h.users.update(org.director.actor, crew.userId, { role: 'crew' }),
    ).rejects.toMatchObject({
      code: 'ROLE_CHANGE_TO_CREW_NOT_ALLOWED',
    });
  });

  it('treats an unchanged role as a no-op: no audit event, sessions kept', async () => {
    const lead = await onboardUser(h, org, 'lead');
    h.audit.clear();
    const same = await h.users.update(org.director.actor, lead.userId, { role: 'lead' });
    expect(same.role).toBe('lead');
    expect(h.audit.events).toEqual([]);
    await expect(h.auth.refresh(lead.session.refreshToken)).resolves.toBeDefined();
    // Even "to crew" is accepted when the user already is crew.
    const crew = await onboardUser(h, org, 'crew');
    await expect(
      h.users.update(org.director.actor, crew.userId, { role: 'crew' }),
    ).resolves.toMatchObject({ role: 'crew' });
  });

  it('answers 404 for users that do not exist', async () => {
    await expect(
      h.users.update(org.director.actor, newId(), { role: 'lead' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('update: deactivation', () => {
  it('blocks login and refresh, revokes sessions, and is idempotent', async () => {
    const crew = await onboardUser(h, org, 'crew');
    const deactivated = await h.users.update(org.director.actor, crew.userId, {
      status: 'deactivated',
    });
    expect(deactivated.status).toBe('deactivated');
    await expect(h.auth.refresh(crew.session.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(
      h.auth.login({ orgId: org.orgId, email: crew.email, password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(
      h.audit.forEntity('user', crew.userId).find((e) => e.action === 'user.deactivated'),
    ).toMatchObject({
      action: 'user.deactivated',
      before: { status: 'active' },
      after: { status: 'deactivated' },
    });
    h.audit.clear();
    await expect(
      h.users.update(org.director.actor, crew.userId, { status: 'deactivated' }),
    ).resolves.toMatchObject({
      status: 'deactivated',
    });
    expect(h.audit.events).toEqual([]);
  });

  it('can deactivate a user who never accepted, which kills their invite', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('p'),
      role: 'lead',
    });
    await h.users.update(org.director.actor, invited.user.id, { status: 'deactivated' });
    await expect(
      h.auth.acceptInvite({
        code: invited.invite.inviteCode,
        name: 'Late',
        password: TEST_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
  });

  it('applies a role change and a deactivation together', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const result = await h.users.update(org.director.actor, lead.userId, {
      role: 'director',
      status: 'deactivated',
    });
    expect(result).toMatchObject({ role: 'director', status: 'deactivated' });
    expect(
      h.audit
        .forEntity('user', lead.userId)
        .slice(-2)
        .map((e) => e.action),
    ).toEqual(['user.role_changed', 'user.deactivated']);
  });
});

describe('update: last active Director guard (OQ-4)', () => {
  it('blocks deactivating or demoting the only active Director', async () => {
    const solo = await provisionOrganisation(h, 'Solo');
    await expect(
      h.users.update(solo.director.actor, solo.director.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({
      code: 'LAST_ACTIVE_DIRECTOR',
      status: 409,
    });
    await expect(
      h.users.update(solo.director.actor, solo.director.userId, { role: 'lead' }),
    ).rejects.toMatchObject({
      code: 'LAST_ACTIVE_DIRECTOR',
    });
    // Nothing changed.
    expect((await h.users.me(solo.director.actor)).user.role).toBe('director');
    await expect(h.auth.refresh(solo.director.session.refreshToken)).resolves.toBeDefined();
  });

  it('does not count invited or deactivated Directors as remaining', async () => {
    const solo = await provisionOrganisation(h, 'Solo2');
    await h.users.invite(solo.director.actor, { email: uniqueEmail('inv'), role: 'director' });
    await expect(
      h.users.update(solo.director.actor, solo.director.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({
      code: 'LAST_ACTIVE_DIRECTOR',
    });
  });

  it('allows it once another Director is active', async () => {
    const pair = await provisionOrganisation(h, 'Pair');
    await onboardUser(h, pair, 'director');
    await expect(
      h.users.update(pair.director.actor, pair.director.userId, { status: 'deactivated' }),
    ).resolves.toMatchObject({
      status: 'deactivated',
    });
  });

  it('holds under concurrency: two Directors deactivating each other, only one succeeds', async () => {
    const pair = await provisionOrganisation(h, 'Pair2');
    const second = await onboardUser(h, pair, 'director');
    const results = await Promise.allSettled([
      h.users.update(pair.director.actor, second.userId, { status: 'deactivated' }),
      h.users.update(second.actor, pair.director.userId, { status: 'deactivated' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'LAST_ACTIVE_DIRECTOR' });
    const users = await h.db.withTenant(pair.orgId, (tx) => tx.select().from(schema.users));
    expect(users.filter((u) => u.role === 'director' && u.status === 'active')).toHaveLength(1);
  });
});

describe('update: guard extension point', () => {
  it('runs every registered guard and lets one block the change', async () => {
    const seen: UserChange['kind'][] = [];
    const guarded = await createHarness(urls, {
      guards: [
        async (_tx, change) => {
          seen.push(change.kind);
          if (change.from.role === 'crew') {
            throw new AppError('CREW_HAS_HOLDS', 409, 'blocked by a later spec');
          }
        },
      ],
    });
    try {
      const o = await provisionOrganisation(guarded, 'Guarded');
      const crew = await onboardUser(guarded, o, 'crew');
      const lead = await onboardUser(guarded, o, 'lead');
      await expect(
        guarded.users.update(o.director.actor, crew.userId, { status: 'deactivated' }),
      ).rejects.toMatchObject({
        code: 'CREW_HAS_HOLDS',
      });
      await expect(
        guarded.users.update(o.director.actor, crew.userId, { role: 'lead' }),
      ).rejects.toMatchObject({
        code: 'CREW_HAS_HOLDS',
      });
      await guarded.users.update(o.director.actor, lead.userId, {
        role: 'director',
        status: 'deactivated',
      });
      expect(seen).toEqual(['deactivate', 'role_change', 'role_change', 'deactivate']);
    } finally {
      await guarded.close();
    }
  });
});

describe('reinvite', () => {
  it('issues a new code and invalidates earlier ones', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('re'),
      role: 'lead',
    });
    const fresh = await h.users.reinvite(org.director.actor, invited.user.id);
    expect(fresh.inviteCode).not.toBe(invited.invite.inviteCode);
    await expect(
      h.auth.acceptInvite({
        code: invited.invite.inviteCode,
        name: 'Old',
        password: TEST_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
    await expect(
      h.auth.acceptInvite({ code: fresh.inviteCode, name: 'New', password: TEST_PASSWORD }),
    ).resolves.toMatchObject({ userId: invited.user.id });
    expect(h.audit.forEntity('user', invited.user.id).map((e) => e.action)).toContain(
      'user.invite_reissued',
    );
  });

  it('recovers from an expired invite', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('exp'),
      role: 'crew',
    });
    h.clock.advance(INVITE_TTL_MS + 1000);
    await expect(
      h.auth.acceptInvite({ code: invited.invite.inviteCode, name: 'X', password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
    const fresh = await h.users.reinvite(org.director.actor, invited.user.id);
    await expect(
      h.auth.acceptInvite({ code: fresh.inviteCode, name: 'X', password: TEST_PASSWORD }),
    ).resolves.toBeDefined();
  });

  it('is only for users who have not accepted', async () => {
    const lead = await onboardUser(h, org, 'lead');
    await expect(h.users.reinvite(org.director.actor, lead.userId)).rejects.toMatchObject({
      code: 'USER_NOT_INVITED',
      status: 409,
    });
    await expect(h.users.reinvite(org.director.actor, newId())).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('tenant isolation', () => {
  it('returns 404 when a Director addresses another organisation user by id', async () => {
    const victim = await onboardUser(h, other, 'lead');
    await expect(
      h.users.update(org.director.actor, victim.userId, { status: 'deactivated' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    await expect(
      h.users.update(org.director.actor, victim.userId, { role: 'director' }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(h.users.reinvite(org.director.actor, victim.userId)).rejects.toMatchObject({
      status: 404,
    });
    // Untouched.
    expect(
      (await h.users.list(other.director.actor, { limit: 100 })).items.find(
        (u) => u.id === victim.userId,
      ),
    ).toMatchObject({
      status: 'active',
      role: 'lead',
    });
  });
});
