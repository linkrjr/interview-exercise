import {
  AppError,
  ErrorCodes,
  type AcceptInviteRequest,
  type LoginRequest,
  type Session,
} from '@mc/contracts';
import { schema, type Db, type Tx } from '@mc/db';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { AccessTokenService } from '../auth/access-tokens.js';
import type { AuditWriter } from '../audit.js';
import type { Clock } from '../clock.js';
import type { PasswordHasher } from '../crypto/passwords.js';
import { parseToken, sha256Hex } from '../crypto/secrets.js';
import type { Logger } from '../logger.js';
import { issueSession, revokeFamily } from './sessions.js';

export interface AuthDeps {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  logger: Logger;
  accessTokens: AccessTokenService;
  hasher: PasswordHasher;
}

const invalidCredentials = () =>
  new AppError(ErrorCodes.INVALID_CREDENTIALS, 401, 'Invalid credentials');
const invalidRefreshToken = () =>
  new AppError(ErrorCodes.INVALID_REFRESH_TOKEN, 401, 'The refresh token is invalid or expired');
const refreshTokenReused = () =>
  new AppError(
    ErrorCodes.REFRESH_TOKEN_REUSED,
    401,
    'The refresh token was already used; the session has been revoked',
  );
type RefreshTokenRow = typeof schema.refreshTokens.$inferSelect;

/** True when a newer token exists in the same session family (ordered by creation time, then id). */
async function hasSuccessor(tx: Tx, row: RefreshTokenRow): Promise<boolean> {
  const [newer] = await tx
    .select({ id: schema.refreshTokens.id })
    .from(schema.refreshTokens)
    .where(
      and(
        eq(schema.refreshTokens.familyId, row.familyId),
        or(
          gt(schema.refreshTokens.createdAt, row.createdAt),
          and(
            eq(schema.refreshTokens.createdAt, row.createdAt),
            gt(schema.refreshTokens.id, row.id),
          ),
        ),
      ),
    )
    .limit(1);
  return Boolean(newer);
}

const invalidInvite = () =>
  new AppError(ErrorCodes.INVALID_INVITE, 400, 'The invite code is invalid or has expired');

