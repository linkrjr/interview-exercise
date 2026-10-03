import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skill } from './fixtures.js';
import { createSkillsApi } from './skills-api.js';

async function setup(respond: (url: URL) => Response) {
  const store = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
  await store.setUrl('http://api.test');
  await store.setCredentials({ orgId: 'o', accessToken: 'access-1', refreshToken: 'r' });
  const calls: Array<{ url: URL; init: RequestInit; headers: Headers }> = [];
  const client = new ApiClient(store, async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init: init ?? {}, headers: new Headers(init?.headers) });
    return respond(parsed);
  });
  return { api: createSkillsApi(client), calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

describe('skills api', () => {
  it('lists the catalogue with the cursor, as the signed-in user', async () => {
    const { api, calls } = await setup(() => json(200, { items: [skill(1)], nextCursor: 'n' }));
    const page = await api.list({ cursor: 'abc' });
    expect(page.items[0]!.name).toBe('Skill 01');
    expect(calls[0]!.url.pathname).toBe('/v1/skills');
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('abc');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('adds a skill by name, like `mc skills add`', async () => {
    const { api, calls } = await setup(() => json(201, skill(2, { name: 'Piloting' })));
    expect((await api.create('Piloting')).name).toBe('Piloting');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'Piloting' });
  });

  it('renames a skill, like `mc skills rename`', async () => {
    const { api, calls } = await setup(() => json(200, skill(3, { name: 'Navigation' })));
    expect((await api.rename(skill(3).id, 'Navigation')).name).toBe('Navigation');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/skills/${skill(3).id}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'Navigation' });
  });

  it("turns the server's refusal into a message, and rejects a body of the wrong shape", async () => {
    const taken = await setup(() =>
      json(409, {
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'SKILL_NAME_TAKEN',
        detail: 'A skill with that name already exists',
      }),
    );
    await expect(taken.api.create('Medicine')).rejects.toThrow('SKILL_NAME_TAKEN');
    const odd = await setup(() => json(200, { hello: 'world' }));
    await expect(odd.api.list()).rejects.toThrow('unexpected answer');
  });
});
