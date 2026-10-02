import { newId, schema, type Tx } from '@mc/db';
import { sql } from 'drizzle-orm';
import type { AuditEventInput, AuditWriter } from '../audit.js';
import { systemClock, type Clock } from '../clock.js';

// Payloads are readable by Directors and must never carry credentials (DESIGN.md §18).
const FORBIDDEN_KEY = /password|token|secret|hash|invite_?code/i;

function assertNoSecrets(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`Audit ${path}.${key} looks like a secret`);
      assertNoSecrets(inner, `${path}.${key}`);
    }
  }
}

/**
 * Writes audit events into `audit_events` through the caller's transaction, so an event exists
 * if and only if the change it describes committed (DESIGN.md §17). The organisation comes from
 * the transaction's `app.org_id`, never from the event.
 */
export class DbAuditWriter implements AuditWriter {
  constructor(private readonly clock: Clock = systemClock) {}

  async record(tx: Tx, event: AuditEventInput): Promise<void> {
    assertNoSecrets(event.before, 'before');
    assertNoSecrets(event.after, 'after');
    await tx.insert(schema.auditEvents).values({
      id: newId(),
      orgId: sql`NULLIF(current_setting('app.org_id', true), '')::uuid` as unknown as string,
      actorId: event.actorId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      before: event.before ?? null,
      after: event.after ?? null,
      occurredAt: this.clock.now(),
    });
  }
}
