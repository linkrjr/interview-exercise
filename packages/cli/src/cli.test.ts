import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiClient } from './client.js';
import { ExitCode, exitCodeForStatus } from './errors.js';
import { runCli } from './program.js';
import { checkNewPassword, readPassword } from './secrets.js';
import { SESSION, makeCli, problem } from './test-support.js';

const ORG = SESSION.orgId;

describe('exit codes (DESIGN.md §14)', () => {
  it.each([
    [400, 1],
    [415, 1],
    [422, 1],
    [401, 2],
    [403, 2],
    [404, 3],
    [409, 4],
    [412, 4],
    [429, 5],
    [500, 5],
    [503, 5],
  ])('maps HTTP %i to exit code %i', (status, code) => {
    expect(exitCodeForStatus(status)).toBe(code);
  });

  it('exposes the documented values', () => {
    expect(ExitCode).toEqual({ OK: 0, USAGE: 1, AUTH: 2, NOT_FOUND: 3, CONFLICT: 4, SERVER: 5 });
  });
});

describe('credential storage', () => {
  it('stores tokens in credentials.json with mode 0600 inside a 0700 directory', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      env: { MC_PASSWORD: 'correct horse battery' },
    });
    expect(await runCli(['auth', 'login', '--org', ORG, '--email', 'a@b.space'], cli.deps)).toBe(0);
    const file = join(cli.dir, 'credentials.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(cli.dir)).mode & 0o777).toBe(0o700);
    expect(await cli.store.getCredentials()).toMatchObject({
      orgId: ORG,
      accessToken: 'access-1',
      refreshToken: SESSION.refreshToken,
    });
  });

  it('keeps the file private when it is rewritten', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SESSION }));
    await cli.store.setCredentials({ accessToken: 'a' });
    await cli.store.setCredentials({ accessToken: 'b' });
    expect((await stat(join(cli.dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
  });

  it('reads as empty when nothing is stored', async () => {
    const cli = await makeCli(() => ({ status: 200 }), { withUrl: false });
    expect(await cli.store.getCredentials()).toEqual({});
    expect(await cli.store.getUrl()).toBeUndefined();
  });
});

describe('mc config set-url', () => {
  it('stores a normalised URL', async () => {
    const cli = await makeCli(() => ({ status: 200 }), { withUrl: false });
    expect(await runCli(['config', 'set-url', 'https://api.example.com/'], cli.deps)).toBe(0);
    expect(await cli.store.getUrl()).toBe('https://api.example.com');
  });

  it.each(['not a url', 'ftp://example.com'])('rejects %s as a usage error', async (url) => {
    const cli = await makeCli(() => ({ status: 200 }), { withUrl: false });
    expect(await runCli(['config', 'set-url', url], cli.deps)).toBe(1);
    expect(cli.err.join('')).toContain('Error:');
  });

  it('refuses to call the API before a URL is set', async () => {
    const cli = await makeCli(() => ({ status: 200 }), {
      withUrl: false,
      env: { MC_PASSWORD: 'x'.repeat(12) },
    });
    expect(await runCli(['auth', 'login', '--org', ORG, '--email', 'a@b.space'], cli.deps)).toBe(1);
    expect(cli.err.join('')).toContain('mc config set-url');
    expect(cli.calls).toEqual([]);
  });
});

