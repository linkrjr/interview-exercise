import { buildApp } from '@mc/api';
import { createIdentityHarness, uniqueEmail, type IdentityHarness } from '@mc/core/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const urls = inject('dbUrls');
const MC = fileURLToPath(new URL('../dist/bin/mc.js', import.meta.url));
const OPERATOR_TOKEN = 'e2e-operator-token-0123456789abcdef0123';
const PASSWORD = 'a perfectly long password';

let h: IdentityHarness;
let app: ReturnType<typeof buildApp>;
let apiUrl: string;

beforeAll(async () => {
  h = await createIdentityHarness(urls);
  app = buildApp({
    identity: h,
    accessTokens: h.accessTokens,
    operatorToken: OPERATOR_TOKEN,
    loginRate: { emailMax: 50, ipMax: 100, windowMs: 60_000 },
    clock: h.clock,
  });
  apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await h.close();
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/** One person's machine: their own config directory, running the real `mc` binary. */
class Machine {
  private constructor(readonly dir: string) {}
  static async create(): Promise<Machine> {
    const machine = new Machine(await mkdtemp(join(tmpdir(), 'mc-e2e-')));
    await machine.run(['config', 'set-url', apiUrl]);
    return machine;
  }
  run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Result> {
    return new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [MC, ...args],
        { env: { PATH: process.env.PATH, MC_CONFIG_DIR: this.dir, ...env }, timeout: 30_000 },
        (error, stdout, stderr) => {
          let json: unknown;
          try {
            json = JSON.parse(stdout);
          } catch {
            json = undefined;
          }
          resolve({
            code: error ? ((error as { code?: number }).code ?? 1) : 0,
            stdout,
            stderr,
            json,
          });
        },
      );
      child.stdin?.end(stdin ?? '');
    });
  }
  async credentials() {
    return JSON.parse(await readFile(join(this.dir, 'credentials.json'), 'utf8'));
  }
}

const withPassword = { MC_PASSWORD: PASSWORD };

