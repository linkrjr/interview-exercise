import { AppError, ErrorCodes } from '@mc/contracts';
import { schema, type Tx } from '@mc/db';
import { and, asc, eq, ne } from 'drizzle-orm';

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

export const defaultUserChangeGuards: readonly UserChangeGuard[] = [lastActiveDirectorGuard];
