// Typed description of the tables created by the SQL migrations in `migrations/`.
// The migrations are the source of truth for constraints, RLS and grants; this file is the
// column-level view used for typed queries, and a test keeps the two in sync.
import {
  date,
  integer,
  jsonb,
  pgEnum,
  primaryKey,
  smallint,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { pgTable } from 'drizzle-orm/pg-core';
import { citext, daterange, orgId, timestamps, timestamptz } from './types.js';

export const userRole = pgEnum('user_role', ['director', 'lead', 'crew']);
export const userStatus = pgEnum('user_status', ['invited', 'active', 'deactivated']);
export const missionStatus = pgEnum('mission_status', [
  'draft',
  'crewing',
  'pending_approval',
  'approved',
  'active',
  'completed',
  'cancelled',
]);
export const approvalDecisionKind = pgEnum('approval_decision_kind', ['approved', 'rejected']);

export const organisations = pgTable('organisations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('UTC'),
  maxUpcomingMissions: smallint('max_upcoming_missions').notNull().default(3),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  email: citext('email').notNull(),
  name: text('name'),
  role: userRole('role').notNull(),
  passwordHash: text('password_hash'),
  status: userStatus('status').notNull().default('invited'),
  ...timestamps,
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  usedAt: timestamptz('used_at'),
  ...timestamps,
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id').notNull(),
  familyId: uuid('family_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  revokedAt: timestamptz('revoked_at'),
  ...timestamps,
});

export const crewProfiles = pgTable('crew_profiles', {
  userId: uuid('user_id').primaryKey(),
  orgId: orgId(),
  ...timestamps,
});

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  name: citext('name').notNull(),
  ...timestamps,
});

export const crewSkills = pgTable(
  'crew_skills',
  {
    orgId: orgId(),
    crewMemberId: uuid('crew_member_id').notNull(),
    skillId: uuid('skill_id').notNull(),
    level: smallint('level').notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.crewMemberId, t.skillId] })],
);

export const unavailability = pgTable('unavailability', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  crewMemberId: uuid('crew_member_id').notNull(),
  period: daterange('period').notNull(),
  note: text('note'),
  ...timestamps,
});

export const missions = pgTable('missions', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  leadId: uuid('lead_id').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: missionStatus('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  ...timestamps,
});

export const requirements = pgTable('requirements', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  missionId: uuid('mission_id').notNull(),
  skillId: uuid('skill_id').notNull(),
  minLevel: smallint('min_level').notNull(),
  count: integer('count').notNull(),
  ...timestamps,
});

export const assignments = pgTable('assignments', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  missionId: uuid('mission_id').notNull(),
  crewMemberId: uuid('crew_member_id').notNull(),
  assignedBy: uuid('assigned_by').notNull(),
  acknowledgedAt: timestamptz('acknowledged_at'),
  ...timestamps,
});

export const holds = pgTable('holds', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  assignmentId: uuid('assignment_id').notNull(),
  crewMemberId: uuid('crew_member_id').notNull(),
  missionId: uuid('mission_id').notNull(),
  period: daterange('period').notNull(),
  releasedAt: timestamptz('released_at'),
  releaseReason: text('release_reason'),
  ...timestamps,
});

export const approvalDecisions = pgTable('approval_decisions', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  missionId: uuid('mission_id').notNull(),
  directorId: uuid('director_id').notNull(),
  decision: approvalDecisionKind('decision').notNull(),
  comment: text('comment'),
  decidedAt: timestamptz('decided_at').notNull().defaultNow(),
  ...timestamps,
});

export const matchProposals = pgTable('match_proposals', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  missionId: uuid('mission_id').notNull(),
  teamHash: text('team_hash').notNull(),
  result: jsonb('result').notNull(),
  expiresAt: timestamptz('expires_at').notNull(),
  ...timestamps,
});

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  readAt: timestamptz('read_at'),
  ...timestamps,
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
  ...timestamps,
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey(),
  orgId: orgId(),
  source: text('source').notNull(),
  code: text('code').notNull(),
  message: text('message').notNull(),
  details: jsonb('details'),
  occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
  ...timestamps,
});
