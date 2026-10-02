import type {
  CrewMission,
  Mission,
  MissionAction,
  MissionView,
  MeResponse,
  Page,
  MissionSummary,
} from '@mc/contracts';
import { Argument, Option, type Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';
import { crewMissionText, missionTable, missionText } from '../mission-format.js';
import { resolveSkill } from '../skills-lookup.js';
import { matchCommands } from './match.js';

const STATUSES = [
  'draft',
  'crewing',
  'pending_approval',
  'approved',
  'active',
  'completed',
  'cancelled',
];

/** `Name:level:count` with the name last-colon-safe: the level and count are the final two parts. */
export function parseRequirement(text: string): { name: string; minLevel: number; count: number } {
  const parts = text.split(':');
  const count = Number(parts.pop());
  const minLevel = Number(parts.pop());
  const name = parts.join(':').trim();
  if (
    !name ||
    !Number.isInteger(minLevel) ||
    minLevel < 1 ||
    minLevel > 5 ||
    !Number.isInteger(count) ||
    count < 1
  ) {
    throw usageError(
      `Invalid --req "${text}". Use "Skill name:level:count", e.g. "Orbital Piloting:4:1" (level 1-5, count 1 or more)`,
    );
  }
  return { name, minLevel, count };
}

/** The version to send in `If-Match`: the one given with `--version`, else the mission's current one. */
async function versionOf(ctx: Context, id: string, given: string | undefined): Promise<number> {
  if (given !== undefined) {
    const n = Number(given);
    if (!Number.isInteger(n) || n < 1) throw usageError('--version must be a whole number');
    return n;
  }
  const mission = await ctx.client.request<MissionView>(
    'GET',
    `/v1/missions/${encodeURIComponent(id)}`,
    { auth: 'user' },
  );
  if (!mission || !('version' in mission)) throw usageError('You cannot change this mission');
  return mission.version;
}

async function myId(ctx: Context): Promise<string> {
  const stored = (await ctx.deps.store.getCredentials()).userId;
  if (stored) return stored;
  return (await ctx.client.request<MeResponse>('GET', '/v1/me', { auth: 'user' }))!.user.id;
}

const versionOption = () =>
  new Option('--version <n>', 'the mission version you last saw (default: fetched now)');

const PAST: Record<string, string> = {
  start_crewing: 'is now being crewed',
  reopen: 'is back in draft',
  submit: 'was submitted for approval',
  withdraw: 'was withdrawn and is being crewed again',
  approve: 'was approved',
  reject: 'was rejected',
  cancel: 'was cancelled',
};

export function missionCommands(program: Command, ctx: Context): void {
  const missions = program
    .command('missions')
    .description('Plan missions and take them through approval');

  missions
    .command('create')
    .description('Create a mission (Leads)')
    .requiredOption('--name <name>', 'mission name')
    .requiredOption('--start <date>', 'first day, YYYY-MM-DD')
    .requiredOption('--end <date>', 'last day (inclusive), YYYY-MM-DD')
    .option('--description <text>', 'description')
    .action(
      async (
        o: { name: string; start: string; end: string; description?: string },
        command: Command,
      ) => {
        const mission = await ctx.client.request<Mission>('POST', '/v1/missions', {
          auth: 'user',
          body: {
            name: o.name,
            startDate: o.start,
            endDate: o.end,
            ...(o.description ? { description: o.description } : {}),
          },
        });
        emit(command, ctx, mission, () => `Created mission ${mission!.name} (${mission!.id})`);
      },
    );

  missions
    .command('list')
    .description('List missions')
    .addOption(
      new Option('--status <status>', 'only this status (repeat for several)')
        .choices(STATUSES)
        .argParser(collect(STATUSES)),
    )
    .option('--mine', 'only missions you lead')
    .option('--lead <userId>', 'only missions led by this user')
    .option('--from <date>', 'overlapping dates from, YYYY-MM-DD')
    .option('--to <date>', 'overlapping dates to, YYYY-MM-DD')
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(
      async (
        o: {
          status?: string[];
          mine?: boolean;
          lead?: string;
          from?: string;
          to?: string;
          limit?: string;
          cursor?: string;
        },
        command: Command,
      ) => {
        if (o.mine && o.lead) throw usageError('Use either --mine or --lead, not both');
        const leadId = o.mine ? await myId(ctx) : o.lead;
        const page = await ctx.client.request<Page<MissionSummary | CrewMission>>(
          'GET',
          '/v1/missions',
          {
            auth: 'user',
            query: { leadId, from: o.from, to: o.to, limit: o.limit, cursor: o.cursor },
            ...(o.status?.length ? { repeat: { status: o.status } } : {}),
          },
        );
        emit(command, ctx, page, () => {
          const text = page!.items.length ? missionTable(page!.items) : 'No missions';
          return page!.nextCursor
            ? `${text}\n\nMore: mc missions list --cursor ${page!.nextCursor}`
            : text;
        });
      },
    );

  missions
    .command('show')
    .argument('<id>', 'mission ID')
    .description('Show a mission')
    .action(async (id: string, _o, command: Command) => {
      const mission = await ctx.client.request<MissionView>(
        'GET',
        `/v1/missions/${encodeURIComponent(id)}`,
        { auth: 'user' },
      );
      emit(command, ctx, mission, () =>
        'version' in mission!
          ? missionText(mission as Mission)
          : crewMissionText(mission as CrewMission),
      );
    });

  matchCommands(missions, ctx);

  const requirements = missions
    .command('requirements')
    .description("A mission's skill requirements");
  requirements
    .command('set')
    .argument('<id>', 'mission ID')
    .description('Replace the requirements (Draft and Crewing, owning Lead)')
    .option(
      '--req <skill:level:count>',
      'a requirement such as "Orbital Piloting:4:1" (repeat for several)',
      collectAny,
      [],
    )
    .option('--clear', 'remove every requirement')
    .addOption(versionOption())
    .action(
      async (
        id: string,
        o: { req: string[]; clear?: boolean; version?: string },
        command: Command,
      ) => {
        if (o.req.length === 0 && !o.clear)
          throw usageError('Give at least one --req, or --clear to remove them all');
        if (o.req.length > 0 && o.clear) throw usageError('Use either --req or --clear, not both');
        const parsed = o.req.map(parseRequirement);
        const resolved = [];
        for (const r of parsed) {
          resolved.push({
            skillId: (await resolveSkill(ctx, r.name)).id,
            minLevel: r.minLevel,
            count: r.count,
          });
        }
        const version = await versionOf(ctx, id, o.version);
        const mission = await ctx.client.request<Mission>(
          'PUT',
          `/v1/missions/${encodeURIComponent(id)}/requirements`,
          {
            auth: 'user',
            body: { requirements: resolved },
            headers: { 'If-Match': `"${version}"` },
          },
        );
        emit(
          command,
          ctx,
          mission,
          () =>
            `Requirements set (${mission!.requirements.length}); mission is at version ${mission!.version}`,
        );
      },
    );

  const crew = missions.command('crew').description("A mission's tentative crew");
  crew
    .command('set')
    .addArgument(new Argument('<id>', 'mission ID'))
    .addArgument(new Argument('[crewIds...]', 'crew member IDs'))
    .description('Replace the tentative crew (Crewing, owning Lead)')
    .option('--clear', 'remove the whole crew')
    .addOption(versionOption())
    .action(
      async (
        id: string,
        crewIds: string[],
        o: { clear?: boolean; version?: string },
        command: Command,
      ) => {
        if (crewIds.length === 0 && !o.clear)
          throw usageError('Give crew member IDs, or --clear to remove the whole crew');
        if (crewIds.length > 0 && o.clear)
          throw usageError('Use either crew member IDs or --clear, not both');
        const version = await versionOf(ctx, id, o.version);
        const mission = await ctx.client.request<Mission>(
          'PUT',
          `/v1/missions/${encodeURIComponent(id)}/crew`,
          {
            auth: 'user',
            body: { crewMemberIds: crewIds },
            headers: { 'If-Match': `"${version}"` },
          },
        );
        emit(command, ctx, mission, () => {
          const check = mission!.crewValidation;
          return `Crew set (${mission!.crew.length}); ${check ? (check.valid ? 'ready to submit' : 'not ready to submit yet') : ''}`.trim();
        });
      },
    );

  const transition = (name: string, action: MissionAction, description: string) =>
    missions
      .command(name)
      .argument('<id>', 'mission ID')
      .description(description)
      .addOption(versionOption())
      .action(async (id: string, o: { version?: string }, command: Command) => {
        const mission = await doTransition(id, { action }, o.version);
        emit(
          command,
          ctx,
          mission,
          () => `Mission ${mission.name} ${PAST[action]} (now ${mission.status})`,
        );
      });

  async function doTransition(
    id: string,
    body: { action: MissionAction; comment?: string },
    given: string | undefined,
  ) {
    const version = await versionOf(ctx, id, given);
    return (await ctx.client.request<Mission>(
      'POST',
      `/v1/missions/${encodeURIComponent(id)}/transitions`,
      {
        auth: 'user',
        body,
        headers: { 'If-Match': `"${version}"` },
      },
    ))!;
  }

  transition('start-crewing', 'start_crewing', 'Start crewing a Draft mission (owning Lead)');
  transition(
    'reopen',
    'reopen',
    'Take a Crewing mission back to Draft, clearing its crew (owning Lead)',
  );
  transition('submit', 'submit', 'Submit the crew for approval (owning Lead)');
  transition('withdraw', 'withdraw', 'Withdraw a submitted mission back to Crewing (owning Lead)');
  transition('cancel', 'cancel', 'Cancel a mission before it starts (owning Lead)');

  missions
    .command('approve')
    .argument('<id>', 'mission ID')
    .description('Approve a submitted mission (Directors)')
    .option('--comment <text>', 'an optional comment')
    .addOption(versionOption())
    .action(async (id: string, o: { comment?: string; version?: string }, command: Command) => {
      const mission = await doTransition(
        id,
        { action: 'approve', ...(o.comment ? { comment: o.comment } : {}) },
        o.version,
      );
      emit(
        command,
        ctx,
        mission,
        () => `Mission ${mission.name} ${PAST.approve} (now ${mission.status})`,
      );
    });

  missions
    .command('reject')
    .argument('<id>', 'mission ID')
    .description('Reject a submitted mission; it returns to Crewing (Directors)')
    .requiredOption('--reason <text>', 'why it is rejected')
    .addOption(versionOption())
    .action(async (id: string, o: { reason: string; version?: string }, command: Command) => {
      const mission = await doTransition(id, { action: 'reject', comment: o.reason }, o.version);
      emit(
        command,
        ctx,
        mission,
        () => `Mission ${mission.name} ${PAST.reject} (now ${mission.status})`,
      );
    });

  program
    .command('approvals')
    .description('Missions awaiting a decision (Directors)')
    .command('list')
    .description('List missions pending approval')
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(async (o: { limit?: string; cursor?: string }, command: Command) => {
      const page = await ctx.client.request<Page<MissionSummary>>('GET', '/v1/missions', {
        auth: 'user',
        query: { limit: o.limit, cursor: o.cursor },
        repeat: { status: ['pending_approval'] },
      });
      emit(command, ctx, page, () => {
        const text = page!.items.length
          ? missionTable(page!.items)
          : 'Nothing is waiting for approval';
        return page!.nextCursor
          ? `${text}\n\nMore: mc approvals list --cursor ${page!.nextCursor}`
          : text;
      });
    });
}

/** A repeatable option restricted to the given values. */
function collect(allowed: string[]) {
  return (value: string, previous: string[] | undefined): string[] => {
    if (!allowed.includes(value))
      throw usageError(`Unknown value "${value}"; use one of: ${allowed.join(', ')}`);
    return [...(previous ?? []), value];
  };
}

function collectAny(value: string, previous: string[]): string[] {
  return [...previous, value];
}
