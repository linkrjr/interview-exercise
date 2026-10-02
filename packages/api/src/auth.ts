import { AppError, ErrorCodes, type Actor } from '@mc/contracts';
import { unauthenticated, type AccessTokenService, sha256Hex } from '@mc/core';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export type UserActor = Extract<Actor, { kind: 'user' }>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate` on routes that need a signed-in user. */
    actor?: UserActor;
  }
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, token, ...rest] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token && rest.length === 0 ? token : undefined;
}

/** Route hook: verifies the user's JWT access token and sets `request.actor`. */
export function authenticate(accessTokens: AccessTokenService) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearer(request);
    if (!token) throw unauthenticated();
    request.actor = await accessTokens.verify(token);
  };
}

/**
 * Route hook for `/v1/platform/*`: only the static operator token is accepted. User access tokens
 * are rejected here, and the operator token is rejected everywhere else (it is not a JWT).
 */
export function authenticateOperator(operatorToken: string) {
  const expected = Buffer.from(sha256Hex(operatorToken));
  return async (request: FastifyRequest): Promise<void> => {
    const token = bearer(request);
    // Compare fixed-length digests in constant time, so the token's length and prefix do not leak.
    const actual = Buffer.from(sha256Hex(token ?? ''));
    if (!token || !timingSafeEqual(actual, expected)) {
      throw new AppError(ErrorCodes.UNAUTHENTICATED, 401, 'Operator credential required');
    }
  };
}

export function requireActor(request: FastifyRequest): UserActor {
  if (!request.actor) throw unauthenticated();
  return request.actor;
}
