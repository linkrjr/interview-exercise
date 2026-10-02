import type {
  CrewMission,
  CrewValidation,
  Mission,
  MissionAction,
  MissionSummary,
} from '@mc/contracts';
import { schema, type Tx } from '@mc/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { UserActor } from '../policy/index.js';
import { memberIssues, requirementCoverage } from './eligibility.js';
import { actionsFor, CREW_VISIBLE_STATUSES } from './state-machine.js';
import type { MissionRow } from './transitions.js';

/** Missions a Crew Member may see: their own assignments from Approved onward, and Approved ones since cancelled. */
export const crewVisibleClause = sql`(
  ${schema.missions.status} in (${sql.join(
    CREW_VISIBLE_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})
  or (${schema.missions.status} = 'cancelled' and exists (
    select 1 from ${schema.approvalDecisions}
     where ${schema.approvalDecisions.missionId} = ${schema.missions.id}
       and ${schema.approvalDecisions.decision} = 'approved'))
)`;

export const toSummary = (row: MissionRow, leadName: string | null): MissionSummary => ({
  id: row.id,
  name: row.name,
  description: row.description,
  startDate: row.startDate,
  endDate: row.endDate,
  status: row.status,
  version: row.version,
  leadId: row.leadId,
  leadName,
  createdAt: row.createdAt.toISOString(),
});

/** The actions this user may take on this mission now (owner Lead, or Director), empty for everyone else. */
export function allowedActionsFor(
  actor: UserActor,
  mission: Pick<MissionRow, 'leadId' | 'status'>,
): MissionAction[] {
  if (actor.role === 'director') return actionsFor('director', mission.status);
  if (actor.role === 'lead' && actor.userId === mission.leadId)
    return actionsFor('owner', mission.status);
  return [];
}

/**
 * Whether the tentative crew of a Crewing mission could be submitted. People are reported only as
 * `NOT_ELIGIBLE`, never with a reason (DESIGN.md §7.1). Requirements are judged by skills alone:
 * a person who cannot take the dates is flagged separately.
 */
export async function crewValidation(
  tx: Tx,
  mission: MissionRow,
  assignments: Array<{ id: string; crewMemberId: string }>,
  cap: number,
): Promise<CrewValidation> {
  const ids = assignments.map((a) => a.crewMemberId);
  const issues = await memberIssues(tx, ids, mission, cap, { exceptMissionId: mission.id });
  const coverage = await requirementCoverage(tx, mission.id, ids);
  const assignmentIssues = assignments
    .filter((a) => issues.has(a.crewMemberId))
    .map((a) => ({
      assignmentId: a.id,
      crewMemberId: a.crewMemberId,
      code: 'NOT_ELIGIBLE' as const,
    }));
  const unmetRequirements = coverage.filter((c) => c.met < c.required);
  return {
    valid: assignmentIssues.length === 0 && unmetRequirements.length === 0,
    assignmentIssues,
    unmetRequirements,
  };
}

/** The full view for Directors and Leads. */
export async function loadStaffMission(
  tx: Tx,
  row: MissionRow,
  actor: UserActor,
  cap: number,
): Promise<Mission> {
  const [lead] = await tx
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, row.leadId));

  const requirements = await tx
    .select({
      skillId: schema.requirements.skillId,
      skillName: schema.skills.name,
      minLevel: schema.requirements.minLevel,
      count: schema.requirements.count,
    })
    .from(schema.requirements)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.requirements.skillId))
    .where(eq(schema.requirements.missionId, row.id))
    .orderBy(asc(schema.skills.name));

  const crew = await tx
    .select({
      assignmentId: schema.assignments.id,
      crewMemberId: schema.assignments.crewMemberId,
      name: schema.users.name,
      email: schema.users.email,
      acknowledgedAt: schema.assignments.acknowledgedAt,
    })
    .from(schema.assignments)
    .innerJoin(schema.users, eq(schema.users.id, schema.assignments.crewMemberId))
    .where(eq(schema.assignments.missionId, row.id))
    .orderBy(asc(schema.assignments.id));

  const decisions = await tx
    .select()
    .from(schema.approvalDecisions)
    .where(eq(schema.approvalDecisions.missionId, row.id))
    .orderBy(asc(schema.approvalDecisions.decidedAt), asc(schema.approvalDecisions.id));

  const validation =
    row.status === 'crewing'
      ? await crewValidation(
          tx,
          row,
          crew.map((c) => ({ id: c.assignmentId, crewMemberId: c.crewMemberId })),
          cap,
        )
      : undefined;

  return {
    ...toSummary(row, lead?.name ?? null),
    requirements,
    crew: crew.map((c) => ({ ...c, acknowledgedAt: c.acknowledgedAt?.toISOString() ?? null })),
    decisions: decisions.map((d) => ({
      id: d.id,
      directorId: d.directorId,
      decision: d.decision,
      comment: d.comment,
      decidedAt: d.decidedAt.toISOString(),
    })),
    ...(validation ? { crewValidation: validation } : {}),
    allowedActions: allowedActionsFor(actor, row),
  };
}

/** What a Crew Member sees of a mission they are assigned to (DESIGN.md OQ-3). */
export const toCrewMission = (
  row: MissionRow,
  assignment: { id: string; acknowledgedAt: Date | null },
): CrewMission => ({
  id: row.id,
  name: row.name,
  description: row.description,
  startDate: row.startDate,
  endDate: row.endDate,
  status: row.status,
  assignment: {
    id: assignment.id,
    acknowledgedAt: assignment.acknowledgedAt?.toISOString() ?? null,
  },
});

/** The crew member's own assignment on a mission, if they are allowed to see the mission. */
export async function visibleAssignment(tx: Tx, missionId: string, crewMemberId: string) {
  const [row] = await tx
    .select({ assignment: schema.assignments })
    .from(schema.assignments)
    .innerJoin(schema.missions, eq(schema.missions.id, schema.assignments.missionId))
    .where(
      and(
        eq(schema.assignments.missionId, missionId),
        eq(schema.assignments.crewMemberId, crewMemberId),
        crewVisibleClause,
      ),
    );
  return row?.assignment;
}
