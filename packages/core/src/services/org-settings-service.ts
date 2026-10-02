import type { Actor, OrgSettings, UpdateOrgSettingsRequest } from '@mc/contracts';
import { AppError, ErrorCodes } from '@mc/contracts';
import { schema, type Db, type Tx } from '@mc/db';
import { eq } from 'drizzle-orm';
import type { AuditWriter } from '../audit.js';
import { notFound } from '../errors.js';
import type { Policy } from '../policy/index.js';

/** The organisation's settings, as seen by the tenant of `tx` (Row-level security picks the row). */
export async function getOrgSettings(tx: Tx): Promise<OrgSettings> {
  const [org] = await tx
    .select({
      timeZone: schema.organisations.timeZone,
      maxUpcomingMissions: schema.organisations.maxUpcomingMissions,
    })
    .from(schema.organisations)
    .limit(1);
  if (!org) throw notFound('Organisation');
  return org;
}

export interface OrgSettingsServiceDeps {
  db: Db;
  audit: AuditWriter;
  policy: Policy;
}

export class OrgSettingsService {
  constructor(private readonly deps: OrgSettingsServiceDeps) {}

  async get(actor: Actor): Promise<OrgSettings> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'org.settings.read');
    return db.withTenant(userOrg(actor), (tx) => getOrgSettings(tx));
  }

  /** Changing the cap never touches existing holds: it applies to new submissions only (§5.2). */
  async update(actor: Actor, patch: UpdateOrgSettingsRequest): Promise<OrgSettings> {
    const { db, audit, policy } = this.deps;
    policy.authorize(actor, 'org.settings.update');
    const orgId = userOrg(actor);
    return db.withTenant(orgId, async (tx) => {
      const [current] = await tx
        .select({
          timeZone: schema.organisations.timeZone,
          maxUpcomingMissions: schema.organisations.maxUpcomingMissions,
        })
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId))
        .for('update');
      if (!current) throw notFound('Organisation');

      const next = {
        timeZone: patch.timeZone ?? current.timeZone,
        maxUpcomingMissions: patch.maxUpcomingMissions ?? current.maxUpcomingMissions,
      };
      const before: Partial<OrgSettings> = {};
      const after: Partial<OrgSettings> = {};
      if (next.timeZone !== current.timeZone) {
        before.timeZone = current.timeZone;
        after.timeZone = next.timeZone;
      }
      if (next.maxUpcomingMissions !== current.maxUpcomingMissions) {
        before.maxUpcomingMissions = current.maxUpcomingMissions;
        after.maxUpcomingMissions = next.maxUpcomingMissions;
      }
      if (Object.keys(after).length === 0) return current;

      await tx.update(schema.organisations).set(next).where(eq(schema.organisations.id, orgId));
      await audit.record(tx, {
        action: 'org.settings_updated',
        entityType: 'organisation',
        entityId: orgId,
        before,
        after,
        actorId: actor.kind === 'user' ? actor.userId : null,
      });
      return next;
    });
  }
}

/** The organisation of a signed-in user. The policy has already refused the system actor. */
export function userOrg(actor: Actor): string {
  if (actor.kind !== 'user') throw new AppError(ErrorCodes.FORBIDDEN, 403, 'A user is required');
  return actor.orgId;
}
