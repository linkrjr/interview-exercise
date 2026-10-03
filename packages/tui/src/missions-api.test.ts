import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mission, summary } from './fixtures.js';
import { createMissionsApi } from './missions-api.js';

async function setup(respond: (url: URL) => Response) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
  await store.setUrl('http://api.test');
  await store.setCredentials({ orgId: 'o', accessToken: 'access-1', refreshToken: 'r' });
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const client = new ApiClient(store, async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, headers: new Headers(init?.headers) });
    return respond(parsed);
  });
  return { api: createMissionsApi(client), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

describe('missions api', () => {
  it('lists with the signed-in token, the status filter repeated, and the cursor', async () => {
    const { api, calls } = await setup(() =>
      json(200, { items: [summary(1)], nextCursor: 'next' }),
    );
    const page = await api.list({
      status: ['pending_approval', 'crewing'],
      cursor: 'abc',
      limit: 50,
    });
    expect(page.items[0]!.name).toBe('Mission 01');
    expect(page.nextCursor).toBe('next');
    expect(calls[0]!.url.pathname).toBe('/v1/missions');
    expect(calls[0]!.url.searchParams.getAll('status')).toEqual(['pending_approval', 'crewing']);
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('abc');
    expect(calls[0]!.url.searchParams.get('limit')).toBe('50');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('lists everything when no status is given', async () => {
    const { api, calls } = await setup(() => json(200, { items: [], nextCursor: null }));
    await api.list();
    expect(calls[0]!.url.searchParams.has('status')).toBe(false);
  });

  it('reads one mission by id', async () => {
    const m = mission();
    const { api, calls } = await setup(() => json(200, m));
    expect((await api.get(m.id)).requirements).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe(`/v1/missions/${m.id}`);
  });

  it("turns the server's problem into a plain error message", async () => {
    const { api } = await setup(() =>
      json(404, {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'Mission not found',
      }),
    );
    await expect(api.get('x')).rejects.toThrow('Mission not found (NOT_FOUND)');
  });

  it('rejects an answer of the wrong shape', async () => {
    const { api } = await setup(() => json(200, { hello: 'world' }));
    await expect(api.list()).rejects.toThrow('unexpected answer');
    await expect(api.get('x')).rejects.toThrow('unexpected answer');
  });

  it('creates, edits, moves, and sets requirements and crew with If-Match', async () => {
    const m = mission();
    const bodies: Array<{ method: string; path: string; body: unknown; ifMatch: string | null }> =
      [];
    const store = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
    await store.setUrl('http://api.test');
    await store.setCredentials({ orgId: 'o', accessToken: 'access-1', refreshToken: 'r' });
    const client = new ApiClient(store, async (url, init) => {
      bodies.push({
        method: String(init?.method),
        path: new URL(url).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: new Headers(init?.headers).get('if-match'),
      });
      return json(200, m);
    });
    const api = createMissionsApi(client);
    const skillId = m.requirements[0]!.skillId;

    await api.create({
      name: 'New',
      description: '',
      startDate: '2027-01-01',
      endDate: '2027-01-02',
    });
    await api.update(m.id, { name: 'Renamed' }, 3);
    await api.transition(m.id, 'submit', 3);
    await api.setRequirements(m.id, [{ skillId, minLevel: 4, count: 1 }], 3);
    await api.setCrew(m.id, [m.crew[0]!.crewMemberId], 3);

    expect(bodies).toEqual([
      {
        method: 'POST',
        path: '/v1/missions',
        body: { name: 'New', description: '', startDate: '2027-01-01', endDate: '2027-01-02' },
        ifMatch: null,
      },
      { method: 'PATCH', path: `/v1/missions/${m.id}`, body: { name: 'Renamed' }, ifMatch: '"3"' },
      {
        method: 'POST',
        path: `/v1/missions/${m.id}/transitions`,
        body: { action: 'submit' },
        ifMatch: '"3"',
      },
      {
        method: 'PUT',
        path: `/v1/missions/${m.id}/requirements`,
        body: { requirements: [{ skillId, minLevel: 4, count: 1 }] },
        ifMatch: '"3"',
      },
      {
        method: 'PUT',
        path: `/v1/missions/${m.id}/crew`,
        body: { crewMemberIds: [m.crew[0]!.crewMemberId] },
        ifMatch: '"3"',
      },
    ]);
  });
});
