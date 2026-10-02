import type { Command } from 'commander';
import type { ApiClient } from './client.js';
import type { CliDeps } from './io.js';

export interface Context {
  deps: CliDeps;
  client: ApiClient;
}

/** Prints `data` as JSON when `--json` is set (on any parent command), else the human text. */
export function emit(command: Command, ctx: Context, data: unknown, human: () => string): void {
  const json = Boolean(command.optsWithGlobals().json);
  ctx.deps.stdout.write(`${json ? JSON.stringify(data, null, 2) : human()}\n`);
}
