import {
  parseDateOrTimestamp,
  type Actor,
  type Alert,
  type ListAlertsQuery,
  type Page,
} from '@mc/contracts';
import { schema, type Db } from '@mc/db';
import { and, desc, gte, lt, sql, type SQL } from 'drizzle-orm';
import { decodeKeyCursor, encodeKeyCursor, isIsoTimestamp, isUuid } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import { userOrg } from './org-settings-service.js';

export interface AlertServiceDeps {
  db: Db;
  policy: Policy;
}

type Row = typeof schema.alerts.$inferSelect;

const toAlert = (row: Row): Alert => ({
  id: row.id,
  source: row.source as Alert['source'],
  code: row.code,
  message: row.message,
  details: row.details ?? null,
  occurredAt: row.occurredAt.toISOString(),
});

/** Reads the organisation's operational alerts (Directors only), newest first, paged by (time, id). */
export class AlertService {
  constructor(private readonly deps: AlertServiceDeps) {}

  async list(actor: Actor, query: ListAlertsQuery): Promise<Page<Alert>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'alert.read');

    const conditions: (SQL | undefined)[] = [];
    if (query.since)
      conditions.push(gte(schema.alerts.occurredAt, parseDateOrTimestamp(query.since)));
    if (query.until)
      conditions.push(lt(schema.alerts.occurredAt, parseDateOrTimestamp(query.until)));
    if (query.cursor) {
      const { t, id } = decodeKeyCursor(query.cursor, { t: isIsoTimestamp, id: isUuid });
      conditions.push(
        sql`(${schema.alerts.occurredAt}, ${schema.alerts.id}) < (${new Date(t)}, ${id})`,
      );
    }

    return db.withTenant(userOrg(actor), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.alerts)
        .where(and(...conditions))
        .orderBy(desc(schema.alerts.occurredAt), desc(schema.alerts.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map(toAlert),
        nextCursor:
          rows.length > query.limit && last
            ? encodeKeyCursor({ t: last.occurredAt.toISOString(), id: last.id })
            : null,
      };
    });
  }
}
