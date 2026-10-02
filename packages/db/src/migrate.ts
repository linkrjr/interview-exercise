import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies pending SQL migrations. Needs a role that can create extensions, roles and tables. */
export async function runMigrations(migratorUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: migratorUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