describe('mc auth login', () => {
  it('posts the organisation, email and password and remembers the organisation', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      env: { MC_PASSWORD: 'correct horse battery' },
    });
    expect(
      await runCli(['auth', 'login', '--org', ORG, '--email', 'lead@lrl.space'], cli.deps),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/auth/login',
      body: { orgId: ORG, email: 'lead@lrl.space', password: 'correct horse battery' },
    });
    expect(cli.calls[0]!.headers.authorization).toBeUndefined();
    expect(cli.out.join('')).toContain('Signed in as lead@lrl.space (lead)');

    // The next login needs no --org.
    const again = await makeCli(() => ({ status: 200, body: SESSION }), {
      env: { MC_PASSWORD: 'correct horse battery' },
    });
    await again.store.setCredentials({ orgId: ORG });
    expect(await runCli(['auth', 'login', '--email', 'lead@lrl.space'], again.deps)).toBe(0);
    expect(again.calls[0]!.body).toMatchObject({ orgId: ORG });
  });

  it('reads the password from stdin when asked', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      stdin: 'from stdin password\n',
    });
    await runCli(
      ['auth', 'login', '--org', ORG, '--email', 'a@b.space', '--password-stdin'],
      cli.deps,
    );
    expect(cli.calls[0]!.body).toMatchObject({ password: 'from stdin password' });
  });

  it('prompts for missing values on a terminal, with a hidden password', async () => {
    const asked: string[] = [];
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      interactive: true,
      prompts: {
        input: async (m) => {
          asked.push(m);
          return m.startsWith('Organisation') ? ORG : 'prompted@lrl.space';
        },
        password: async (m) => {
          asked.push(m);
          return 'prompted password!!';
        },
      },
    });
    expect(await runCli(['auth', 'login'], cli.deps)).toBe(0);
    expect(asked).toEqual(['Organisation ID:', 'Email:', 'Password:']);
    expect(cli.calls[0]!.body).toEqual({
      orgId: ORG,
      email: 'prompted@lrl.space',
      password: 'prompted password!!',
    });
  });

  it('fails as a usage error, without calling the server, when it cannot ask', async () => {
    const noEmail = await makeCli(() => ({ status: 200 }), {
      env: { MC_PASSWORD: 'x'.repeat(12) },
    });
    expect(await runCli(['auth', 'login', '--org', ORG], noEmail.deps)).toBe(1);
    const noOrg = await makeCli(() => ({ status: 200 }), { env: { MC_PASSWORD: 'x'.repeat(12) } });
    expect(await runCli(['auth', 'login', '--email', 'a@b.space'], noOrg.deps)).toBe(1);
    const noPassword = await makeCli(() => ({ status: 200 }));
    expect(
      await runCli(['auth', 'login', '--org', ORG, '--email', 'a@b.space'], noPassword.deps),
    ).toBe(1);
    expect(noPassword.err.join('')).toContain('MC_PASSWORD');
    expect([...noEmail.calls, ...noOrg.calls, ...noPassword.calls]).toEqual([]);
  });

  it('exits 2 on bad credentials and prints no secrets', async () => {
    const cli = await makeCli(() => problem(401, 'INVALID_CREDENTIALS', 'Invalid credentials'), {
      env: { MC_PASSWORD: 'super secret password' },
    });
    expect(await runCli(['auth', 'login', '--org', ORG, '--email', 'a@b.space'], cli.deps)).toBe(2);
    expect(cli.err.join('')).toContain('Invalid credentials (INVALID_CREDENTIALS)');
    expect(cli.err.join('') + cli.out.join('')).not.toContain('super secret password');
    expect(await cli.store.getCredentials()).toEqual({});
  });

  it('prints JSON with --json, and JSON errors on stderr', async () => {
    const ok = await makeCli(() => ({ status: 200, body: SESSION }), {
      env: { MC_PASSWORD: 'correct horse battery' },
    });
    await runCli(['--json', 'auth', 'login', '--org', ORG, '--email', 'a@b.space'], ok.deps);
    expect(JSON.parse(ok.out.join(''))).toEqual({
      orgId: ORG,
      userId: SESSION.userId,
      role: 'lead',
    });
    expect(ok.out.join('')).not.toContain('access-1');

    const bad = await makeCli(() => problem(401, 'INVALID_CREDENTIALS'), {
      env: { MC_PASSWORD: 'nope nope nope' },
    });
    expect(
      await runCli(['auth', 'login', '--org', ORG, '--email', 'a@b.space', '--json'], bad.deps),
    ).toBe(2);
    expect(JSON.parse(bad.err.join('')).error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('mc auth accept-invite', () => {
  const CODE = `${ORG}.the-secret`;

  it('asks for the name and a confirmed password, then signs in and remembers the organisation', async () => {
    const asked: string[] = [];
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      interactive: true,
      prompts: {
        input: async (m) => {
          asked.push(m);
          return 'Ada Lovelace';
        },
        password: async (m) => {
          asked.push(m);
          return 'a long enough password';
        },
      },
    });
    expect(await runCli(['auth', 'accept-invite', CODE], cli.deps)).toBe(0);
    expect(asked).toEqual(['Your name:', 'Password:', 'Confirm password:']);
    expect(cli.calls[0]).toMatchObject({
      url: 'http://api.test/v1/auth/accept-invite',
      body: { code: CODE, name: 'Ada Lovelace', password: 'a long enough password' },
    });
    expect(await cli.store.getCredentials()).toMatchObject({ orgId: ORG, accessToken: 'access-1' });
    expect(cli.out.join('')).toContain(`Your organisation ID is ${ORG}`);
  });

  it('works non-interactively with --name and MC_PASSWORD', async () => {
    const cli = await makeCli(() => ({ status: 200, body: SESSION }), {
      env: { MC_PASSWORD: 'a long enough password' },
    });
    expect(await runCli(['auth', 'accept-invite', CODE, '--name', 'Scripted'], cli.deps)).toBe(0);
    expect(cli.calls[0]!.body).toMatchObject({ name: 'Scripted' });
  });

  it('rejects mismatched confirmations and short passwords before calling the server', async () => {
    const mismatch = await makeCli(() => ({ status: 200 }), {
      interactive: true,
      prompts: {
        input: async () => 'Ada',
        password: (() => {
          let n = 0;
          return async () => (n++ === 0 ? 'first password!!' : 'second password!');
        })(),
      },
    });
    expect(await runCli(['auth', 'accept-invite', CODE], mismatch.deps)).toBe(1);
    expect(mismatch.err.join('')).toContain('do not match');

    const short = await makeCli(() => ({ status: 200 }), { env: { MC_PASSWORD: 'too short' } });
    expect(await runCli(['auth', 'accept-invite', CODE, '--name', 'Ada'], short.deps)).toBe(1);
    expect(short.err.join('')).toContain('at least 12');
    expect([...mismatch.calls, ...short.calls]).toEqual([]);
  });

  it('exits 1 for an invalid or expired code', async () => {
    const cli = await makeCli(
      () => problem(400, 'INVALID_INVITE', 'The invite code is invalid or has expired'),
      {
        env: { MC_PASSWORD: 'a long enough password' },
      },
    );
    expect(await runCli(['auth', 'accept-invite', CODE, '--name', 'Ada'], cli.deps)).toBe(1);
    expect(cli.err.join('')).toContain('INVALID_INVITE');
  });
});

describe('transparent token refresh', () => {
  it('refreshes once on a 401, stores the new tokens and retries', async () => {
    let meCalls = 0;
    const cli = await makeCli((call) => {
      if (call.url.endsWith('/v1/auth/refresh')) {
        return {
          status: 200,
          body: { ...SESSION, accessToken: 'access-2', refreshToken: `${ORG}.secret-2` },
        };
      }
      return ++meCalls === 1
        ? problem(401, 'UNAUTHENTICATED', 'The access token has expired')
        : {
            status: 200,
            body: {
              user: { id: 'u', email: 'e@x.space', name: 'N', role: 'lead' },
              org: { id: ORG, name: 'Org' },
            },
          };
    });
    await cli.store.setCredentials({
      orgId: ORG,
      accessToken: 'access-1',
      refreshToken: SESSION.refreshToken,
    });
    expect(await runCli(['auth', 'whoami'], cli.deps)).toBe(0);
    expect(cli.calls.map((c) => c.url.replace('http://api.test', ''))).toEqual([
      '/v1/me',
      '/v1/auth/refresh',
      '/v1/me',
    ]);
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer access-1');
    expect(cli.calls[2]!.headers.authorization).toBe('Bearer access-2');
    expect(await cli.store.getCredentials()).toMatchObject({
      accessToken: 'access-2',
      refreshToken: `${ORG}.secret-2`,
      orgId: ORG,
    });
    expect(cli.out.join('')).toContain('N <e@x.space>, lead at Org');
  });

  it('exits 2 when the refresh token is no longer accepted', async () => {
    const cli = await makeCli((call) =>
      call.url.endsWith('/v1/auth/refresh')
        ? problem(401, 'REFRESH_TOKEN_REUSED')
        : problem(401, 'UNAUTHENTICATED'),
    );
    await cli.store.setCredentials({ orgId: ORG, accessToken: 'a', refreshToken: 'r' });
    expect(await runCli(['auth', 'whoami'], cli.deps)).toBe(2);
    expect(cli.calls).toHaveLength(2);
  });

  it('does not loop: a second 401 after refreshing is reported', async () => {
    const cli = await makeCli((call) =>
      call.url.endsWith('/v1/auth/refresh')
        ? { status: 200, body: SESSION }
        : problem(401, 'UNAUTHENTICATED'),
    );
    await cli.store.setCredentials({ orgId: ORG, accessToken: 'a', refreshToken: 'r' });
    expect(await runCli(['auth', 'whoami'], cli.deps)).toBe(2);
    expect(cli.calls).toHaveLength(3);
  });

  it('asks the user to sign in when nothing is stored', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    expect(await runCli(['auth', 'whoami'], cli.deps)).toBe(2);
    expect(cli.err.join('')).toContain('mc auth login');
    expect(cli.calls).toEqual([]);
  });
});

