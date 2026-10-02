import type { Assignment, Page } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

export function assignmentCommands(program: Command, ctx: Context): void {
  const assignments = program.command('assignments').description('Your assignments (Crew Members)');

  assignments
    .command('list')
    .description('List your assignments, from approval onward')
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(async (o: { limit?: string; cursor?: string }, command: Command) => {
      const page = await ctx.client.request<Page<Assignment>>('GET', '/v1/assignments/me', {
        auth: 'user',
        query: { limit: o.limit, cursor: o.cursor },
      });
      emit(command, ctx, page, () => {
        const rows = page!.items.map((a) => [
          a.id,
          a.mission.name,
          a.mission.status,
          a.mission.startDate,
          a.mission.endDate,
          a.acknowledgedAt ? 'yes' : 'no',
        ]);
        const text = rows.length
          ? table(['ID', 'MISSION', 'STATUS', 'START', 'END', 'ACKNOWLEDGED'], rows)
          : 'No assignments yet';
        return page!.nextCursor
          ? `${text}\n\nMore: mc assignments list --cursor ${page!.nextCursor}`
          : text;
      });
    });

  assignments
    .command('acknowledge')
    .argument('<id>', 'assignment ID from `assignments list`')
    .description(
      'Acknowledge that you have received an assignment (it is binding; it cannot be refused)',
    )
    .action(async (id: string, _o, command: Command) => {
      const a = await ctx.client.request<Assignment>(
        'POST',
        `/v1/assignments/${encodeURIComponent(id)}/acknowledge`,
        { auth: 'user' },
      );
      emit(
        command,
        ctx,
        a,
        () => `Acknowledged ${a!.mission.name} (${a!.mission.startDate} to ${a!.mission.endDate})`,
      );
    });
}
