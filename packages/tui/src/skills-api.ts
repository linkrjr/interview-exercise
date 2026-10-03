import { SkillSchema, pageSchema, type Page, type Skill } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** What the Skills screens need from the API: injectable, so the screens can be tested without it. */
export interface SkillsApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<Skill>>;
  create(name: string): Promise<Skill>;
  rename(id: string, name: string): Promise<Skill>;
}

const SkillPage = pageSchema(SkillSchema);

/** The CLI's calls for `mc skills ...`, with its client, so tokens refresh and errors read the same. */
export function createSkillsApi(client: ApiClient): SkillsApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/skills', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => SkillPage.parse(body),
      ),
    create: (name) =>
      call(
        () => client.request('POST', '/v1/skills', { auth: 'user', body: { name } }),
        (body) => SkillSchema.parse(body),
      ),
    rename: (id, name) =>
      call(
        () =>
          client.request('PATCH', `/v1/skills/${encodeURIComponent(id)}`, {
            auth: 'user',
            body: { name },
          }),
        (body) => SkillSchema.parse(body),
      ),
  };
}