describe('mc auth logout', () => {
  it('revokes the session, forgets the tokens and keeps the organisation', async () => {
    const cli = await makeCli(() => ({ status: 204 }));
    await cli.store.setCredentials({ orgId: ORG, accessToken: 'a', refreshToken: 'r' });
    expect(await runCli(['auth', 'logout'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      url: 'http://api.test/v1/auth/logout',
      body: { refreshToken: 'r' },
    });
    expect(await cli.store.getCredentials()).toEqual({ orgId: ORG });
  });

  it('still signs out locally when the server is unreachable', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    await cli.store.setCredentials({ orgId: ORG, accessToken: 'a', refreshToken: 'r' });
    cli.deps.fetch = async () => {
      throw new Error('connection refused');
    };
    expect(await runCli(['auth', 'logout'], cli.deps)).toBe(0);
    expect(cli.err.join('')).toContain('Warning');
    expect(await cli.store.getCredentials()).toEqual({ orgId: ORG });
  });

  it('is a no-op when signed out already', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    expect(await runCli(['auth', 'logout'], cli.deps)).toBe(0);
    expect(cli.calls).toEqual([]);
  });
});

describe('mc platform org', () => {
  const created = {
    organisationId: ORG,
    directorUserId: SESSION.userId,
    invite: { inviteCode: `${ORG}.code`, expiresAt: '2026-10-05T10:00:00.000Z' },
  };

  it('creates an organisation with the operator token from the environment', async () => {
    const cli = await makeCli(() => ({ status: 201, body: created }), {
      env: { MC_OPERATOR_TOKEN: 'op-token' },
    });
    expect(
      await runCli(
        [
          'platform',
          'org',
          'create',
          '--name',
          'Lunar Research Lab',
          '--director-email',
          'd@lrl.space',
        ],
        cli.deps,
      ),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      url: 'http://api.test/v1/platform/organisations',
      body: { name: 'Lunar Research Lab', directorEmail: 'd@lrl.space' },
    });
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer op-token');
    expect(cli.out.join('')).toContain(`${ORG}.code`);
    expect(await cli.store.getCredentials()).toEqual({});
  });

  it('prefers --token, and never stores it', async () => {
    const cli = await makeCli(() => ({ status: 201, body: created }), {
      env: { MC_OPERATOR_TOKEN: 'from-env' },
    });
    await runCli(
      [
        'platform',
        'org',
        'create',
        '--name',
        'X',
        '--director-email',
        'd@x.space',
        '--token',
        'from-flag',
      ],
      cli.deps,
    );
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer from-flag');
    expect(await cli.store.getCredentials()).toEqual({});
  });

  it('requires an operator token and the mandatory options', async () => {
    const none = await makeCli(() => ({ status: 201, body: created }));
    expect(
      await runCli(
        ['platform', 'org', 'create', '--name', 'X', '--director-email', 'd@x.space'],
        none.deps,
      ),
    ).toBe(1);
    expect(none.err.join('')).toContain('MC_OPERATOR_TOKEN');
    const missing = await makeCli(() => ({ status: 201, body: created }), {
      env: { MC_OPERATOR_TOKEN: 't' },
    });
    expect(await runCli(['platform', 'org', 'create', '--name', 'X'], missing.deps)).toBe(1);
    expect([...none.calls, ...missing.calls]).toEqual([]);
  });

  it('exits 4 when the Director email is taken, and 2 for a wrong token', async () => {
    const taken = await makeCli(() => problem(409, 'EMAIL_ALREADY_REGISTERED'), {
      env: { MC_OPERATOR_TOKEN: 't' },
    });
    expect(
      await runCli(
        ['platform', 'org', 'create', '--name', 'X', '--director-email', 'd@x.space'],
        taken.deps,
      ),
    ).toBe(4);
    const wrong = await makeCli(() => problem(401, 'UNAUTHENTICATED'), {
      env: { MC_OPERATOR_TOKEN: 'bad' },
    });
    expect(
      await runCli(
        ['platform', 'org', 'create', '--name', 'X', '--director-email', 'd@x.space'],
        wrong.deps,
      ),
    ).toBe(2);
  });

  it('re-issues an invite for a user of the organisation', async () => {
    const cli = await makeCli(() => ({ status: 201, body: { invite: created.invite } }), {
      env: { MC_OPERATOR_TOKEN: 't' },
    });
    expect(
      await runCli(['platform', 'org', 'reinvite', ORG, '--user', SESSION.userId], cli.deps),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      url: `http://api.test/v1/platform/organisations/${ORG}/invites`,
      body: { userId: SESSION.userId },
    });
    expect(cli.out.join('')).toContain(`${ORG}.code`);
  });
});

