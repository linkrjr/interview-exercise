import type { CrewProfile, Page } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';
import { table } from '../io.js';
import { resolveSkill } from '../skills-lookup.js';

const SKILL_FILTER = /^(.+?)\s*>=\s*([1-5])$/;

const skillsText = (p: CrewProfile) =>
  p.skills.map((s) => `${s.name}:${s.level}`).join(', ') || '-';

export function profileText(p: CrewProfile): string {
  const lines = [
    `${p.name ?? '(no name)'} <${p.email}>  [${p.id}]`,
    `Upcoming missions: ${p.load}`,
    'Skills:',
    ...(p.skills.length ? p.skills.map((s) => `  ${s.name}  level ${s.level}`) : ['  (none)']),
    'Unavailable:',
    ...(p.unavailability.length
      ? p.unavailability.map(
          (u) => `  ${u.from} to ${u.to}${u.note ? `  (${u.note})` : ''}  [${u.id}]`,
        )
      : ['  (never)']),
  ];
  return lines.join('\n');
}

export function crewCommands(program: Command, ctx: Context): void {
  const crew = program.command('crew').description('Find crew members (Directors and Leads)');

  crew
    .command('list')
    .description('List active crew members')
    .option(
      '--skill <name>=<level>',
      'skill filter such as "Medicine>=3" (repeat to require several)',
      collect,
      [],
    )
    .option(
      '--available <from>:<to>',
      'only people with no unavailability and no hold in these dates',
    )
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(
      async (
        options: { skill: string[]; available?: string; limit?: string; cursor?: string },
        command: Command,
      ) => {
        const skill: string[] = [];
        for (const filter of options.skill) {
          const match = SKILL_FILTER.exec(filter);
          if (!match)
            throw usageError(`Invalid --skill "${filter}". Use the form "Medicine>=3" (level 1-5)`);
          skill.push(`${(await resolveSkill(ctx, match[1]!)).id}:${match[2]}`);
        }
        const page = await ctx.client.request<Page<CrewProfile>>('GET', '/v1/crew', {
          auth: 'user',
          query: { limit: options.limit, cursor: options.cursor, available: options.available },
          // Repeated parameters: the client joins them below.
          ...(skill.length ? { repeat: { skill } } : {}),
        });
        emit(command, ctx, page, () => {
          const rows = page!.items.map((p) => [
            p.id,
            p.name ?? '-',
            p.email,
            skillsText(p),
            String(p.load),
          ]);
          const text = table(['ID', 'NAME', 'EMAIL', 'SKILLS', 'LOAD'], rows);
          return page!.nextCursor
            ? `${text}\n\nMore: mc crew list --cursor ${page!.nextCursor}`
            : text;
        });
      },
    );

  crew
    .command('show')
    .argument('<id>', 'crew member ID')
    .description('Show one crew member')
    .action(async (id: string, _options, command: Command) => {
      const profile = await ctx.client.request<CrewProfile>(
        'GET',
        `/v1/crew/${encodeURIComponent(id)}`,
        {
          auth: 'user',
        },
      );
      emit(command, ctx, profile, () => profileText(profile!));
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
