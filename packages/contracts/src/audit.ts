import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';

export const AuditEventSchema = z.object({
  id: z.uuid(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid(),
  /** `null` is the system actor. */
  actorId: z.uuid().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  occurredAt: z.iso.datetime(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** A bare ISO date means the start of that day in UTC; a full timestamp is taken as given. */
const DateOrTimestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export function parseDateOrTimestamp(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
}

export const ListAuditQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
  /** `<entityType>:<entityId>`, e.g. `mission:0199…`. */
  entity: z
    .string()
    .regex(
      /^[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'Expected <entityType>:<entityId>',
    )
    .optional(),
  /** A user id, or `system`. */
  actor: z.union([z.uuid(), z.literal('system')]).optional(),
  /** Events at or after this instant. */
  since: DateOrTimestamp.optional(),
  /** Events strictly before this instant. */
  until: DateOrTimestamp.optional(),
});
export type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;
