import type { PolicyRules } from './policy.js';

/**
 * Role matrix rows owned by the identity spec (DESIGN.md §6). Later specs add their own tables
 * and pass them all to `createPolicy`.
 */
export const identityRules = {
  'me.read': { roles: ['director', 'lead', 'crew'] },
  'user.list': { roles: ['director'] },
  'user.invite': { roles: ['director'] },
  'user.reinvite': { roles: ['director'] },
  'user.update': { roles: ['director'] },
} as const satisfies PolicyRules;
