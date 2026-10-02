import { createHarness, uniqueEmail, TEST_PASSWORD, type Harness } from '@mc/core/testing';
import { newId } from '@mc/db';
import { addAssignment, addHold, addMission, openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from './app.js';

const urls = inject('dbUrls');
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';

let h: Harness;
let app: ReturnType<typeof buildApp>;
let admin: AdminDb;

beforeAll(async () => {
  h = await createHarness(urls, { dbAudit: true });
  admin = openAdminDb(urls.migrator);
  app = buildApp({
    services: h,
    accessTokens: h.accessTokens,
    operatorToken: OPERATOR,
    loginRate: { emailMax: 50, ipMax: 500, windowMs: 60_000 },
    clock: h.clock,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.close();
  await admin.end();
});

// Response bodies are inspected loosely, field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  options: { token?: string; body?: unknown } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  let body: Json | undefined;
  try {
    body = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.statusCode, headers: res.headers, body: body as Json };
}

/** An organisation with a Director, a Lead, two Crew Members and a skill, over real HTTP. */
async function world() {
  const created = await call('POST', '/v1/platform/organisations', {
    token: OPERATOR,
    body: { name: 'HTTP Org', directorEmail: uniqueEmail('d') },
  });
  const accept = async (code: string, name: string) =>
    (
      await call('POST', '/v1/auth/accept-invite', {
        body: { code, name, password: TEST_PASSWORD },
      })
    ).body;
  const director = await accept(created.body.invite.inviteCode, 'Director');
  const invite = async (role: string) => {
    const r = await call('POST', '/v1/users', {
      token: director.accessToken,
      body: { email: uniqueEmail(role), role },
    });
    const session = await accept(r.body.invite.inviteCode, role);
    return { id: r.body.user.id as string, token: session.accessToken as string };
  };
  const lead = await invite('lead');
  const ann = await invite('crew');
  const bob = await invite('crew');
  const skill = (
    await call('POST', '/v1/skills', { token: director.accessToken, body: { name: 'Medicine' } })
  ).body;
  return {
    orgId: created.body.organisationId as string,
    director: { id: created.body.directorUserId as string, token: director.accessToken as string },
    lead,
    ann,
    bob,
    skill,
  };
}

describe('authentication and roles on every new endpoint', () => {
  const endpoints: Array<[string, string]> = [
    ['GET', '/v1/org/settings'],
    ['PATCH', '/v1/org/settings'],
    ['GET', '/v1/skills'],
    ['POST', '/v1/skills'],
    ['PATCH', `/v1/skills/${newId()}`],
    ['GET', '/v1/crew'],
    ['GET', `/v1/crew/${newId()}`],
    ['PUT', `/v1/crew/me/skills/${newId()}`],
    ['DELETE', `/v1/crew/me/skills/${newId()}`],
    ['POST', '/v1/crew/me/unavailability'],
    ['DELETE', `/v1/crew/me/unavailability/${newId()}`],
    ['GET', '/v1/audit'],
  ];

  it('requires a signed-in user', async () => {
    for (const [method, url] of endpoints) {
      const res = await call(method as 'GET', url, { body: {} });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    }
    const operator = await call('GET', '/v1/skills', { token: OPERATOR });
    expect(operator.status).toBe(401);
  });

  it('applies the role matrix', async () => {
    const w = await world();
    const forbidden = async (
      method: string,
      url: string,
      who: { token: string },
      body?: unknown,
    ) => {
      const res = await call(method as 'GET', url, { token: who.token, body });
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    };
    // Directors only
    for (const who of [w.lead, w.ann]) {
      await forbidden('PATCH', '/v1/org/settings', who, { maxUpcomingMissions: 5 });
      await forbidden('POST', '/v1/skills', who, { name: 'Nope' });
      await forbidden('PATCH', `/v1/skills/${w.skill.id}`, who, { name: 'Nope' });
      await forbidden('GET', '/v1/audit', who);
    }
    // Crew only
    for (const who of [w.director, w.lead]) {
      await forbidden('PUT', `/v1/crew/me/skills/${w.skill.id}`, who, { level: 3 });
      await forbidden('DELETE', `/v1/crew/me/skills/${w.skill.id}`, who);
      await forbidden('POST', '/v1/crew/me/unavailability', who, {
        from: '2033-01-01',
        to: '2033-01-02',
      });
      await forbidden('DELETE', `/v1/crew/me/unavailability/${newId()}`, who);
    }
    // Everyone reads
    for (const who of [w.director, w.lead, w.ann]) {
      expect((await call('GET', '/v1/org/settings', { token: who.token })).status).toBe(200);
      expect((await call('GET', '/v1/skills', { token: who.token })).status).toBe(200);
      expect((await call('GET', '/v1/crew', { token: who.token })).status).toBe(200);
    }
  });
});

describe('organisation settings', () => {
  it('reads defaults and changes them', async () => {
    const w = await world();
    const before = await call('GET', '/v1/org/settings', { token: w.lead.token });
    expect(before.body).toEqual({ timeZone: 'UTC', maxUpcomingMissions: 3 });
    const patched = await call('PATCH', '/v1/org/settings', {
      token: w.director.token,
      body: { timeZone: 'Europe/London', maxUpcomingMissions: 5 },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ timeZone: 'Europe/London', maxUpcomingMissions: 5 });
    expect((await call('GET', '/v1/org/settings', { token: w.ann.token })).body).toEqual(
      patched.body,
    );
  });

  it('rejects invalid time zones and out-of-range caps with field errors', async () => {
    const w = await world();
    const bad: Array<[Json, string]> = [
      [{ timeZone: 'Mars/Olympus' }, 'timeZone'],
      [{ timeZone: '+01:00' }, 'timeZone'],
      [{ timeZone: '' }, 'timeZone'],
      [{ timeZone: 'UTC; DROP TABLE organisations' }, 'timeZone'],
      [{ maxUpcomingMissions: 0 }, 'maxUpcomingMissions'],
      [{ maxUpcomingMissions: 21 }, 'maxUpcomingMissions'],
      [{ maxUpcomingMissions: 2.5 }, 'maxUpcomingMissions'],
      [{ maxUpcomingMissions: '5' }, 'maxUpcomingMissions'],
    ];
    for (const [body, field] of bad) {
      const res = await call('PATCH', '/v1/org/settings', { token: w.director.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors.map((e: Json) => e.field)).toContain(field);
    }
    expect(
      (await call('PATCH', '/v1/org/settings', { token: w.director.token, body: {} })).status,
    ).toBe(400);
    expect((await call('GET', '/v1/org/settings', { token: w.director.token })).body).toEqual({
      timeZone: 'UTC',
      maxUpcomingMissions: 3,
    });
  });

  it('accepts the cap boundaries and common zones', async () => {
    const w = await world();
    for (const body of [
      { maxUpcomingMissions: 1 },
      { maxUpcomingMissions: 20 },
      { timeZone: 'UTC' },
      { timeZone: 'Asia/Kolkata' },
      { timeZone: 'America/Argentina/Buenos_Aires' },
    ]) {
      expect(
        (await call('PATCH', '/v1/org/settings', { token: w.director.token, body })).status,
        JSON.stringify(body),
      ).toBe(200);
    }
  });
});

describe('skills', () => {
  it('creates (201), lists, renames and normalises names', async () => {
    const w = await world();
    const created = await call('POST', '/v1/skills', {
      token: w.director.token,
      body: { name: '  Orbital   Piloting ' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Orbital Piloting' });
    const renamed = await call('PATCH', `/v1/skills/${created.body.id}`, {
      token: w.director.token,
      body: { name: 'Orbital Navigation' },
    });
    expect(renamed.body).toMatchObject({ id: created.body.id, name: 'Orbital Navigation' });
    const list = await call('GET', '/v1/skills?limit=1', { token: w.lead.token });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toEqual(expect.any(String));
    const rest = await call('GET', `/v1/skills?cursor=${list.body.nextCursor}`, {
      token: w.lead.token,
    });
    expect(rest.body.items.map((s: Json) => s.name)).toEqual(['Orbital Navigation']);
  });

  it('reports a taken name (409), invalid names (400) and unknown ids (404)', async () => {
    const w = await world();
    const taken = await call('POST', '/v1/skills', {
      token: w.director.token,
      body: { name: 'MEDICINE' },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SKILL_NAME_TAKEN');
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 5 },
    ]) {
      expect(
        (await call('POST', '/v1/skills', { token: w.director.token, body })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    for (const id of [newId(), 'not-a-uuid']) {
      const res = await call('PATCH', `/v1/skills/${id}`, {
        token: w.director.token,
        body: { name: 'X' },
      });
      expect(res.status).toBe(404);
    }
    expect((await call('GET', '/v1/skills?limit=0', { token: w.director.token })).status).toBe(400);
  });

  it("answers 404 for another organisation's skill", async () => {
    const a = await world();
    const b = await world();
    const res = await call('PATCH', `/v1/skills/${b.skill.id}`, {
      token: a.director.token,
      body: { name: 'Hijack' },
    });
    expect(res.status).toBe(404);
    expect((await call('GET', '/v1/skills', { token: b.director.token })).body.items[0].name).toBe(
      'Medicine',
    );
  });
});

describe('crew skills', () => {
  it('sets, changes and removes (204) a skill level, returning the skill name', async () => {
    const w = await world();
    const set = await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.ann.token,
      body: { level: 4 },
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ skillId: w.skill.id, name: 'Medicine', level: 4 });
    await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.ann.token,
      body: { level: 2 },
    });
    const profile = await call('GET', `/v1/crew/${w.ann.id}`, { token: w.lead.token });
    expect(profile.body.skills).toEqual([{ skillId: w.skill.id, name: 'Medicine', level: 2 }]);
    const removed = await call('DELETE', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.ann.token,
    });
    expect(removed.status).toBe(204);
    expect(removed.body).toBeUndefined();
    expect(
      (await call('DELETE', `/v1/crew/me/skills/${w.skill.id}`, { token: w.ann.token })).status,
    ).toBe(404);
  });

  it('validates levels, ids and skills', async () => {
    const w = await world();
    for (const level of [0, 6, 2.5, '3', null]) {
      expect(
        (
          await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
            token: w.ann.token,
            body: { level },
          })
        ).status,
        String(level),
      ).toBe(400);
    }
    expect(
      (await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, { token: w.ann.token, body: {} }))
        .status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `/v1/crew/me/skills/${newId()}`, {
          token: w.ann.token,
          body: { level: 3 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('PUT', '/v1/crew/me/skills/not-a-uuid', {
          token: w.ann.token,
          body: { level: 3 },
        })
      ).status,
    ).toBe(404);
    const other = await world();
    expect(
      (
        await call('PUT', `/v1/crew/me/skills/${other.skill.id}`, {
          token: w.ann.token,
          body: { level: 3 },
        })
      ).status,
    ).toBe(404);
  });
});

describe('unavailability over HTTP', () => {
  it('adds (201), returns the private note only to its owner, and removes (204)', async () => {
    const w = await world();
    const added = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2033-05-01', to: '2033-05-10', note: 'Leave' },
    });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({
      id: expect.any(String),
      from: '2033-05-01',
      to: '2033-05-10',
      note: 'Leave',
    });
    const own = await call('GET', `/v1/crew/${w.ann.id}`, { token: w.ann.token });
    expect(own.body.unavailability).toEqual([added.body]);
    for (const who of [w.lead, w.director]) {
      const seen = await call('GET', `/v1/crew/${w.ann.id}`, { token: who.token });
      expect(seen.body.unavailability).toEqual([
        { id: added.body.id, from: '2033-05-01', to: '2033-05-10' },
      ]);
    }
    expect(
      (await call('DELETE', `/v1/crew/me/unavailability/${added.body.id}`, { token: w.ann.token }))
        .status,
    ).toBe(204);
    expect(
      (await call('GET', `/v1/crew/${w.ann.id}`, { token: w.ann.token })).body.unavailability,
    ).toEqual([]);
  });

  it('validates dates and note length with field errors', async () => {
    const w = await world();
    const bad: Array<[Json, string]> = [
      [{ from: '2033-05-10', to: '2033-05-01' }, 'to'],
      [{ from: '2033-13-01', to: '2033-13-02' }, 'from'],
      [{ from: '2033-02-30', to: '2033-03-01' }, 'from'],
      [{ from: '05/01/2033', to: '2033-05-02' }, 'from'],
      [{ from: '2033-05-01' }, 'to'],
      [{ from: '2033-05-01', to: '2033-05-02', note: 'x'.repeat(501) }, 'note'],
    ];
    for (const [body, field] of bad) {
      const res = await call('POST', '/v1/crew/me/unavailability', { token: w.ann.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: Json) => e.field)).toContain(field);
    }
  });

  it('rejects ranges in the past with a stable code, overlaps with the existing ranges listed', async () => {
    const w = await world();
    const past = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2026-01-01', to: '2026-01-05' },
    });
    expect(past.status).toBe(400);
    expect(past.body).toMatchObject({
      code: 'UNAVAILABILITY_IN_PAST',
      errors: [expect.objectContaining({ field: 'to' })],
    });
    const first = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2033-06-10', to: '2033-06-20' },
    });
    const overlap = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2033-06-20', to: '2033-06-25' },
    });
    expect(overlap.status).toBe(409);
    expect(overlap.headers['content-type']).toContain('application/problem+json');
    expect(overlap.body).toMatchObject({
      code: 'UNAVAILABILITY_OVERLAPS_EXISTING',
      unavailability: [{ id: first.body.id, from: '2033-06-10', to: '2033-06-20' }],
    });
  });

  it('reports the missions that block a range as a problem extension (OQ-1)', async () => {
    const w = await world();
    const tenant = { orgId: w.orgId, leadId: w.lead.id };
    const mission = await addMission(admin, tenant, '2033-07-01', '2033-07-10');
    await admin.query(
      "UPDATE missions SET status = 'pending_approval', name = 'Artemis Relay' WHERE id = $1",
      [mission],
    );
    const assignment = await addAssignment(admin, tenant, mission, w.ann.id);
    await addHold(admin, tenant, assignment, mission, w.ann.id, '2033-07-01', '2033-07-10');

    const res = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2033-07-05', to: '2033-07-06' },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      type: 'about:blank',
      status: 409,
      code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
      missions: [
        {
          id: mission,
          name: 'Artemis Relay',
          startDate: '2033-07-01',
          endDate: '2033-07-10',
          status: 'pending_approval',
        },
      ],
    });
  });

  it("answers 404 for someone else's range and for malformed ids", async () => {
    const w = await world();
    const added = await call('POST', '/v1/crew/me/unavailability', {
      token: w.ann.token,
      body: { from: '2033-08-01', to: '2033-08-02' },
    });
    expect(
      (await call('DELETE', `/v1/crew/me/unavailability/${added.body.id}`, { token: w.bob.token }))
        .status,
    ).toBe(404);
    expect(
      (await call('DELETE', '/v1/crew/me/unavailability/not-a-uuid', { token: w.bob.token }))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/crew/${w.ann.id}`, { token: w.ann.token })).body.unavailability,
    ).toHaveLength(1);
  });
});

describe('crew search over HTTP', () => {
  it('lists active crew and filters by repeated skill and by availability', async () => {
    const w = await world();
    const piloting = (
      await call('POST', '/v1/skills', { token: w.director.token, body: { name: 'Piloting' } })
    ).body;
    await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.ann.token,
      body: { level: 3 },
    });
    await call('PUT', `/v1/crew/me/skills/${piloting.id}`, {
      token: w.ann.token,
      body: { level: 5 },
    });
    await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.bob.token,
      body: { level: 4 },
    });
    await call('POST', '/v1/crew/me/unavailability', {
      token: w.bob.token,
      body: { from: '2033-09-10', to: '2033-09-20' },
    });

    const ids = async (query: string) =>
      ((await call('GET', `/v1/crew${query}`, { token: w.lead.token })).body.items as Json[])
        .map((p) => p.id)
        .sort();
    const both = [w.ann.id, w.bob.id].sort();
    expect(await ids('')).toEqual(both);
    expect(await ids(`?skill=${w.skill.id}:3`)).toEqual(both);
    expect(await ids(`?skill=${w.skill.id}:4`)).toEqual([w.bob.id]);
    expect(await ids(`?skill=${w.skill.id}:3&skill=${piloting.id}:5`)).toEqual([w.ann.id]);
    expect(await ids('?available=2033-09-01:2033-09-09')).toEqual(both);
    expect(await ids('?available=2033-09-15:2033-09-16')).toEqual([w.ann.id]);
    expect(await ids(`?skill=${w.skill.id}:4&available=2033-09-15:2033-09-16`)).toEqual([]);

    const page = await call('GET', '/v1/crew?limit=1', { token: w.lead.token });
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({
      email: expect.any(String),
      load: 0,
      skills: expect.any(Array),
      unavailability: expect.any(Array),
    });
  });

  it('validates filters', async () => {
    const w = await world();
    for (const query of [
      '?skill=nope',
      `?skill=${newId()}:0`,
      `?skill=${newId()}:6`,
      `?skill=${w.skill.id}`,
      '?available=2033-09-10',
      '?available=2033-09-20:2033-09-10',
      '?available=2033-02-30:2033-03-01',
      '?limit=101',
    ]) {
      const res = await call('GET', `/v1/crew${query}`, { token: w.lead.token });
      expect(res.status, query).toBe(400);
    }
  });

  it("gives a Crew Member only their own profile, and 404 for everyone else's, other tenants' and malformed ids", async () => {
    const w = await world();
    const other = await world();
    expect(
      (await call('GET', '/v1/crew', { token: w.ann.token })).body.items.map((p: Json) => p.id),
    ).toEqual([w.ann.id]);
    expect((await call('GET', `/v1/crew/${w.ann.id}`, { token: w.ann.token })).status).toBe(200);
    for (const [token, id] of [
      [w.ann.token, w.bob.id],
      [w.lead.token, other.ann.id],
      [w.lead.token, w.lead.id],
      [w.lead.token, w.director.id],
      [w.lead.token, 'not-a-uuid'],
      [w.lead.token, 'me'],
    ] as const) {
      const res = await call('GET', `/v1/crew/${id}`, { token });
      expect(res.status, id).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect(
      (await call('GET', '/v1/crew', { token: w.lead.token })).body.items.map((p: Json) => p.id),
    ).not.toContain(other.ann.id);
  });
});

describe('audit log over HTTP', () => {
  it('shows the Director what happened, newest first, with filters and paging', async () => {
    const w = await world();
    h.clock.advance(1000);
    await call('PATCH', '/v1/org/settings', {
      token: w.director.token,
      body: { maxUpcomingMissions: 6 },
    });
    h.clock.advance(1000);
    await call('PUT', `/v1/crew/me/skills/${w.skill.id}`, {
      token: w.ann.token,
      body: { level: 3 },
    });

    const all = await call('GET', '/v1/audit?limit=100', { token: w.director.token });
    expect(all.status).toBe(200);
    const actions = (all.body.items as Json[]).map((e) => e.action);
    expect(actions.slice(0, 2)).toEqual(['crew.skill_set', 'org.settings_updated']);
    expect(actions).toEqual(
      expect.arrayContaining(['user.invited', 'auth.invite_accepted', 'skill.created']),
    );
    expect(all.body.items[0]).toMatchObject({
      actorId: w.ann.id,
      entityType: 'crew_profile',
      entityId: w.ann.id,
      after: { skillId: w.skill.id, level: 3 },
      occurredAt: expect.any(String),
    });

    const byEntity = await call('GET', `/v1/audit?entity=skill:${w.skill.id}`, {
      token: w.director.token,
    });
    expect(byEntity.body.items.map((e: Json) => e.action)).toEqual(['skill.created']);
    const byActor = await call('GET', `/v1/audit?actor=${w.ann.id}`, { token: w.director.token });
    expect(byActor.body.items.every((e: Json) => e.actorId === w.ann.id)).toBe(true);

    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call('GET', `/v1/audit?limit=4${cursor ? `&cursor=${cursor}` : ''}`, {
        token: w.director.token,
      });
      paged.push(...page.body.items.map((e: Json) => e.id));
      cursor = page.body.nextCursor ?? undefined;
    } while (cursor);
    expect(paged).toEqual(all.body.items.map((e: Json) => e.id));
  });

  it('filters by date and validates its parameters', async () => {
    const w = await world();
    // A valid time with a non-uuid id: this must be a 400, never a database error.
    const tamperedCursor = Buffer.from(
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', id: 'x' }),
    ).toString('base64url');
    const today = h.clock.now().toISOString().slice(0, 10);
    expect(
      (await call('GET', `/v1/audit?since=${today}`, { token: w.director.token })).body.items
        .length,
    ).toBeGreaterThan(0);
    expect(
      (await call('GET', '/v1/audit?until=2000-01-01', { token: w.director.token })).body.items,
    ).toEqual([]);
    for (const query of [
      '?since=yesterday',
      '?until=2026-13-40',
      '?entity=mission',
      '?entity=mission:nope',
      '?actor=bob',
      '?limit=0',
      '?cursor=garbage',
      `?cursor=${tamperedCursor}`,
    ]) {
      expect(
        (await call('GET', `/v1/audit${query}`, { token: w.director.token })).status,
        query,
      ).toBe(400);
    }
  });

  it("only contains the Director's own organisation", async () => {
    const a = await world();
    const b = await world();
    const skillOfB = (
      await call('POST', '/v1/skills', { token: b.director.token, body: { name: 'Only B' } })
    ).body;
    const seen = await call('GET', '/v1/audit?limit=100', { token: a.director.token });
    expect(seen.body.items.map((e: Json) => e.entityId)).not.toContain(skillOfB.id);
    expect(
      (await call('GET', `/v1/audit?entity=skill:${skillOfB.id}`, { token: a.director.token })).body
        .items,
    ).toEqual([]);
  });

  it('records the Spec 02 actions too, such as failed logins, without credentials', async () => {
    const w = await world();
    const me = await call('GET', '/v1/me', { token: w.ann.token });
    await call('POST', '/v1/auth/login', {
      body: { orgId: w.orgId, email: me.body.user.email, password: 'wrong password!!' },
    });
    const events = (await call('GET', '/v1/audit?limit=100', { token: w.director.token })).body
      .items as Json[];
    const failed = events.find((e) => e.action === 'auth.login_failed');
    expect(failed).toMatchObject({
      entityId: w.ann.id,
      actorId: null,
      after: { reason: 'bad_password' },
    });
    expect(JSON.stringify(events)).not.toContain('wrong password');
  });
});
