import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@mc/contracts';
import type { CliDeps } from './io.js';
import { usageError } from './errors.js';

export interface PasswordOptions {
  /** Read the password from standard input instead of prompting. */
  passwordStdin?: boolean;
  /** Ask twice and require a match (new passwords). */
  confirm?: boolean;
}

/**
 * Where a password comes from, in order: `--password-stdin`, the `MC_PASSWORD` environment
 * variable, an interactive hidden prompt. There is deliberately no `--password` flag, so secrets
 * never appear in the process list or shell history.
 */
export async function readPassword(deps: CliDeps, options: PasswordOptions): Promise<string> {
  if (options.passwordStdin) return (await deps.readStdin()).replace(/\r?\n$/, '');
  if (deps.env.MC_PASSWORD) return deps.env.MC_PASSWORD;
  if (!deps.interactive) {
    throw usageError('No password available: set MC_PASSWORD or use --password-stdin');
  }
  const password = await deps.prompts.password('Password:');
  if (options.confirm) {
    const again = await deps.prompts.password('Confirm password:');
    if (again !== password) throw usageError('The passwords do not match');
  }
  return password;
}

/** Same length rule the server enforces, checked early so the user gets quick feedback. */
export function checkNewPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw usageError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw usageError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}

/** A value from a flag, or an interactive prompt when allowed. */
export async function valueOrPrompt(
  deps: CliDeps,
  value: string | undefined,
  flag: string,
  message: string,
): Promise<string> {
  if (value) return value;
  if (!deps.interactive) throw usageError(`Missing ${flag}`);
  const answer = (await deps.prompts.input(message)).trim();
  if (!answer) throw usageError(`Missing ${flag}`);
  return answer;
}
