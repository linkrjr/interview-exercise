import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsApi } from './settings-api.js';

async function setup(respond: () => Response) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
  await store.setUrl('http://api.test');
  await store.setCredentials({ orgId: 'o', accessToken: 'access-1', refreshToken: 'r' });
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new ApiClient(store, async (url, init) => {
    calls.push({ url: new URL(url), init: init ?? {} });
    return respond();
  });
  return { api: createSettingsApi(client), calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

describe('settings api', () => {
  it('reads the settings', async () => {
    const { api, calls } = await setup(() =>
      json(200, { timeZone: 'UTC', maxUpcomingMissions: 3 }),
    );
    expect(await api.get()).toEqual({ timeZone: 'UTC', maxUpcomingMissions: 3 });
    expect(calls[0]!.url.pathname).toBe('/v1/org/settings');
  });

  it('patches only what it is given, like `mc org settings set`', async () => {
    const { api, calls } = await setup(() =>
      json(200, { timeZone: 'UTC', maxUpcomingMissions: 5 }),
    );
    expect((await api.update({ maxUpcomingMissions: 5 })).maxUpcomingMissions).toBe(5);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ maxUpcomingMissions: 5 });
  });

  it("shows the server's field errors, and rejects a body of the wrong shape", async () => {
    const refused = await setup(() =>
      json(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid',
        errors: [{ field: 'timeZone', code: 'invalid', message: 'Not a valid IANA time zone' }],
      }),
    );
    await expect(refused.api.update({ timeZone: 'Mars/Base' })).rejects.toThrow(
      'timeZone: Not a valid IANA time zone',
    );
    const odd = await setup(() => json(200, { hello: 'world' }));
    await expect(odd.api.get()).rejects.toThrow('unexpected answer');
  });
});
