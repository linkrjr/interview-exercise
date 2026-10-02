import type {
  Actor,
  ListNotificationsQuery,
  Notification,
  NotificationType,
  Page,
} from '@mc/contracts';
import { newId, schema, type Db, type Tx } from '@mc/db';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { notFound } from '../errors.js';
import { decodeCursor, toPage } from '../pagination.js';
import type { Policy } from '../policy/index.js';
import type { Clock } from '../clock.js';
import { userOrg } from '../services/org-settings-service.js';

type Row = typeof schema.notifications.$inferSelect;

const toNotification = (row: Row): Notification => ({
  id: row.id,
  type: row.type,
  payload: row.payload as Record<string, unknown>,
  readAt: row.readAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export interface NotificationServiceDeps {
  db: Db;
  clock: Clock;
  policy: Policy;
}

/** The in-app inbox (DESIGN.md §17): written inside the transaction of the change that causes it. */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /** Adds one notification per recipient (duplicates are ignored). Call inside the causing transaction. */
  async notify(
    tx: Tx,
    userIds: string[],
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipients = [...new Set(userIds)];
    if (recipients.length === 0) return;
    const now = this.deps.clock.now();
    // The organisation is the transaction's own (`app.org_id`), as for audit events: no lookup.
    const orgId = sql`NULLIF(current_setting('app.org_id', true), '')::uuid` as unknown as string;
    await tx
      .insert(schema.notifications)
      .values(
        recipients.map((userId) => ({ id: newId(), orgId, userId, type, payload, createdAt: now })),
      );
  }

  async list(actor: Actor, query: ListNotificationsQuery): Promise<Page<Notification>> {
    const { db, policy } = this.deps;
    policy.authorize(actor, 'notification.read');
    const me = (actor as { userId: string }).userId;
    const before = query.cursor ? decodeCursor(query.cursor) : undefined;
    return db.withTenant(userOrg(actor), async (tx) => {
      const rows = await tx
        .select()
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.userId, me),
            query.unread ? isNull(schema.notifications.readAt) : undefined,
            before ? lt(schema.notifications.id, before) : undefined,
          ),
        )
        .orderBy(desc(schema.notifications.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, toNotification);
    });
  }

  /** Marks one of the caller's own notifications as read. Idempotent; anyone else's is a 404. */
  async markRead(actor: Actor, id: string): Promise<Notification> {
    const { db, clock, policy } = this.deps;
    policy.authorize(actor, 'notification.read');
    const me = (actor as { userId: string }).userId;
    return db.withTenant(userOrg(actor), async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, me)))
        .limit(1);
      if (!row) throw notFound('Notification');
      if (row.readAt) return toNotification(row);
      const [updated] = await tx
        .update(schema.notifications)
        .set({ readAt: clock.now() })
        .where(eq(schema.notifications.id, id))
        .returning();
      return toNotification(updated!);
    });
  }
}
