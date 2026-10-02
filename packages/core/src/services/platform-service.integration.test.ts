import { newId, schema } from '@mc/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  TEST_PASSWORD,
  createIdentityHarness,
  onboardUser,
  provisionOrganisation,
  uniqueEmail,
  type IdentityHarness,
} from '../testing/index.js';

const urls = inject('dbUrls');
let h: IdentityHarness;

beforeAll(async () => {
  h = await createIdentityHarness(urls);
});

afterAll(async () => {
  await h.close();
});

const organisationIds = () =>
  h.db
    .withScheduler((tx) => tx.select({ id: schema.organisations.id }).from(schema.organisations))
    .then((rows) => rows.map((r) => r.id));

describe('createOrganisation', () => {
  it('creates the organisation and an invited first Director, and returns a one-time code', async () => {
    const email = uniqueEmail('first');
    const created = await h.platform.createOrganisation({
      name: 'Lunar Research Lab',
      directorEmail: email,
    });
    expect(created.invite.inviteCode.startsWith(`${created.organisationId}.`)).toBe(true);
    expect(await organisationIds()).toContain(created.organisationId);

    const [director] = await h.db.withTenant(created.organisationId, (tx) =>
      tx.select().from(schema.users),
    );
    expect(director).toMatchObject({
      id: created.directorUserId,
      role: 'director',
      status: 'invited',
      name: null,
    });

    const session = await h.auth.acceptInvite({
      code: created.invite.inviteCode,
      name: 'Dr First',
      password: TEST_PASSWORD,
    });
    expect(session).toMatchObject({ orgId: created.organisationId, role: 'director' });
  });

  it('uses the default settings (UTC, workload cap 3)', async () => {
    const created = await h.platform.createOrganisation({
      name: 'Defaults',
      directorEmail: uniqueEmail('def'),
    });
    const [org] = await h.db.withTenant(created.organisationId, (tx) =>
      tx.select().from(schema.organisations),
    );
    expect(org).toMatchObject({ name: 'Defaults', timeZone: 'UTC', maxUpcomingMissions: 3 });
  });

  it('rejects an email already registered anywhere and creates no organisation', async () => {
    const existing = await provisionOrganisation(h, 'Existing');
    const before = await organisationIds();
    await expect(
      h.platform.createOrganisation({
        name: 'Dup',
        directorEmail: existing.director.email.toUpperCase(),
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', status: 409 });
    expect(await organisationIds()).toEqual(before);
  });

  it('gives each organisation its own isolated users', async () => {
    const a = await provisionOrganisation(h, 'A');
    const b = await provisionOrganisation(h, 'B');
    const usersOfA = await h.users.list(a.director.actor, { limit: 100 });
    expect(usersOfA.items.map((u) => u.id)).toEqual([a.director.userId]);
    expect(usersOfA.items.map((u) => u.id)).not.toContain(b.director.userId);
  });
});

describe('reissueInvite', () => {
  it('gives the first Director a new code and invalidates the old one', async () => {
    const created = await h.platform.createOrganisation({
      name: 'Reissue',
      directorEmail: uniqueEmail('r'),
    });
    const fresh = await h.platform.reissueInvite(created.organisationId, created.directorUserId);
    expect(fresh.invite.inviteCode).not.toBe(created.invite.inviteCode);
    await expect(
      h.auth.acceptInvite({ code: created.invite.inviteCode, name: 'X', password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
    await expect(
      h.auth.acceptInvite({ code: fresh.invite.inviteCode, name: 'X', password: TEST_PASSWORD }),
    ).resolves.toMatchObject({ role: 'director' });
  });

  it('returns 404 for a user that is not in the organisation, or does not exist', async () => {
    const a = await provisionOrganisation(h, 'A');
    const b = await provisionOrganisation(h, 'B');
    await expect(h.platform.reissueInvite(a.orgId, b.director.userId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(h.platform.reissueInvite(a.orgId, newId())).rejects.toMatchObject({ status: 404 });
    await expect(h.platform.reissueInvite(newId(), a.director.userId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('cannot take over an account that is already active', async () => {
    const a = await provisionOrganisation(h, 'Active');
    const lead = await onboardUser(h, a, 'lead');
    const rogue = await h.platform.reissueInvite(a.orgId, lead.userId);
    await expect(
      h.auth.acceptInvite({
        code: rogue.invite.inviteCode,
        name: 'Rogue',
        password: 'another long password',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITE' });
    await expect(
      h.auth.login({ orgId: a.orgId, email: lead.email, password: TEST_PASSWORD }),
    ).resolves.toBeDefined();
  });
});
