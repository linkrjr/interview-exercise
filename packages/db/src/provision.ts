import { Pool } from 'pg';

export const APP_ROLES = ['app_tenant', 'app_platform', 'app_scheduler'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export type RolePasswords = Record<AppRole, string>;

/**
 * Gives the application roles (created NOLOGIN by the migrations) a login and a password. Kept
 * out of the migrations so no credentials are stored in version control. Idempotent.
 */
export async function provisionRoles(migratorUrl: string, passwords: RolePasswords): Promise<void> {
  const pool = new Pool({ connectionString: migratorUrl, max: 1 });
  try {
    for (const role of APP_ROLES) {
      const password = passwords[role];
      if (!password) throw new Error(`No password supplied for ${role}`);
      const { rows } = await pool.query<{ statement: string }>(
        "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS statement",
        [role, password],
      );
      await pool.query(rows[0]!.statement);
    }
  } finally {
    await pool.end();
  }
}
