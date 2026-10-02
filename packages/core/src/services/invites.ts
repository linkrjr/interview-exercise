import { newId, schema, type PlatformTx, type Tx } from '@mc/db';
import { formatToken, generateSecret, sha256Hex } from '../crypto/secrets.js';

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export interface IssuedInvite {
  /** `<orgId>.<secret>`; shown once, only the hash of the secret is stored. */
  code: string;
  expiresAt: Date;
}

/**
 * Creates a fresh invite for a user. Only the newest invite of a user is valid when accepted, so
 * issuing another one invalidates all earlier codes without needing to update them.
 */
export async function issueInvite(
  tx: Tx | PlatformTx,
  orgId: string,
  userId: string,
  now: Date,
): Promise<IssuedInvite> {
  const secret = generateSecret();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await tx.insert(schema.invites).values({
    id: newId(),
    orgId,
    userId,
    codeHash: sha256Hex(secret),
    expiresAt,
    createdAt: now,
  });
  return { code: formatToken(orgId, secret), expiresAt };
}
