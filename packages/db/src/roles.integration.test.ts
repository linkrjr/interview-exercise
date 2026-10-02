import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from './ids.js';
import { seedTenant, type SeededTenant } from './testing/index.js';
import { failure, rolledBack } from './testing/sql.js';

const urls = inject('dbUrls');
const superuser = new Pool({ connectionString: urls.migrator, max: 2 });
const tenant = new Pool({ connectionString: urls.tenant, max: 2 });
const platform = new Pool({ connectionString: urls.platform, max: 2 });
const scheduler = new Pool({ connectionString: urls.scheduler, max: 2 });

let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  a = await seedTenant(superuser, 'a');
  b = await seedTenant(superuser, 'b');
});

afterAll(async () => {
  await Promise.all([superuser.end(), tenant.end(), platform.end(), scheduler.end()]);
});

const DENIED = '42501';

describe('role attributes', () => {
  it('has no superuser, role-creation or RLS-bypass privilege and owns no tables', async () => {
    const roles = await superuser.query(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
         FROM pg_roles WHERE rolname IN ('app_tenant', 'app_platform', 'app_scheduler')
         ORDER BY rolname`,
    );
    expect(roles.rows.map((r) => r.rolname)).toEqual([
      'app_platform',
      'app_scheduler',
      'app_tenant',
    ]);
    for (const r of roles.rows) {
      expect(r.rolsuper, r.rolname).toBe(false);
      expect(r.rolbypassrls, r.rolname).toBe(false);
      expect(r.rolcreaterole, r.rolname).toBe(false);
      expect(r.rolcreatedb, r.rolname).toBe(false);
      expect(r.rolcanlogin, `${r.rolname} is provisioned with a login`).toBe(true);
    }
    const owned = await superuser.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tableowner IN ('app_tenant', 'app_platform', 'app_scheduler')`,
    );
    expect(owned.rows).toEqual([]);
  });
});

describe('app_tenant', () => {
  it('cannot update, delete or truncate audit_events', async () => {
    for (const sql of [
      "UPDATE audit_events SET action = 'tampered'",
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
    ]) {
      const error = await failure(rolledBack(tenant, a.orgId, (c) => c.query(sql)));
      expect(error.code, sql).toBe(DENIED);
    }
  });

  it('can read and append audit events for its own tenant', async () => {
    const result = await rolledBack(tenant, a.orgId, async (c) => {
      await c.query(
        `INSERT INTO audit_events (id, org_id, action, entity_type, entity_id)
         VALUES ($1, $2, 'x', 'mission', $3)`,
        [newId(), a.orgId, a.missionId],
      );
      return c.query('SELECT count(*)::int AS n FROM audit_events');
    });
    expect(result.rows[0].n).toBe(2);
  });

  it('reads only its own organisation and can change only the settings columns', async () => {
    const own = await rolledBack(tenant, a.orgId, (c) =>
      c.query('SELECT id, name FROM organisations'),
    );
    expect(own.rows.map((r) => r.id)).toEqual([a.orgId]);

    const settings = await rolledBack(tenant, a.orgId, (c) =>
      c.query(
        "UPDATE organisations SET time_zone = 'Europe/London', max_upcoming_missions = 5 WHERE id = $1",
        [a.orgId],
      ),
    );
    expect(settings.rowCount).toBe(1);

    const rename = await failure(
      rolledBack(tenant, a.orgId, (c) =>
        c.query("UPDATE organisations SET name = 'x' WHERE id = $1", [a.orgId]),
      ),
    );
    expect(rename.code).toBe(DENIED);
    const insert = await failure(
      rolledBack(tenant, a.orgId, (c) =>
        c.query("INSERT INTO organisations (id, name) VALUES ($1, 'x')", [newId()]),
      ),
    );
    expect(insert.code).toBe(DENIED);
  });

  it('cannot delete holds, approval decisions or organisations, and cannot write alerts', async () => {
    for (const sql of [
      'DELETE FROM holds',
      'DELETE FROM approval_decisions',
      'DELETE FROM organisations',
      "INSERT INTO alerts (id, org_id, source, code, message) VALUES (gen_random_uuid(), (SELECT id FROM organisations LIMIT 1), 'scheduler', 'x', 'x')",
      'DELETE FROM alerts',
    ]) {
      const error = await failure(rolledBack(tenant, a.orgId, (c) => c.query(sql)));
      expect(error.code, sql).toBe(DENIED);
    }
  });

  it('can lock a crew profile row for the submit transaction', async () => {
    const { rowCount } = await rolledBack(tenant, a.orgId, (c) =>
      c.query('SELECT 1 FROM crew_profiles WHERE user_id = $1 FOR UPDATE', [a.crewId]),
    );
    expect(rowCount).toBe(1);
  });
});

