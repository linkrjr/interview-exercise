import {
  parseDateOrTimestamp,
  type Actor,
  type AuditEvent,
  type ListAuditQuery,
  type Page,
} from '@mc/contracts';
import { schema, type Db } from '@mc/db';
import { and, desc, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { decodeKeyCursor, encodeKeyCursor, isIsoTimestamp, isUuid } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { userOrg } from './org-settings-service.js';

export interface AuditServiceDeps {
  db: Db;
  policy: Policy;
}

type Row = typeof schema.auditEvents.$inferSelect;

const toEvent = (row: Row): AuditEvent => ({
  id: row.id,
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  actorId: row.actorId,
  before: row.before ?? null,
  after: row.after ?? null,
  occurredAt: row.occurredAt.toISOString(),
});

/** Reads the audit log (Directors only), newest first, paged by (time, id). */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async list(actor: Actor, query: ListAuditQuery): Promise<Page<AuditEvent>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'audit.read');

    const conditions: (SQL | undefined)[] = [];
    if (query.entity) {
      const [type, id] = query.entity.split(':') as [string, string];
      conditions.push(eq(schema.auditEvents.entityType, type), eq(schema.auditEvents.entityId, id));
    }
    if (query.actor === 'system') conditions.push(isNull(schema.auditEvents.actorId));
    else if (query.actor) conditions.push(eq(schema.auditEvents.actorId, query.actor));
    if (query.since)
      conditions.push(gte(schema.auditEvents.occurredAt, parseDateOrTimestamp(query.since)));
    if (query.until)
      conditions.push(lt(schema.auditEvents.occurredAt, parseDateOrTimestamp(query.until)));
    if (query.cursor) {
      // Both keys are checked here: a bad id would otherwise reach Postgres as an invalid uuid.
      const { t, id } = decodeKeyCursor(query.cursor, { t: isIsoTimestamp, id: isUuid });
      conditions.push(
        sql`(${schema.auditEvents.occurredAt}, ${schema.auditEvents.id}) < (${new Date(t)}, ${id})`,
      );
    }

    return db.withTenant(userOrg(actor), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.auditEvents)
        .where(and(...conditions))
        .orderBy(desc(schema.auditEvents.occurredAt), desc(schema.auditEvents.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(toEvent),
        nextCursor:
          rows.length > query.limit && last
            ? encodeKeyCursor({ t: last.occurredAt.toISOString(), id: last.id })
            : null,
      };
    });
  }
}
