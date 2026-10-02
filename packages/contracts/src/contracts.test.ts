import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  FieldErrorSchema,
  MAX_PAGE_LIMIT,
  ProblemDetailsSchema,
  RoleSchema,
  pageSchema,
} from './index.js';

describe('RoleSchema', () => {
  it('accepts exactly the three organisation roles', () => {
    for (const role of ['director', 'lead', 'crew']) expect(RoleSchema.parse(role)).toBe(role);
    expect(RoleSchema.safeParse('operator').success).toBe(false);
  });
});

describe('ProblemDetailsSchema', () => {
  it('accepts a problem with field errors', () => {
    const problem = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [FieldErrorSchema.parse({ field: 'email', code: 'invalid', message: 'bad' })],
    };
    expect(ProblemDetailsSchema.parse(problem)).toEqual(problem);
  });

  it('rejects non-error statuses and missing codes', () => {
    expect(
      ProblemDetailsSchema.safeParse({ type: 't', title: 't', status: 200, code: 'X' }).success,
    ).toBe(false);
    expect(ProblemDetailsSchema.safeParse({ type: 't', title: 't', status: 400 }).success).toBe(
      false,
    );
  });
});

describe('pageSchema', () => {
  it('wraps items with a nullable cursor', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.parse({ items: [{ id: 'a' }], nextCursor: null })).toEqual({
      items: [{ id: 'a' }],
      nextCursor: null,
    });
    expect(schema.safeParse({ items: [{ id: 1 }], nextCursor: null }).success).toBe(false);
    expect(MAX_PAGE_LIMIT).toBe(100);
  });
});

describe('AppError', () => {
  it('carries code, status, detail and extra', () => {
    const err = new AppError('CREW_DOUBLE_BOOKED', 409, 'overlap', { missions: ['m1'] });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AppError');
    expect(err.code).toBe('CREW_DOUBLE_BOOKED');
    expect(err.status).toBe(409);
    expect(err.detail).toBe('overlap');
    expect(err.extra).toEqual({ missions: ['m1'] });
    expect(err.message).toBe('overlap');
  });

  it('falls back to the code as message', () => {
    expect(new AppError('X', 400).message).toBe('X');
  });
});
