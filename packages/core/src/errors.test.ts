import { describe, expect, it } from 'vitest';
import {
  forbidden,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
  unauthenticated,
} from './errors.js';

describe('error helpers', () => {
  it('build the standard problems', () => {
    expect(notFound('User')).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      detail: 'User not found',
    });
    expect(forbidden()).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(unauthenticated()).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
    expect(unauthenticated('nope').detail).toBe('nope');
  });

  it('recognises Postgres violations, including ones wrapped by Drizzle', () => {
    const pg = { code: '23505', constraint: 'users_email_key' };
    expect(isUniqueViolation(pg)).toBe(true);
    expect(isUniqueViolation(pg, 'users_email_key')).toBe(true);
    expect(isUniqueViolation(pg, 'other_key')).toBe(false);
    expect(isUniqueViolation({ cause: pg }, 'users_email_key')).toBe(true);
    expect(isUniqueViolation({ cause: { cause: pg } })).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: '23503' } })).toBe(true);
    expect(isForeignKeyViolation(pg)).toBe(false);
  });

  it('is false for anything else', () => {
    for (const value of [null, undefined, 'x', 42, new Error('x'), {}]) {
      expect(isUniqueViolation(value)).toBe(false);
    }
  });
});
