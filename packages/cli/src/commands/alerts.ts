import type { Alert, Page } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

export function alertCommands(program: Command, ctx: Context): void {
  program
    .command('alerts')
    .description('Operational alerts for the organisation, such as scheduler failures (Directors)')
    .option('--since <date|time>', 'from this UTC date (YYYY-MM-DD) or ISO time, inclusive')
    .option('--until <date|time>', 'before this UTC date or ISO time')
    .option('--limit <n>', 'page size (1-100, default 50)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(
      async (
        options: { since?: string; until?: string; limit?: string; cursor?: string },
        command: Command,
      ) => {
        const page = await ctx.client.request<Page<Alert>>('GET', '/v1/alerts', {
          auth: 'user',
          query: { ...options },
        });
        emit(command, ctx, page, () => {
          if (page!.items.length === 0) return 'No alerts.';
          const rows = page!.items.map((a) => [
            a.occurredAt,
            a.code,
            a.message,
            a.details ? JSON.stringify(a.details) : '',
          ]);
          const text = table(['TIME (UTC)', 'CODE', 'MESSAGE', 'DETAILS'], rows);
          return page!.nextCursor
            ? `${text}\n\nMore: mc alerts --cursor ${page!.nextCursor}`
            : text;
        });
      },
    );
}
