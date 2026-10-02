import { newId, schema, type Tx } from '@mc/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

export type ReleaseReason = 'rejected' | 'withdrawn' | 'cancelled' | 'expired' | 'completed';

/**
 * Takes a binding hold for each assignment of a mission, over the mission's inclusive dates
 * (DESIGN.md §8). The exclusion constraint on holds is the backstop against double-booking.
 */
export async function takeHolds(
  tx: Tx,
  orgId: string,
  mission: { id: string; startDate: string; endDate: string },
  assignments: Array<{ id: string; crewMemberId: string }>,
  now: Date,
): Promise<void> {
  if (assignments.length === 0) return;
  await tx.insert(schema.holds).values(
    assignments.map((a) => ({
      id: newId(),
      orgId,
      assignmentId: a.id,
      crewMemberId: a.crewMemberId,
      missionId: mission.id,
      period:
        sql`daterange(${mission.startDate}::date, ${mission.endDate}::date, '[]')` as unknown as string,
      createdAt: now,
    })),
  );
}

/** Releases the live holds of a mission, keeping them as history (they are never deleted). */
export async function releaseHolds(
  tx: Tx,
  missionId: string,
  reason: ReleaseReason,
  now: Date,
): Promise<number> {
  const released = await tx
    .update(schema.holds)
    .set({ releasedAt: now, releaseReason: reason })
    .where(and(eq(schema.holds.missionId, missionId), isNull(schema.holds.releasedAt)))
    .returning({ id: schema.holds.id });
  return released.length;
}
