import type { Invite, InviteUserResponse, Page, User } from '@mc/contracts';
import { Argument, Option, type Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

const ROLES = ['director', 'lead', 'crew'];

const showInvite = (invite: Invite) =>
  `Invite code (shown once, expires ${invite.expiresAt}):\n${invite.inviteCode}`;

export function userCommands(program: Command, ctx: Context): void {
  const users = program
    .command('users')
    .description('Manage the users of your organisation (Directors)');

  users
    .command('invite')
    .description('Invite a user; the invitee completes their profile with `mc auth accept-invite`')
    .requiredOption('--email <email>', 'email address')
    .addOption(new Option('--role <role>', 'role').choices(ROLES).makeOptionMandatory())
    .action(async (options: { email: string; role: string }, command: Command) => {
      const result = await ctx.client.request<InviteUserResponse>('POST', '/v1/users', {
        auth: 'user',
        body: { email: options.email, role: options.role },
      });
      emit(
        command,
        ctx,
        result,
        () =>
          `Invited ${result!.user.email} as ${result!.user.role}.\n${showInvite(result!.invite)}`,
      );
    });

  users
    .command('list')
    .description('List users')
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(async (options: { limit?: string; cursor?: string }, command: Command) => {
      const page = await ctx.client.request<Page<User>>('GET', '/v1/users', {
        auth: 'user',
        query: { limit: options.limit, cursor: options.cursor },
      });
      emit(command, ctx, page, () => {
        const rows = page!.items.map((u) => [u.id, u.email, u.name ?? '-', u.role, u.status]);
        const text = table(['ID', 'EMAIL', 'NAME', 'ROLE', 'STATUS'], rows);
        return page!.nextCursor
          ? `${text}\n\nMore: mc users list --cursor ${page!.nextCursor}`
          : text;
      });
    });

  users
    .command('set-role')
    .addArgument(new Argument('<id>', 'user ID'))
    .addArgument(new Argument('<role>', 'new role').choices(ROLES))
    .description("Change a user's role (nobody can be changed to crew)")
    .action(async (id: string, role: string, _options, command: Command) => {
      const user = await ctx.client.request<User>('PATCH', `/v1/users/${encodeURIComponent(id)}`, {
        auth: 'user',
        body: { role },
      });
      emit(command, ctx, user, () => `${user!.email} is now ${user!.role}`);
    });

  users
    .command('deactivate')
    .argument('<id>', 'user ID')
    .description('Deactivate a user')
    .action(async (id: string, _options, command: Command) => {
      const user = await ctx.client.request<User>('PATCH', `/v1/users/${encodeURIComponent(id)}`, {
        auth: 'user',
        body: { status: 'deactivated' },
      });
      emit(command, ctx, user, () => `${user!.email} is deactivated`);
    });

  users
    .command('reinvite')
    .argument('<id>', 'user ID')
    .description('Issue a new invite code for a user who has not accepted yet')
    .action(async (id: string, _options, command: Command) => {
      const invite = await ctx.client.request<Invite>(
        'POST',
        `/v1/users/${encodeURIComponent(id)}/invites`,
        {
          auth: 'user',
        },
      );
      emit(command, ctx, invite, () => showInvite(invite!));
    });
}
