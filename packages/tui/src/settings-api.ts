import { OrgSettingsSchema, type OrgSettings, type UpdateOrgSettingsRequest } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** What the Settings screen needs from the API: injectable, so the screen can be tested without it. */
export interface SettingsApi {
  get(): Promise<OrgSettings>;
  /** Changes only the settings given; the answer is all of them as they now are. */
  update(patch: UpdateOrgSettingsRequest): Promise<OrgSettings>;
}

/** The CLI's calls for `mc org settings show|set`, with its client. */
export function createSettingsApi(client: ApiClient): SettingsApi {
  return {
    get: () =>
      call(
        () => client.request('GET', '/v1/org/settings', { auth: 'user' }),
        (body) => OrgSettingsSchema.parse(body),
      ),
    update: (patch) =>
      call(
        () => client.request('PATCH', '/v1/org/settings', { auth: 'user', body: patch }),
        (body) => OrgSettingsSchema.parse(body),
      ),
  };
}
