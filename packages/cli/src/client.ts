import {
  ProblemDetailsSchema,
  SessionSchema,
  type ProblemDetails,
  type Session,
} from '@mc/contracts';
import { CliError, ExitCode, exitCodeForStatus, usageError } from './errors.js';
import type { Store } from './store.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Extra request headers, e.g. `If-Match`. */
  headers?: Record<string, string>;
  /** Parameters that are sent once per value, e.g. `skill=a&skill=b`. */
  repeat?: Record<string, string[]>;
  /** `user` sends the stored access token (refreshing it transparently); `operator` sends the given token; `none` sends nothing. */
  auth: 'user' | 'operator' | 'none';
  operatorToken?: string;
}

interface BlockingMission {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
}
interface OverlappingRange {
  id: string;
  from: string;
  to: string;
}

/** The problem as text: the headline, field errors, and the extension members the API adds. */
function messageFor(problem: ProblemDetails): string {
  const lines = (problem.errors ?? []).map((e) => `  - ${e.field || 'request'}: ${e.message}`);
  const missions = problem.missions as BlockingMission[] | undefined;
  for (const m of Array.isArray(missions) ? missions : []) {
    lines.push(`  - mission ${m.name} (${m.startDate} to ${m.endDate}, ${m.status}) [${m.id}]`);
  }
  const ranges = problem.unavailability as OverlappingRange[] | undefined;
  for (const r of Array.isArray(ranges) ? ranges : []) {
    lines.push(`  - existing range ${r.from} to ${r.to} [${r.id}]`);
  }
  const issues = problem.issues as Array<{ code: string; crewMemberIds: string[] }> | undefined;
  for (const i of Array.isArray(issues) ? issues : [])
    lines.push(`  - ${i.code}: ${i.crewMemberIds.join(', ')}`);
  const unmet = problem.unmetRequirements as
    Array<{ skillId: string; minLevel: number; required: number; met: number }> | undefined;
  for (const u of Array.isArray(unmet) ? unmet : []) {
    lines.push(
      `  - requirement ${u.skillId} (level ${u.minLevel}+): needs ${u.required}, has ${u.met}`,
    );
  }
  const refused = problem.crewMemberIds as string[] | undefined;
  if (Array.isArray(refused) && refused.length)
    lines.push(`  - not assignable: ${refused.join(', ')}`);
  const allowed = problem.allowedActions as string[] | undefined;
  if (Array.isArray(allowed)) {
    lines.push(
      allowed.length
        ? `  - you can now: ${allowed.join(', ')}`
        : '  - nothing can be done to this mission by you now',
    );
  }
  if (typeof problem.currentVersion === 'number')
    lines.push(`  - the mission is now at version ${problem.currentVersion}`);
  const head = `${problem.detail ?? problem.title} (${problem.code})`;
  return lines.length > 0 ? `${head}\n${lines.join('\n')}` : head;
}

export class ApiClient {
  constructor(
    private readonly store: Store,
    private readonly fetchImpl: FetchLike,
  ) {}

  async baseUrl(): Promise<string> {
    const url = await this.store.getUrl();
    if (!url) throw usageError('No API URL configured. Run: mc config set-url <url>');
    return url;
  }

  async request<T>(method: string, path: string, options: RequestOptions): Promise<T | undefined> {
    const base = await this.baseUrl();
    const credentials = await this.store.getCredentials();

    const send = (accessToken?: string) =>
      this.send(base, method, path, options, options.auth === 'user' ? accessToken : undefined);

    if (options.auth === 'user' && !credentials.accessToken) {
      throw new CliError('Not signed in. Run: mc auth login', ExitCode.AUTH);
    }

    let response = await send(credentials.accessToken);
    if (options.auth === 'user' && response.status === 401 && credentials.refreshToken) {
      const refreshed = await this.refresh(base, credentials.refreshToken);
      if (refreshed) {
        await this.store.setCredentials({
          ...credentials,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          userId: refreshed.userId,
          role: refreshed.role,
        });
        response = await send(refreshed.accessToken);
      }
    }
    return this.parse<T>(response);
  }

  private async send(
    base: string,
    method: string,
    path: string,
    options: RequestOptions,
    accessToken: string | undefined,
  ): Promise<Response> {
    // A relative path keeps any prefix in the configured URL (https://host/prefix + /v1/x).
    const url = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (const [key, values] of Object.entries(options.repeat ?? {})) {
      for (const value of values) url.searchParams.append(key, value);
    }
    const token = options.auth === 'operator' ? options.operatorToken : accessToken;
    try {
      return await this.fetchImpl(url.toString(), {
        method,
        headers: {
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...options.headers,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new CliError(`Cannot reach ${base}: ${(error as Error).message}`, ExitCode.SERVER);
    }
  }

  /** Returns the new session, or `undefined` when the refresh token is no longer accepted. */
  private async refresh(base: string, refreshToken: string): Promise<Session | undefined> {
    const response = await this.send(
      base,
      'POST',
      '/v1/auth/refresh',
      { auth: 'none', body: { refreshToken } },
      undefined,
    );
    if (!response.ok) return undefined;
    return SessionSchema.parse(await response.json());
  }

  private async parse<T>(response: Response): Promise<T | undefined> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.ok) return json as T;

    const problem = ProblemDetailsSchema.safeParse(json);
    if (problem.success) {
      throw new CliError(
        messageFor(problem.data),
        exitCodeForStatus(response.status),
        problem.data,
      );
    }
    throw new CliError(
      `Unexpected response from the server (HTTP ${response.status})`,
      exitCodeForStatus(response.status),
    );
  }
}
