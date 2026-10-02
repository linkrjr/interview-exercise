import {
  AppError,
  ErrorCodes,
  type Actor,
  type Assignment,
  type ListAssignmentsQuery,
  type Page,
} from '@mc/contracts';
import { schema, type Db } from '@mc/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import { notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { userOrg } from '../services/org-settings-service.js';
import { crewVisibleClause } from './mission-view.js';

type Row = {
  assignment: typeof schema.assignments.$inferSelect;
  mission: typeof schema.missions.$inferSelect;
};

const toAssignment = ({ assignment, mission }: Row): Assignment => ({
  id: assignment.id,
  acknowledgedAt: assignment.acknowledgedAt?.toISOString() ?? null,
  mission: {
    id: mission.id,
    name: mission.name,
    description: mission.description,
    startDate: mission.startDate,
    endDate: mission.endDate,
    status: mission.status,
  },
});

export interface AssignmentServiceDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  policy: Policy;
}

/** A Crew Member's own assignments: visible from Approved onward, binding, acknowledged but never refused. */
export class AssignmentService {
  constructor(private readonly deps: AssignmentServiceDeps) {}

  async listMine(actor: Actor, query: ListAssignmentsQuery): Promise<Page<Assignment>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'assignment.list');
    const me = (actor as { userId: string }).userId;
    const before = query.cursor ? decodeCursor(query.cursor) : undefined;
    return db.withTenant(userOrg(actor), async (tx) => {
      const rows = await tx
        .select({ assignment: schema.assignments, mission: schema.missions })
        .from(schema.assignments)
        .innerJoin(schema.missions, eq(schema.missions.id, schema.assignments.missionId))
        .where(
          and(
            eq(schema.assignments.crewMemberId, me),
            crewVisibleClause,
            before ? lt(schema.assignments.id, before) : undefined,
          ),
        )
        .orderBy(desc(schema.assignments.id))
        .limit(query.limit + 1);
      return toPage(
        rows.map((r) => ({ id: r.assignment.id, ...r })),
        query.limit,
        toAssignment,
      );
    });
  }

  /** Acknowledges receipt, once; asking again changes nothing. Only while the mission is Approved or Active. */
  async acknowledge(actor: Actor, assignmentId: string): Promise<Assignment> {
    const { db, audit, clock, policy } = this.deps;
    policy.authorize(actor, 'assignment.acknowledge');
    const me = (actor as { userId: string }).userId;
    return db.withTenant(userOrg(actor), async (tx) => {
      const [row] = await tx
        .select({ assignment: schema.assignments, mission: schema.missions })
        .from(schema.assignments)
        .innerJoin(schema.missions, eq(schema.missions.id, schema.assignments.missionId))
        .where(
          and(
            eq(schema.assignments.id, assignmentId),
            eq(schema.assignments.crewMemberId, me),
            crewVisibleClause,
          ),
        )
        .for('update', { of: schema.assignments });
      if (!row) throw notFound('Assignment');
      if (row.assignment.acknowledgedAt) return toAssignment(row);
      if (row.mission.status !== 'approved' && row.mission.status !== 'active') {
        throw new AppError(
          ErrorCodes.ASSIGNMENT_NOT_ACKNOWLEDGEABLE,
          409,
          `A mission that is ${row.mission.status} cannot be acknowledged`,
        );
      }
      const [updated] = await tx
        .update(schema.assignments)
        .set({ acknowledgedAt: clock.now() })
        .where(eq(schema.assignments.id, assignmentId))
        .returning();
      await audit.record(tx, {
        action: 'assignment.acknowledged',
        entityType: 'assignment',
        entityId: assignmentId,
        after: { missionId: row.mission.id },
        actorId: me,
      });
      return toAssignment({ assignment: updated!, mission: row.mission });
    });
  }
}
