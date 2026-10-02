import type { Role } from '@mc/contracts';
import type { PolicyRules, UserActor } from './policy.js';

const everyone: readonly Role[] = ['director', 'lead', 'crew'];

/** Role matrix rows owned by the missions spec (DESIGN.md §6). */
export const missionRules = {
  'mission.create': { roles: ['lead'] },
  // Directors and Leads see every mission; Crew see their own assignments (narrowed in the service).
  'mission.list': { roles: everyone },
  'mission.read': { roles: everyone },
  // Edit, crew, run the matcher, submit, withdraw, cancel: the owning Lead only.
  'mission.manage': {
    roles: ['lead'],
    allow: (actor: UserActor, resource: { leadId: string }) => actor.userId === resource.leadId,
  },
  // Approve and reject: any Director (who never owns a mission).
  'mission.decide': { roles: ['director'] },
  'assignment.list': { roles: ['crew'] },
  'assignment.acknowledge': { roles: ['crew'] },
  'notification.read': { roles: everyone },
} as const satisfies PolicyRules;
