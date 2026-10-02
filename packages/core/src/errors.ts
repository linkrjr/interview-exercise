import { AppError, ErrorCodes } from '@mc/contracts';

export const notFound = (what: string): AppError =>
  new AppError(ErrorCodes.NOT_FOUND, 404, `${what} not found`);

export const forbidden = (): AppError =>
  new AppError(ErrorCodes.FORBIDDEN, 403, 'You are not allowed to do this');

export const unauthenticated = (detail = 'Authentication required'): AppError =>
  new AppError(ErrorCodes.UNAUTHENTICATED, 401, detail);

/** True when `error` (possibly wrapped by Drizzle) is a unique violation, optionally on a named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return matchesPgError(error, '23505', constraint);
}

/** True when `error` (possibly wrapped by Drizzle) is a foreign-key violation. */
export function isForeignKeyViolation(error: unknown): boolean {
  return matchesPgError(error, '23503');
}

function matchesPgError(error: unknown, code: string, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === code) return constraint === undefined || e.constraint === constraint;
    current = e.cause;
  }
  return false;
}