describe('mc users', () => {
  const signedIn = async (respond: Parameters<typeof makeCli>[0]) => {
    const cli = await makeCli(respond);
    await cli.store.setCredentials({ orgId: ORG, accessToken: 'tok', refreshToken: 'ref' });
    return cli;
  };
  const user = (over = {}) => ({
    id: 'u1',
    email: 'lead@lrl.space',
    name: null,
    role: 'lead',
    status: 'invited',
    createdAt: '2026-10-02T10:00:00.000Z',
    ...over,
  });

  it('invites a user and shows the one-time code', async () => {
    const cli = await signedIn(() => ({
      status: 201,
      body: {
        user: user(),
        invite: { inviteCode: `${ORG}.c`, expiresAt: '2026-10-05T10:00:00.000Z' },
      },
    }));
    expect(
      await runCli(['users', 'invite', '--email', 'lead@lrl.space', '--role', 'lead'], cli.deps),
    ).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/users',
      body: { email: 'lead@lrl.space', role: 'lead' },
    });
    expect(cli.calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(cli.out.join('')).toContain(`${ORG}.c`);
  });

  it('validates the role locally', async () => {
    const cli = await signedIn(() => ({ status: 201 }));
    expect(
      await runCli(['users', 'invite', '--email', 'a@b.space', '--role', 'pilot'], cli.deps),
    ).toBe(1);
    expect(await runCli(['users', 'invite', '--email', 'a@b.space'], cli.deps)).toBe(1);
    expect(cli.calls).toEqual([]);
  });

  it('lists users as a table and shows how to get the next page', async () => {
    const cli = await signedIn(() => ({
      status: 200,
      body: {
        items: [
          user(),
          user({ id: 'u2', email: 'crew@lrl.space', name: 'Cy', role: 'crew', status: 'active' }),
        ],
        nextCursor: 'CUR',
      },
    }));
    expect(await runCli(['users', 'list', '--limit', '2'], cli.deps)).toBe(0);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/users?limit=2');
    const text = cli.out.join('');
    expect(text.split('\n')[0]).toMatch(/^ID\s+EMAIL\s+NAME\s+ROLE\s+STATUS$/);
    expect(text).toContain('crew@lrl.space');
    expect(text).toContain('mc users list --cursor CUR');
  });

  it('passes the cursor, and prints raw JSON with --json', async () => {
    const page = { items: [user()], nextCursor: null };
    const cli = await signedIn(() => ({ status: 200, body: page }));
    await runCli(['users', 'list', '--cursor', 'abc', '--json'], cli.deps);
    expect(cli.calls[0]!.url).toBe('http://api.test/v1/users?cursor=abc');
    expect(JSON.parse(cli.out.join(''))).toEqual(page);
  });

  it('changes a role and deactivates', async () => {
    const cli = await signedIn((call) => ({
      status: 200,
      body: user({
        role: (call.body as { role?: string }).role ?? 'lead',
        status: (call.body as { status?: string }).status ?? 'active',
      }),
    }));
    expect(await runCli(['users', 'set-role', 'u1', 'director'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'http://api.test/v1/users/u1',
      body: { role: 'director' },
    });
    expect(await runCli(['users', 'deactivate', 'u1'], cli.deps)).toBe(0);
    expect(cli.calls[1]!.body).toEqual({ status: 'deactivated' });
    expect(cli.out.join('')).toContain('is deactivated');
  });

  it.each([
    [403, 'FORBIDDEN', 2],
    [404, 'NOT_FOUND', 3],
    [409, 'LAST_ACTIVE_DIRECTOR', 4],
    [409, 'ROLE_CHANGE_TO_CREW_NOT_ALLOWED', 4],
    [500, 'INTERNAL_ERROR', 5],
  ])('exits with the mapped code for HTTP %i %s', async (status, code, exit) => {
    const cli = await signedIn(() => problem(status, code));
    expect(await runCli(['users', 'deactivate', 'u1'], cli.deps)).toBe(exit);
    expect(cli.err.join('')).toContain(code);
  });

  it('shows field errors from validation problems', async () => {
    const cli = await signedIn(() => ({
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'The request is invalid',
        errors: [{ field: 'email', code: 'invalid_format', message: 'Invalid email address' }],
      },
    }));
    expect(await runCli(['users', 'invite', '--email', 'nope', '--role', 'crew'], cli.deps)).toBe(
      1,
    );
    expect(cli.err.join('')).toContain('email: Invalid email address');
  });

  it('re-issues an invite', async () => {
    const cli = await signedIn(() => ({
      status: 201,
      body: { inviteCode: `${ORG}.new`, expiresAt: '2026-10-05T10:00:00.000Z' },
    }));
    expect(await runCli(['users', 'reinvite', 'u1'], cli.deps)).toBe(0);
    expect(cli.calls[0]).toMatchObject({
      method: 'POST',
      url: 'http://api.test/v1/users/u1/invites',
    });
    expect(cli.out.join('')).toContain(`${ORG}.new`);
  });

  it('reports an unreachable server as exit 5, and unexpected bodies as server errors', async () => {
    const cli = await signedIn(() => ({ status: 200 }));
    cli.deps.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await runCli(['users', 'list'], cli.deps)).toBe(5);
    expect(cli.err.join('')).toContain('Cannot reach http://api.test');

    const odd = await signedIn(() => ({ status: 502, body: 'bad gateway' }));
    odd.deps.fetch = async () => new Response('<html>nope</html>', { status: 502 });
    expect(await runCli(['users', 'list'], odd.deps)).toBe(5);
    expect(odd.err.join('')).toContain('HTTP 502');
  });
});

