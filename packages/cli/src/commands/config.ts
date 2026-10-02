import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';

export function configCommands(program: Command, ctx: Context): void {
  const config = program.command('config').description('CLI configuration');

  config
    .command('set-url')
    .argument('<url>', 'API base URL, e.g. https://api.example.com')
    .description('Set the API URL')
    .action(async (raw: string, _options, command: Command) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw usageError(`Not a valid URL: ${raw}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw usageError('The API URL must start with http:// or https://');
      }
      const normalised = url.toString().replace(/\/$/, '');
      await ctx.deps.store.setUrl(normalised);
      emit(command, ctx, { url: normalised }, () => `API URL set to ${normalised}`);
    });
}
