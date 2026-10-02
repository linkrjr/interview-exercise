import { SignJWT } from 'jose';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from '@mc/db';
import {
  TEST_PASSWORD,
  createIdentityHarness,
  uniqueEmail,
  type IdentityHarness,
} from '@mc/core/testing';
import { buildApp, loggerOptions } from './app.js';

const urls = inject('dbUrls');
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';

let h: IdentityHarness;
let app: FastifyInstance;
const logLines: string[] = [];

beforeAll(async () => {
  // The same sink receives the Fastify logs and the core services' logs.
  h = await createIdentityHarness(urls, {
    logger: {
      info: (obj, msg) => void logLines.push(JSON.stringify({ ...obj, msg })),
      warn: (obj, msg) => void logLines.push(JSON.stringify({ ...obj, msg })),
    },
  });
  app = buildApp({
    identity: h,
    accessTokens: h.accessTokens,
    operatorToken: OPERATOR,
    // Small limits keep the rate-limit tests short.
    loginRate: { emailMax: 3, ipMax: 6, windowMs: 15 * 60 * 1000 },
    clock: h.clock,
    logger: {
      ...loggerOptions('info'),
      stream: new Writable({
        write(chunk, _enc, cb) {
          logLines.push(String(chunk));
          cb();
        },
      }),
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await h.close();
});

// Response bodies are inspected loosely, field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const call = async (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  options: {
    token?: string;
    body?: unknown;
    ip?: string;
    headers?: Record<string, string | undefined>;
  } = {},
) => {
  const res = await app.inject({
    method,
    url,
    remoteAddress: options.ip ?? '10.0.0.1',
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    body: (res.body ? safeJson(res.body) : undefined) as Json,
  };
};
const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

interface Onboarded {
  orgId: string;
  directorToken: string;
  directorEmail: string;
  directorId: string;
}

let ipCounter = 0;
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function createOrg(name = 'Lunar Research Lab'): Promise<Onboarded> {
  const email = uniqueEmail('director');
  const created = await call('POST', '/v1/platform/organisations', {
    token: OPERATOR,
    body: { name, directorEmail: email },
  });
  expect(created.status).toBe(201);
  const accepted = await call('POST', '/v1/auth/accept-invite', {
    body: { code: created.body.invite.inviteCode, name: 'Director', password: TEST_PASSWORD },
  });
  expect(accepted.status).toBe(200);
  return {
    orgId: created.body.organisationId,
    directorToken: accepted.body.accessToken,
    directorEmail: email,
    directorId: created.body.directorUserId,
  };
}

async function onboard(org: Onboarded, role: 'director' | 'lead' | 'crew') {
  const email = uniqueEmail(role);
  const invited = await call('POST', '/v1/users', {
    token: org.directorToken,
    body: { email, role },
  });
  expect(invited.status).toBe(201);
  const accepted = await call('POST', '/v1/auth/accept-invite', {
    body: { code: invited.body.invite.inviteCode, name: `${role} person`, password: TEST_PASSWORD },
  });
  return {
    id: invited.body.user.id as string,
    email,
    token: accepted.body.accessToken as string,
    refreshToken: accepted.body.refreshToken as string,
  };
}

describe('problem responses', () => {
  it('answers unknown routes with a 404 problem', async () => {
    const res = await call('GET', '/v1/nothing');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('answers malformed JSON with INVALID_JSON and wrong media types with 415', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'INVALID_JSON', status: 400 });
    const media = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/xml' },
      payload: 'x',
    });
    expect(media.statusCode).toBe(415);
    expect(media.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('lists field errors for invalid bodies', async () => {
    const res = await call('POST', '/v1/auth/login', {
      body: { orgId: 'nope', email: 'x', password: '' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors.map((e: Json) => e.field).sort()).toEqual([
      'email',
      'orgId',
      'password',
    ]);
  });

  it('turns unexpected failures into a generic 500 that leaks nothing', async () => {
    const broken = buildApp({
      identity: {
        ...h,
        auth: {
          refresh: async () => {
            throw new Error('database password is hunter2');
          },
        } as never,
      },
      accessTokens: h.accessTokens,
      operatorToken: OPERATOR,
      loginRate: { emailMax: 3, ipMax: 6, windowMs: 1000 },
    });
    const res = await broken.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'x' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred',
    });
    expect(res.body).not.toContain('hunter2');
    await broken.close();
  });
});

describe('operator endpoints', () => {
  const body = () => ({ name: 'Operator Org', directorEmail: uniqueEmail('op') });

  it('reject a missing, wrong or malformed credential', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer wrong' },
      { authorization: OPERATOR },
      { authorization: `Basic ${OPERATOR}` },
      { authorization: `Bearer ${OPERATOR} extra` },
    ]) {
      const res = await call('POST', '/v1/platform/organisations', { body: body(), headers });
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it("reject user access tokens, even a Director's", async () => {
    const org = await createOrg();
    const res = await call('POST', '/v1/platform/organisations', {
      token: org.directorToken,
      body: body(),
    });
    expect(res.status).toBe(401);
  });

  it('are rejected on every user route when presented with the operator token', async () => {
    const routes: Array<['GET' | 'POST' | 'PATCH', string]> = [
      ['GET', '/v1/me'],
      ['GET', '/v1/users'],
      ['POST', '/v1/users'],
      ['PATCH', `/v1/users/${newId()}`],
      ['POST', `/v1/users/${newId()}/invites`],
    ];
    for (const [method, url] of routes) {
      const res = await call(method, url, { token: OPERATOR, body: {} });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
  });

  it('create an organisation and its first Director', async () => {
    const res = await call('POST', '/v1/platform/organisations', { token: OPERATOR, body: body() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      organisationId: expect.any(String),
      directorUserId: expect.any(String),
      invite: {
        inviteCode: expect.stringContaining(`${res.body.organisationId}.`),
        expiresAt: expect.any(String),
      },
    });
  });

  it('validate input and report a taken email', async () => {
    const invalid = await call('POST', '/v1/platform/organisations', {
      token: OPERATOR,
      body: { name: '', directorEmail: 'nope' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e: Json) => e.field).sort()).toEqual(['directorEmail', 'name']);
    const org = await createOrg();
    const taken = await call('POST', '/v1/platform/organisations', {
      token: OPERATOR,
      body: { name: 'X', directorEmail: org.directorEmail },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('re-issue an invite for a user of the organisation', async () => {
    const created = await call('POST', '/v1/platform/organisations', {
      token: OPERATOR,
      body: body(),
    });
    const fresh = await call(
      'POST',
      `/v1/platform/organisations/${created.body.organisationId}/invites`,
      {
        token: OPERATOR,
        body: { userId: created.body.directorUserId },
      },
    );
    expect(fresh.status).toBe(201);
    expect(fresh.body.invite.inviteCode).not.toBe(created.body.invite.inviteCode);
    const old = await call('POST', '/v1/auth/accept-invite', {
      body: { code: created.body.invite.inviteCode, name: 'X', password: TEST_PASSWORD },
    });
    expect(old.status).toBe(400);
    expect(old.body.code).toBe('INVALID_INVITE');
  });

  it('answer 404 for unknown organisations, foreign users and malformed ids', async () => {
    const a = await createOrg();
    const b = await createOrg();
    const cases = [
      [`/v1/platform/organisations/${a.orgId}/invites`, { userId: b.directorId }],
      [`/v1/platform/organisations/${newId()}/invites`, { userId: a.directorId }],
      [`/v1/platform/organisations/not-a-uuid/invites`, { userId: a.directorId }],
    ] as const;
    for (const [url, payload] of cases) {
      const res = await call('POST', url, { token: OPERATOR, body: payload });
      expect(res.status, url).toBe(404);
    }
    const invalid = await call('POST', `/v1/platform/organisations/${a.orgId}/invites`, {
      token: OPERATOR,
      body: {},
    });
    expect(invalid.status).toBe(400);
  });
});

describe('WWW-Authenticate', () => {
  it('is a Bearer challenge only on responses that ask for credentials', async () => {
    const org = await createOrg();
    // Successful calls carry none.
    const ok = await call('GET', '/v1/me', { token: org.directorToken });
    expect(ok.status).toBe(200);
    expect(ok.headers['www-authenticate']).toBeUndefined();
    const created = await call('POST', '/v1/platform/organisations', {
      token: OPERATOR,
      body: { name: 'X', directorEmail: uniqueEmail('w') },
    });
    expect(created.status).toBe(201);
    expect(created.headers['www-authenticate']).toBeUndefined();

    // A missing or bad credential is challenged.
    expect((await call('GET', '/v1/me')).headers['www-authenticate']).toBe('Bearer');
    expect(
      (await call('POST', '/v1/platform/organisations', { body: {} })).headers['www-authenticate'],
    ).toBe('Bearer');

    // Other 401s are not Bearer challenges.
    const login = await call('POST', '/v1/auth/login', {
      ip: freshIp(),
      body: { orgId: org.orgId, email: org.directorEmail, password: 'wrong password!!' },
    });
    expect(login.status).toBe(401);
    expect(login.headers['www-authenticate']).toBeUndefined();
    const refresh = await call('POST', '/v1/auth/refresh', { body: { refreshToken: 'garbage' } });
    expect(refresh.status).toBe(401);
    expect(refresh.headers['www-authenticate']).toBeUndefined();
  });
});

describe('authentication', () => {
  it('requires a valid bearer access token on user routes', async () => {
    const org = await createOrg();
    const stale = org.directorToken;
    const forged = await new SignJWT({ org: org.orgId, role: 'director' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(org.directorId)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    for (const token of [undefined, 'garbage', forged]) {
      const res = await call('GET', '/v1/me', { token });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await call('GET', '/v1/me', { token: stale })).status).toBe(200);
  });

  it('rejects an expired access token', async () => {
    const org = await createOrg();
    h.clock.advance(15 * 60 * 1000 + 1000);
    const res = await call('GET', '/v1/me', { token: org.directorToken });
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('The access token has expired');
  });

  it('signs in, refreshes, rotates and logs out', async () => {
    const org = await createOrg();
    const login = await call('POST', '/v1/auth/login', {
      ip: freshIp(),
      body: { orgId: org.orgId, email: org.directorEmail, password: TEST_PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ orgId: org.orgId, role: 'director', expiresIn: 900 });
    const me = await call('GET', '/v1/me', { token: login.body.accessToken });
    expect(me.body).toMatchObject({
      user: { email: org.directorEmail, role: 'director' },
      org: { id: org.orgId },
    });

    const refreshed = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: login.body.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const reused = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: login.body.refreshToken },
    });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('REFRESH_TOKEN_REUSED');
    const revoked = await call('POST', '/v1/auth/refresh', {
      body: { refreshToken: refreshed.body.refreshToken },
    });
    expect(revoked.status).toBe(401);

    const again = await call('POST', '/v1/auth/login', {
      ip: freshIp(),
      body: { orgId: org.orgId, email: org.directorEmail, password: TEST_PASSWORD },
    });
    const logout = await call('POST', '/v1/auth/logout', {
      body: { refreshToken: again.body.refreshToken },
    });
    expect(logout.status).toBe(204);
    expect(logout.body).toBeUndefined();
    expect(
      (await call('POST', '/v1/auth/refresh', { body: { refreshToken: again.body.refreshToken } }))
        .status,
    ).toBe(401);
  });

  it('answers every login failure identically', async () => {
    const org = await createOrg();
    const attempts = [
      { orgId: org.orgId, email: org.directorEmail, password: 'wrong password!!' },
      { orgId: org.orgId, email: uniqueEmail('ghost'), password: TEST_PASSWORD },
      { orgId: newId(), email: org.directorEmail, password: TEST_PASSWORD },
    ];
    const results = [];
    for (const body of attempts)
      results.push(await call('POST', '/v1/auth/login', { body, ip: freshIp() }));
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(results[0]!.body);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('enforces the password length on accept-invite with a stable code', async () => {
    const org = await createOrg();
    const invited = await call('POST', '/v1/users', {
      token: org.directorToken,
      body: { email: uniqueEmail('pw'), role: 'lead' },
    });
    const short = await call('POST', '/v1/auth/accept-invite', {
      body: {
        code: invited.body.invite.inviteCode,
        name: 'Pat',
        password: 'only 11 chrs'.slice(0, 11),
      },
    });
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('PASSWORD_TOO_SHORT');
    const twelve = await call('POST', '/v1/auth/accept-invite', {
      body: { code: invited.body.invite.inviteCode, name: 'Pat', password: '123456789012' },
    });
    expect(twelve.status).toBe(200);
    const long = await call('POST', '/v1/auth/accept-invite', {
      body: { code: invited.body.invite.inviteCode, name: 'Pat', password: 'x'.repeat(129) },
    });
    expect(long.status).toBe(400);
  });
});

describe('login rate limiting', () => {
  const attempt = (orgId: string, email: string, ip: string, password = 'definitely wrong') =>
    call('POST', '/v1/auth/login', { ip, body: { orgId, email, password } });

  it('blocks the 4th attempt for one email, from any address, with Retry-After', async () => {
    const org = await createOrg();
    for (let i = 0; i < 3; i++)
      expect((await attempt(org.orgId, org.directorEmail, freshIp())).status).toBe(401);
    const blocked = await attempt(
      org.orgId,
      org.directorEmail.toUpperCase(),
      freshIp(),
      TEST_PASSWORD,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right password is refused while blocked.
    expect(blocked.body.accessToken).toBeUndefined();
  });

  it('blocks one address after 6 attempts across different emails', async () => {
    const org = await createOrg();
    const ip = freshIp();
    for (let i = 0; i < 6; i++)
      expect((await attempt(org.orgId, uniqueEmail('spray'), ip)).status).toBe(401);
    expect((await attempt(org.orgId, uniqueEmail('spray'), ip)).status).toBe(429);
    expect((await attempt(org.orgId, uniqueEmail('spray'), freshIp())).status).toBe(401);
  });

  it('forgets after the window, and does not count invalid requests', async () => {
    const org = await createOrg();
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await call('POST', '/v1/auth/login', {
            ip,
            body: { orgId: 'bad', email: org.directorEmail, password: 'x' },
          })
        ).status,
      ).toBe(400);
    }
    for (let i = 0; i < 3; i++) await attempt(org.orgId, org.directorEmail, ip);
    expect((await attempt(org.orgId, org.directorEmail, ip)).status).toBe(429);
    h.clock.advance(15 * 60 * 1000 + 1000);
    expect((await attempt(org.orgId, org.directorEmail, ip, TEST_PASSWORD)).status).toBe(200);
  });

  it('does not limit refresh or accept-invite', async () => {
    const org = await createOrg();
    const login = await attempt(org.orgId, org.directorEmail, freshIp(), TEST_PASSWORD);
    let token = login.body.refreshToken as string;
    for (let i = 0; i < 10; i++) {
      const res = await call('POST', '/v1/auth/refresh', {
        ip: '10.9.9.9',
        body: { refreshToken: token },
      });
      expect(res.status).toBe(200);
      token = res.body.refreshToken;
    }
  });
});

describe('users', () => {
  it('runs the onboarding chain: Director invites a Lead and a Crew Member, who accept and sign in', async () => {
    const org = await createOrg();
    const lead = await onboard(org, 'lead');
    const crew = await onboard(org, 'crew');
    expect((await call('GET', '/v1/me', { token: lead.token })).body.user.role).toBe('lead');
    expect((await call('GET', '/v1/me', { token: crew.token })).body.user.role).toBe('crew');
    const list = await call('GET', '/v1/users', { token: org.directorToken });
    expect(list.status).toBe(200);
    expect(list.body.items.map((u: Json) => u.role).sort()).toEqual(['crew', 'director', 'lead']);
    expect(list.body.items.find((u: Json) => u.id === lead.id)).toMatchObject({
      status: 'active',
      name: 'lead person',
    });
  });

  it('shows an invited user without a name', async () => {
    const org = await createOrg();
    const invited = await call('POST', '/v1/users', {
      token: org.directorToken,
      body: { email: uniqueEmail('n'), role: 'crew' },
    });
    expect(invited.body.user).toMatchObject({ status: 'invited', name: null, role: 'crew' });
    expect(invited.body.invite.inviteCode).toEqual(expect.any(String));
  });

  it('paginates with cursors and validates paging parameters', async () => {
    const org = await createOrg();
    for (let i = 0; i < 3; i++)
      await call('POST', '/v1/users', {
        token: org.directorToken,
        body: { email: uniqueEmail(`p${i}`), role: 'crew' },
      });
    const first = await call('GET', '/v1/users?limit=2', { token: org.directorToken });
    expect(first.body.items).toHaveLength(2);
    const second = await call('GET', `/v1/users?limit=2&cursor=${first.body.nextCursor}`, {
      token: org.directorToken,
    });
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    for (const query of ['limit=0', 'limit=101', 'limit=abc']) {
      expect(
        (await call('GET', `/v1/users?${query}`, { token: org.directorToken })).status,
        query,
      ).toBe(400);
    }
    const badCursor = await call('GET', '/v1/users?cursor=garbage', { token: org.directorToken });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe('INVALID_CURSOR');
  });

  it('forbids Leads and Crew from managing users', async () => {
    const org = await createOrg();
    const lead = await onboard(org, 'lead');
    const crew = await onboard(org, 'crew');
    for (const who of [lead, crew]) {
      const calls = [
        call('GET', '/v1/users', { token: who.token }),
        call('POST', '/v1/users', {
          token: who.token,
          body: { email: uniqueEmail('x'), role: 'crew' },
        }),
        call('PATCH', `/v1/users/${org.directorId}`, { token: who.token, body: { role: 'lead' } }),
        call('POST', `/v1/users/${org.directorId}/invites`, { token: who.token }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
    }
  });

  it('changes roles and deactivates, with the documented rejections', async () => {
    const org = await createOrg();
    const lead = await onboard(org, 'lead');
    const crew = await onboard(org, 'crew');
    const promoted = await call('PATCH', `/v1/users/${lead.id}`, {
      token: org.directorToken,
      body: { role: 'director' },
    });
    expect(promoted.body.role).toBe('director');
    expect(
      (await call('POST', '/v1/auth/refresh', { body: { refreshToken: lead.refreshToken } }))
        .status,
    ).toBe(401);

    const toCrew = await call('PATCH', `/v1/users/${lead.id}`, {
      token: org.directorToken,
      body: { role: 'crew' },
    });
    expect(toCrew.status).toBe(409);
    expect(toCrew.body.code).toBe('ROLE_CHANGE_TO_CREW_NOT_ALLOWED');

    const deactivated = await call('PATCH', `/v1/users/${crew.id}`, {
      token: org.directorToken,
      body: { status: 'deactivated' },
    });
    expect(deactivated.body.status).toBe('deactivated');
    expect(
      (await call('POST', '/v1/auth/refresh', { body: { refreshToken: crew.refreshToken } }))
        .status,
    ).toBe(401);

    for (const body of [{}, { status: 'active' }, { role: 'boss' }]) {
      expect(
        (await call('PATCH', `/v1/users/${lead.id}`, { token: org.directorToken, body })).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it('protects the last active Director', async () => {
    const org = await createOrg();
    const res = await call('PATCH', `/v1/users/${org.directorId}`, {
      token: org.directorToken,
      body: { status: 'deactivated' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ACTIVE_DIRECTOR');
  });

  it('re-issues invites only for users who have not accepted', async () => {
    const org = await createOrg();
    const invited = await call('POST', '/v1/users', {
      token: org.directorToken,
      body: { email: uniqueEmail('r'), role: 'lead' },
    });
    const fresh = await call('POST', `/v1/users/${invited.body.user.id}/invites`, {
      token: org.directorToken,
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.inviteCode).not.toBe(invited.body.invite.inviteCode);
    const active = await call('POST', `/v1/users/${org.directorId}/invites`, {
      token: org.directorToken,
    });
    expect(active.status).toBe(409);
    expect(active.body.code).toBe('USER_NOT_INVITED');
  });

  it("answers 404 for another organisation's users on every id endpoint, and for malformed ids", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const victim = await onboard(b, 'lead');
    const calls = [
      call('PATCH', `/v1/users/${victim.id}`, {
        token: a.directorToken,
        body: { status: 'deactivated' },
      }),
      call('PATCH', `/v1/users/${victim.id}`, {
        token: a.directorToken,
        body: { role: 'director' },
      }),
      call('POST', `/v1/users/${victim.id}/invites`, { token: a.directorToken }),
      call('PATCH', `/v1/users/${newId()}`, { token: a.directorToken, body: { role: 'lead' } }),
      call('PATCH', '/v1/users/not-a-uuid', { token: a.directorToken, body: { role: 'lead' } }),
      call('POST', '/v1/users/not-a-uuid/invites', { token: a.directorToken }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const list = await call('GET', '/v1/users', { token: a.directorToken });
    expect(list.body.items.map((u: Json) => u.id)).not.toContain(victim.id);
    expect(
      (await call('GET', '/v1/users', { token: b.directorToken })).body.items.find(
        (u: Json) => u.id === victim.id,
      ).status,
    ).toBe('active');
  });

  it('keeps emails unique platform-wide', async () => {
    const a = await createOrg();
    const b = await createOrg();
    const res = await call('POST', '/v1/users', {
      token: a.directorToken,
      body: { email: b.directorEmail.toUpperCase(), role: 'crew' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});

describe('logging', () => {
  it('never writes credentials or email addresses to the logs', async () => {
    const org = await createOrg();
    await call('POST', '/v1/auth/login', {
      ip: freshIp(),
      body: { orgId: org.orgId, email: org.directorEmail, password: 'not the password' },
    });
    await call('GET', '/v1/me', { token: org.directorToken });
    const logs = logLines.join('');
    expect(logs).toContain('login failed');
    expect(logs).not.toContain(org.directorToken);
    expect(logs).not.toContain(org.directorEmail);
    expect(logs).not.toContain('not the password');
    expect(logs).not.toContain(OPERATOR);
  });
});
