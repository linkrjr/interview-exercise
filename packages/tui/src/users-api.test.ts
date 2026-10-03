import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { user } from './fixtures.js';
import { createUsersApi } from './users-api.js';

async function setup(respond: (url: URL, init: RequestInit) => Response) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
  await store.setUrl('http://api.test');
  await store.setCredentials({ orgId: 'o', accessToken: 'access-1', refreshToken: 'r' });
  const calls: Array<{ url: URL; init: RequestInit; headers: Headers }> = [];
  const client = new ApiClient(store, async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init: init ?? {}, headers: new Headers(init?.headers) });
    return respond(parsed, init ?? {});
  });
  return { api: createUsersApi(client), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
const problem = (status: number, code: string, detail: string) =>
  json(status, { type: 'about:blank', title: 'Error', status, code, detail });

describe('users api', () => {
  it('lists users with the cursor, as the signed-in user', async () => {
    const { api, calls } = await setup(() => json(200, { items: [user(1)], nextCursor: 'n' }));
    const page = await api.list({ cursor: 'abc', limit: 50 });
    expect(page.items[0]!.email).toBe('user1@example.com');
    expect(page.nextCursor).toBe('n');
    expect(calls[0]!.url.pathname).toBe('/v1/users');
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('abc');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('invites with an email and a role', async () => {
    const response = {
      user: user(2, { status: 'invited', name: null, role: 'lead' }),
      invite: { inviteCode: 'ORG.code', expiresAt: '2026-10-10T10:00:00.000Z' },
    };
    const { api, calls } = await setup(() => json(201, response));
    const result = await api.invite({ email: 'new@example.com', role: 'lead' });
    expect(result.invite.inviteCode).toBe('ORG.code');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      email: 'new@example.com',
      role: 'lead',
    });
  });

  it('deactivates with a status patch, like `mc users deactivate`', async () => {
    const { api, calls } = await setup(() => json(200, user(3, { status: 'deactivated' })));
    expect((await api.deactivate(user(3).id)).status).toBe('deactivated');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/users/${user(3).id}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ status: 'deactivated' });
  });

  it('reinvites through the invites endpoint', async () => {
    const { api, calls } = await setup(() =>
      json(201, { inviteCode: 'ORG.new', expiresAt: '2026-10-11T10:00:00.000Z' }),
    );
    expect((await api.reinvite(user(4).id)).inviteCode).toBe('ORG.new');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/v1/users/${user(4).id}/invites`);
  });

  it("turns the server's problem into a plain message, and rejects a body of the wrong shape", async () => {
    const refused = await setup(() =>
      problem(409, 'LAST_ACTIVE_DIRECTOR', 'The last active Director cannot be deactivated'),
    );
    await expect(refused.api.deactivate('x')).rejects.toThrow('LAST_ACTIVE_DIRECTOR');
    const odd = await setup(() => json(200, { hello: 'world' }));
    await expect(odd.api.list()).rejects.toThrow('unexpected answer');
    await expect(odd.api.reinvite('x')).rejects.toThrow('unexpected answer');
  });
});