describe('app_platform', () => {
  it('cannot select any tenant data', async () => {
    for (const table of [
      'organisations',
      'users',
      'invites',
      'missions',
      'audit_events',
      'alerts',
    ]) {
      const error = await failure(
        rolledBack(platform, null, (c) => c.query(`SELECT * FROM ${table}`)),
      );
      expect(error.code, table).toBe(DENIED);
    }
  });

  it('can create an organisation, its first Director and the invite, without a tenant context', async () => {
    const orgId = newId();
    const userId = newId();
    await rolledBack(platform, null, async (c) => {
      await c.query("INSERT INTO organisations (id, name) VALUES ($1, 'Lunar Research Lab')", [
        orgId,
      ]);
      await c.query(
        `INSERT INTO users (id, org_id, email, name, role) VALUES ($1, $2, $3, 'First', 'director')`,
        [userId, orgId, `first-${orgId}@lrl.space`],
      );
      await c.query(
        `INSERT INTO invites (id, org_id, user_id, code_hash, expires_at)
         VALUES ($1, $2, $3, 'hash', now() + interval '72 hours')`,
        [newId(), orgId, userId],
      );
    });
  });

  it('cannot write anything else', async () => {
    const error = await failure(
      rolledBack(platform, null, (c) =>
        c.query("INSERT INTO skills (id, org_id, name) VALUES ($1, $2, 'x')", [newId(), a.orgId]),
      ),
    );
    expect(error.code).toBe(DENIED);
    const update = await failure(
      rolledBack(platform, null, (c) => c.query("UPDATE users SET name = 'x'")),
    );
    expect(update.code).toBe(DENIED);
  });
});

describe('app_scheduler', () => {
  it('reads only id and time_zone of every organisation', async () => {
    const { rows } = await rolledBack(scheduler, null, (c) =>
      c.query('SELECT id, time_zone FROM organisations'),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.orgId);
    expect(ids).toContain(b.orgId);

    for (const sql of [
      'SELECT name FROM organisations',
      'SELECT max_upcoming_missions FROM organisations',
      'SELECT * FROM organisations',
    ]) {
      const error = await failure(rolledBack(scheduler, null, (c) => c.query(sql)));
      expect(error.code, sql).toBe(DENIED);
    }
  });

  it('cannot read or write tenant data other than alerts', async () => {
    for (const sql of [
      'SELECT 1 FROM users',
      'SELECT 1 FROM missions',
      'SELECT 1 FROM audit_events',
      "INSERT INTO audit_events (id, org_id, action, entity_type, entity_id) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'x', gen_random_uuid())",
      "UPDATE missions SET name = 'x'",
      'DELETE FROM holds',
    ]) {
      const error = await failure(rolledBack(scheduler, null, (c) => c.query(sql)));
      expect(error.code, sql).toBe(DENIED);
    }
  });

  it('inserts alerts for any organisation and purges expired ones, reading only occurred_at', async () => {
    const result = await rolledBack(scheduler, null, async (c) => {
      const old = newId();
      await c.query(
        `INSERT INTO alerts (id, org_id, source, code, message, occurred_at)
         VALUES ($1, $2, 'scheduler', 'OLD', 'old', now() - interval '31 days')`,
        [old, a.orgId],
      );
      await c.query(
        `INSERT INTO alerts (id, org_id, source, code, message) VALUES ($1, $2, 'scheduler', 'NEW', 'new')`,
        [newId(), b.orgId],
      );
      const purged = await c.query(
        "DELETE FROM alerts WHERE occurred_at < now() - interval '30 days'",
      );
      const remaining = await c.query(
        'SELECT count(*)::int AS n FROM alerts WHERE occurred_at IS NOT NULL',
      );
      return { purged: purged.rowCount, remaining: remaining.rows[0].n };
    });
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(result.remaining).toBeGreaterThanOrEqual(2);
  });

  it('cannot read other alert columns, nor update alerts', async () => {
    for (const sql of [
      'SELECT message FROM alerts',
      'SELECT * FROM alerts',
      'SELECT details FROM alerts',
      "UPDATE alerts SET message = 'x'",
    ]) {
      const error = await failure(rolledBack(scheduler, null, (c) => c.query(sql)));
      expect(error.code, sql).toBe(DENIED);
    }
  });
});
