import { z } from 'zod';
import { MAX_PAGE_LIMIT } from './page.js';
import { EmailSchema } from './auth.js';
import { RoleSchema } from './role.js';

export const UserStatusSchema = z.enum(['invited', 'active', 'deactivated']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  /** Null until the invitee accepts the invite and supplies their name. */
  name: z.string().nullable(),
  role: RoleSchema,
  status: UserStatusSchema,
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const ListUsersQuerySchema = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(25),
});
export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const InviteUserRequestSchema = z.object({
  email: EmailSchema,
  role: RoleSchema,
});
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

/** One-time setup code, shown once; only its hash is stored. */
export const InviteSchema = z.object({
  inviteCode: z.string(),
  expiresAt: z.iso.datetime(),
});
export type Invite = z.infer<typeof InviteSchema>;

export const InviteUserResponseSchema = z.object({ user: UserSchema, invite: InviteSchema });
export type InviteUserResponse = z.infer<typeof InviteUserResponseSchema>;

export const UpdateUserRequestSchema = z
  .object({
    role: RoleSchema.optional(),
    status: z.literal('deactivated').optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'Provide a role or a status',
  });
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
