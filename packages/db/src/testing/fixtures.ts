import type { Pool, PoolClient } from 'pg';
import { newId } from '../ids.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface SeededTenant {
  orgId: string;
  directorId: string;
  leadId: string;
  crewId: string;
  invitedUserId: string;
  skillId: string;
  missionId: string;
  assignmentId: string;
  holdId: string;
}

/**
 * Inserts one organisation with a row in every tenant table, bypassing RLS (superuser
 * connection). Used by the isolation tests; each call uses fresh ids and emails.
 */
export async function seedTenant(db: Queryable, label = 'org'): Promise<SeededTenant> {
  const orgId = newId();
  const directorId = newId();
  const leadId = newId();
  const crewId = newId();
  const invitedUserId = newId();
  const skillId = newId();
  const missionId = newId();
  const assignmentId = newId();
  const holdId = newId();
  const email = (who: string) => `${label}-${who}-${orgId}@test.space`;
  const q = (text: string, values: unknown[] = []) => db.query(text, values);

  await q('INSERT INTO organisations (id, name) VALUES ($1, $2)', [orgId, `${label} ${orgId}`]);
  await q(
    `INSERT INTO users (id, org_id, email, name, role, password_hash, status) VALUES
       ($2, $1, $6, 'Director', 'director', 'hash', 'active'),
       ($3, $1, $7, 'Lead', 'lead', 'hash', 'active'),
       ($4, $1, $8, 'Crew', 'crew', 'hash', 'active'),
       ($5, $1, $9, 'Invited', 'crew', NULL, 'invited')`,
    [
      orgId,
      directorId,
      leadId,
      crewId,
      invitedUserId,
      email('d'),
      email('l'),
      email('c'),
      email('i'),
    ],
  );
  await q(
    `INSERT INTO invites (id, org_id, user_id, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '72 hours')`,
    [newId(), orgId, invitedUserId, `code-${newId()}`],
  );
  await q(
    `INSERT INTO refresh_tokens (id, org_id, user_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [newId(), orgId, leadId, newId(), `token-${newId()}`],
  );
  await q('INSERT INTO crew_profiles (user_id, org_id) VALUES ($1, $2)', [crewId, orgId]);
  await q('INSERT INTO skills (id, org_id, name) VALUES ($1, $2, $3)', [
    skillId,
    orgId,
    'Medicine',
  ]);
  await q(
    'INSERT INTO crew_skills (org_id, crew_member_id, skill_id, level) VALUES ($1, $2, $3, 4)',
    [orgId, crewId, skillId],
  );
  await q(
    `INSERT INTO unavailability (id, org_id, crew_member_id, period, note)
     VALUES ($1, $2, $3, daterange('2030-01-01', '2030-01-10', '[]'), 'Leave')`,
    [newId(), orgId, crewId],
  );
  await q(
    `INSERT INTO missions (id, org_id, lead_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, 'Mission', '2031-01-01', '2031-01-31', 'pending_approval')`,
    [missionId, orgId, leadId],
  );
  await q(
    'INSERT INTO requirements (id, org_id, mission_id, skill_id, min_level, count) VALUES ($1, $2, $3, $4, 3, 1)',
    [newId(), orgId, missionId, skillId],
  );
  await q(
    'INSERT INTO assignments (id, org_id, mission_id, crew_member_id, assigned_by) VALUES ($1, $2, $3, $4, $5)',
    [assignmentId, orgId, missionId, crewId, leadId],
  );
  await q(
    `INSERT INTO holds (id, org_id, assignment_id, crew_member_id, mission_id, period)
     VALUES ($1, $2, $3, $4, $5, daterange('2031-01-01', '2031-01-31', '[]'))`,
    [holdId, orgId, assignmentId, crewId, missionId],
  );
  await q(
    `INSERT INTO approval_decisions (id, org_id, mission_id, director_id, decision, comment)
     VALUES ($1, $2, $3, $4, 'approved', 'ok')`,
    [newId(), orgId, missionId, directorId],
  );
  await q(
    `INSERT INTO match_proposals (id, org_id, mission_id, team_hash, result, expires_at)
     VALUES ($1, $2, $3, 'hash', '{}'::jsonb, now() + interval '30 minutes')`,
    [newId(), orgId, missionId],
  );
  await q(
    `INSERT INTO notifications (id, org_id, user_id, type, payload)
     VALUES ($1, $2, $3, 'mission.approved', '{}'::jsonb)`,
    [newId(), orgId, crewId],
  );
  await q(
    `INSERT INTO audit_events (id, org_id, actor_id, action, entity_type, entity_id)
     VALUES ($1, $2, $3, 'mission.approve', 'mission', $4)`,
    [newId(), orgId, directorId, missionId],
  );
  await q(
    `INSERT INTO alerts (id, org_id, source, code, message)
     VALUES ($1, $2, 'scheduler', 'SCHEDULER_FAILED', 'boom')`,
    [newId(), orgId],
  );

  return {
    orgId,
    directorId,
    leadId,
    crewId,
    invitedUserId,
    skillId,
    missionId,
    assignmentId,
    holdId,
  };
}

/** Adds a mission for a lead, bypassing RLS. */
export async function addMission(
  db: Queryable,
  tenant: Pick<SeededTenant, 'orgId' | 'leadId'>,
  startDate: string,
  endDate: string,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO missions (id, org_id, lead_id, name, start_date, end_date)
     VALUES ($1, $2, $3, 'Extra', $4, $5)`,
    [id, tenant.orgId, tenant.leadId, startDate, endDate],
  );
  return id;
}

/** Assigns a crew member to a mission, bypassing RLS. Returns the assignment id. */
export async function addAssignment(
  db: Queryable,
  tenant: Pick<SeededTenant, 'orgId' | 'leadId'>,
  missionId: string,
  crewId: string,
): Promise<string> {
  const id = newId();
  await db.query(
    'INSERT INTO assignments (id, org_id, mission_id, crew_member_id, assigned_by) VALUES ($1, $2, $3, $4, $5)',
    [id, tenant.orgId, missionId, crewId, tenant.leadId],
  );
  return id;
}

/** Inserts a live hold for an assignment over an inclusive date range, bypassing RLS. */
export async function addHold(
  db: Queryable,
  tenant: Pick<SeededTenant, 'orgId'>,
  assignmentId: string,
  missionId: string,
  crewId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const id = newId();
  await db.query(
    `INSERT INTO holds (id, org_id, assignment_id, crew_member_id, mission_id, period)
     VALUES ($1, $2, $3, $4, $5, daterange($6::date, $7::date, '[]'))`,
    [id, tenant.orgId, assignmentId, crewId, missionId, startDate, endDate],
  );
  return id;
}
