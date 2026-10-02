import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';

/** The stable codes alerts carry. */
export const AlertCodes = {
  /** The scheduler could not process an organisation; its changes for that run were rolled back. */
  SCHEDULER_RUN_FAILED: 'SCHEDULER_RUN_FAILED',
} as const;

export const AlertSchema = z.object({
  id: z.uuid(),
  source: z.enum(['scheduler']),
  code: z.string(),
  message: z.string(),
  /** Structured context (never secrets or personal data), e.g. the stage that failed. */
  details: z.unknown().nullable(),
  occurredAt: z.iso.datetime(),
});
export type Alert = z.infer<typeof AlertSchema>;

/** A bare ISO date means the start of that day in UTC; a full timestamp is taken as given. */
const DateOrTimestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export const ListAlertsQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
  /** Alerts at or after this instant. */
  since: DateOrTimestamp.optional(),
  /** Alerts strictly before this instant. */
  until: DateOrTimestamp.optional(),
});
export type ListAlertsQuery = z.infer<typeof ListAlertsQuerySchema>;
