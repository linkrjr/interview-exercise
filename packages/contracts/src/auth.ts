import { z } from 'zod';
import { ErrorCodes } from './codes.js';
import { RoleSchema } from './role.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PasswordSchema = z
  .string()
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => value.length >= PASSWORD_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    params: { code: ErrorCodes.PASSWORD_TOO_SHORT },
  });

export const EmailSchema = z.string().trim().max(254).pipe(z.email());

export const LoginRequestSchema = z.object({
  orgId: z.uuid(),
  email: EmailSchema,
  // Not length-checked on login: a wrong password is just a failed login.
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1).max(512) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const LogoutRequestSchema = RefreshRequestSchema;
export type LogoutRequest = RefreshRequest;

export const AcceptInviteRequestSchema = z.object({
  code: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(200),
  password: PasswordSchema,
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;

/** Returned by login, refresh and accept-invite. */
export const SessionSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  orgId: z.uuid(),
  userId: z.uuid(),
  role: RoleSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const MeResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string(),
    name: z.string().nullable(),
    role: RoleSchema,
  }),
  org: z.object({ id: z.uuid(), name: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
