import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { seedTenant, type SeededTenant } from './testing/index.js';
import { definedTables } from './testing/schema.js';
import { failure, rolledBack } from './testing/sql.js';

const urls = inject('dbUrls');
const superuser = new Pool({ connectionString: urls.migrator, max: 2 });
const tenant = new Pool({ connectionString: urls.tenant, max: 2 });

let a: SeededTenant;
let b: SeededTenant;
let tenantTables: string[];

beforeAll(async () => {
  a = await seedTenant(superuser, 'a');
  b = await seedTenant(superuser, 'b');
  const { rows } = await superuser.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'org_id' ORDER BY table_name`,
  );
  tenantTables = rows.map((r) => r.table_name);
});

afterAll(async () => {
  await Promise.all([superuser.end(), tenant.end()]);
});

describe('tenant table inventory', () => {
  it('covers every tenant table defined in the Drizzle schema', () => {
    const defined = definedTables()
      .filter((t) => t.columns.some((c) => c.name === 'org_id'))
      .map((t) => t.name)
      .sort();
    expect(tenantTables).toEqual(defined);
    expect(tenantTables).toHaveLength(16);
  });
});

describe('row-level security is enabled, forced and has the tenant policy', () => {
  it('on every table with an org_id column and on organisations', async () => {
    const { rows } = await superuser.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string[] | null;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    const names = rows.map((r) => r.relname);
    expect(names).toEqual([...tenantTables, 'organisations'].sort());
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} RLS forced`).toBe(true);
      expect(row.policies, `${row.relname} policies`).toContain('tenant_isolation');
    }
  });
});

describe('reads', () => {
  it('return zero rows from every tenant table when app.org_id is unset', async () => {
    for (const table of [...tenantTables, 'organisations']) {
      const { rows } = await tenant.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('return only the current tenant rows from every tenant table', async () => {
    for (const table of tenantTables) {
      const expected = await superuser.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
        [a.orgId],
      );
      expect(expected.rows[0].n).toBeGreaterThan(0);
      const visible = await rolledBack(tenant, a.orgId, (c) =>
        c.query(`SELECT org_id FROM ${table}`),
      );
      expect(visible.rows.length, table).toBe(expected.rows[0].n);
      expect(new Set(visible.rows.map((r) => r.org_id)), table).toEqual(new Set([a.orgId]));
    }
  });

  it('return zero rows when another tenant is selected by an unknown id', async () => {
    const unknown = '00000000-0000-7000-8000-000000000000';
    for (const table of [...tenantTables, 'organisations']) {
      const { rows } = await rolledBack(tenant, unknown, (c) =>
        c.query(`SELECT count(*)::int AS n FROM ${table}`),
      );
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('show a tenant only its own organisation row', async () => {
    const { rows } = await rolledBack(tenant, a.orgId, (c) =>
      c.query('SELECT id FROM organisations'),
    );
    expect(rows).toEqual([{ id: a.orgId }]);
  });
});

describe('writes', () => {
  it('reject a row for another tenant on every writable tenant table (WITH CHECK)', async () => {
    let attempted = 0;
    for (const table of tenantTables) {
      const privilege = await superuser.query(
        "SELECT has_table_privilege('app_tenant', $1, 'INSERT') AS ok",
        [table],
      );
      if (!privilege.rows[0].ok) continue;
      const { rows } = await superuser.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id = $1 LIMIT 1`,
        [a.orgId],
      );
      const error = await failure(
        rolledBack(tenant, b.orgId, (c) =>
          c.query(
            `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
            [rows[0].row],
          ),
        ),
      );
      expect(error.code, table).toBe('42501');
      expect(error.message, table).toContain('row-level security');
      attempted++;
    }
    expect(attempted).toBeGreaterThanOrEqual(14);
  });

  it('do not let one tenant update or delete another tenant rows', async () => {
    const update = await rolledBack(tenant, b.orgId, (c) =>
      c.query("UPDATE skills SET name = 'hijacked' WHERE org_id = $1", [a.orgId]),
    );
    expect(update.rowCount).toBe(0);
    const del = await rolledBack(tenant, b.orgId, (c) =>
      c.query('DELETE FROM requirements WHERE org_id = $1', [a.orgId]),
    );
    expect(del.rowCount).toBe(0);
  });

  it('allow a tenant to write its own rows', async () => {
    const result = await rolledBack(tenant, a.orgId, (c) =>
      c.query("UPDATE skills SET name = 'Surgery' WHERE id = $1", [a.skillId]),
    );
    expect(result.rowCount).toBe(1);
  });
});
