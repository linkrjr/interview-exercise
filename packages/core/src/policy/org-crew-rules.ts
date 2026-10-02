import type { Role } from '@mc/contracts';
import type { PolicyRules, UserActor } from './policy.js';

const everyone: readonly Role[] = ['director', 'lead', 'crew'];

/** Role matrix rows owned by the org-and-crew spec (DESIGN.md §6). */
export const orgCrewRules = {
  'org.settings.read': { roles: everyone },
  'org.settings.update': { roles: ['director'] },
  'skill.list': { roles: everyone },
  'skill.create': { roles: ['director'] },
  'skill.rename': { roles: ['director'] },
  'crew.list': { roles: everyone },
  // Directors and Leads see every crew profile; a Crew Member only their own.
  'crew.read': {
    roles: everyone,
    allow: (actor: UserActor, resource: { userId: string }) =>
      actor.role !== 'crew' || actor.userId === resource.userId,
  },
  'crew.skill.edit': { roles: ['crew'] },
  'crew.unavailability.edit': { roles: ['crew'] },
  'audit.read': { roles: ['director'] },
} as const satisfies PolicyRules;
