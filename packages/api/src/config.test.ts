import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  DATABASE_URL_TENANT: 'postgres://t',
  DATABASE_URL_PLATFORM: 'postgres://p',
  PLATFORM_OPERATOR_TOKEN: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      env: 'development',
      host: '0.0.0.0',
      port: 3000,
      trustProxy: false,
      jwtPrivateKey: undefined,
      loginRate: { emailMax: 5, ipMax: 20, windowMs: 15 * 60 * 1000 },
      // 30 matcher requests a minute per user, a 1 MiB body limit and one year of HSTS (DESIGN.md §18).
      matchRate: { max: 30, windowMs: 60_000 },
      bodyLimitBytes: 1_048_576,
      hstsMaxAgeSeconds: 31_536_000,
      schedulerUrl: undefined,
      testEndpoints: false,
    });
  });

  it('enables the test endpoints only on request, and never in production', () => {
    expect(loadConfig({ ...base, ENABLE_TEST_ENDPOINTS: 'true' }).testEndpoints).toBe(true);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        JWT_PRIVATE_KEY: 'k',
        JWT_PUBLIC_KEY: 'k',
        ENABLE_TEST_ENDPOINTS: 'true',
      }),
    ).toThrow(/ENABLE_TEST_ENDPOINTS/);
  });

  it('reads the hardening settings', () => {
    expect(
      loadConfig({
        ...base,
        MATCH_RATE_MAX: '5',
        MATCH_RATE_WINDOW_SECONDS: '10',
        BODY_LIMIT_BYTES: '2048',
        HSTS_MAX_AGE_SECONDS: '0',
        DATABASE_URL_SCHEDULER: 'postgres://s',
      }),
    ).toMatchObject({
      matchRate: { max: 5, windowMs: 10_000 },
      bodyLimitBytes: 2048,
      hstsMaxAgeSeconds: 0,
      schedulerUrl: 'postgres://s',
    });
  });

  it('refuses a rate limit or body limit that would disable the protection', () => {
    expect(() => loadConfig({ ...base, MATCH_RATE_MAX: '0' })).toThrow(/MATCH_RATE_MAX/);
    expect(() => loadConfig({ ...base, BODY_LIMIT_BYTES: '10' })).toThrow(/BODY_LIMIT_BYTES/);
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...base,
      PORT: '8080',
      TRUST_PROXY: 'true',
      LOGIN_RATE_EMAIL_MAX: '2',
      LOGIN_RATE_IP_MAX: '7',
      LOGIN_RATE_WINDOW_SECONDS: '60',
    });
    expect(config).toMatchObject({
      port: 8080,
      trustProxy: true,
      loginRate: { emailMax: 2, ipMax: 7, windowMs: 60_000 },
    });
  });

  it('reports every problem at once and never echoes secrets', () => {
    let message = '';
    try {
      loadConfig({ PLATFORM_OPERATOR_TOKEN: 'short-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL_TENANT');
    expect(message).toContain('DATABASE_URL_PLATFORM');
    expect(message).toContain('PLATFORM_OPERATOR_TOKEN');
    expect(message).not.toContain('short-secret-value');
  });

  it('requires the JWT keys together, and in production', () => {
    expect(() => loadConfig({ ...base, JWT_PRIVATE_KEY: 'k' })).toThrow(/set together/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/required in production/);
    expect(
      loadConfig({ ...base, JWT_PRIVATE_KEY: 'a\\nb', JWT_PUBLIC_KEY: 'c\\nd' }),
    ).toMatchObject({
      jwtPrivateKey: 'a\nb',
      jwtPublicKey: 'c\nd',
    });
  });

  it('rejects an invalid environment name or port', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging' })).toThrow();
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow();
  });
});
