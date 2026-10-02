import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema/index.js';
import type { PlatformTx, SchedulerTx, Tx } from './tx.js';

export interface DbConfig {
  /** Login for `app_tenant`. */
  tenantUrl?: string;
  /** Login for `app_platform`. */
  platformUrl?: string;
  /** Login for `app_scheduler`. */
  schedulerUrl?: string;
  /** Maximum connections per pool. */
  poolMax?: number;
}

export interface Db {
  /** Runs `fn` in one transaction as `app_tenant` with `app.org_id` set via `SET LOCAL`. */
  withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs `fn` in one transaction as `app_platform` (provisioning endpoints only). */
  withPlatform<T>(fn: (tx: PlatformTx) => Promise<T>): Promise<T>;
  /** Runs `fn` in one transaction as `app_scheduler`. */
  withScheduler<T>(fn: (tx: SchedulerTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the three role URLs from `DATABASE_URL_TENANT`, `_PLATFORM` and `_SCHEDULER`. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    tenantUrl: env.DATABASE_URL_TENANT,
    platformUrl: env.DATABASE_URL_PLATFORM,
    schedulerUrl: env.DATABASE_URL_SCHEDULER,
  };
}

async function inTransaction<T>(
  pool: Pool,
  setup: (client: PoolClient) => Promise<void>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let destroy: Error | undefined;
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(drizzle(client, { schema }));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // The connection is in an unknown state: discard it instead of returning it to the pool.
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

/**
 * The only way to reach the database. Raw connections are never exported, and the lint rule in
 * `eslint.config.js` forbids importing `pg` outside this package (DESIGN.md §11, §21).
 */
export function createDb(config: DbConfig): Db {
  const pools = new Map<string, Pool>();

  const pool = (key: string, url: string | undefined): Pool => {
    if (!url) throw new Error(`No database URL configured for ${key}`);
    let existing = pools.get(key);
    if (!existing) {
      existing = new Pool({ connectionString: url, max: config.poolMax ?? 10 });
      // An idle client erroring must not crash the process; the pool discards it.
      existing.on('error', () => undefined);
      pools.set(key, existing);
    }
    return existing;
  };

  return {
    async withTenant(orgId, fn) {
      if (!UUID.test(orgId)) throw new TypeError('withTenant requires a UUID organisation id');
      return inTransaction(
        pool('tenant', config.tenantUrl),
        async (client) => {
          await client.query('SET LOCAL ROLE app_tenant');
          await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
        },
        fn,
      );
    },
    async withPlatform(fn) {
      return inTransaction(
        pool('platform', config.platformUrl),
        async (client) => {
          await client.query('SET LOCAL ROLE app_platform');
        },
        fn,
      );
    },
    async withScheduler(fn) {
      return inTransaction(
        pool('scheduler', config.schedulerUrl),
        async (client) => {
          await client.query('SET LOCAL ROLE app_scheduler');
        },
        fn,
      );
    },
    async close() {
      const open = [...pools.values()];
      pools.clear();
      await Promise.all(open.map((p) => p.end()));
    },
  };
}
