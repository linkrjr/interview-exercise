import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { newId } from './ids.js';
import * as schema from './schema/index.js';
import { seedTenant, type SeededTenant } from './testing/index.js';
import { definedTables } from './testing/schema.js';

const urls = inject('dbUrls');
const superuser = new Pool({ connectionString: urls.migrator, max: 2 });
let db: Db;
let single: Db;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  db = createDb({
    tenantUrl: urls.tenant,
    platformUrl: urls.platform,
    schedulerUrl: urls.scheduler,
  });
  // One connection, so consecutive calls are guaranteed to reuse it.
  single = createDb({ tenantUrl: urls.tenant, poolMax: 1 });
  a = await seedTenant(superuser, 'a');
  b = await seedTenant(superuser, 'b');
});

afterAll(async () => {
  await Promise.all([db.close(), single.close(), superuser.end()]);
});

describe('withTenant', () => {
  it('scopes every query to the given organisation', async () => {
    const missions = await db.withTenant(a.orgId, (tx) => tx.select().from(schema.missions));
    expect(missions.map((m) => m.orgId)).toEqual([a.orgId]);
    const other = await db.withTenant(b.orgId, (tx) => tx.select().from(schema.missions));
    expect(other.map((m) => m.orgId)).toEqual([b.orgId]);
  });

  it('does not leak SET LOCAL context between sequential calls on one pooled connection', async () => {
    const first = await single.withTenant(a.orgId, async (tx) => {
      const r = await tx.execute(sql`SELECT current_setting('app.org_id', true) AS org`);
      return r.rows[0]?.org;
    });
    const second = await single.withTenant(b.orgId, async (tx) => {
      const r = await tx.execute(sql`SELECT current_setting('app.org_id', true) AS org`);
      return { org: r.rows[0]?.org, users: await tx.select().from(schema.users) };
    });
    expect(first).toBe(a.orgId);
    expect(second.org).toBe(b.orgId);
    expect(new Set(second.users.map((u) => u.orgId))).toEqual(new Set([b.orgId]));
  });

  it('leaves the connection with no tenant after commit, failing closed with zero rows', async () => {
    const pool = new Pool({ connectionString: urls.tenant, max: 1 });
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [a.orgId]);
      await client.query('COMMIT');
      const setting = await client.query("SELECT current_setting('app.org_id', true) AS org");
      expect([null, '']).toContain(setting.rows[0].org);
      const users = await client.query('SELECT count(*)::int AS n FROM users');
      expect(users.rows[0].n).toBe(0);
      client.release();
    } finally {
      await pool.end();
    }
  });

  it('rolls back everything when the callback throws', async () => {
    const id = newId();
    await expect(
      db.withTenant(a.orgId, async (tx) => {
        await tx.insert(schema.skills).values({ id, orgId: a.orgId, name: 'Rolled back' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await superuser.query('SELECT 1 FROM skills WHERE id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('commits when the callback succeeds', async () => {
    const id = newId();
    await db.withTenant(a.orgId, (tx) =>
      tx.insert(schema.skills).values({ id, orgId: a.orgId, name: 'Committed' }),
    );
    const { rows } = await superuser.query('SELECT 1 FROM skills WHERE id = $1', [id]);
    expect(rows).toHaveLength(1);
  });

  it('refuses to write a row for another organisation', async () => {
    await expect(
      db.withTenant(a.orgId, (tx) =>
        tx.insert(schema.skills).values({ id: newId(), orgId: b.orgId, name: 'Smuggled' }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringContaining('row-level security') },
    });
  });

  it('rejects an organisation id that is not a UUID before touching the database', async () => {
    for (const bad of ['', 'not-a-uuid', "'; DROP TABLE users; --", `${a.orgId} OR true`]) {
      const result = db.withTenant(bad, async () => undefined);
      await expect(result).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('keeps working after a failed transaction on the same connection', async () => {
    await expect(
      single.withTenant(a.orgId, (tx) => tx.execute(sql`SELECT * FROM no_such_table`)),
    ).rejects.toThrow();
    const users = await single.withTenant(a.orgId, (tx) =>
      tx.select().from(schema.users).where(eq(schema.users.id, a.leadId)),
    );
    expect(users).toHaveLength(1);
  });
});

describe('withPlatform', () => {
  it('can create an organisation and its first Director but cannot read them back', async () => {
    const orgId = newId();
    await db.withPlatform(async (tx) => {
      await tx.insert(schema.organisations).values({ id: orgId, name: 'Provisioned' });
      await tx.insert(schema.users).values({
        id: newId(),
        orgId,
        email: `director-${orgId}@lrl.space`,
        name: 'First Director',
        role: 'director',
      });
    });
    const { rows } = await superuser.query('SELECT role FROM users WHERE org_id = $1', [orgId]);
    expect(rows).toEqual([{ role: 'director' }]);
    await expect(db.withPlatform((tx) => tx.select().from(schema.users))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });
});

describe('withScheduler', () => {
  it('lists organisation ids and time zones and records alerts', async () => {
    const orgs = await db.withScheduler((tx) =>
      tx
        .select({ id: schema.organisations.id, timeZone: schema.organisations.timeZone })
        .from(schema.organisations),
    );
    expect(orgs.map((o) => o.id)).toEqual(expect.arrayContaining([a.orgId, b.orgId]));

    const id = newId();
    await db.withScheduler((tx) =>
      tx.insert(schema.alerts).values({
        id,
        orgId: a.orgId,
        source: 'scheduler',
        code: 'SCHEDULER_ORG_FAILED',
        message: 'failed',
      }),
    );
    const { rows } = await superuser.query('SELECT code FROM alerts WHERE id = $1', [id]);
    expect(rows).toEqual([{ code: 'SCHEDULER_ORG_FAILED' }]);
  });
});

describe('configuration', () => {
  it('rejects, rather than throwing synchronously, when a role URL is not configured', async () => {
    const partial = createDb({ tenantUrl: urls.tenant });
    await expect(partial.withPlatform(async () => undefined)).rejects.toThrow(/platform/);
    await expect(partial.withScheduler(async () => undefined)).rejects.toThrow(/scheduler/);
    await partial.close();
  });

  it('can be closed more than once', async () => {
    const extra = createDb({ tenantUrl: urls.tenant });
    await extra.withTenant(a.orgId, async () => undefined);
    await extra.close();
    await extra.close();
  });
});

describe('Drizzle schema parity', () => {
  it('describes exactly the tables and columns the migrations create', async () => {
    const { rows } = await superuser.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name <> '__drizzle_migrations'
        ORDER BY table_name, column_name`,
    );
    const actual = new Map<string, string[]>();
    for (const r of rows) {
      const list = actual.get(r.table_name) ?? [];
      list.push(`${r.column_name}:${r.is_nullable === 'YES' ? 'null' : 'not null'}`);
      actual.set(r.table_name, list);
    }

    const defined = new Map<string, string[]>();
    for (const table of definedTables()) {
      defined.set(
        table.name,
        table.columns.map((c) => `${c.name}:${c.notNull ? 'not null' : 'null'}`).sort(),
      );
    }
    expect([...defined.keys()].sort()).toEqual([...actual.keys()].sort());
    for (const [table, columns] of defined) {
      expect(columns, table).toEqual(actual.get(table));
    }
  });
});
