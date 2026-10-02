import type { Services } from '@mc/core';
import { AccessTokenService, generateKeyPairPem } from '@mc/core';
import { documentedRoutes } from '@mc/contracts';
import { describe, expect, it } from 'vitest';
import { buildApp, type BuildAppOptions } from './app.js';
import type { TestSupport } from './routes/test-support.js';

const OPERATOR = 'operator-token-for-tests-0123456789abcdef';
const accessTokens = await AccessTokenService.create(await generateKeyPairPem());

const noTestSupport: TestSupport = {
  runScheduler: async () => ({ organisations: [], alertsPurged: 0 }),
  seed: async () => {
    throw new Error('not used');
  },
};

const build = (options: Partial<BuildAppOptions> = {}) =>
  buildApp({
    // None of these routes reaches a service.
    services: {} as Services,
    accessTokens,
    operatorToken: OPERATOR,
    loginRate: { emailMax: 5, ipMax: 20, windowMs: 60_000 },
    ...options,
  });

describe('security headers', () => {
  it('are on every response: success, error and not found', async () => {
    const app = build();
    for (const url of ['/v1/openapi.json', '/v1/me', '/nowhere']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers).toMatchObject({
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'cache-control': 'no-store',
      });
    }
    await app.close();
  });

  it('can switch HSTS off or change its age', async () => {
    const off = build({ hstsMaxAgeSeconds: 0 });
    expect((await off.inject({ url: '/v1/openapi.json' })).headers).not.toHaveProperty(
      'strict-transport-security',
    );
    const short = build({ hstsMaxAgeSeconds: 60 });
    expect((await short.inject({ url: '/v1/openapi.json' })).headers).toMatchObject({
      'strict-transport-security': 'max-age=60; includeSubDomains',
    });
    await Promise.all([off.close(), short.close()]);
  });
});

describe('request size limit', () => {
  it('rejects a body over the limit with a 413 problem', async () => {
    const app = build({ bodyLimit: 1024 });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'x'.repeat(2000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });
    await app.close();
  });

  it('defaults to 1 MiB', async () => {
    const app = build();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'x'.repeat(1_048_576) }),
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});

describe('GET /v1/openapi.json', () => {
  it('is public and serves the OpenAPI 3.1 document', async () => {
    const app = build();
    const response = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Mission Control API' },
    });
    await app.close();
  });

  it('documents exactly the routes the server registers (the test-only ones excepted)', async () => {
    const registered: string[] = [];
    const app = build({
      testSupport: noTestSupport,
      onRoute: ({ method, url }) => {
        if (method === 'HEAD' || method === 'OPTIONS') return;
        if (url.startsWith('/v1/test/')) return;
        registered.push(`${method} ${url.replace(/:(\w+)/g, '{$1}')}`);
      },
    });
    await app.ready();
    expect(registered.sort()).toEqual(documentedRoutes());
    await app.close();
  });
});

describe('the test-only endpoints', () => {
  const endpoints = [
    { url: '/v1/test/scheduler/run', payload: { today: '2000-01-01' } },
    { url: '/v1/test/seed', payload: { scenario: 'demo' } },
  ];

  it('do not exist unless the build is given test support', async () => {
    const app = build();
    for (const { url, payload } of endpoints) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${OPERATOR}` },
      });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it('need the operator credential when present', async () => {
    const app = build({ testSupport: noTestSupport });
    const anonymous = await app.inject({
      method: 'POST',
      url: endpoints[0]!.url,
      payload: endpoints[0]!.payload,
    });
    expect(anonymous.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: endpoints[0]!.url,
      payload: endpoints[0]!.payload,
      headers: { authorization: `Bearer ${OPERATOR}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ organisations: [], alertsPurged: 0 });
    await app.close();
  });

  it('validate their bodies', async () => {
    const app = build({ testSupport: noTestSupport });
    for (const [url, payload] of [
      ['/v1/test/scheduler/run', { today: 'tomorrow' }],
      ['/v1/test/seed', { scenario: 'enormous' }],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${OPERATOR}` },
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });
});
