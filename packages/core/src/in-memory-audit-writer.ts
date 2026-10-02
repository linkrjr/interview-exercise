import type { Tx } from '@mc/db';
import type { AuditEventInput, AuditWriter } from './audit.js';

/** Test double for `AuditWriter`: keeps the recorded events in memory. */
export class InMemoryAuditWriter implements AuditWriter {
  readonly events: AuditEventInput[] = [];

  async record(_tx: Tx, event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
  }

  /** Events recorded for one entity, in order. */
  forEntity(entityType: string, entityId: string): AuditEventInput[] {
    return this.events.filter((e) => e.entityType === entityType && e.entityId === entityId);
  }

  clear(): void {
    this.events.length = 0;
  }
}

/** Discards audit events. Used by the API until the database-backed writer (Spec 03) exists. */
export const noopAuditWriter: AuditWriter = {
  async record() {
    // intentionally empty
  },
};
