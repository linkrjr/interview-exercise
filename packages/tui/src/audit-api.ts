import { AuditEventSchema, pageSchema, type AuditEvent, type Page } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** The audit log, newest first (Directors). */
export interface AuditApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<AuditEvent>>;
}

const AuditPage = pageSchema(AuditEventSchema);

/** `mc audit list`, with its client. */
export function createAuditApi(client: ApiClient): AuditApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/audit', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => AuditPage.parse(body),
      ),
  };
}
