import { AppError, ErrorCodes } from '@mc/contracts';
import { schema, type Tx } from '@mc/db';
import { and, asc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';

type UserRow = typeof schema.users.$inferSelect;

/** What is about to happen to the target user. */
export interface UserChange {
  kind: 'deactivate' | 'role_change';
  from: UserRow;
}

/**
 * A guard blocks a deactivation or role change by throwing an `AppError`. All blocking
 * conditions (OQ-4) live behind this one function type, so they are easy to change. Spec 04 adds
 * the Crew (has holds) and Lead (owns non-terminal missions) guards to the list.
 */
export type UserChangeGuard = (tx: Tx, change: UserChange) => Promise<void>;

/** A Director cannot leave the Director role or be deactivated if they are the last active Director. */
export const lastActiveDirectorGuard: UserChangeGuard = async (tx, { from }) => {
  if (from.role !== 'director' || from.status !== 'active') return;
  // Lock every active Director so two concurrent changes cannot each see the other as remaining.
  const others = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.orgId, from.orgId),
        eq(schema.users.role, 'director'),
        eq(schema.users.status, 'active'),
        ne(schema.users.id, from.id),
      ),
    )
    .orderBy(asc(schema.users.id))
    .for('update');
  if (others.length === 0) {
    throw new AppError(
      ErrorCodes.LAST_ACTIVE_DIRECTOR,
      409,
      'The organisation must keep at least one active Director',
    );
  }
};

/** A Crew Member cannot be deactivated, or change role, while they are held on a mission (OQ-4). */
export const crewHasCommitmentsGuard: UserChangeGuard = async (tx, { from }) => {
  if (from.role !== 'crew') return;
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.holds)
    .where(and(eq(schema.holds.crewMemberId, from.id), isNull(schema.holds.releasedAt)))) as [
    { n: number },
  ];
  if (n > 0) {
    throw new AppError(
      ErrorCodes.USER_HAS_COMMITMENTS,
      409,
      'This crew member is committed to upcoming missions; ask the Mission Lead to re-crew or cancel first',
    );
  }
};

/** A Lead cannot be deactivated, or change role, while they own a mission that is not Completed or Cancelled (OQ-4). */
export const leadOwnsMissionsGuard: UserChangeGuard = async (tx, { from }) => {
  if (from.role !== 'lead') return;
  const [open] = await tx
    .select({ id: schema.missions.id })
    .from(schema.missions)
    .where(
      and(
        eq(schema.missions.leadId, from.id),
        notInArray(schema.missions.status, ['completed', 'cancelled']),
      ),
    )
    .limit(1);
  if (open) {
    throw new AppError(
      ErrorCodes.USER_OWNS_MISSIONS,
      409,
      'This Lead owns missions that are not finished; ownership transfer is not supported, so cancel or complete them first',
    );
  }
};

export const defaultUserChangeGuards: readonly UserChangeGuard[] = [
  lastActiveDirectorGuard,
  crewHasCommitmentsGuard,
  leadOwnsMissionsGuard,
];
