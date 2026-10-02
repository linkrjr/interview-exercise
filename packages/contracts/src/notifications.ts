import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';

/** In-app notification types (DESIGN.md §17). */
export const NOTIFICATION_TYPES = [
  'mission.submitted',
  'mission.approved',
  'mission.rejected',
  'mission.expired',
  'mission.assigned',
  'mission.cancelled',
] as const;
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(25),
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;
