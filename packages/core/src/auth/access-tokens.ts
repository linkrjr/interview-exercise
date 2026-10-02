import { AppError, ErrorCodes, RoleSchema, type Actor } from '@mc/contracts';
import {
  SignJWT,
  errors,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  type CryptoKey,
} from 'jose';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ALG = 'EdDSA';

const ClaimsSchema = z.object({
  sub: z.uuid(),
  org: z.uuid(),
  role: RoleSchema,
});

export interface AccessTokenConfig {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Key id placed in the JWT header so keys can be rotated later. */
  kid?: string;
  ttlSeconds?: number;
  clock?: Clock;
}

export interface KeyPairPem {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Generates an EdDSA key pair as PEM, for development and tests. */
export async function generateKeyPairPem(): Promise<KeyPairPem> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  return {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
  };
}

/** Short-lived EdDSA JWT access tokens with `sub`, `org`, `role`, `iat` and `exp` (DESIGN.md §12). */
export class AccessTokenService {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    private readonly kid: string,
    readonly ttlSeconds: number,
    private readonly clock: Clock,
  ) {}

  static async create(config: AccessTokenConfig): Promise<AccessTokenService> {
    return new AccessTokenService(
      await importPKCS8(config.privateKeyPem, ALG),
      await importSPKI(config.publicKeyPem, ALG),
      config.kid ?? 'mc-1',
      config.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS,
      config.clock ?? systemClock,
    );
  }

  sign(claims: { userId: string; orgId: string; role: string }): Promise<string> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    return new SignJWT({ org: claims.orgId, role: claims.role })
      .setProtectedHeader({ alg: ALG, kid: this.kid })
      .setSubject(claims.userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.ttlSeconds)
      .sign(this.privateKey);
  }

  /** Verifies signature, algorithm and expiry, and returns the actor. Throws 401 otherwise. */
  async verify(token: string): Promise<Extract<Actor, { kind: 'user' }>> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: [ALG],
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp'],
      });
      const claims = ClaimsSchema.parse(payload);
      return { kind: 'user', userId: claims.sub, orgId: claims.org, role: claims.role };
    } catch (error) {
      const expired = error instanceof errors.JWTExpired;
      throw new AppError(
        ErrorCodes.UNAUTHENTICATED,
        401,
        expired ? 'The access token has expired' : 'Invalid access token',
      );
    }
  }
}
