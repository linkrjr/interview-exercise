import { Pool, type PoolClient } from 'pg';

/**
 * Runs `fn` on a connection inside a transaction that is always rolled back, so tests can
 * attempt writes without leaving data behind. When `orgId` is given, `app.org_id` is set the same
 * way `withTenant` does.
 */
export async function rolledBack<T>(
  pool: Pool,
  orgId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (orgId) await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** Resolves with the Postgres error, or fails the test if the statement succeeds. */
export async function failure(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('Expected the statement to fail, but it succeeded');
}
