import type { Store } from './store.js';
import type { FetchLike } from './client.js';

export interface Prompts {
  input(message: string): Promise<string>;
  password(message: string): Promise<string>;
}

/** Everything the CLI touches outside itself, so tests can run it in-process. */
export interface CliDeps {
  fetch: FetchLike;
  store: Store;
  env: NodeJS.ProcessEnv;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  /** True when stdin and stdout are terminals: prompts are allowed. */
  interactive: boolean;
  prompts: Prompts;
  readStdin(): Promise<string>;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}
