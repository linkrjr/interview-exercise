import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDeps, Prompts } from './io.js';
import { Store } from './store.js';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (
  call: RecordedCall,
) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

export interface TestCli {
  deps: CliDeps;
  calls: RecordedCall[];
  out: string[];
  err: string[];
  store: Store;
  dir: string;
}

export async function makeCli(
  respond: Responder,
  options: {
    env?: NodeJS.ProcessEnv;
    interactive?: boolean;
    prompts?: Partial<Prompts>;
    stdin?: string;
    withUrl?: boolean;
  } = {},
): Promise<TestCli> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-cli-'));
  const store = new Store(dir);
  if (options.withUrl !== false) await store.setUrl('http://api.test');
  const calls: RecordedCall[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    store,
    env: options.env ?? {},
    stdout: { write: (t) => void out.push(t) },
    stderr: { write: (t) => void err.push(t) },
    interactive: options.interactive ?? false,
    prompts: {
      input:
        options.prompts?.input ??
        (async () => {
          throw new Error('unexpected input prompt');
        }),
      password:
        options.prompts?.password ??
        (async () => {
          throw new Error('unexpected password prompt');
        }),
    },
    readStdin: async () => options.stdin ?? '',
    fetch: async (url, init) => {
      const call: RecordedCall = {
        method: init?.method ?? 'GET',
        url,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const { status, body } = await respond(call);
      return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
        status,
        headers: {
          'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        },
      });
    },
  };
  return { deps, calls, out, err, store, dir };
}

export const problem = (status: number, code: string, detail = code) => ({
  status,
  body: { type: 'about:blank', title: 'Error', status, code, detail },
});

export const SESSION = {
  accessToken: 'access-1',
  expiresIn: 900,
  refreshToken: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.secret-1',
  orgId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
  userId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  role: 'lead',
};
