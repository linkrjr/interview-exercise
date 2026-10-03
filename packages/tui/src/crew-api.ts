import { CrewProfileSchema, pageSchema, type CrewProfile, type Page } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** The organisation's Crew Members (Directors and Leads), to pick a crew from. */
export interface CrewApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<CrewProfile>>;
}

const CrewPage = pageSchema(CrewProfileSchema);

/** `mc crew list`, with the CLI's client. */
export function createCrewApi(client: ApiClient): CrewApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/crew', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => CrewPage.parse(body),
      ),
  };
}
