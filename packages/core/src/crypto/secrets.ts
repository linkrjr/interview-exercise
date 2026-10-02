import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of randomness, URL-safe. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Hex SHA-256: how invite codes and refresh tokens are stored (never in clear). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refresh tokens and invite codes are `<orgId>.<secret>`: the organisation ID is a visible,
 * non-secret routing prefix so the token resolves through the tenant path (DESIGN.md §11, §12);
 * only the secret part is hashed and stored.
 */
export function formatToken(orgId: string, secret: string): string {
  return `${orgId}.${secret}`;
}

export function parseToken(token: string): { orgId: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const orgId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(orgId) || secret.length === 0) return null;
  return { orgId, secret };
}
