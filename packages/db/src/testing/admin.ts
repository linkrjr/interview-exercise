import { Pool } from 'pg';

/**
 * A superuser connection that bypasses row-level security, for test fixtures only. It lives in
 * this package so other packages' tests never import `pg` themselves.
 */
export interface AdminDb {
  query: Pool['query'];
  end(): Promise<void>;
}

export function openAdminDb(migratorUrl: string): AdminDb {
  const pool = new Pool({ connectionString: migratorUrl, max: 2 });
  return {
    query: pool.query.bind(pool) as Pool['query'],
    end: () => pool.end(),
  };
}
