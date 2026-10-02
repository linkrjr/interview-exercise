import { generateKeyPairPem } from '@mc/core';
import {
  createHarness,
  provisionOrganisation,
  TEST_PASSWORD,
  type Harness,
} from '@mc/core/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApplication, type Application } from './bootstrap.js';
import { loadConfig } from './config.js';

const urls = inject('dbUrls');
const OPERATOR = 'operator-token-for-tests-0123456789abcdef';
const keys = await generateKeyPairPem();

const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL_TENANT: urls.tenant,
  DATABASE_URL_PLATFORM: urls.platform,
  DATABASE_URL_SCHEDULER: urls.scheduler,
  PLATFORM_OPERATOR_TOKEN: OPERATOR,
  LOG_LEVEL: 'silent',
  ...extra,
});

let h: Harness;
const running: Application[] = [];
const start = async (extra: Record<string, string> = {}) => {
  const application = await createApplication(loadConfig(env(extra)));
  running.push(application);
  return application;
};

beforeAll(async () => {
  h = await createHarness(urls);
});
afterAll(async () => {
  await Promise.all(running.map((a) => a.close()));
  await h.close();
});

const operatorPost = (app: Application, url: string, payload: object) =>
  app.app.inject({
    method: 'POST',
    url,
    payload,
    headers: { authorization: `Bearer ${OPERATOR}` },
  });

describe('the test-only endpoints', () => {
  it('are not registered in a production build, even for the operator', async () => {
    const production = await start({
      NODE_ENV: 'production',
      JWT_PRIVATE_KEY: keys.privateKeyPem,
      JWT_PUBLIC_KEY: keys.publicKeyPem,
    });
    for (const [url, payload] of [
      ['/v1/test/scheduler/run', { today: '2000-01-01' }],
      ['/v1/test/seed', { scenario: 'demo' }],
    ] as const) {
      const response = await operatorPost(production, url, payload);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
    const doc = (await production.app.inject({ url: '/v1/openapi.json' })).body;
    expect(doc).not.toContain('/v1/test');
  });

  it('are off by default, even outside production', async () => {
    const byDefault = await start();
    expect((await operatorPost(byDefault, '/v1/test/seed', { scenario: 'demo' })).statusCode).toBe(
      404,
    );
  });

  it('are registered in a development build, behind the operator credential, and stay out of OpenAPI', async () => {
    const development = await start({ NODE_ENV: 'development', ENABLE_TEST_ENDPOINTS: 'true' });
    const org = await provisionOrganisation(h);
    const anonymous = await development.app.inject({
      method: 'POST',
      url: '/v1/test/scheduler/run',
      payload: { today: '2000-01-01' },
    });
    expect(anonymous.statusCode).toBe(401);

    // A date long ago: the real pass runs over every organisation but changes nothing.
    const response = await operatorPost(development, '/v1/test/scheduler/run', {
      today: '2000-01-01',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.organisations.every((o: { status: string }) => o.status === 'ok')).toBe(true);
    expect(
      body.organisations.find((o: { organisationId: string }) => o.organisationId === org.orgId),
    ).toMatchObject({ status: 'ok', expired: 0, activated: 0, completed: 0 });

    expect((await development.app.inject({ url: '/v1/openapi.json' })).body).not.toContain(
      '/v1/test',
    );
  });

  it('answer 501 for a scheduler pass when the API has no scheduler login', async () => {
    const application = await createApplication({
      ...loadConfig(env({ NODE_ENV: 'development', ENABLE_TEST_ENDPOINTS: 'true' })),
      schedulerUrl: undefined,
    });
    running.push(application);
    const response = await operatorPost(application, '/v1/test/scheduler/run', {
      today: '2000-01-01',
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'SCHEDULER_NOT_CONFIGURED' });
  });
});

describe('rate limiting the matcher', () => {
  it('allows 30 requests a minute per user by default, then answers 429 with Retry-After', async () => {
    const application = await start();
    const org = await provisionOrganisation(h);
    const login = await application.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { orgId: org.orgId, email: org.director.email, password: TEST_PASSWORD },
    });
    const token = login.json().accessToken as string;
    const match = () =>
      application.app.inject({
        method: 'POST',
        url: '/v1/missions/0199a3e0-0000-7000-8000-000000000000/match',
        payload: {},
        headers: { authorization: `Bearer ${token}` },
      });

    // Not a Lead and not a real mission: every answer is an error, but each request is counted.
    for (let i = 0; i < 30; i++) expect((await match()).statusCode).not.toBe(429);
    const limited = await match();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
});
