import type { OrgSettings } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';

const show = (s: OrgSettings) =>
  `Time zone:                       ${s.timeZone}\nMax upcoming missions per crew:  ${s.maxUpcomingMissions}`;

export function orgCommands(program: Command, ctx: Context): void {
  const org = program.command('org').description('Your organisation');
  const settings = org.command('settings').description('Organisation settings');

  settings
    .command('show')
    .description('Show the time zone and the workload cap')
    .action(async (_options, command: Command) => {
      const result = await ctx.client.request<OrgSettings>('GET', '/v1/org/settings', {
        auth: 'user',
      });
      emit(command, ctx, result, () => show(result!));
    });

  settings
    .command('set')
    .description('Change settings (Directors)')
    .option('--timezone <zone>', 'IANA time zone, e.g. Europe/London')
    .option('--max-upcoming <n>', 'most upcoming missions per crew member (1-20)')
    .action(async (options: { timezone?: string; maxUpcoming?: string }, command: Command) => {
      if (options.timezone === undefined && options.maxUpcoming === undefined) {
        throw usageError('Give --timezone and/or --max-upcoming');
      }
      const body: Record<string, unknown> = {};
      if (options.timezone !== undefined) body.timeZone = options.timezone;
      if (options.maxUpcoming !== undefined) {
        const n = Number(options.maxUpcoming);
        if (!Number.isInteger(n)) throw usageError('--max-upcoming must be a whole number');
        body.maxUpcomingMissions = n;
      }
      const result = await ctx.client.request<OrgSettings>('PATCH', '/v1/org/settings', {
        auth: 'user',
        body,
      });
      emit(command, ctx, result, () => show(result!));
    });
}