/** Login, refresh, logout and accept-invite. All of them run through `withTenant` (DESIGN.md §11, §12). */
export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  async login(input: LoginRequest): Promise<Session> {
    const { db, audit, clock, logger, accessTokens, hasher } = this.deps;
    const outcome = await db.withTenant(input.orgId, async (tx) => {
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, input.email))
        .limit(1);
      // Always run a full verification so timing does not reveal whether the user exists.
      const passwordOk = await hasher.verify(user?.passwordHash, input.password);
      if (!user || !passwordOk || user.status !== 'active') {
        if (user) {
          await audit.record(tx, {
            action: 'auth.login_failed',
            entityType: 'user',
            entityId: user.id,
            after: { reason: passwordOk ? 'inactive' : 'bad_password' },
            actorId: null,
          });
        }
        return { ok: false as const, knownUser: Boolean(user) };
      }
      return {
        ok: true as const,
        session: await issueSession(tx, accessTokens, user, clock.now()),
      };
    });
    if (!outcome.ok) {
      // Failures for unknown organisations or emails have no tenant to audit in: log only.
      logger.warn(
        { event: 'login_failed', orgId: input.orgId, knownUser: outcome.knownUser },
        'login failed',
      );
      throw invalidCredentials();
    }
    return outcome.session;
  }

  async refresh(refreshToken: string): Promise<Session> {
    const { db, audit, clock, accessTokens } = this.deps;
    const parsed = parseToken(refreshToken);
    if (!parsed) throw invalidRefreshToken();
    const now = clock.now();

    const outcome = await db.withTenant(parsed.orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256Hex(parsed.secret)))
        .limit(1);
      if (!row) return { kind: 'invalid' as const };

      const reuse = async () => {
        await revokeFamily(tx, row.orgId, row.familyId, now);
        await audit.record(tx, {
          action: 'auth.refresh_token_reuse_detected',
          entityType: 'user',
          entityId: row.userId,
          actorId: null,
        });
        return { kind: 'reused' as const };
      };

      if (row.revokedAt) {
        // A token that was rotated has a successor in its family: presenting it again means a
        // copy escaped, which is theft. A token revoked by logout, a role change or a
        // deactivation has none (it was the newest), and is merely no longer valid.
        return (await hasSuccessor(tx, row)) ? reuse() : { kind: 'invalid' as const };
      }
      if (row.expiresAt <= now) return { kind: 'invalid' as const };

      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, row.userId))
        .limit(1);
      if (!user || user.status !== 'active') {
        await revokeFamily(tx, row.orgId, row.familyId, now);
        return { kind: 'invalid' as const };
      }

      // Claim the token atomically: of two concurrent refreshes with the same token, one loses.
      const claimed = await tx
        .update(schema.refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(schema.refreshTokens.id, row.id), isNull(schema.refreshTokens.revokedAt)))
        .returning({ id: schema.refreshTokens.id });
      if (claimed.length === 0) return reuse();

      return {
        kind: 'ok' as const,
        session: await issueSession(tx, accessTokens, user, now, row.familyId),
      };
    });

    if (outcome.kind === 'reused') throw refreshTokenReused();
    if (outcome.kind === 'invalid') throw invalidRefreshToken();
    return outcome.session;
  }

  /** Revokes the whole session family of the token. Idempotent; unknown tokens are ignored. */
  async logout(refreshToken: string): Promise<void> {
    const { db, clock } = this.deps;
    const parsed = parseToken(refreshToken);
    if (!parsed) return;
    await db.withTenant(parsed.orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, sha256Hex(parsed.secret)))
        .limit(1);
      if (row) await revokeFamily(tx, row.orgId, row.familyId, clock.now());
    });
  }

  /**
   * Activates an invited user and signs them in. Unknown, used, expired and superseded codes are
   * indistinguishable. The invite is validated before the (expensive) password hash is computed,
   * so requests with bad codes cost one cheap lookup, and again when it is claimed.
   */
  async acceptInvite(input: AcceptInviteRequest): Promise<Session> {
    const { db, audit, clock, accessTokens, hasher } = this.deps;
    const parsed = parseToken(input.code);
    if (!parsed) throw invalidInvite();
    const now = clock.now();

    const acceptable = await db.withTenant(parsed.orgId, (tx) =>
      findAcceptableInvite(tx, parsed.secret, now),
    );
    if (!acceptable) throw invalidInvite();

    const passwordHash = await hasher.hash(input.password);

    const session = await db.withTenant(parsed.orgId, async (tx) => {
      // The invite may have been used or superseded while the password was being hashed.
      const found = await findAcceptableInvite(tx, parsed.secret, now);
      if (!found) return null;
      const { invite, user } = found;

      // Claim the invite atomically so a code cannot be accepted twice concurrently.
      const claimed = await tx
        .update(schema.invites)
        .set({ usedAt: now })
        .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.usedAt)))
        .returning({ id: schema.invites.id });
      if (claimed.length === 0) return null;

      const [activated] = await tx
        .update(schema.users)
        .set({ name: input.name, passwordHash, status: 'active' })
        .where(eq(schema.users.id, user.id))
        .returning();
      await audit.record(tx, {
        action: 'auth.invite_accepted',
        entityType: 'user',
        entityId: user.id,
        before: { status: 'invited' },
        after: { status: 'active' },
        actorId: user.id,
      });
      return issueSession(tx, accessTokens, activated!, now);
    });

    if (!session) throw invalidInvite();
    return session;
  }
}

/**
 * The invite for this code secret, with its user, if it can still be accepted: not used, not
 * expired, its user still `invited`, and no newer invite issued for that user.
 */
async function findAcceptableInvite(tx: Tx, secret: string, now: Date) {
  const [invite] = await tx
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.codeHash, sha256Hex(secret)))
    .limit(1);
  if (!invite || invite.usedAt || invite.expiresAt <= now) return null;

  const [user] = await tx
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, invite.userId))
    .limit(1);
  if (!user || user.status !== 'invited') return null;

  // Only the newest invite of the user is valid; re-issuing supersedes earlier codes.
  const [newer] = await tx
    .select({ id: schema.invites.id })
    .from(schema.invites)
    .where(
      and(
        eq(schema.invites.userId, invite.userId),
        or(
          gt(schema.invites.createdAt, invite.createdAt),
          and(eq(schema.invites.createdAt, invite.createdAt), gt(schema.invites.id, invite.id)),
        ),
      ),
    )
    .limit(1);
  return newer ? null : { invite, user };
}
