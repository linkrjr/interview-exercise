import {
  InviteSchema,
  InviteUserResponseSchema,
  UserSchema,
  pageSchema,
  type Invite,
  type InviteUserRequest,
  type InviteUserResponse,
  type Page,
  type User,
} from '@mc/contracts';
import type { ApiClient } from '@mc/cli';
import { call } from './api-call.js';

/** What the Users screens need from the API: injectable, so the screens can be tested without it. */
export interface UsersApi {
  list(query?: { cursor?: string; limit?: number }): Promise<Page<User>>;
  invite(input: InviteUserRequest): Promise<InviteUserResponse>;
  /** Deactivates a user (there is no way back from the TUI, as in the CLI). */
  deactivate(id: string): Promise<User>;
  /** A new invite code for a user who has not accepted yet. */
  reinvite(id: string): Promise<Invite>;
}

const UserPage = pageSchema(UserSchema);

/** The CLI's calls for `mc users ...`, with its client, so tokens refresh and errors read the same. */
export function createUsersApi(client: ApiClient): UsersApi {
  const path = (id: string) => `/v1/users/${encodeURIComponent(id)}`;
  return {
    list: (query = {}) =>
      call(
        () =>
          client.request('GET', '/v1/users', {
            auth: 'user',
            query: { limit: query.limit, cursor: query.cursor },
          }),
        (body) => UserPage.parse(body),
      ),
    invite: (input) =>
      call(
        () => client.request('POST', '/v1/users', { auth: 'user', body: input }),
        (body) => InviteUserResponseSchema.parse(body),
      ),
    deactivate: (id) =>
      call(
        () => client.request('PATCH', path(id), { auth: 'user', body: { status: 'deactivated' } }),
        (body) => UserSchema.parse(body),
      ),
    reinvite: (id) =>
      call(
        () => client.request('POST', `${path(id)}/invites`, { auth: 'user' }),
        (body) => InviteSchema.parse(body),
      ),
  };
}
