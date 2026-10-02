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

export function problemBody(error: AppError): ProblemDetails {
  const extra = error.extra as { errors?: FieldError[] } | undefined;
  return { ...problemFor(error), ...(extra?.errors ? { errors: extra.errors } : {}) };
}