describe('operator → Director → Lead → Crew onboarding, through the real mc binary', () => {
  it('works end to end', async () => {
    const operator = await Machine.create();
    const director = await Machine.create();
    const lead = await Machine.create();
    const crew = await Machine.create();
    const directorEmail = uniqueEmail('director');

    // 1. The operator creates the organisation. No organisation, no sign-in needed.
    const created = await operator.run(
      [
        '--json',
        'platform',
        'org',
        'create',
        '--name',
        'Lunar Research Lab',
        '--director-email',
        directorEmail,
      ],
      { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
    );
    expect(created.code).toBe(0);
    const { organisationId, directorUserId, invite } = created.json;
    expect(invite.inviteCode.startsWith(`${organisationId}.`)).toBe(true);
    await expect(operator.credentials()).rejects.toThrow(); // nothing stored for the operator

    // 2. The Director accepts the invite; mc asks for everything the invite did not contain.
    const accepted = await director.run(
      ['auth', 'accept-invite', invite.inviteCode, '--name', 'Dr Director', '--password-stdin'],
      {},
      `${PASSWORD}\n`,
    );
    expect(accepted.code, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`Your organisation ID is ${organisationId}`);
    const stored = await director.credentials();
    expect(stored).toMatchObject({ orgId: organisationId, role: 'director' });
    expect((await stat(join(director.dir, 'credentials.json'))).mode & 0o777).toBe(0o600);
    const whoami = await director.run(['--json', 'auth', 'whoami']);
    expect(whoami.json).toMatchObject({
      user: { id: directorUserId, name: 'Dr Director', email: directorEmail, role: 'director' },
      org: { id: organisationId, name: 'Lunar Research Lab' },
    });

    // 3. The Director invites a Lead and a Crew Member.
    const leadEmail = uniqueEmail('lead');
    const crewEmail = uniqueEmail('crew');
    const leadInvite = await director.run([
      '--json',
      'users',
      'invite',
      '--email',
      leadEmail,
      '--role',
      'lead',
    ]);
    const crewInvite = await director.run([
      '--json',
      'users',
      'invite',
      '--email',
      crewEmail,
      '--role',
      'crew',
    ]);
    expect(leadInvite.code).toBe(0);
    expect(leadInvite.json.user).toMatchObject({ status: 'invited', name: null, role: 'lead' });

    // 4. They accept on their own machines.
    for (const [machine, result, name] of [
      [lead, leadInvite, 'Lee Lead'],
      [crew, crewInvite, 'Cy Crew'],
    ] as const) {
      const r = await machine.run(
        ['auth', 'accept-invite', result.json.invite.inviteCode, '--name', name],
        withPassword,
      );
      expect(r.code, r.stderr).toBe(0);
    }
    expect((await lead.run(['--json', 'auth', 'whoami'])).json.user).toMatchObject({
      name: 'Lee Lead',
      role: 'lead',
    });
    expect((await crew.run(['--json', 'auth', 'whoami'])).json.user).toMatchObject({
      name: 'Cy Crew',
      role: 'crew',
    });

    // 5. Only the Director manages users.
    expect((await lead.run(['users', 'list'])).code).toBe(2);
    expect(
      (await crew.run(['users', 'invite', '--email', uniqueEmail('x'), '--role', 'crew'])).code,
    ).toBe(2);
    const listed = await director.run(['--json', 'users', 'list']);
    expect(listed.json.items.map((u: { role: string }) => u.role).sort()).toEqual([
      'crew',
      'director',
      'lead',
    ]);
    expect((await director.run(['users', 'list'])).stdout).toMatch(
      /ID\s+EMAIL\s+NAME\s+ROLE\s+STATUS/,
    );

    // 6. Role change revokes sessions: the Crew Member's tokens stop refreshing once the access token expires.
    const promoted = await director.run([
      '--json',
      'users',
      'set-role',
      crewInvite.json.user.id,
      'lead',
    ]);
    expect(promoted.json.role).toBe('lead');
    h.clock.advance(16 * 60 * 1000);
    expect((await crew.run(['auth', 'whoami'])).code).toBe(2);

    // 7. The Director's own session survives the same wait, by refreshing transparently.
    const before = await director.credentials();
    expect((await director.run(['auth', 'whoami'])).code).toBe(0);
    const after = await director.credentials();
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);

    // 8. Sign out, then sign in again without repeating the organisation ID.
    expect((await director.run(['auth', 'logout'])).code).toBe(0);
    expect(await director.credentials()).toEqual({ orgId: organisationId });
    expect((await director.run(['auth', 'whoami'])).code).toBe(2);
    const relogin = await director.run(['auth', 'login', '--email', directorEmail], withPassword);
    expect(relogin.code, relogin.stderr).toBe(0);
    expect((await director.run(['auth', 'whoami'])).code).toBe(0);
  });

  it('maps failures to the documented exit codes', async () => {
    const operator = await Machine.create();
    const director = await Machine.create();
    const email = uniqueEmail('director');
    const created = await operator.run(
      ['--json', 'platform', 'org', 'create', '--name', 'Codes', '--director-email', email],
      { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
    );
    await director.run(
      ['auth', 'accept-invite', created.json.invite.inviteCode, '--name', 'D', '--password-stdin'],
      {},
      `${PASSWORD}\n`,
    );
    const { organisationId, directorUserId } = created.json;

    expect(
      (
        await operator.run(
          ['platform', 'org', 'create', '--name', 'X', '--director-email', email],
          { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
        )
      ).code,
    ).toBe(4); // email taken
    expect(
      (
        await operator.run([
          'platform',
          'org',
          'create',
          '--name',
          'X',
          '--director-email',
          uniqueEmail('y'),
          '--token',
          'wrong',
        ])
      ).code,
    ).toBe(2);
    expect((await director.run(['users', 'deactivate', directorUserId])).code).toBe(4); // last active Director
    expect(
      (await director.run(['users', 'deactivate', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0009'])).code,
    ).toBe(3);
    expect((await director.run(['users', 'deactivate', 'not-a-uuid'])).code).toBe(3);
    expect((await director.run(['users', 'invite', '--email', email, '--role', 'crew'])).code).toBe(
      4,
    );
    expect((await director.run(['users', 'set-role', directorUserId, 'crew'])).code).toBe(4);
    expect(
      (await director.run(['users', 'invite', '--email', 'not-an-email', '--role', 'crew'])).code,
    ).toBe(1);
    expect((await director.run(['users', 'frobnicate'])).code).toBe(1);

    const wrong = await Machine.create();
    expect(
      (
        await wrong.run(['auth', 'login', '--org', organisationId, '--email', email], {
          MC_PASSWORD: 'definitely not it',
        })
      ).code,
    ).toBe(2);
    const down = await Machine.create();
    await down.run(['config', 'set-url', 'http://127.0.0.1:1']);
    expect(
      (await down.run(['auth', 'login', '--org', organisationId, '--email', email], withPassword))
        .code,
    ).toBe(5);
  });

  it('recovers from an expired invite with re-issue, for the operator and for a Director', async () => {
    const operator = await Machine.create();
    const director = await Machine.create();
    const fresh = await Machine.create();
    const created = await operator.run(
      [
        '--json',
        'platform',
        'org',
        'create',
        '--name',
        'Reinvite',
        '--director-email',
        uniqueEmail('d'),
      ],
      { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
    );
    h.clock.advance(73 * 60 * 60 * 1000);
    const expired = await director.run(
      ['auth', 'accept-invite', created.json.invite.inviteCode, '--name', 'D'],
      withPassword,
    );
    expect(expired.code).toBe(1);
    expect(expired.stderr).toContain('INVALID_INVITE');

    const reissued = await operator.run(
      [
        '--json',
        'platform',
        'org',
        'reinvite',
        created.json.organisationId,
        '--user',
        created.json.directorUserId,
      ],
      { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
    );
    expect(reissued.code, reissued.stderr).toBe(0);
    expect(
      (
        await director.run(
          ['auth', 'accept-invite', reissued.json.invite.inviteCode, '--name', 'D'],
          withPassword,
        )
      ).code,
    ).toBe(0);

    const invited = await director.run([
      '--json',
      'users',
      'invite',
      '--email',
      uniqueEmail('l'),
      '--role',
      'lead',
    ]);
    h.clock.advance(73 * 60 * 60 * 1000);
    expect((await director.run(['auth', 'whoami'])).code).toBe(0); // refreshed transparently
    const again = await director.run(['--json', 'users', 'reinvite', invited.json.user.id]);
    expect(again.code, again.stderr).toBe(0);
    expect(
      (
        await fresh.run(
          ['auth', 'accept-invite', again.json.inviteCode, '--name', 'L'],
          withPassword,
        )
      ).code,
    ).toBe(0);
    expect((await director.run(['users', 'reinvite', created.json.directorUserId])).code).toBe(4); // already accepted
  });
});
