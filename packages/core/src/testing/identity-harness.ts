import type { Session } from '@mc/contracts';
import { createDb, newId, type Db } from '@mc/db';
import { generateKeyPairPem, AccessTokenService } from '../auth/access-tokens.js';
import type { Actor } from '@mc/contracts';
import type { Clock } from '../clock.js';
import type { PasswordHasher } from '../crypto/passwords.js';
import { InMemoryAuditWriter } from '../in-memory-audit-writer.js';
import { createIdentityServices, type IdentityServices } from '../identity.js';
import { silentLogger, type Logger } from '../logger.js';
import type { UserChangeGuard } from '../services/guards.js';

export const TEST_PASSWORD = 'correct horse battery staple';

/** A clock tests can move forward. */
export class TestClock implements Clock {
  constructor(private current = new Date('2026-10-02T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface IdentityHarness extends IdentityServices {
  db: Db;
  audit: InMemoryAuditWriter;
  clock: TestClock;
  accessTokens: AccessTokenService;
  close(): Promise<void>;
}

export interface HarnessUrls {
  tenant: string;
  platform: string;
  scheduler: string;
}

export async function createIdentityHarness(
  urls: HarnessUrls,
  options: { logger?: Logger; guards?: readonly UserChangeGuard[]; hasher?: PasswordHasher } = {},
): Promise<IdentityHarness> {
  const db = createDb({
    tenantUrl: urls.tenant,
    platformUrl: urls.platform,
    schedulerUrl: urls.scheduler,
    poolMax: 5,
  });
  const clock = new TestClock();
  const audit = new InMemoryAuditWriter();
  const accessTokens = await AccessTokenService.create({ ...(await generateKeyPairPem()), clock });
  const services = createIdentityServices({
    db,
    audit,
    clock,
    accessTokens,
    logger: options.logger ?? silentLogger,
    guards: options.guards,
    hasher: options.hasher,
  });
  return { ...services, db, audit, clock, accessTokens, close: () => db.close() };
}

export const uniqueEmail = (label: string): string => `${label}-${newId()}@test.space`;

export interface ProvisionedOrg {
  orgId: string;
  director: { userId: string; email: string; session: Session; actor: Actor & { kind: 'user' } };
}

/** Creates an organisation as the operator and activates its first Director, as the CLI flow does. */
export async function provisionOrganisation(
  h: Pick<IdentityHarness, 'platform' | 'auth'>,
  name = 'Lunar Research Lab',
): Promise<ProvisionedOrg> {
  const email = uniqueEmail('director');
  const created = await h.platform.createOrganisation({ name, directorEmail: email });
  const session = await h.auth.acceptInvite({
    code: created.invite.inviteCode,
    name: 'First Director',
    password: TEST_PASSWORD,
  });
  return {
    orgId: created.organisationId,
    director: {
      userId: created.directorUserId,
      email,
      session,
      actor: {
        kind: 'user',
        userId: created.directorUserId,
        orgId: created.organisationId,
        role: 'director',
      },
    },
  };
}

/** Invites a user as the given Director and activates them. */
export async function onboardUser(
  h: Pick<IdentityHarness, 'users' | 'auth'>,
  org: ProvisionedOrg,
  role: 'director' | 'lead' | 'crew',
  label = role,
) {
  const email = uniqueEmail(label);
  const invited = await h.users.invite(org.director.actor, { email, role });
  const session = await h.auth.acceptInvite({
    code: invited.invite.inviteCode,
    name: `${label} person`,
    password: TEST_PASSWORD,
  });
  return {
    userId: invited.user.id,
    email,
    session,
    actor: { kind: 'user', userId: invited.user.id, orgId: org.orgId, role } as Actor & {
      kind: 'user';
    },
  };
}
