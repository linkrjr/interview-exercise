import type { RunSchedulerResponse, SeedResponse } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { CliError, ExitCode, usageError } from '../errors.js';
import { table } from '../io.js';

function operatorToken(ctx: Context, flag: string | undefined): string {
  const token = flag ?? ctx.deps.env.MC_OPERATOR_TOKEN;
  if (!token)
    throw usageError('The operator token is required: set MC_OPERATOR_TOKEN or pass --token');
  return token;
}

/** The server has no such route in a production build: say so instead of "Route not found". */
async function onDevServer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CliError && error.exitCode === ExitCode.NOT_FOUND) {
      throw new CliError(
        'This server does not offer development commands (they exist only in non-production builds).',
        ExitCode.NOT_FOUND,
        error.problem,
      );
    }
    throw error;
  }
}

/** Development helpers; the server only answers them outside production (DESIGN.md §16). */
export function devCommands(program: Command, ctx: Context): void {
  const dev = program
    .command('dev')
    .description('Development helpers (non-production servers only)');

  dev
    .command('seed')
    .description(
      'Fill an empty database with a demo scenario: two organisations, crew and missions',
    )
    .option('--scenario <name>', 'the scenario to seed', 'demo')
    .option('--token <token>', 'operator token (default: MC_OPERATOR_TOKEN)')
    .action(async (options: { scenario: string; token?: string }, command: Command) => {
      const seeded = await onDevServer(() =>
        ctx.client.request<SeedResponse>('POST', '/v1/test/seed', {
          auth: 'operator',
          operatorToken: operatorToken(ctx, options.token),
          body: { scenario: options.scenario },
        }),
      );
      emit(command, ctx, seeded, () => {
        const lines = [
          `Seeded the "${seeded!.scenario}" scenario. Every user's password: ${seeded!.password}`,
        ];
        for (const org of seeded!.organisations) {
          lines.push(
            '',
            `${org.name} (${org.timeZone})  organisation id: ${org.id}`,
            table(
              ['ROLE', 'NAME', 'EMAIL'],
              org.users.map((u) => [u.role, u.name, u.email]),
            ),
            '',
            table(
              ['MISSION', 'STATUS'],
              org.missions.map((m) => [m.name, m.status]),
            ),
          );
        }
        lines.push('', 'Sign in with: mc auth login --org <organisation id> --email <email>');
        return lines.join('\n');
      });
    });

  dev
    .command('run-scheduler')
    .description('Run one scheduler pass as if today were the given date')
    .requiredOption('--date <YYYY-MM-DD>', 'the day to pretend it is')
    .option('--token <token>', 'operator token (default: MC_OPERATOR_TOKEN)')
    .action(async (options: { date: string; token?: string }, command: Command) => {
      const result = await onDevServer(() =>
        ctx.client.request<RunSchedulerResponse>('POST', '/v1/test/scheduler/run', {
          auth: 'operator',
          operatorToken: operatorToken(ctx, options.token),
          body: { today: options.date },
        }),
      );
      emit(command, ctx, result, () => {
        const rows = result!.organisations.map((o) => [
          o.organisationId,
          o.status,
          o.status === 'ok'
            ? `expired ${o.expired}, activated ${o.activated}, completed ${o.completed}`
            : o.alertWritten
              ? 'failed, alert raised'
              : 'failed, alert NOT written',
        ]);
        return `${table(['ORGANISATION', 'RESULT', 'DETAILS'], rows)}\n\nAlerts purged: ${result!.alertsPurged}`;
      });
    });
}
