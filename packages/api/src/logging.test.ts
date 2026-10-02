import type { Services } from '@mc/core';
import { AccessTokenService, generateKeyPairPem } from '@mc/core';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildApp, loggerOptions, safeError } from './app.js';

const accessTokens = await AccessTokenService.create(await generateKeyPairPem());

/** An error shaped like the driver's: the message and `detail` quote the row and its parameters. */
function driverError() {
  return Object.assign(
    new Error(
      'Failed query: insert into users (email) values ($1) params: secret.person@example.com',
    ),
    {
      name: 'DrizzleQueryError',
      detail: 'Key (email)=(secret.person@example.com) already exists.',
      cause: { code: '23505' },
    },
  );
}

describe('logs', () => {
  it('never carry the email, password or token of a failed request', async () => {
    const lines: string[] = [];
    const app = buildApp({
      services: {
        auth: {
          login: async () => {
            throw driverError();
          },
        },
      } as unknown as Services,
      accessTokens,
      operatorToken: 'operator-token-for-tests-0123456789abcdef',
      loginRate: { emailMax: 5, ipMax: 20, windowMs: 60_000 },
      logger: {
        ...loggerOptions('trace'),
        stream: new Writable({
          write(chunk, _enc, cb) {
            lines.push(String(chunk));
            cb();
          },
        }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { authorization: 'Bearer top-secret-token' },
      payload: {
        orgId: '0199a3e0-0000-7000-8000-000000000000',
        email: 'secret.person@example.com',
        password: 'a very secret password',
      },
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret.person');
    const logged = lines.join('');
    expect(logged).toContain('unhandled error');
    expect(logged).toContain('DrizzleQueryError');
    expect(logged).toContain('23505');
    expect(logged).not.toContain('secret.person');
    expect(logged).not.toContain('a very secret password');
    expect(logged).not.toContain('top-secret-token');
  });
});

describe('safeError', () => {
  it('keeps the name, the driver code and the stack frames, but not the message', () => {
    const summary = safeError(driverError());
    expect(summary).toMatchObject({ name: 'DrizzleQueryError', code: '23505' });
    expect(summary.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain('secret.person');
  });

  it('copes with things that are not errors', () => {
    expect(safeError('boom')).toEqual({ name: 'string', frames: [] });
    expect(safeError(undefined)).toEqual({ name: 'undefined', frames: [] });
  });
});
