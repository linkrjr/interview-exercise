import { describe, expect, it } from 'vitest';
import {
  AcceptInviteRequestSchema,
  CreateOrganisationRequestSchema,
  InviteUserRequestSchema,
  ListUsersQuerySchema,
  LoginRequestSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordSchema,
  ReissueInviteRequestSchema,
  UpdateUserRequestSchema,
} from './index.js';

const ORG = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';

describe('PasswordSchema', () => {
  it('accepts exactly 12 to 128 characters', () => {
    expect(PasswordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(PasswordSchema.safeParse('x'.repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(PasswordSchema.safeParse('x'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(PasswordSchema.safeParse('x'.repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('reports a stable code for a short password', () => {
    const issue = PasswordSchema.safeParse('short').error?.issues[0] as {
      params?: { code?: string };
    };
    expect(issue.params?.code).toBe('PASSWORD_TOO_SHORT');
  });
});

describe('LoginRequestSchema', () => {
  it('requires a UUID organisation, a valid email (trimmed) and a password', () => {
    expect(LoginRequestSchema.parse({ orgId: ORG, email: '  a@b.space ', password: 'x' })).toEqual({
      orgId: ORG,
      email: 'a@b.space',
      password: 'x',
    });
    for (const bad of [
      { orgId: 'nope', email: 'a@b.space', password: 'x' },
      { orgId: ORG, email: 'not-an-email', password: 'x' },
      { orgId: ORG, email: 'a@b.space', password: '' },
      { email: 'a@b.space', password: 'x' },
    ]) {
      expect(LoginRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('does not apply the new-password length rule to logins', () => {
    expect(
      LoginRequestSchema.safeParse({ orgId: ORG, email: 'a@b.space', password: 'abc' }).success,
    ).toBe(true);
  });
});

describe('AcceptInviteRequestSchema', () => {
  it('needs a code, a non-empty name and a valid password', () => {
    const ok = { code: `${ORG}.s`, name: ' Ada ', password: 'x'.repeat(12) };
    expect(AcceptInviteRequestSchema.parse(ok).name).toBe('Ada');
    expect(AcceptInviteRequestSchema.safeParse({ ...ok, name: '  ' }).success).toBe(false);
    expect(AcceptInviteRequestSchema.safeParse({ ...ok, password: 'short' }).success).toBe(false);
  });
});

describe('user and platform requests', () => {
  it('accepts only the three roles when inviting', () => {
    expect(InviteUserRequestSchema.safeParse({ email: 'a@b.space', role: 'crew' }).success).toBe(
      true,
    );
    expect(
      InviteUserRequestSchema.safeParse({ email: 'a@b.space', role: 'operator' }).success,
    ).toBe(false);
  });

  it('needs a role or a deactivation in an update, and nothing else', () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ role: 'lead' }).success).toBe(true);
    expect(UpdateUserRequestSchema.safeParse({ status: 'deactivated' }).success).toBe(true);
    expect(UpdateUserRequestSchema.safeParse({ status: 'active' }).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ role: 'lead', status: 'deactivated' }).success).toBe(
      true,
    );
  });

  it('coerces and bounds paging parameters', () => {
    expect(ListUsersQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(ListUsersQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    for (const limit of ['0', '101', 'x', '1.5']) {
      expect(ListUsersQuerySchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it('validates organisation creation and invite re-issue', () => {
    expect(
      CreateOrganisationRequestSchema.safeParse({ name: 'Lunar', directorEmail: 'd@l.space' })
        .success,
    ).toBe(true);
    expect(
      CreateOrganisationRequestSchema.safeParse({ name: '', directorEmail: 'd@l.space' }).success,
    ).toBe(false);
    expect(ReissueInviteRequestSchema.safeParse({ userId: ORG }).success).toBe(true);
    expect(ReissueInviteRequestSchema.safeParse({ userId: 'x' }).success).toBe(false);
  });
});
