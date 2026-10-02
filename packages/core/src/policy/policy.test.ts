import type { Actor, Role } from '@mc/contracts';
import { AppError } from '@mc/contracts';
import { describe, expect, it } from 'vitest';
import { createPolicy, identityRules, policy } from './index.js';

const ROLES: Role[] = ['director', 'lead', 'crew'];
const actorWith = (role: Role): Actor => ({ kind: 'user', userId: 'u', orgId: 'o', role });
const system: Actor = { kind: 'system' };

describe('identity role matrix (DESIGN.md §6)', () => {
  const matrix = Object.entries(identityRules).flatMap(([action, rule]) =>
    ROLES.map((role) => ({
      action,
      role,
      expected: (rule.roles as readonly Role[]).includes(role),
    })),
  );

  it.each(matrix)('$action as $role is allowed: $expected', ({ action, role, expected }) => {
    expect(policy.can(actorWith(role), action)).toBe(expected);
  });

  it('only Directors manage users', () => {
    for (const action of ['user.list', 'user.invite', 'user.reinvite', 'user.update']) {
      expect(policy.can(actorWith('director'), action)).toBe(true);
      expect(policy.can(actorWith('lead'), action)).toBe(false);
      expect(policy.can(actorWith('crew'), action)).toBe(false);
    }
  });

  it('lets every role read its own identity', () => {
    for (const role of ROLES) expect(policy.can(actorWith(role), 'me.read')).toBe(true);
  });

  it('denies the system actor everything', () => {
    for (const action of policy.actions()) expect(policy.can(system, action)).toBe(false);
  });

  it('denies unknown actions', () => {
    expect(policy.can(actorWith('director'), 'nope.nothing')).toBe(false);
  });
});

describe('authorize', () => {
  it('passes silently when allowed', () => {
    expect(() => policy.authorize(actorWith('director'), 'user.list')).not.toThrow();
  });

  it('throws 403 FORBIDDEN when not allowed', () => {
    try {
      policy.authorize(actorWith('crew'), 'user.list');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    }
  });

  it('can conceal the resource with a 404', () => {
    try {
      policy.authorize(actorWith('crew'), 'user.update', undefined, { concealAs404: 'User' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });
});

describe('createPolicy', () => {
  it('narrows an allowed role by the resource', () => {
    const own = createPolicy({
      'thing.edit': {
        roles: ['lead'],
        allow: (actor: { userId: string }, resource: { ownerId: string }) =>
          actor.userId === resource.ownerId,
      },
    } as never);
    const lead = (userId: string): Actor => ({ kind: 'user', userId, orgId: 'o', role: 'lead' });
    expect(own.can(lead('a'), 'thing.edit', { ownerId: 'a' })).toBe(true);
    expect(own.can(lead('b'), 'thing.edit', { ownerId: 'a' })).toBe(false);
  });

  it('merges rule tables from several specs and rejects duplicates', () => {
    const merged = createPolicy(identityRules, { 'org.settings.update': { roles: ['director'] } });
    expect(merged.actions()).toContain('org.settings.update');
    expect(merged.actions()).toContain('user.list');
    expect(() => createPolicy(identityRules, identityRules)).toThrow(/Duplicate policy rule/);
  });
});
