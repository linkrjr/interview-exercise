import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApis } from './apis.js';
import { alert, assignment, auditEvent, crewProfile, notification } from './fixtures.js';

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
  return { apis: createApis(client), calls };
}
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
const page = (items: unknown[]) => json(200, { items, nextCursor: 'next' });
const problem = (status: number, code: string, detail: string) =>
  json(status, { type: 'about:blank', title: 'Error', status, code, detail });

describe('audit, alerts and inbox', () => {
  it('lists the audit log, alerts and notifications with the cursor, as the signed-in user', async () => {
    const { apis, calls } = await setup((url) =>
      url.pathname === '/v1/audit'
        ? page([auditEvent(1)])
        : url.pathname === '/v1/alerts'
          ? page([alert(1)])
          : page([notification(1)]),
    );
    expect((await apis.audit.list({ cursor: 'c1' })).items[0]!.action).toBe('mission.approve');
    expect((await apis.alerts.list({ cursor: 'c2' })).items[0]!.code).toBe('SCHEDULER_RUN_FAILED');
    expect((await apis.inbox.list({ cursor: 'c3' })).items[0]!.type).toBe('mission.approved');
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/v1/audit',
      '/v1/alerts',
      '/v1/notifications',
    ]);
    expect(calls.map((c) => c.url.searchParams.get('cursor'))).toEqual(['c1', 'c2', 'c3']);
    for (const call of calls) expect(call.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('marks a notification read, like `mc inbox read`', async () => {
    const read = notification(2, { readAt: '2026-10-03T15:00:00.000Z' });
    const { apis, calls } = await setup(() => json(200, read));
    expect((await apis.inbox.markRead(read.id)).readAt).toBe('2026-10-03T15:00:00.000Z');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/v1/notifications/${read.id}/read`);
  });

  it('turns a refusal into a message, and rejects the wrong shape', async () => {
    const forbidden = await setup(() =>
      problem(403, 'FORBIDDEN', 'You are not allowed to do this'),
    );
    await expect(forbidden.apis.audit.list()).rejects.toThrow('FORBIDDEN');
    const odd = await setup(() => json(200, { hello: 'world' }));
    await expect(odd.apis.alerts.list()).rejects.toThrow('unexpected answer');
  });
});

describe('assignments', () => {
  it('lists and acknowledges, like `mc assignments`', async () => {
    const acknowledged = assignment(1, { acknowledgedAt: '2026-10-03T15:00:00.000Z' });
    const { apis, calls } = await setup((url) =>
      url.pathname.endsWith('/acknowledge') ? json(200, acknowledged) : page([assignment(1)]),
    );
    expect((await apis.assignments.list()).items[0]!.mission.name).toBe('Mission 01');
    expect((await apis.assignments.acknowledge(acknowledged.id)).acknowledgedAt).not.toBeNull();
    expect(calls[0]!.url.pathname).toBe('/v1/assignments/me');
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.url.pathname).toBe(`/v1/assignments/${acknowledged.id}/acknowledge`);
  });
});

describe('profile and crew', () => {
  it('reads a profile by user id and sets and removes skills', async () => {
    const profile = crewProfile(1);
    const { apis, calls } = await setup((url, init) =>
      init.method === 'DELETE'
        ? json(204, null)
        : url.pathname.includes('/skills/')
          ? json(200, { skillId: url.pathname.split('/').at(-1), name: 'Medicine', level: 4 })
          : json(200, profile),
    );
    expect((await apis.profile.get(profile.id)).email).toBe('crew1@example.com');
    expect((await apis.profile.setSkill(profile.id, 4)).level).toBe(4);
    await apis.profile.removeSkill(profile.id);
    expect(calls[0]!.url.pathname).toBe(`/v1/crew/${profile.id}`);
    expect(calls[1]!.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ level: 4 });
    expect(calls[1]!.url.pathname).toBe(`/v1/crew/me/skills/${profile.id}`);
    expect(calls[2]!.init.method).toBe('DELETE');
  });

  it('adds and removes unavailability, sending the note only when there is one', async () => {
    const range = { id: crewProfile(2).id, from: '2027-01-10', to: '2027-01-12', note: null };
    const { apis, calls } = await setup((_url, init) =>
      init.method === 'DELETE' ? json(204, null) : json(201, range),
    );
    await apis.profile.addUnavailability({ from: '2027-01-10', to: '2027-01-12' });
    await apis.profile.addUnavailability({ from: '2027-01-10', to: '2027-01-12', note: 'Leave' });
    await apis.profile.removeUnavailability(range.id);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: '2027-01-10',
      to: '2027-01-12',
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      from: '2027-01-10',
      to: '2027-01-12',
      note: 'Leave',
    });
    expect(calls[2]!.url.pathname).toBe(`/v1/crew/me/unavailability/${range.id}`);
  });

  it('shows the server’s refusal of a range that clashes with a mission', async () => {
    const { apis } = await setup(() =>
      problem(409, 'UNAVAILABILITY_CONFLICTS_WITH_MISSIONS', 'You are held for a mission then'),
    );
    await expect(
      apis.profile.addUnavailability({ from: '2027-01-10', to: '2027-01-12' }),
    ).rejects.toThrow('UNAVAILABILITY_CONFLICTS_WITH_MISSIONS');
  });

  it('lists the crew to pick from', async () => {
    const { apis, calls } = await setup(() => page([crewProfile(3)]));
    expect((await apis.crew.list({ cursor: 'x' })).items[0]!.email).toBe('crew3@example.com');
    expect(calls[0]!.url.pathname).toBe('/v1/crew');
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('x');
  });
});
