import {
  AppError,
  ErrorCodes,
  type Actor,
  type InviteUserRequest,
  type InviteUserResponse,
  type ListUsersQuery,
  type MeResponse,
  type Page,
  type UpdateUserRequest,
  type User,
} from '@mc/contracts';
import { newId, schema, type Db } from '@mc/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import { isUniqueViolation, notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { defaultUserChangeGuards, type UserChangeGuard } from './guards.js';
import { issueInvite } from './invites.js';
import { revokeUserSessions } from './sessions.js';

type UserRow = typeof schema.users.$inferSelect;

export interface UserServiceDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  policy: Policy;
  /** Blocking conditions for deactivation and role change (OQ-4); Spec 04 appends its own. */
  guards?: readonly UserChangeGuard[];
}

export const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

function userActor(actor: Actor) {
  if (actor.kind !== 'user') throw new AppError(ErrorCodes.FORBIDDEN, 403, 'A user is required');
  return actor;
}

export class UserService {
  private readonly guards: readonly UserChangeGuard[];

  constructor(private readonly deps: UserServiceDeps) {
    this.guards = deps.guards ?? defaultUserChangeGuards;
  }

  async me(actor: Actor): Promise<MeResponse> {
    const { db, policy } = this.deps;
    const caller = userActor(actor);
    policy.authorize(caller, 'me.read');
    return db.withTenant(caller.orgId, async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, caller.userId))
        .limit(1);
      const [org] = await tx.select().from(schema.organisations).limit(1);
      if (!user || !org) throw notFound('User');
      return {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        org: { id: org.id, name: org.name },
      };
    });
  }

  async list(actor: Actor, query: ListUsersQuery): Promise<Page<User>> {
    const { db, policy } = this.deps;
    const caller = userActor(actor);
    policy.authorize(caller, 'user.list');
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    return db.withTenant(caller.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.users)
        .where(after ? gt(schema.users.id, after) : undefined)
        .orderBy(asc(schema.users.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toUser);
    });
  }

  async invite(actor: Actor, input: InviteUserRequest): Promise<InviteUserResponse> {
    const { db, audit, clock, policy } = this.deps;
    const caller = userActor(actor);
    policy.authorize(caller, 'user.invite');
    const now = clock.now();
    try {
      return await db.withTenant(caller.orgId, async (tx) => {
        const [user] = await tx
          .insert(schema.users)
          .values({
            id: newId(),
            orgId: caller.orgId,
            email: input.email,
            role: input.role,
            status: 'invited',
            createdAt: now,
          })
          .returning();
        if (input.role === 'crew') {
          await tx.insert(schema.crewProfiles).values({ userId: user!.id, orgId: caller.orgId });
        }
        const invite = await issueInvite(tx, caller.orgId, user!.id, now);
        await audit.record(tx, {
          action: 'user.invited',
          entityType: 'user',
          entityId: user!.id,
          after: { role: user!.role, status: user!.status },
          actorId: caller.userId,
        });
        return {
          user: toUser(user!),
          invite: { inviteCode: invite.code, expiresAt: invite.expiresAt.toISOString() },
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new AppError(
          ErrorCodes.EMAIL_ALREADY_REGISTERED,
          409,
          'That email address is already registered',
        );
      }
      throw error;
    }
  }

  /** Issues a fresh invite for a user who has not accepted yet; earlier codes stop working. */
  async reinvite(actor: Actor, userId: string): Promise<InviteUserResponse['invite']> {
    const { db, audit, clock, policy } = this.deps;
    const caller = userActor(actor);
    policy.authorize(caller, 'user.reinvite');
    const now = clock.now();
    return db.withTenant(caller.orgId, async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!user) throw notFound('User');
      if (user.status !== 'invited') {
        throw new AppError(
          ErrorCodes.USER_NOT_INVITED,
          409,
          'Only users who have not accepted their invite can be re-invited',
        );
      }
      const invite = await issueInvite(tx, caller.orgId, user.id, now);
      await audit.record(tx, {
        action: 'user.invite_reissued',
        entityType: 'user',
        entityId: user.id,
        actorId: caller.userId,
      });
      return { inviteCode: invite.code, expiresAt: invite.expiresAt.toISOString() };
    });
  }

  /** Changes a user's role and/or deactivates them. Both revoke the user's refresh tokens. */
  async update(actor: Actor, userId: string, input: UpdateUserRequest): Promise<User> {
    const { db, audit, clock, policy } = this.deps;
    const caller = userActor(actor);
    policy.authorize(caller, 'user.update');
    const now = clock.now();

    return db.withTenant(caller.orgId, async (tx) => {
      const [target] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1)
        .for('update');
      if (!target) throw notFound('User');

      const changesRole = input.role !== undefined && input.role !== target.role;
      const deactivates = input.status === 'deactivated' && target.status !== 'deactivated';
      if (!changesRole && !deactivates) return toUser(target);

      if (changesRole && input.role === 'crew') {
        throw new AppError(
          ErrorCodes.ROLE_CHANGE_TO_CREW_NOT_ALLOWED,
          409,
          'A user cannot be changed to the Crew role',
        );
      }

      const guardChanges = [
        ...(changesRole ? [{ kind: 'role_change' as const, from: target }] : []),
        ...(deactivates ? [{ kind: 'deactivate' as const, from: target }] : []),
      ];
      for (const change of guardChanges) {
        for (const guard of this.guards) await guard(tx, change);
      }

      const [updated] = await tx
        .update(schema.users)
        .set({
          ...(changesRole ? { role: input.role! } : {}),
          ...(deactivates ? { status: 'deactivated' as const } : {}),
        })
        .where(and(eq(schema.users.id, target.id)))
        .returning();
      await revokeUserSessions(tx, caller.orgId, target.id, now);

      if (changesRole) {
        await audit.record(tx, {
          action: 'user.role_changed',
          entityType: 'user',
          entityId: target.id,
          before: { role: target.role },
          after: { role: updated!.role },
          actorId: caller.userId,
        });
      }
      if (deactivates) {
        await audit.record(tx, {
          action: 'user.deactivated',
          entityType: 'user',
          entityId: target.id,
          before: { status: target.status },
          after: { status: 'deactivated' },
          actorId: caller.userId,
        });
      }
      return toUser(updated!);
    });
  }
}