describe('usage', () => {
  it('exits 0 for --help and 1 for unknown commands and missing arguments', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    expect(await runCli(['--help'], cli.deps)).toBe(0);
    expect(cli.out.join('')).toContain('Usage: mc');
    expect(await runCli(['frobnicate'], cli.deps)).toBe(1);
    expect(await runCli(['users', 'deactivate'], cli.deps)).toBe(1);
    expect(await runCli(['auth', 'accept-invite'], cli.deps)).toBe(1);
  });

  it('lists every command in the help text', async () => {
    const cli = await makeCli(() => ({ status: 200 }));
    await runCli(['users', '--help'], cli.deps);
    for (const word of ['invite', 'list', 'set-role', 'deactivate', 'reinvite']) {
      expect(cli.out.join('')).toContain(word);
    }
  });
});

describe('secrets helpers', () => {
  it('prefers stdin, then MC_PASSWORD, then a prompt', async () => {
    const both = await makeCli(() => ({ status: 200 }), {
      env: { MC_PASSWORD: 'from env' },
      stdin: 'from stdin\n',
    });
    expect(await readPassword(both.deps, { passwordStdin: true })).toBe('from stdin');
    expect(await readPassword(both.deps, {})).toBe('from env');
    const prompt = await makeCli(() => ({ status: 200 }), {
      interactive: true,
      prompts: { password: async () => 'typed' },
    });
    expect(await readPassword(prompt.deps, {})).toBe('typed');
  });

  it('enforces the new-password length bounds', () => {
    expect(() => checkNewPassword('x'.repeat(11))).toThrow(/at least 12/);
    expect(() => checkNewPassword('x'.repeat(12))).not.toThrow();
    expect(() => checkNewPassword('x'.repeat(128))).not.toThrow();
    expect(() => checkNewPassword('x'.repeat(129))).toThrow(/at most 128/);
  });
});

describe('ApiClient', () => {
  it('builds URLs from the stored base, including a trailing slash and a path prefix', async () => {
    const cli = await makeCli(() => ({ status: 200, body: {} }));
    await cli.store.setUrl('http://api.test/prefix/');
    await new ApiClient(cli.store, cli.deps.fetch).request('GET', '/v1/x', {
      auth: 'none',
      query: { a: 1, b: undefined },
    });
    expect(cli.calls[0]!.url).toBe('http://api.test/prefix/v1/x?a=1');
  });
});
