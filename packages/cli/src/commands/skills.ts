import type { Page, Skill } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

export function skillCommands(program: Command, ctx: Context): void {
  const skills = program.command('skills').description('The skill catalogue');

  skills
    .command('add')
    .argument('<name>', 'skill name, e.g. "Orbital Piloting"')
    .description('Add a skill (Directors)')
    .action(async (name: string, _options, command: Command) => {
      const skill = await ctx.client.request<Skill>('POST', '/v1/skills', {
        auth: 'user',
        body: { name },
      });
      emit(command, ctx, skill, () => `Added skill ${skill!.name} (${skill!.id})`);
    });

  skills
    .command('list')
    .description('List skills')
    .option('--limit <n>', 'page size (1-100, default 50)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(async (options: { limit?: string; cursor?: string }, command: Command) => {
      const page = await ctx.client.request<Page<Skill>>('GET', '/v1/skills', {
        auth: 'user',
        query: { limit: options.limit, cursor: options.cursor },
      });
      emit(command, ctx, page, () => {
        const text = table(
          ['ID', 'NAME'],
          page!.items.map((s) => [s.id, s.name]),
        );
        return page!.nextCursor
          ? `${text}\n\nMore: mc skills list --cursor ${page!.nextCursor}`
          : text;
      });
    });

  skills
    .command('rename')
    .argument('<id>', 'skill ID')
    .argument('<name>', 'new name')
    .description('Rename a skill (Directors)')
    .action(async (id: string, name: string, _options, command: Command) => {
      const skill = await ctx.client.request<Skill>(
        'PATCH',
        `/v1/skills/${encodeURIComponent(id)}`,
        {
          auth: 'user',
          body: { name },
        },
      );
      emit(command, ctx, skill, () => `Renamed to ${skill!.name}`);
    });
}
