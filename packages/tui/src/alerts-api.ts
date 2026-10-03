import { AlertSchema, pageSchema, type Alert, type Page } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** Operational alerts, such as scheduler failures, newest first (Directors). */
export interface AlertsApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<Alert>>;
}

const AlertPage = pageSchema(AlertSchema);

/** `mc alerts`, with its client. */
export function createAlertsApi(client: ApiClient): AlertsApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/alerts', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => AlertPage.parse(body),
      ),
  };
}
