import type { ApiClient } from '@mc/cli';
import { createAlertsApi, type AlertsApi } from './alerts-api.js';
import { createAssignmentsApi, type AssignmentsApi } from './assignments-api.js';
import { createAuditApi, type AuditApi } from './audit-api.js';
import { createCrewApi, type CrewApi } from './crew-api.js';
import { createInboxApi, type InboxApi } from './inbox-api.js';
import { createMissionsApi, type MissionsApi } from './missions-api.js';
import { createProfileApi, type ProfileApi } from './profile-api.js';
import { createSettingsApi, type SettingsApi } from './settings-api.js';
import { createSkillsApi, type SkillsApi } from './skills-api.js';
import { createUsersApi, type UsersApi } from './users-api.js';

/** Everything the screens read from the API, one injectable piece per area. */
export interface Apis {
  missions: MissionsApi;
  users: UsersApi;
  skills: SkillsApi;
  settings: SettingsApi;
  audit: AuditApi;
  alerts: AlertsApi;
  inbox: InboxApi;
  assignments: AssignmentsApi;
  profile: ProfileApi;
  crew: CrewApi;
}

/** All of them over the CLI's client, so tokens refresh and errors read the way they do in `mc`. */
export function createApis(client: ApiClient): Apis {
  return {
    missions: createMissionsApi(client),
    users: createUsersApi(client),
    skills: createSkillsApi(client),
    settings: createSettingsApi(client),
    audit: createAuditApi(client),
    alerts: createAlertsApi(client),
    inbox: createInboxApi(client),
    assignments: createAssignmentsApi(client),
    profile: createProfileApi(client),
    crew: createCrewApi(client),
  };
}
