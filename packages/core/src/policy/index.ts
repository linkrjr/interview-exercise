import { identityRules } from './identity-rules.js';
import { orgCrewRules } from './org-crew-rules.js';
import { createPolicy } from './policy.js';

export { identityRules } from './identity-rules.js';
export { orgCrewRules } from './org-crew-rules.js';
export {
  createPolicy,
  type AuthorizeOptions,
  type Policy,
  type PolicyRule,
  type PolicyRules,
  type UserActor,
} from './policy.js';

/** The application policy: every rule table registered so far. */
export const policy = createPolicy(identityRules, orgCrewRules);
