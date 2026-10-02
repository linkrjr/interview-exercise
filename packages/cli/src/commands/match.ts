import type { Mission, MatchProposal } from '@mc/contracts';
import { Argument, Option, type Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';
import { missionText } from '../mission-format.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collectIds(value: string, previous: string[] | undefined): string[] {
  if (!UUID.test(value)) throw usageError(`--exclude needs a crew member ID, got "${value}"`);
  return [...(previous ?? []), value];
}

export function proposalText(p: MatchProposal, missionId: string): string {
  const lines = [
    `Proposal ${p.proposalId}  (${p.method}${p.method === 'heuristic' ? ': the solver timed out, so this is a good answer, not a proven best one' : ''})`,
    `Valid until ${p.expiresAt}, for mission version ${p.missionVersion}`,
    p.complete ? 'Every requirement is met.' : 'NOT every requirement can be met.',
    `Team (${p.team.length}):`,
  ];
  lines.push(
    ...(p.team.length
      ? p.team.map((m) => {
          const covers = m.covers
            .map((c) => `${c.skill} (level ${c.level}, needs ${c.required})`)
            .join(', ');
          return `  ${m.name ?? '(no name)'} <${m.email}>  [${m.crewMemberId}]  upcoming missions: ${m.upcomingMissions}  covers: ${covers}`;
        })
      : ['  (nobody)']),
  );
  lines.push('Coverage:');
  for (const c of p.coverage) {
    lines.push(`  ${c.skill} level ${c.minLevel}+: ${c.met} of ${c.required}`);
    if (c.gap) {
      const blocked = Object.entries(c.gap.blocked)
        .filter(([, n]) => n > 0)
        .map(([reason, n]) => `${reason} ${n}`)
        .join(', ');
      lines.push(
        `    ${c.gap.qualifiedTotal} qualified in the organisation${blocked ? `; blocked: ${blocked}` : ''}`,
      );
    }
  }
  const withAlternates = p.alternates.filter((a) => a.candidates.length > 0);
  if (withAlternates.length) {
    lines.push('Next best:');
    for (const a of withAlternates) {
      lines.push(
        `  ${a.skill}: ${a.candidates.map((c) => `${c.name ?? c.email} <${c.email}> (level ${c.level}, upcoming ${c.upcomingMissions})`).join('; ')}`,
      );
    }
  }
  lines.push(`Team hash: ${p.teamHash}`);
  lines.push(
    `To apply: mc missions match apply ${missionId} ${p.proposalId} --team-hash ${p.teamHash}`,
  );
  return lines.join('\n');
}

export function matchCommands(missions: Command, ctx: Context): void {
  const match = missions
    .command('match')
    .addArgument(new Argument('<id>', 'mission ID'))
    .description(
      'Propose the best crew for a Crewing mission (owning Lead); nothing changes until you apply it',
    )
    .addOption(
      new Option(
        '--exclude <crewId>',
        'a crew member who must not be proposed (repeat for several)',
      ).argParser(collectIds),
    )
    .action(async (id: string, o: { exclude?: string[] }, command: Command) => {
      const proposal = await ctx.client.request<MatchProposal>(
        'POST',
        `/v1/missions/${encodeURIComponent(id)}/match`,
        {
          auth: 'user',
          body: { exclude: o.exclude ?? [] },
        },
      );
      emit(command, ctx, proposal, () => proposalText(proposal!, id));
    });

  match
    .command('apply')
    .addArgument(new Argument('<id>', 'mission ID'))
    .addArgument(new Argument('<proposalId>', 'proposal ID from `mc missions match`'))
    .description('Replace the tentative crew with a proposal (owning Lead)')
    .requiredOption(
      '--team-hash <hash>',
      'the team hash printed with the proposal: it confirms the team you looked at',
    )
    .option('--version <n>', 'the mission version you last saw (default: fetched now)')
    .action(
      async (
        id: string,
        proposalId: string,
        o: { teamHash: string; version?: string },
        command: Command,
      ) => {
        let version: number;
        if (o.version !== undefined) {
          version = Number(o.version);
          if (!Number.isInteger(version) || version < 1)
            throw usageError('--version must be a whole number');
        } else {
          const current = await ctx.client.request<Mission>(
            'GET',
            `/v1/missions/${encodeURIComponent(id)}`,
            { auth: 'user' },
          );
          if (!current || !('version' in current))
            throw usageError('You cannot change this mission');
          version = current.version;
        }
        const mission = await ctx.client.request<Mission>(
          'POST',
          `/v1/missions/${encodeURIComponent(id)}/match/${encodeURIComponent(proposalId)}/apply`,
          { auth: 'user', body: { teamHash: o.teamHash }, headers: { 'If-Match': `"${version}"` } },
        );
        emit(command, ctx, mission, () => `Applied. ${missionText(mission!)}`);
      },
    );
}
