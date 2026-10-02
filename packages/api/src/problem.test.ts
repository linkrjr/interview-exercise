import { AppError, PasswordSchema } from '@mc/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { problemBody, problemFor, validationError } from './problem.js';

describe('problem details', () => {
  it('builds an RFC 9457 body with the status phrase as title and the stable code', () => {
    expect(problemFor(new AppError('NOT_FOUND', 404, 'User not found'))).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'User not found',
    });
    expect(problemFor(new AppError('X', 409))).not.toHaveProperty('detail');
  });

  it('carries extension members such as the blocking missions, but never lets them override the standard ones', () => {
    const missions = [
      {
        id: 'm1',
        name: 'Artemis',
        startDate: '2026-11-02',
        endDate: '2026-11-20',
        status: 'approved',
      },
    ];
    const body = problemBody(
      new AppError('UNAVAILABILITY_CONFLICTS_WITH_MISSIONS', 409, 'blocked', {
        missions,
        status: 200,
        code: 'HIJACKED',
        title: 'Hijacked',
      }),
    );
    expect(body).toMatchObject({
      status: 409,
      code: 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS',
      title: 'Conflict',
      missions,
    });
  });

  it('maps Zod issues to field errors', () => {
    const result = z
      .object({ email: z.email(), nested: z.object({ n: z.number() }) })
      .safeParse({ email: 'x', nested: { n: 'a' } });
    const error = validationError(result.error!);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    const body = problemBody(error);
    expect(body.errors?.map((e) => e.field)).toEqual(['email', 'nested.n']);
  });

  it('promotes a stable custom code such as PASSWORD_TOO_SHORT to the problem code', () => {
    const result = z.object({ password: PasswordSchema }).safeParse({ password: 'short' });
    const body = problemBody(validationError(result.error!));
    expect(body.code).toBe('PASSWORD_TOO_SHORT');
    expect(body.errors).toEqual([
      {
        field: 'password',
        code: 'PASSWORD_TOO_SHORT',
        message: 'Password must be at least 12 characters',
      },
    ]);
  });
});
