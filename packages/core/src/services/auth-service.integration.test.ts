import { newId, schema } from '@mc/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PasswordHasher } from '../crypto/passwords.js';
import { INVITE_TTL_MS } from './invites.js';
import { REFRESH_TOKEN_TTL_MS } from './sessions.js';
import {
  TEST_PASSWORD,
  createIdentityHarness,
  onboardUser,
  provisionOrganisation,
  uniqueEmail,
  type IdentityHarness,
  type ProvisionedOrg,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: IdentityHarness;
let org: ProvisionedOrg;
let other: ProvisionedOrg;

beforeAll(async () => {
  h = await createIdentityHarness(urls);
  org = await provisionOrganisation(h, 'Org A');
  other = await provisionOrganisation(h, 'Org B');
});

afterAll(async () => {
  await h.close();
});

const login = (o: ProvisionedOrg, password = TEST_PASSWORD, email = o.director.email) =>
  h.auth.login({ orgId: o.orgId, email, password });

describe('accept-invite', () => {
  it('activates the user, stores name and an argon2id hash, and signs them in', async () => {
    const lead = await onboardUser(h, org, 'lead');
    expect(lead.session).toMatchObject({
      orgId: org.orgId,
      userId: lead.userId,
      role: 'lead',
      expiresIn: 900,
    });
    const actor = await h.accessTokens.verify(lead.session.accessToken);
    expect(actor).toEqual(lead.actor);

    const [user] = await h.db.withTenant(org.orgId, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.id, lead.userId)),
    );
    expect(user).toMatchObject({ status: 'active', name: 'lead person' });
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('stores only a hash of the invite secret, and marks the invite used', async () => {
    const email = uniqueEmail('hash');
    const invited = await h.users.invite(org.director.actor, { email, role: 'lead' });
    const code = invited.invite.inviteCode;
    const secret = code.slice(code.indexOf('.') + 1);
    const [row] = await h.db.withTenant(org.orgId, (tx) =>
      tx.select().from(schema.invites).where(eq(schema.invites.userId, invited.user.id)),
    );
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.codeHash).not.toBe(secret);
    expect(row!.usedAt).toBeNull();

    await h.auth.acceptInvite({ code, name: 'Hashed', password: TEST_PASSWORD });
    const [used] = await h.db.withTenant(org.orgId, (tx) =>
      tx.select().from(schema.invites).where(eq(schema.invites.userId, invited.user.id)),
    );
    expect(used!.usedAt).toEqual(h.clock.now());
  });

  it('is single-use', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('once'),
      role: 'crew',
    });
    const input = { code: invited.invite.inviteCode, name: 'Once', password: TEST_PASSWORD };
    await h.auth.acceptInvite(input);
    await expect(h.auth.acceptInvite(input)).rejects.toMatchObject({
      code: 'INVALID_INVITE',
      status: 400,
    });
  });

  it('cannot be accepted twice concurrently', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('race'),
      role: 'crew',
    });
    const input = { code: invited.invite.inviteCode, name: 'Race', password: TEST_PASSWORD };
    const results = await Promise.allSettled([
      h.auth.acceptInvite(input),
      h.auth.acceptInvite(input),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('expires after 72 hours', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('late'),
      role: 'crew',
    });
    h.clock.advance(INVITE_TTL_MS - 1000);
    // Still valid just before the deadline.
    const early = await h.users.invite(org.director.actor, {
      email: uniqueEmail('early'),
      role: 'crew',
    });
    await expect(
      h.auth.acceptInvite({
        code: early.invite.inviteCode,
        name: 'Early',
        password: TEST_PASSWORD,
      }),
    ).resolves.toBeDefined();
    h.clock.advance(2000);
    await expect(
      h.auth.acceptInvite({
        code: invited.invite.inviteCode,
        name: 'Late',
        password: TEST_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
  });

  it('rejects unknown, malformed and cross-organisation codes with the same error', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('x'),
      role: 'crew',
    });
    const secret = invited.invite.inviteCode.slice(invited.invite.inviteCode.indexOf('.') + 1);
    const codes = [
      '',
      'garbage',
      `${org.orgId}.${'a'.repeat(43)}`,
      `${newId()}.${secret}`,
      `${other.orgId}.${secret}`,
    ];
    for (const code of codes) {
      await expect(
        h.auth.acceptInvite({ code, name: 'X', password: TEST_PASSWORD }),
      ).rejects.toMatchObject({ code: 'INVALID_INVITE', status: 400 });
    }
  });

  it('validates the invite before hashing the password, so bad codes cost no argon2 work', async () => {
    let hashes = 0;
    const hasher = new PasswordHasher();
    const original = hasher.hash.bind(hasher);
    hasher.hash = (password) => {
      hashes++;
      return original(password);
    };
    const counted = await createIdentityHarness(urls, { hasher });
    try {
      const o = await provisionOrganisation(counted, 'Counted');
      hashes = 0; // the first Director's own acceptance does hash

      const used = await counted.users.invite(o.director.actor, {
        email: uniqueEmail('u'),
        role: 'crew',
      });
      await counted.auth.acceptInvite({
        code: used.invite.inviteCode,
        name: 'U',
        password: TEST_PASSWORD,
      });
      const superseded = await counted.users.invite(o.director.actor, {
        email: uniqueEmail('s'),
        role: 'crew',
      });
      await counted.users.reinvite(o.director.actor, superseded.user.id);
      const expired = await counted.users.invite(o.director.actor, {
        email: uniqueEmail('e'),
        role: 'crew',
      });
      counted.clock.advance(INVITE_TTL_MS + 1000);
      hashes = 0;

      const bad = [
        'garbage',
        `${o.orgId}.${'a'.repeat(43)}`,
        used.invite.inviteCode,
        superseded.invite.inviteCode,
        expired.invite.inviteCode,
      ];
      for (const code of bad) {
        await expect(
          counted.auth.acceptInvite({ code, name: 'X', password: TEST_PASSWORD }),
        ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
      }
      expect(hashes).toBe(0);

      const fresh = await counted.users.invite(o.director.actor, {
        email: uniqueEmail('f'),
        role: 'crew',
      });
      await counted.auth.acceptInvite({
        code: fresh.invite.inviteCode,
        name: 'F',
        password: TEST_PASSWORD,
      });
      expect(hashes).toBe(1);
    } finally {
      await counted.close();
    }
  });

  it('audits the acceptance', async () => {
    const lead = await onboardUser(h, org, 'lead');
    expect(h.audit.forEntity('user', lead.userId).map((e) => e.action)).toEqual([
      'user.invited',
      'auth.invite_accepted',
    ]);
  });
});

