import { policy } from '@mc/core';
import { RoleSchema, type Actor, type Role } from '@mc/contracts';
import { describe, expect, it } from 'bun:test';
import { navigationFor, SIGN_OUT } from './navigation.js';

const labels = (role: string | undefined) => navigationFor(role).map((i) => i.label);

describe('navigationFor', () => {
  it('offers a Director the administration and decision actions', () => {
    expect(labels('director')).toEqual([
      'Approvals',
      'Missions',
      'Users',
      'Skills',
      'Settings',
      'Audit log',
      'Alerts',
      'Inbox',
      'Sign out',
    ]);
  });

  it('offers a Lead the planning actions, and nothing administrative', () => {
    expect(labels('lead')).toEqual(['Missions', 'New mission', 'Skills', 'Inbox', 'Sign out']);
  });

  it('offers a Crew Member only their own profile, assignments and inbox', () => {
    expect(labels('crew')).toEqual(['My profile', 'My assignments', 'Inbox', 'Sign out']);
  });

  it('has no Crew section: Users covers the people of the organisation', () => {
    for (const role of RoleSchema.options) expect(labels(role)).not.toContain('Crew');
  });

  it('ends every role’s bar with Sign out', () => {
    for (const role of RoleSchema.options) expect(navigationFor(role).at(-1)).toBe(SIGN_OUT);
  });

  it('never lists an item twice', () => {
    for (const role of RoleSchema.options) {
      const ids = navigationFor(role).map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('gives an unknown or missing role nothing but Sign out', () => {
    for (const role of [undefined, '', 'operator', 'DIRECTOR', 'admin']) {
      expect(navigationFor(role)).toEqual([SIGN_OUT]);
    }
  });

  it('keeps each role’s exclusive actions away from the others', () => {
    const only = (role: Role, items: string[]) => {
      for (const other of RoleSchema.options.filter((r) => r !== role)) {
        for (const item of items) expect(labels(other)).not.toContain(item);
      }
    };
    only('director', ['Approvals', 'Users', 'Settings', 'Audit log', 'Alerts']);
    only('lead', ['New mission']);
    only('crew', ['My profile', 'My assignments']);
  });
});

/** The API action that each item's screen is for: the policy decides whether a role may do it. */
const POLICY_ACTION: Record<string, string> = {
  approvals: 'mission.decide',
  missions: 'mission.list',
  'new-mission': 'mission.create',
  users: 'user.list',
  skills: 'skill.list',
  settings: 'org.settings.update',
  audit: 'audit.read',
  alerts: 'alert.read',
  inbox: 'notification.read',
  profile: 'crew.skill.edit',
  assignments: 'assignment.list',
};

describe('navigation and the API policy', () => {
  const actorOf = (role: Role): Actor => ({
    kind: 'user',
    userId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
    orgId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
    role,
  });

  it('knows the policy action of every item (so a new item cannot skip this check)', () => {
    for (const role of RoleSchema.options) {
      for (const item of navigationFor(role)) {
        if (item.id !== SIGN_OUT.id) expect(POLICY_ACTION[item.id]).toBeDefined();
      }
    }
  });

  it('shows a role only actions the API lets it perform', () => {
    for (const role of RoleSchema.options) {
      for (const item of navigationFor(role)) {
        if (item.id === SIGN_OUT.id) continue;
        const action = POLICY_ACTION[item.id]!;
        expect(policy.can(actorOf(role), action), `${role} sees "${item.label}" (${action})`).toBe(
          true,
        );
      }
    }
  });
});
