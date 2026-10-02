import type { Session } from '@mc/contracts';
import { newId, schema, type Tx } from '@mc/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { AccessTokenService } from '../auth/access-tokens.js';
import { formatToken, generateSecret, sha256Hex } from '../crypto/secrets.js';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type UserRow = typeof schema.users.$inferSelect;

/** Issues an access token and a new single-use refresh token in the given session family. */
export async function issueSession(
  tx: Tx,
  accessTokens: AccessTokenService,
  user: Pick<UserRow, 'id' | 'orgId' | 'role'>,
  now: Date,
  familyId: string = newId(),
): Promise<Session> {
  const secret = generateSecret();
  await tx.insert(schema.refreshTokens).values({
    id: newId(),
    orgId: user.orgId,
    userId: user.id,
    familyId,
    tokenHash: sha256Hex(secret),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    createdAt: now,
  });
  return {
    accessToken: await accessTokens.sign({
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
    }),
    expiresIn: accessTokens.ttlSeconds,
    refreshToken: formatToken(user.orgId, secret),
    orgId: user.orgId,
    userId: user.id,
    role: user.role,
  };
}

/** Revokes every live refresh token of a session family. */
export async function revokeFamily(tx: Tx, orgId: string, familyId: string, now: Date) {
  await tx
    .update(schema.refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.refreshTokens.orgId, orgId),
        eq(schema.refreshTokens.familyId, familyId),
        isNull(schema.refreshTokens.revokedAt),
      ),
    );
}

/** Revokes every live refresh token of a user (role change, deactivation). */
export async function revokeUserSessions(tx: Tx, orgId: string, userId: string, now: Date) {
  await tx
    .update(schema.refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(schema.refreshTokens.orgId, orgId),
        eq(schema.refreshTokens.userId, userId),
        isNull(schema.refreshTokens.revokedAt),
      ),
    );
}
