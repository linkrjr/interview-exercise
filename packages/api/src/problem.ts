import { AppError, ErrorCodes, type FieldError, type ProblemDetails } from '@mc/contracts';
import { STATUS_CODES } from 'node:http';
import type { ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function problemFor(error: AppError): ProblemDetails {
  return {
    type: 'about:blank',
    title: STATUS_CODES[error.status] ?? 'Error',
    status: error.status,
    code: error.code,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

/** Maps Zod issues to RFC 9457 field errors. A custom stable code (e.g. PASSWORD_TOO_SHORT) wins. */
export function validationError(error: ZodError, what = 'The request is invalid'): AppError {
  const errors: FieldError[] = error.issues.map((issue) => {
    const params = (issue as { params?: { code?: unknown } }).params;
    const custom = typeof params?.code === 'string' ? params.code : undefined;
    return { field: issue.path.join('.'), code: custom ?? issue.code, message: issue.message };
  });
  const specific = errors.find((e) => e.code in ErrorCodes)?.code;
  return new AppError(specific ?? ErrorCodes.VALIDATION_FAILED, 400, what, { errors });
}

const RESERVED = new Set(['type', 'title', 'status', 'code', 'detail']);

/**
 * The problem body, including the error's extension members (`errors`, and others such as the
 * `missions` blocking an unavailability range). The standard members cannot be overridden.
 */
export function problemBody(error: AppError): ProblemDetails {
  const extension = Object.fromEntries(
    Object.entries((error.extra ?? {}) as Record<string, unknown>).filter(
      ([key]) => !RESERVED.has(key),
    ),
  );
  return { ...extension, ...problemFor(error) } as ProblemDetails;
}
