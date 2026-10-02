import type { ProblemDetails } from '@mc/contracts';

/** Exit codes (DESIGN.md §14). */
export const ExitCode = {
  OK: 0,
  USAGE: 1,
  AUTH: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  SERVER: 5,
} as const;

/** A failure with the exit code the process should end with. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usageError = (message: string) => new CliError(message, ExitCode.USAGE);

/** Maps an HTTP status to an exit code: 400 → usage, 401/403 → auth, 404, 409/412 → conflict, the rest → server. */
export function exitCodeForStatus(status: number): number {
  if (status === 400 || status === 415 || status === 422) return ExitCode.USAGE;
  if (status === 401 || status === 403) return ExitCode.AUTH;
  if (status === 404) return ExitCode.NOT_FOUND;
  if (status === 409 || status === 412) return ExitCode.CONFLICT;
  return ExitCode.SERVER;
}
