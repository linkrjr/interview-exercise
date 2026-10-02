import type { CreateOrganisationResponse, ReissueInviteResponse } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';

function operatorToken(ctx: Context, flag: string | undefined): string {
  const token = flag ?? ctx.deps.env.MC_OPERATOR_TOKEN;
  if (!token)
    throw usageError('The operator token is required: set MC_OPERATOR_TOKEN or pass --token');
  return token;
}

export function platformCommands(program: Command, ctx: Context): void {
  const platform = program
    .command('platform')
    .description('Operator commands (organisation provisioning)');
  const org = platform.command('org').description('Organisations');

  org
    .command('create')
    .description('Create an organisation and its first Director')
    .requiredOption('--name <name>', 'organisation name')
    .requiredOption('--director-email <email>', 'email of the first Director')
    .option('--token <token>', 'operator token (default: MC_OPERATOR_TOKEN)')
    .action(
      async (
        options: { name: string; directorEmail: string; token?: string },
        command: Command,
      ) => {
        const created = await ctx.client.request<CreateOrganisationResponse>(
          'POST',
          '/v1/platform/organisations',
          {
            auth: 'operator',
            operatorToken: operatorToken(ctx, options.token),
            body: { name: options.name, directorEmail: options.directorEmail },
          },
        );
        emit(command, ctx, created, () =>
          [
            `Organisation ${created!.organisationId} created.`,
            `Director user: ${created!.directorUserId}`,
            `Invite code (shown once, expires ${created!.invite.expiresAt}):`,
            created!.invite.inviteCode,
            'Give it to the Director, who runs: mc auth accept-invite <code>',
          ].join('\n'),
        );
      },
    );

  org
    .command('reinvite')
    .argument('<orgId>', 'organisation ID')
    .requiredOption(
      '--user <userId>',
      'the invited user, e.g. the Director user ID from `org create`',
    )
    .option('--token <token>', 'operator token (default: MC_OPERATOR_TOKEN)')
    .description('Issue a new invite code for a user who has not accepted yet')
    .action(async (orgId: string, options: { user: string; token?: string }, command: Command) => {
      const result = await ctx.client.request<ReissueInviteResponse>(
        'POST',
        `/v1/platform/organisations/${encodeURIComponent(orgId)}/invites`,
        {
          auth: 'operator',
          operatorToken: operatorToken(ctx, options.token),
          body: { userId: options.user },
        },
      );
      emit(
        command,
        ctx,
        result,
        () =>
          `New invite code (shown once, expires ${result!.invite.expiresAt}):\n${result!.invite.inviteCode}`,
      );
    });
}
