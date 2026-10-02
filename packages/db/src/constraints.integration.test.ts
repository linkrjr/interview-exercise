import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { newId } from './ids.js';
import {
  addAssignment,
  addHold,
  addMission,
  seedTenant,
  type SeededTenant,
} from './testing/index.js';
import { failure, rolledBack } from './testing/sql.js';

const urls = inject('dbUrls');
const superuser = new Pool({ connectionString: urls.migrator, max: 2 });

let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  a = await seedTenant(superuser, 'a');
  b = await seedTenant(superuser, 'b');
});

afterAll(async () => {
  await superuser.end();
});

const EXCLUSION = '23P01';
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';

describe('holds exclusion constraint', () => {
  // The seeded hold covers 2031-01-01..2031-01-31 for a.crewId.
  it('rejects two live holds for one crew member over overlapping dates', async () => {
    const mission = await addMission(superuser, a, '2031-01-20', '2031-02-10');
    const assignment = await addAssignment(superuser, a, mission, a.crewId);
    const error = await failure(
      addHold(superuser, a, assignment, mission, a.crewId, '2031-01-20', '2031-02-10'),
    );
    expect(error.code).toBe(EXCLUSION);
  });

  it('rejects an overlap of a single shared day (ranges are inclusive)', async () => {
    const mission = await addMission(superuser, a, '2031-01-31', '2031-02-05');
    const assignment = await addAssignment(superuser, a, mission, a.crewId);
    const error = await failure(
      addHold(superuser, a, assignment, mission, a.crewId, '2031-01-31', '2031-02-05'),
    );
    expect(error.code).toBe(EXCLUSION);
  });

  it('allows the next day, and the same dates for a different crew member', async () => {
    const next = await addMission(superuser, a, '2031-02-01', '2031-02-10');
    const nextAssignment = await addAssignment(superuser, a, next, a.crewId);
    await addHold(superuser, a, nextAssignment, next, a.crewId, '2031-02-01', '2031-02-10');

    // Both seeded tenants hold an identical period for their own crew member.
    const { rows } = await superuser.query(
      'SELECT count(DISTINCT crew_member_id)::int AS crew FROM holds WHERE id = ANY($1)',
      [[a.holdId, b.holdId]],
    );
    expect(rows[0].crew).toBe(2);
  });

  it('does not conflict once the earlier hold is released, and keeps the released row', async () => {
    const x = await seedTenant(superuser, 'x');
    const mission = await addMission(superuser, x, '2031-01-15', '2031-02-15');
    const assignment = await addAssignment(superuser, x, mission, x.crewId);
    await superuser.query(
      "UPDATE holds SET released_at = now(), release_reason = 'rejected' WHERE id = $1",
      [x.holdId],
    );
    await addHold(superuser, x, assignment, mission, x.crewId, '2031-01-15', '2031-02-15');
    const { rows } = await superuser.query(
      'SELECT count(*)::int AS n FROM holds WHERE crew_member_id = $1',
      [x.crewId],
    );
    expect(rows[0].n).toBe(2);
  });

  it('allows only one live hold per assignment', async () => {
    const error = await failure(
      addHold(superuser, a, a.assignmentId, a.missionId, a.crewId, '2040-01-01', '2040-01-05'),
    );
    expect(error.code).toBe(UNIQUE);
  });

  it('requires released_at and release_reason together, with a known reason', async () => {
    const half = await failure(
      superuser.query('UPDATE holds SET released_at = now() WHERE id = $1', [a.holdId]),
    );
    expect(half.code).toBe(CHECK);
    const unknown = await failure(
      superuser.query(
        "UPDATE holds SET released_at = now(), release_reason = 'because' WHERE id = $1",
        [a.holdId],
      ),
    );
    expect(unknown.code).toBe(CHECK);
    for (const reason of ['rejected', 'withdrawn', 'cancelled', 'expired', 'completed']) {
      await rolledBack(superuser, null, (c) =>
        c.query('UPDATE holds SET released_at = now(), release_reason = $2 WHERE id = $1', [
          a.holdId,
          reason,
        ]),
      );
    }
  });
});

describe('CHECK constraints', () => {
  const cases: Array<[string, string, () => unknown[]]> = [
    [
      'skill level below 1',
      'UPDATE crew_skills SET level = 0 WHERE crew_member_id = $1',
      () => [a.crewId],
    ],
    [
      'skill level above 5',
      'UPDATE crew_skills SET level = 6 WHERE crew_member_id = $1',
      () => [a.crewId],
    ],
    [
      'requirement level below 1',
      'UPDATE requirements SET min_level = 0 WHERE org_id = $1',
      () => [a.orgId],
    ],
    [
      'requirement level above 5',
      'UPDATE requirements SET min_level = 6 WHERE org_id = $1',
      () => [a.orgId],
    ],
    [
      'requirement count of 0',
      'UPDATE requirements SET count = 0 WHERE org_id = $1',
      () => [a.orgId],
    ],
    [
      'workload cap of 0',
      'UPDATE organisations SET max_upcoming_missions = 0 WHERE id = $1',
      () => [a.orgId],
    ],
    [
      'workload cap above 20',
      'UPDATE organisations SET max_upcoming_missions = 21 WHERE id = $1',
      () => [a.orgId],
    ],
    [
      'mission ending before it starts',
      "UPDATE missions SET end_date = '2030-12-31' WHERE id = $1",
      () => [a.missionId],
    ],
    [
      'an empty unavailability range',
      "UPDATE unavailability SET period = 'empty'::daterange WHERE org_id = $1",
      () => [a.orgId],
    ],
    [
      'an unbounded unavailability range',
      "UPDATE unavailability SET period = daterange('2030-01-01', NULL) WHERE org_id = $1",
      () => [a.orgId],
    ],
    [
      'a rejection without a reason',
      "UPDATE approval_decisions SET decision = 'rejected', comment = '  ' WHERE org_id = $1",
      () => [a.orgId],
    ],
    [
      'an unknown alert source',
      "UPDATE alerts SET source = 'other' WHERE org_id = $1",
      () => [a.orgId],
    ],
    [
      'an active user without a password',
      'UPDATE users SET password_hash = NULL WHERE id = $1',
      () => [a.crewId],
    ],
  ];

  it.each(cases)('rejects %s', async (_name, sql, values) => {
    const error = await failure(superuser.query(sql, values()));
    expect(error.code).toBe(CHECK);
  });

  it('accepts the boundary values', async () => {
    await rolledBack(superuser, null, async (c) => {
      await c.query('UPDATE crew_skills SET level = 1 WHERE crew_member_id = $1', [a.crewId]);
      await c.query('UPDATE crew_skills SET level = 5 WHERE crew_member_id = $1', [a.crewId]);
      await c.query('UPDATE organisations SET max_upcoming_missions = 1 WHERE id = $1', [a.orgId]);
      await c.query('UPDATE organisations SET max_upcoming_missions = 20 WHERE id = $1', [a.orgId]);
      await c.query('UPDATE missions SET end_date = start_date WHERE id = $1', [a.missionId]);
      await c.query(
        "UPDATE approval_decisions SET decision = 'rejected', comment = 'no' WHERE org_id = $1",
        [a.orgId],
      );
    });
  });
});

