import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.js';

export type Schema = typeof schema;
type Database = NodePgDatabase<Schema>;

/** Transaction scoped to one tenant by `app.org_id` (role `app_tenant`). */
export type Tx = Database;
/** Transaction for operator provisioning (role `app_platform`: insert-only, no tenant data). */
export type PlatformTx = Database;
/** Transaction for the scheduler (role `app_scheduler`: organisation ids and alerts only). */
export type SchedulerTx = Database;
