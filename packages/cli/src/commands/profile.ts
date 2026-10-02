import type { CrewProfile, CrewSkill, MeResponse, Unavailability } from '@mc/contracts';
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';
import { table } from '../io.js';
import { resolveSkill } from '../skills-lookup.js';
import { profileText } from './crew.js';

async function myId(ctx: Context): Promise<string> {
  const stored = (await ctx.deps.store.getCredentials()).userId;
  if (stored) return stored;
  const me = await ctx.client.request<MeResponse>('GET', '/v1/me', { auth: 'user' });
  return me!.user.id;
}

async function myProfile(ctx: Context): Promise<CrewProfile> {
  const profile = await ctx.client.request<CrewProfile>('GET', `/v1/crew/${await myId(ctx)}`, {
    auth: 'user',
  });
  return profile!;
}

export function profileCommands(program: Command, ctx: Context): void {
  const profile = program.command('profile').description('Your own crew profile (Crew Members)');

  profile
    .command('show')
    .description('Show your skills, unavailability and workload')
    .action(async (_options, command: Command) => {
      const result = await myProfile(ctx);
      emit(command, ctx, result, () => profileText(result));
    });

  const skill = profile.command('skill').description('Your skills');

  skill
    .command('set')
    .argument('<skill>', 'skill name, e.g. "Medicine"')
    .argument('<level>', `your level, ${SKILL_LEVEL_MIN}-${SKILL_LEVEL_MAX}`)
    .description('Set your level for a skill')
    .action(async (name: string, rawLevel: string, _options, command: Command) => {
      const level = Number(rawLevel);
      if (!Number.isInteger(level) || level < SKILL_LEVEL_MIN || level > SKILL_LEVEL_MAX) {
        throw usageError(
          `The level must be a whole number from ${SKILL_LEVEL_MIN} to ${SKILL_LEVEL_MAX}`,
        );
      }
      const found = await resolveSkill(ctx, name);
      const result = await ctx.client.request<CrewSkill>('PUT', `/v1/crew/me/skills/${found.id}`, {
        auth: 'user',
        body: { level },
      });
      emit(command, ctx, result, () => `${result!.name}: level ${result!.level}`);
    });

  skill
    .command('remove')
    .argument('<skill>', 'skill name')
    .description('Remove a skill from your profile')
    .action(async (name: string, _options, command: Command) => {
      const found = await resolveSkill(ctx, name);
      await ctx.client.request('DELETE', `/v1/crew/me/skills/${found.id}`, { auth: 'user' });
      emit(command, ctx, { removed: found.name }, () => `Removed ${found.name}`);
    });

  const unavailable = profile.command('unavailable').description('Dates you cannot be assigned');

  unavailable
    .command('add')
    .argument('<from>', 'first day, YYYY-MM-DD')
    .argument('<to>', 'last day (inclusive), YYYY-MM-DD')
    .option('--note <text>', 'a private note, visible only to you')
    .description('Add an unavailable range')
    .action(async (from: string, to: string, options: { note?: string }, command: Command) => {
      const range = await ctx.client.request<Unavailability>('POST', '/v1/crew/me/unavailability', {
        auth: 'user',
        body: { from, to, ...(options.note ? { note: options.note } : {}) },
      });
      emit(command, ctx, range, () => `Unavailable ${range!.from} to ${range!.to} [${range!.id}]`);
    });

  unavailable
    .command('list')
    .description('List your unavailable ranges')
    .action(async (_options, command: Command) => {
      const { unavailability } = await myProfile(ctx);
      emit(command, ctx, unavailability, () =>
        unavailability.length
          ? table(
              ['ID', 'FROM', 'TO', 'NOTE'],
              unavailability.map((u) => [u.id, u.from, u.to, u.note ?? '']),
            )
          : 'No unavailable ranges',
      );
    });

  unavailable
    .command('remove')
    .argument('<id>', 'range ID from `unavailable list`')
    .description('Remove an unavailable range')
    .action(async (id: string, _options, command: Command) => {
      await ctx.client.request('DELETE', `/v1/crew/me/unavailability/${encodeURIComponent(id)}`, {
        auth: 'user',
      });
      emit(command, ctx, { removed: id }, () => `Removed ${id}`);
    });
}
