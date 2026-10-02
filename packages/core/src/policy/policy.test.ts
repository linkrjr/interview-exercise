import type { Actor, Role } from '@mc/contracts';
import { AppError } from '@mc/contracts';
import { describe, expect, it } from 'vitest';
import { createPolicy, identityRules, missionRules, orgCrewRules, policy } from './index.js';

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

describe('org and crew role matrix (DESIGN.md §6)', () => {
  const plain = Object.entries(orgCrewRules).filter(([action]) => action !== 'crew.read');
  const matrix = plain.flatMap(([action, rule]) =>
    ROLES.map((role) => ({
      action,
      role,
      expected: (rule.roles as readonly Role[]).includes(role),
    })),
  );

  it.each(matrix)('$action as $role is allowed: $expected', ({ action, role, expected }) => {
    expect(policy.can(actorWith(role), action)).toBe(expected);
  });

  it('lets everyone read settings and skills, and Directors change them', () => {
    for (const role of ROLES) {
      expect(policy.can(actorWith(role), 'org.settings.read')).toBe(true);
      expect(policy.can(actorWith(role), 'skill.list')).toBe(true);
    }
    for (const action of [
      'org.settings.update',
      'skill.create',
      'skill.rename',
      'audit.read',
      'alert.read',
    ]) {
      expect(policy.can(actorWith('director'), action)).toBe(true);
      expect(policy.can(actorWith('lead'), action)).toBe(false);
      expect(policy.can(actorWith('crew'), action)).toBe(false);
    }
  });

  it('restricts own-profile edits to Crew Members', () => {
    for (const action of ['crew.skill.edit', 'crew.unavailability.edit']) {
      expect(policy.can(actorWith('crew'), action)).toBe(true);
      expect(policy.can(actorWith('lead'), action)).toBe(false);
      expect(policy.can(actorWith('director'), action)).toBe(false);
    }
  });

  it('shows every profile to Directors and Leads, but a Crew Member only their own', () => {
    const crew: Actor = { kind: 'user', userId: 'ann', orgId: 'o', role: 'crew' };
    expect(policy.can(crew, 'crew.read', { userId: 'ann' })).toBe(true);
    expect(policy.can(crew, 'crew.read', { userId: 'bob' })).toBe(false);
    for (const role of ['director', 'lead'] as const) {
      expect(policy.can(actorWith(role), 'crew.read', { userId: 'bob' })).toBe(true);
    }
    expect(policy.can(system, 'crew.read', { userId: 'ann' })).toBe(false);
  });

  it('is part of the default policy next to the identity rules', () => {
    expect(policy.actions()).toEqual(
      expect.arrayContaining([...Object.keys(identityRules), ...Object.keys(orgCrewRules)]),
    );
  });
});

describe('mission role matrix (DESIGN.md §6)', () => {
  const plain = Object.entries(missionRules).filter(([action]) => action !== 'mission.manage');
  const matrix = plain.flatMap(([action, rule]) =>
    ROLES.map((role) => ({
      action,
      role,
      expected: (rule.roles as readonly Role[]).includes(role),
    })),
  );

  it.each(matrix)('$action as $role is allowed: $expected', ({ action, role, expected }) => {
    expect(policy.can(actorWith(role), action)).toBe(expected);
  });

  it('lets only Leads create missions, and everyone list and read them (Crew are narrowed by the service)', () => {
    expect(ROLES.map((r) => policy.can(actorWith(r), 'mission.create'))).toEqual([
      false,
      true,
      false,
    ]);
    for (const action of ['mission.list', 'mission.read']) {
      for (const role of ROLES) expect(policy.can(actorWith(role), action)).toBe(true);
    }
  });

  it('lets only the owning Lead manage a mission', () => {
    const lead = (userId: string): Actor => ({ kind: 'user', userId, orgId: 'o', role: 'lead' });
    expect(policy.can(lead('a'), 'mission.manage', { leadId: 'a' })).toBe(true);
    expect(policy.can(lead('b'), 'mission.manage', { leadId: 'a' })).toBe(false);
    expect(policy.can(actorWith('director'), 'mission.manage', { leadId: 'u' })).toBe(false);
    expect(policy.can(actorWith('crew'), 'mission.manage', { leadId: 'u' })).toBe(false);
    expect(policy.can(system, 'mission.manage', { leadId: 'u' })).toBe(false);
  });

  it('lets only Directors decide, and only Crew use assignments', () => {
    expect(ROLES.map((r) => policy.can(actorWith(r), 'mission.decide'))).toEqual([
      true,
      false,
      false,
    ]);
    for (const action of ['assignment.list', 'assignment.acknowledge']) {
      expect(ROLES.map((r) => policy.can(actorWith(r), action))).toEqual([false, false, true]);
    }
    for (const role of ROLES) expect(policy.can(actorWith(role), 'notification.read')).toBe(true);
  });

  it('requireRole refuses a role the action never allows, before any resource is known', () => {
    expect(() => policy.requireRole(actorWith('crew'), 'mission.manage')).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    );
    expect(() => policy.requireRole(actorWith('director'), 'mission.manage')).toThrow();
    expect(() => policy.requireRole(system, 'mission.decide')).toThrow();
    expect(() => policy.requireRole(actorWith('lead'), 'mission.manage')).not.toThrow(); // role is fine; ownership is checked with the resource
    expect(() => policy.requireRole(actorWith('lead'), 'nope')).toThrow();
  });
});
