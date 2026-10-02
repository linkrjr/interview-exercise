import { buildApp, createTestSupport } from '@mc/api';
import { createHarness, type Harness } from '@mc/core/testing';
import { createHighsSolver } from '@mc/matcher/highs';
import type { DbUrls } from '@mc/db/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MC = fileURLToPath(new URL('../dist/bin/mc.js', import.meta.url));

export const OPERATOR_TOKEN = 'e2e-operator-token-0123456789abcdef0123';
export const PASSWORD = 'a perfectly long password';
export const withPassword = { MC_PASSWORD: PASSWORD };

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
  // Parsed stdout when it is JSON, for loose field-by-field checks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/** One person's machine: their own config directory, running the real `mc` binary. */
export class Machine {
  private constructor(
    readonly dir: string,
    private readonly apiUrl: string,
  ) {}

  static async create(apiUrl: string): Promise<Machine> {
    const machine = new Machine(await mkdtemp(join(tmpdir(), 'mc-e2e-')), apiUrl);
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

  /** A new machine pointing at the same API. */
  another(): Promise<Machine> {
    return Machine.create(this.apiUrl);
  }
}

export interface E2e {
  h: Harness;
  apiUrl: string;
  machine(): Promise<Machine>;
  stop(): Promise<void>;
}

/** Starts the real API (with real audit persistence) on a random port, backed by the test database. */
export async function startE2e(
  urls: DbUrls,
  options: { testSupport?: boolean } = {},
): Promise<E2e> {
  const h = await createHarness(urls, { dbAudit: true });
  const app = buildApp({
    services: h,
    accessTokens: h.accessTokens,
    operatorToken: OPERATOR_TOKEN,
    loginRate: { emailMax: 100, ipMax: 1000, windowMs: 60_000 },
    clock: h.clock,
    // The test-only endpoints exist only when asked for, as in a non-production build.
    testSupport:
      options.testSupport === false
        ? undefined
        : createTestSupport({
            db: h.db,
            hasSchedulerLogin: true,
            accessTokens: h.accessTokens,
            solver: await createHighsSolver(),
            logger: { info() {}, warn() {}, error() {} },
            clock: h.clock,
          }),
  });
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    h,
    apiUrl,
    machine: () => Machine.create(apiUrl),
    stop: async () => {
      await app.close();
      await h.close();
    },
  };
}

/** Creates an organisation and activates its Director, returning that Director's machine. */
export async function onboardDirector(
  e2e: E2e,
  directorEmail: string,
  orgName = 'Lunar Research Lab',
) {
  const operator = await e2e.machine();
  const director = await e2e.machine();
  const created = await operator.run(
    ['--json', 'platform', 'org', 'create', '--name', orgName, '--director-email', directorEmail],
    { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
  );
  await director.run(
    ['auth', 'accept-invite', created.json.invite.inviteCode, '--name', 'Dr Director'],
    withPassword,
  );
  return {
    director,
    orgId: created.json.organisationId as string,
    directorUserId: created.json.directorUserId as string,
  };
}

/** Invites a user as the Director and has them accept on their own machine. */
export async function onboardMember(
  director: Machine,
  role: 'lead' | 'crew',
  email: string,
  name: string,
) {
  const invite = await director.run([
    '--json',
    'users',
    'invite',
    '--email',
    email,
    '--role',
    role,
  ]);
  const machine = await director.another();
  await machine.run(
    ['auth', 'accept-invite', invite.json.invite.inviteCode, '--name', name],
    withPassword,
  );
  return { machine, userId: invite.json.user.id as string };
}
