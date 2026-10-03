import { NotificationSchema, pageSchema, type Notification, type Page } from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** The signed-in user's notifications. */
export interface InboxApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<Notification>>;
  markRead(id: string): Promise<Notification>;
}

const NotificationPage = pageSchema(NotificationSchema);

/** `mc inbox` and `mc inbox read`, with the CLI's client. */
export function createInboxApi(client: ApiClient): InboxApi {
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/notifications', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => NotificationPage.parse(body),
      ),
    markRead: (id) =>
      call(
        () =>
          client.request('POST', `/v1/notifications/${encodeURIComponent(id)}/read`, {
            auth: 'user',
          }),
        (body) => NotificationSchema.parse(body),
      ),
  };
}
