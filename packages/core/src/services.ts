import type { Db } from '@mc/db';
import type { AccessTokenService } from './auth/access-tokens.js';
import type { AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { PasswordHasher } from './crypto/passwords.js';
import type { Logger } from './logger.js';
import { policy as defaultPolicy, type Policy } from './policy/index.js';
import { AuditService } from './services/audit-service.js';
import { AuthService } from './services/auth-service.js';
import { CrewService } from './services/crew-service.js';
import { OrgSettingsService } from './services/org-settings-service.js';
import { SkillService } from './services/skill-service.js';
import type { UserChangeGuard } from './services/guards.js';
import { PlatformService } from './services/platform-service.js';
import { UserService } from './services/user-service.js';

export interface ServicesConfig {
  db: Db;
  audit: AuditWriter;
  clock: Clock;
  logger: Logger;
  accessTokens: AccessTokenService;
  hasher?: PasswordHasher;
  policy?: Policy;
  guards?: readonly UserChangeGuard[];
}

export interface Services {
  auth: AuthService;
  users: UserService;
  platform: PlatformService;
  settings: OrgSettingsService;
  skills: SkillService;
  crew: CrewService;
  /** Reads the audit log (the `audit` writer is a different thing: it records events). */
  auditLog: AuditService;
  policy: Policy;
}

/** Wires the identity services together; the API and the tests both build them this way. */
export function createServices(config: ServicesConfig): Services {
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
    settings: new OrgSettingsService({ db: config.db, audit: config.audit, policy }),
    skills: new SkillService({ db: config.db, audit: config.audit, clock: config.clock, policy }),
    crew: new CrewService({ db: config.db, audit: config.audit, clock: config.clock, policy }),
    auditLog: new AuditService({ db: config.db, policy }),
  };
}
