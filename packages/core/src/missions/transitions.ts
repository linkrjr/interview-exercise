import { AppError, ErrorCodes } from '@mc/contracts';
import { schema, type Tx } from '@mc/db';
import { and, eq, sql } from 'drizzle-orm';
import { transitionFor, type TransitionName } from './state-machine.js';

export type MissionRow = typeof schema.missions.$inferSelect;

/**
 * The only place in the codebase that writes `missions.status` (DESIGN.md §21). It moves the
 * mission along a transition of the state machine, checks the current status again in the same
 * statement, and bumps the version. Effects (holds, notifications, audit) belong to the caller.
 */
export async function applyTransition(
  tx: Tx,
  mission: MissionRow,
  action: TransitionName,
): Promise<MissionRow> {
  const def = transitionFor(action);
  if (!def.from.includes(mission.status)) {
    throw new AppError(
      ErrorCodes.MISSION_INVALID_TRANSITION,
      409,
      `Cannot ${action} a mission that is ${mission.status}`,
    );
  }
  const [updated] = await tx
    .update(schema.missions)
    .set({ status: def.to, version: sql`${schema.missions.version} + 1` })
    .where(and(eq(schema.missions.id, mission.id), eq(schema.missions.status, mission.status)))
    .returning();
  if (!updated) {
    throw new AppError(
      ErrorCodes.MISSION_INVALID_TRANSITION,
      409,
      'The mission changed while it was being updated',
    );
  }
  return updated;
}
