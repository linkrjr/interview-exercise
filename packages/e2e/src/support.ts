import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MC = fileURLToPath(new URL('../../cli/dist/bin/mc.js', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3100';
// The development default of docker-compose.yml.
export const OPERATOR_TOKEN =
  process.env.PLATFORM_OPERATOR_TOKEN ?? 'dev-operator-token-change-me-0123456789';
export const PASSWORD = 'a perfectly long password';

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

function run(
  file: string,
  args: string[],
  env: Record<string, string>,
  stdin = '',
): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        cwd: REPO,
        timeout: 60_000,
      },
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
    child.stdin?.end(stdin);
  });
}

/** One person's machine: their own config directory, running the real `mc` binary against the stack. */
export class Machine {
  private constructor(readonly dir: string) {}

  static async create(): Promise<Machine> {
    const machine = new Machine(await mkdtemp(join(tmpdir(), 'mc-e2e-')));
    await machine.mc(['config', 'set-url', API_URL]);
    return machine;
  }

  mc(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Result> {
    return run(process.execPath, [MC, ...args], { MC_CONFIG_DIR: this.dir, ...env }, stdin);
  }

  /** An `mc` call that must succeed. */
  async ok(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Result> {
    const result = await this.mc(args, env, stdin);
    if (result.code !== 0) {
      throw new Error(
        `mc ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  operator(args: string[]): Promise<Result> {
    return this.mc(args, { MC_OPERATOR_TOKEN: OPERATOR_TOKEN });
  }
}

/** Runs SQL as the database superuser inside the compose stack (to break things on purpose). */
export function sql(statement: string): Promise<Result> {
  return run(
    'docker',
    [
      'compose',
      '-p',
      process.env.E2E_COMPOSE_PROJECT ?? 'mc-e2e',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'mission_control',
      '-c',
      statement,
    ],
    { COMPOSE_PROJECT_NAME: process.env.E2E_COMPOSE_PROJECT ?? 'mc-e2e' },
  );
}

/** `YYYY-MM-DD`, `days` from today (UTC). */
export function day(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export const unique = (label: string) =>
  `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.example`;

export async function onboardDirector(name: string) {
  const operator = await Machine.create();
  const director = await Machine.create();
  const created = await operator.ok(
    ['--json', 'platform', 'org', 'create', '--name', name, '--director-email', unique('director')],
    { MC_OPERATOR_TOKEN: OPERATOR_TOKEN },
  );
  await director.ok(
    ['auth', 'accept-invite', created.json.invite.inviteCode, '--name', 'Dr Director'],
    { MC_PASSWORD: PASSWORD },
  );
  return { operator, director, orgId: created.json.organisationId as string };
}

export async function onboardMember(director: Machine, role: 'lead' | 'crew', name: string) {
  const invite = await director.ok([
    '--json',
    'users',
    'invite',
    '--email',
    unique(role),
    '--role',
    role,
  ]);
  const machine = await Machine.create();
  await machine.ok(['auth', 'accept-invite', invite.json.invite.inviteCode, '--name', name], {
    MC_PASSWORD: PASSWORD,
  });
  return { machine, userId: invite.json.user.id as string };
}
