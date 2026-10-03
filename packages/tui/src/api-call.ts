import { CliError } from '@mc/cli';

/**
 * Runs an API call and parses its answer. Failures reach the screens as plain messages: the server's
 * problem text, the connection error, or "unexpected answer" when the body is not what the contract says.
 */
export async function call<T>(
  run: () => Promise<unknown>,
  parse: (body: unknown) => T,
): Promise<T> {
  let body: unknown;
  try {
    body = await run();
  } catch (error) {
    if (error instanceof CliError) throw new Error(error.message);
    throw error;
  }
  const parsed = (() => {
    try {
      return parse(body);
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) throw new Error('The server sent an unexpected answer');
  return parsed;
}
