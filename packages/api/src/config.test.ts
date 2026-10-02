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
    });
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