describe('uniqueness', () => {
  it('keeps emails unique across the platform, ignoring case', async () => {
    const { rows } = await superuser.query('SELECT email FROM users WHERE id = $1', [a.crewId]);
    const duplicate = await failure(
      superuser.query(
        `INSERT INTO users (id, org_id, email, name, role) VALUES ($1, $2, $3, 'Dup', 'crew')`,
        [newId(), b.orgId, String(rows[0].email).toUpperCase()],
      ),
    );
    expect(duplicate.code).toBe(UNIQUE);
  });

  it('keeps skill names unique per organisation, ignoring case, but not across organisations', async () => {
    const duplicate = await failure(
      superuser.query("INSERT INTO skills (id, org_id, name) VALUES ($1, $2, 'MEDICINE')", [
        newId(),
        a.orgId,
      ]),
    );
    expect(duplicate.code).toBe(UNIQUE);
    await rolledBack(superuser, null, (c) =>
      c.query("INSERT INTO skills (id, org_id, name) VALUES ($1, $2, 'Navigation')", [
        newId(),
        a.orgId,
      ]),
    );
    const both = await superuser.query(
      "SELECT count(*)::int AS n FROM skills WHERE name = 'medicine'",
    );
    expect(both.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('allows one requirement per skill per mission and one assignment per crew member per mission', async () => {
    const requirement = await failure(
      superuser.query(
        'INSERT INTO requirements (id, org_id, mission_id, skill_id, min_level, count) VALUES ($1, $2, $3, $4, 1, 1)',
        [newId(), a.orgId, a.missionId, a.skillId],
      ),
    );
    expect(requirement.code).toBe(UNIQUE);
    const assignment = await failure(addAssignment(superuser, a, a.missionId, a.crewId));
    expect(assignment.code).toBe(UNIQUE);
  });
});

describe('composite foreign keys', () => {
  it('reject a row that references another tenant row by crafted id', async () => {
    const error = await failure(
      superuser.query(
        'INSERT INTO assignments (id, org_id, mission_id, crew_member_id, assigned_by) VALUES ($1, $2, $3, $4, $5)',
        [newId(), b.orgId, a.missionId, b.crewId, b.leadId],
      ),
    );
    expect(error.code).toBe(FOREIGN_KEY);
    const requirement = await failure(
      superuser.query(
        'INSERT INTO requirements (id, org_id, mission_id, skill_id, min_level, count) VALUES ($1, $2, $3, $4, 1, 1)',
        [newId(), b.orgId, b.missionId, a.skillId],
      ),
    );
    expect(requirement.code).toBe(FOREIGN_KEY);
    const mission = await failure(
      superuser.query(
        "INSERT INTO missions (id, org_id, lead_id, name, start_date, end_date) VALUES ($1, $2, $3, 'x', '2032-01-01', '2032-01-02')",
        [newId(), b.orgId, a.leadId],
      ),
    );
    expect(mission.code).toBe(FOREIGN_KEY);
  });

  it('include org_id on both sides of every foreign key between tenant tables', async () => {
    const { rows } = await superuser.query<{
      conname: string;
      child: string;
      parent: string;
      ok: boolean;
    }>(
      `SELECT con.conname, child.relname AS child, parent.relname AS parent,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = con.conrelid AND a.attname = 'org_id' AND a.attnum = ANY (con.conkey))
              AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = con.confrelid AND a.attname = 'org_id' AND a.attnum = ANY (con.confkey)) AS ok
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN pg_namespace n ON n.oid = child.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = parent.oid AND a.attname = 'org_id')`,
    );
    expect(rows.length).toBeGreaterThan(15);
    const missing = rows.filter((r) => !r.ok).map((r) => r.conname);
    expect(missing).toEqual([]);
  });
});

describe('updated_at', () => {
  it('is refreshed on update', async () => {
    const before = await superuser.query('SELECT updated_at FROM skills WHERE id = $1', [
      a.skillId,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await rolledBack(superuser, null, async (c) => {
      await c.query("UPDATE skills SET name = 'Anaesthesia' WHERE id = $1", [a.skillId]);
      const after = await c.query('SELECT updated_at FROM skills WHERE id = $1', [a.skillId]);
      expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(
        before.rows[0].updated_at.getTime(),
      );
    });
  });
});
