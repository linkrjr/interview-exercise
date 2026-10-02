import { createHarness, uniqueEmail, TEST_PASSWORD, type Harness } from '@mc/core/testing';
import { newId } from '@mc/db';
import { openAdminDb, type AdminDb } from '@mc/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from './app.js';

const urls = inject('dbUrls');
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';

let h: Harness;
let app: ReturnType<typeof buildApp>;
let admin: AdminDb;

beforeAll(async () => {
  h = await createHarness(urls);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as Json };
}

/** An organisation with a Director, a Lead and a Crew Member, over real HTTP. */
async function world() {
  const created = await call('POST', '/v1/platform/organisations', OPERATOR, {
    name: 'Alert Org',
    directorEmail: uniqueEmail('d'),
  });
  const accept = async (code: string) =>
    (
      await call('POST', '/v1/auth/accept-invite', undefined, {
        code,
        name: 'Someone',
        password: TEST_PASSWORD,
      })
    ).body;
  const director = await accept(created.body.invite.inviteCode);
  const invite = async (role: string) => {
    const r = await call('POST', '/v1/users', director.accessToken, {
      email: uniqueEmail(role),
      role,
    });
    return (await accept(r.body.invite.inviteCode)).accessToken as string;
  };
  return {
    orgId: created.body.organisationId as string,
    director: director.accessToken as string,
    lead: await invite('lead'),
    crew: await invite('crew'),
  };
}

const insertAlert = (
  orgId: string,
  occurredAt: string,
  details: unknown = { stage: 'transitions' },
) =>
  admin.query(
    `INSERT INTO alerts (id, org_id, source, code, message, details, occurred_at)
     VALUES ($1, $2, 'scheduler', 'SCHEDULER_RUN_FAILED', 'It failed', $3, $4)`,
    [newId(), orgId, JSON.stringify(details), occurredAt],
  );

describe('GET /v1/alerts', () => {
  it('needs a signed-in user, and the operator credential is not one', async () => {
    expect((await call('GET', '/v1/alerts')).status).toBe(401);
    expect((await call('GET', '/v1/alerts', OPERATOR)).status).toBe(401);
  });

  it('is for Directors only', async () => {
    const w = await world();
    for (const token of [w.lead, w.crew]) {
      const res = await call('GET', '/v1/alerts', token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    expect((await call('GET', '/v1/alerts', w.director)).status).toBe(200);
  });

  it('lists the organisation’s alerts newest first, with their details', async () => {
    const w = await world();
    await insertAlert(w.orgId, '2026-09-01T10:00:00Z', {
      stage: 'time_zone',
      timeZone: 'Bad/Zone',
    });
    await insertAlert(w.orgId, '2026-09-03T10:00:00Z');
    const res = await call('GET', '/v1/alerts', w.director);
    expect(res.body.items.map((a: Json) => a.occurredAt)).toEqual([
      '2026-09-03T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ]);
    expect(res.body.items[1]).toEqual({
      id: expect.any(String),
      source: 'scheduler',
      code: 'SCHEDULER_RUN_FAILED',
      message: 'It failed',
      details: { stage: 'time_zone', timeZone: 'Bad/Zone' },
      occurredAt: '2026-09-01T10:00:00.000Z',
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it('filters by time: a bare date is the start of that UTC day, since is inclusive', async () => {
    const w = await world();
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      await insertAlert(w.orgId, `${day}T12:00:00Z`);
    }
    const times = async (query: string) =>
      ((await call('GET', `/v1/alerts${query}`, w.director)).body.items as Json[]).map((a) =>
        a.occurredAt.slice(0, 10),
      );
    expect(await times('?since=2026-09-02')).toEqual(['2026-09-03', '2026-09-02']);
    expect(await times('?since=2026-09-02T12:00:00Z')).toEqual(['2026-09-03', '2026-09-02']);
    expect(await times('?since=2026-09-02T12:00:01Z')).toEqual(['2026-09-03']);
    expect(await times('?until=2026-09-02')).toEqual(['2026-09-01']);
    expect(await times('?since=2026-09-02&until=2026-09-03')).toEqual(['2026-09-02']);
    expect(await times('?since=2030-01-01')).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const w = await world();
    for (let i = 1; i <= 5; i++) await insertAlert(w.orgId, `2026-09-0${i}T00:00:00Z`);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(
        'GET',
        `/v1/alerts?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        w.director,
      );
      seen.push(...page.body.items.map((a: Json) => a.occurredAt.slice(0, 10)));
      cursor = page.body.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(['2026-09-05', '2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01']);
  });

  it('shares alerts with no other organisation', async () => {
    const a = await world();
    const b = await world();
    await insertAlert(b.orgId, '2026-09-01T00:00:00Z');
    expect((await call('GET', '/v1/alerts', a.director)).body.items).toEqual([]);
    expect((await call('GET', '/v1/alerts', b.director)).body.items).toHaveLength(1);
  });

  it('rejects bad parameters with a 400, never a database error', async () => {
    const w = await world();
    const tampered = Buffer.from(
      JSON.stringify({ t: '2026-01-01T00:00:00.000Z', id: 'x' }),
    ).toString('base64url');
    for (const query of [
      '?since=yesterday',
      '?until=2026-13-40',
      '?limit=0',
      '?limit=101',
      '?cursor=garbage',
      `?cursor=${tampered}`,
    ]) {
      expect((await call('GET', `/v1/alerts${query}`, w.director)).status, query).toBe(400);
    }
  });
});
