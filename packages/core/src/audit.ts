import type { Tx } from '@mc/db';

/** What a mutating service call records (DESIGN.md §15, §17). The organisation comes from `tx`. */
export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** The acting user, or `null` for the system actor. */
  actorId: string | null;
}

/**
 * Port for audit writing. Every mutating service call writes an event in the same transaction as
 * the change (DESIGN.md §17, §21). The database-backed implementation is delivered by Spec 03;
 * until then, specs 02+ call this port against `InMemoryAuditWriter`.
 */
export interface AuditWriter {
  record(tx: Tx, event: AuditEventInput): Promise<void>;
}
