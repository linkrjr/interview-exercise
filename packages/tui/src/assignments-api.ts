import { AssignmentSchema, pageSchema, type Assignment, type Page } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** The signed-in Crew Member's assignments. */
export interface AssignmentsApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<Assignment>>;
  /** Acknowledges an assignment; it is binding and cannot be refused. */
  acknowledge(id: string): Promise<Assignment>;
}

const AssignmentPage = pageSchema(AssignmentSchema);

/** `mc assignments list|acknowledge`, with the CLI's client. */
export function createAssignmentsApi(client: ApiClient): AssignmentsApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/assignments/me', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => AssignmentPage.parse(body),
      ),
    acknowledge: (id) =>
      call(
        () =>
          client.request('POST', `/v1/assignments/${encodeURIComponent(id)}/acknowledge`, {
            auth: 'user',
          }),
        (body) => AssignmentSchema.parse(body),
      ),
  };
}