describe('login', () => {
  it('signs in with organisation, email and password; email is case-insensitive', async () => {
    const session = await login(org, TEST_PASSWORD, org.director.email.toUpperCase());
    expect(session).toMatchObject({
      orgId: org.orgId,
      userId: org.director.userId,
      role: 'director',
    });
    expect(session.refreshToken.startsWith(`${org.orgId}.`)).toBe(true);
    expect(await h.accessTokens.verify(session.accessToken)).toMatchObject({ orgId: org.orgId });
  });

  it('gives one generic error for wrong password, unknown email, unknown org and wrong org', async () => {
    const failures = await Promise.all([
      login(org, 'not the password').catch((e) => e),
      login(org, TEST_PASSWORD, uniqueEmail('nobody')).catch((e) => e),
      h.auth
        .login({ orgId: newId(), email: org.director.email, password: TEST_PASSWORD })
        .catch((e) => e),
      // A real user, but addressed through another organisation.
      h.auth
        .login({ orgId: other.orgId, email: org.director.email, password: TEST_PASSWORD })
        .catch((e) => e),
    ]);
    for (const failure of failures) {
      expect(failure).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
        detail: 'Invalid credentials',
      });
    }
  });

  it('audits failures only for users that exist, without secrets', async () => {
    const lead = await onboardUser(h, org, 'lead');
    h.audit.clear();
    await h.auth
      .login({ orgId: org.orgId, email: lead.email, password: 'wrong password!!' })
      .catch(() => undefined);
    await h.auth
      .login({ orgId: org.orgId, email: uniqueEmail('ghost'), password: 'whatever' })
      .catch(() => undefined);
    expect(h.audit.events).toHaveLength(1);
    expect(h.audit.events[0]).toMatchObject({
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: lead.userId,
      actorId: null,
      after: { reason: 'bad_password' },
    });
    expect(JSON.stringify(h.audit.events)).not.toContain('wrong password');
  });

  it('refuses invited and deactivated users', async () => {
    const invited = await h.users.invite(org.director.actor, {
      email: uniqueEmail('pending'),
      role: 'crew',
    });
    await expect(
      h.auth.login({ orgId: org.orgId, email: invited.user.email, password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const lead = await onboardUser(h, org, 'lead');
    await h.users.update(org.director.actor, lead.userId, { status: 'deactivated' });
    h.audit.clear();
    await expect(
      h.auth.login({ orgId: org.orgId, email: lead.email, password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(h.audit.events[0]).toMatchObject({ after: { reason: 'inactive' } });
  });

  it('logs failures without the email', async () => {
    const warnings: object[] = [];
    const logged = await createIdentityHarness(urls, {
      logger: { info: () => undefined, warn: (o) => warnings.push(o) },
    });
    try {
      await logged.auth
        .login({ orgId: org.orgId, email: org.director.email, password: 'nope nope nope' })
        .catch(() => undefined);
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain(org.director.email);
    } finally {
      await logged.close();
    }
  });
});

describe('refresh', () => {
  it('rotates the token and keeps the session family', async () => {
    const first = await login(org);
    const second = await h.auth.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const tokens = await h.db.withTenant(org.orgId, (tx) =>
      tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.userId, org.director.userId)),
    );
    const families = new Map(tokens.map((t) => [t.tokenHash, t.familyId]));
    const parsed = (token: string) => token.slice(token.indexOf('.') + 1);
    expect(tokens.filter((t) => t.revokedAt === null).length).toBeGreaterThanOrEqual(1);
    expect(families.size).toBeGreaterThanOrEqual(2);
    expect(parsed(first.refreshToken)).not.toBe(parsed(second.refreshToken));
  });

  it('treats reuse of a rotated token as theft: revokes the whole family and audits it', async () => {
    const first = await login(org);
    const second = await h.auth.refresh(first.refreshToken);
    h.audit.clear();
    await expect(h.auth.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
      status: 401,
    });
    // The legitimate holder's newest token is revoked too.
    await expect(h.auth.refresh(second.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(h.audit.events.map((e) => e.action)).toContain('auth.refresh_token_reuse_detected');
  });

  it('does not call a revoked token theft: logout, role change and deactivation just invalidate it', async () => {
    const lead = await onboardUser(h, org, 'lead');
    const loggedOut = await h.auth.login({
      orgId: org.orgId,
      email: lead.email,
      password: TEST_PASSWORD,
    });
    await h.auth.logout(loggedOut.refreshToken);
    await h.users.update(org.director.actor, lead.userId, { role: 'director' });
    const stale = lead.session.refreshToken; // revoked by the role change
    await h.users.update(org.director.actor, lead.userId, { status: 'deactivated' });

    h.audit.clear();
    for (const token of [loggedOut.refreshToken, stale]) {
      await expect(h.auth.refresh(token)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
        status: 401,
      });
    }
    expect(h.audit.events).toEqual([]);
  });

  it('still calls a rotated token theft when replayed after logout, and then stops alerting', async () => {
    const first = await login(org);
    const second = await h.auth.refresh(first.refreshToken);
    await h.auth.logout(second.refreshToken);
    h.audit.clear();
    await expect(h.auth.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });
    expect(h.audit.events.map((e) => e.action)).toEqual(['auth.refresh_token_reuse_detected']);
    // The newest token, now revoked with no successor, is only invalid: no second alert.
    h.audit.clear();
    await expect(h.auth.refresh(second.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    expect(h.audit.events).toEqual([]);
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const session = await login(org);
    const results = await Promise.allSettled([
      h.auth.refresh(session.refreshToken),
      h.auth.refresh(session.refreshToken),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'REFRESH_TOKEN_REUSED' });
  });

  it('expires after 30 days', async () => {
    const session = await login(org);
    h.clock.advance(REFRESH_TOKEN_TTL_MS - 1000);
    const renewed = await h.auth.refresh(session.refreshToken);
    h.clock.advance(REFRESH_TOKEN_TTL_MS + 1000);
    await expect(h.auth.refresh(renewed.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });

  it('rejects malformed, unknown and cross-organisation tokens', async () => {
    const session = await login(org);
    const secret = session.refreshToken.slice(session.refreshToken.indexOf('.') + 1);
    for (const token of [
      '',
      'garbage',
      `${org.orgId}.${'z'.repeat(43)}`,
      `${other.orgId}.${secret}`,
      `${newId()}.${secret}`,
    ]) {
      await expect(h.auth.refresh(token)).rejects.toMatchObject({
        code: 'INVALID_REFRESH_TOKEN',
        status: 401,
      });
    }
  });

  it('is refused once the user is deactivated', async () => {
    const lead = await onboardUser(h, org, 'lead');
    await h.users.update(org.director.actor, lead.userId, { status: 'deactivated' });
    await expect(h.auth.refresh(lead.session.refreshToken)).rejects.toMatchObject({ status: 401 });
  });
});

describe('logout', () => {
  it('revokes the session family and is idempotent', async () => {
    const session = await login(org);
    await h.auth.logout(session.refreshToken);
    await h.auth.logout(session.refreshToken);
    await expect(h.auth.refresh(session.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('ignores garbage and unknown tokens', async () => {
    await expect(h.auth.logout('garbage')).resolves.toBeUndefined();
    await expect(h.auth.logout(`${org.orgId}.${'q'.repeat(43)}`)).resolves.toBeUndefined();
    await expect(h.auth.logout(`${newId()}.secret`)).resolves.toBeUndefined();
  });

  it('only ends the session it was given', async () => {
    const a = await login(org);
    const b = await login(org);
    await h.auth.logout(a.refreshToken);
    await expect(h.auth.refresh(b.refreshToken)).resolves.toBeDefined();
  });
});
