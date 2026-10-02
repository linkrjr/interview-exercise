import type { Db } from '@mc/db';
import type { AccessTokenService } from './auth/access-tokens.js';
import type { AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { PasswordHasher } from './crypto/passwords.js';
import type { Logger } from './logger.js';
import { policy as defaultPolicy, type Policy } from './policy/index.js';
import { AuthService } from './services/auth-service.js';
import type { UserChangeGuard } from './services/guards.js';
import { PlatformService } from './services/platform-service.js';
import { UserService } from './services/user-service.js';

export interface IdentityConfig {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  logger: Logger;
  accessTokens: AccessTokenService;
  hasher?: PasswordHasher;
  policy?: Policy;
  guards?: readonly UserChangeGuard[];
}

export interface IdentityServices {
  auth: AuthService;
  users: UserService;
  platform: PlatformService;
  policy: Policy;
}

/** Wires the identity services together; the API and the tests both build them this way. */
export function createIdentityServices(config: IdentityConfig): IdentityServices {
  const hasher = config.hasher ?? new PasswordHasher();
  const policy = config.policy ?? defaultPolicy;
  return {
    policy,
    auth: new AuthService({ ...config, hasher }),
    users: new UserService({
      db: config.db,
      audit: config.audit,
      clock: config.clock,
      policy,
      guards: config.guards,
    }),
    platform: new PlatformService({ db: config.db, clock: config.clock }),
  };
}
