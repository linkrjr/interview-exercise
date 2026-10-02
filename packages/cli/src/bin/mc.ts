#!/usr/bin/env node
import { runCli } from '../program.js';
import { Store } from '../store.js';
import type { CliDeps } from '../io.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const deps: CliDeps = {
  fetch: (input, init) => fetch(input, init),
  store: Store.fromEnv(process.env),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompts: {
    async input(message) {
      const { input } = await import('@inquirer/prompts');
      return input({ message });
    },
    async password(message) {
      const { password } = await import('@inquirer/prompts');
      return password({ message, mask: '*' });
    },
  },
  readStdin,
};

process.exitCode = await runCli(process.argv.slice(2), deps);
