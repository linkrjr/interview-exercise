import { ApiClient, Store } from '@mc/cli';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoginError, login } from './auth.js';

const SESSION = {
  accessToken: 'access-1',
  expiresIn: 900,
  refreshToken: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.secret-1',
  orgId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
  userId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  role: 'lead',
};
const INPUT = {
  email: ' lee@example.com ',
  orgId: ` ${SESSION.orgId} `,
  password: 'a very long password',
};

async function setup(respond: (call: { url: string; init: RequestInit }) => Response) {
  const dir = await mkdtemp(join(tmpdir(), 'mc-tui-'));
  const store = new Store(dir);
  await store.setUrl('http://api.test');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new ApiClient(store, async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond({ url, init: init ?? {} });
  });
  return { dir, store, client, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

describe('login', () => {
  it('posts the organisation, email and password like `mc auth login` and stores the session', async () => {
    const { store, client, calls, dir } = await setup(() => json(200, SESSION));
    const session = await login(client, store, INPUT);

    expect(session.role).toBe('lead');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api.test/v1/auth/login');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      orgId: SESSION.orgId,
      email: 'lee@example.com',
      password: 'a very long password',
    });
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBeNull();
    expect(await store.getCredentials()).toEqual({
      orgId: SESSION.orgId,
      userId: SESSION.userId,
      role: 'lead',
      accessToken: 'access-1',
      refreshToken: SESSION.refreshToken,
    });
    // The password is never written down.
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain(
      'a very long password',
    );
  });

  it('names the fields that are missing without calling the server', async () => {
    const { store, client, calls } = await setup(() => json(200, SESSION));
    await expect(login(client, store, { email: '', orgId: ' ', password: '' })).rejects.toThrow(
      'Email, Organisation, Password required',
    );
    await expect(login(client, store, { ...INPUT, password: '' })).rejects.toThrow(
      'Password required',
    );
    expect(calls).toEqual([]);
  });

  it("shows the server's problem and stores nothing when the credentials are wrong", async () => {
    const { store, client } = await setup(() =>
      json(401, {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'INVALID_CREDENTIALS',
        detail: 'Invalid credentials',
      }),
    );
    const failure = await login(client, store, INPUT).catch((e) => e);
    expect(failure).toBeInstanceOf(LoginError);
    expect(failure.message).toBe('Invalid credentials (INVALID_CREDENTIALS)');
    expect(await store.getCredentials()).toEqual({});
  });

  it('lists the field errors of a rejected request', async () => {
    const { store, client } = await setup(() =>
      json(400, {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid',
        errors: [{ field: 'orgId', code: 'invalid', message: 'Invalid UUID' }],
      }),
    );
    const failure = await login(client, store, INPUT).catch((e) => e);
    expect(failure.message).toContain('orgId: Invalid UUID');
  });

  it('reports a server that cannot be reached, and one that is not configured', async () => {
    const down = await setup(() => {
      throw new TypeError('fetch failed');
    });
    expect((await login(down.client, down.store, INPUT).catch((e) => e)).message).toBeTruthy();

    const unconfigured = new Store(await mkdtemp(join(tmpdir(), 'mc-tui-')));
    const client = new ApiClient(unconfigured, async () => json(200, SESSION));
    expect((await login(client, unconfigured, INPUT).catch((e) => e)).message).toContain(
      'mc config set-url',
    );
  });

  it('rejects an answer that is not a session', async () => {
    const { store, client } = await setup(() => json(200, { hello: 'world' }));
    const failure = await login(client, store, INPUT).catch((e) => e);
    expect(failure).toBeInstanceOf(LoginError);
    expect(await store.getCredentials()).toEqual({});
  });
});
