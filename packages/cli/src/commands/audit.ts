import type { AuditEvent, Page } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

export function auditCommands(program: Command, ctx: Context): void {
  const audit = program.command('audit').description('The audit log (Directors)');

  audit
    .command('list')
    .description('List audit events, newest first')
    .option('--entity <type:id>', 'only events about one entity, e.g. mission:<id>')
    .option('--actor <userId|system>', 'only events by one actor')
    .option('--since <date|time>', 'from this UTC date (YYYY-MM-DD) or ISO time, inclusive')
    .option('--until <date|time>', 'before this UTC date or ISO time')
    .option('--limit <n>', 'page size (1-100, default 50)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(
      async (
        options: {
          entity?: string;
          actor?: string;
          since?: string;
          until?: string;
          limit?: string;
          cursor?: string;
        },
        command: Command,
      ) => {
        const page = await ctx.client.request<Page<AuditEvent>>('GET', '/v1/audit', {
          auth: 'user',
          query: { ...options },
        });
        emit(command, ctx, page, () => {
          const rows = page!.items.map((e) => [
            e.occurredAt,
            e.action,
            `${e.entityType}:${e.entityId}`,
            e.actorId ?? 'system',
          ]);
          const text = table(['TIME (UTC)', 'ACTION', 'ENTITY', 'ACTOR'], rows);
          return page!.nextCursor
            ? `${text}\n\nMore: mc audit list --cursor ${page!.nextCursor}`
            : text;
        });
      },
    );
}
