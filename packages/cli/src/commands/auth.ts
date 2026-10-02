import { SessionSchema, type MeResponse, type Session } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { usageError } from '../errors.js';
import { checkNewPassword, readPassword, valueOrPrompt } from '../secrets.js';

async function saveSession(ctx: Context, session: Session): Promise<void> {
  await ctx.deps.store.setCredentials({
    orgId: session.orgId,
    userId: session.userId,
    role: session.role,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });
}

const summary = (s: Session) => ({ orgId: s.orgId, userId: s.userId, role: s.role });

export function authCommands(program: Command, ctx: Context): void {
  const auth = program.command('auth').description('Sign in and out');

  auth
    .command('login')
    .description('Sign in with organisation ID, email and password')
    .option('--org <orgId>', 'organisation ID (remembered after the first sign-in)')
    .option('--email <email>', 'email address (prompted when omitted)')
    .option('--password-stdin', 'read the password from standard input')
    .action(
      async (
        options: { org?: string; email?: string; passwordStdin?: boolean },
        command: Command,
      ) => {
        const orgId =
          options.org ??
          (await ctx.deps.store.getCredentials()).orgId ??
          (await valueOrPrompt(ctx.deps, undefined, '--org', 'Organisation ID:'));
        const email = await valueOrPrompt(ctx.deps, options.email, '--email', 'Email:');
        const password = await readPassword(ctx.deps, { passwordStdin: options.passwordStdin });
        const session = SessionSchema.parse(
          await ctx.client.request('POST', '/v1/auth/login', {
            auth: 'none',
            body: { orgId, email, password },
          }),
        );
        await saveSession(ctx, session);
        emit(command, ctx, summary(session), () => `Signed in as ${email} (${session.role})`);
      },
    );

  auth
    .command('accept-invite')
    .argument('<code>', 'the invite code you were given')
    .description('Accept an invite: choose your name and password, then sign in')
    .option('--name <name>', 'your name (prompted when omitted)')
    .option('--password-stdin', 'read the password from standard input')
    .action(
      async (
        code: string,
        options: { name?: string; passwordStdin?: boolean },
        command: Command,
      ) => {
        const name = await valueOrPrompt(ctx.deps, options.name, '--name', 'Your name:');
        const password = await readPassword(ctx.deps, {
          passwordStdin: options.passwordStdin,
          confirm: true,
        });
        checkNewPassword(password);
        const session = SessionSchema.parse(
          await ctx.client.request('POST', '/v1/auth/accept-invite', {
            auth: 'none',
            body: { code, name, password },
          }),
        );
        await saveSession(ctx, session);
        emit(
          command,
          ctx,
          summary(session),
          () =>
            `Welcome, ${name}. You are signed in as ${session.role}. Your organisation ID is ${session.orgId}.`,
        );
      },
    );

  auth
    .command('logout')
    .description('Sign out and forget the stored tokens')
    .action(async (_options, command: Command) => {
      const credentials = await ctx.deps.store.getCredentials();
      if (credentials.refreshToken) {
        // Best effort: the local tokens are removed even if the server cannot be reached.
        await ctx.client
          .request('POST', '/v1/auth/logout', {
            auth: 'none',
            body: { refreshToken: credentials.refreshToken },
          })
          .catch((error: Error) =>
            ctx.deps.stderr.write(
              `Warning: could not revoke the session on the server: ${error.message}\n`,
            ),
          );
      }
      await ctx.deps.store.clearCredentials({ orgId: credentials.orgId });
      emit(command, ctx, { signedOut: true }, () => 'Signed out');
    });

  auth
    .command('whoami')
    .description('Show the signed-in user')
    .action(async (_options, command: Command) => {
      const me = await ctx.client.request<MeResponse>('GET', '/v1/me', { auth: 'user' });
      if (!me) throw usageError('Empty response from the server');
      emit(
        command,
        ctx,
        me,
        () =>
          `${me.user.name ?? '(no name)'} <${me.user.email}>, ${me.user.role} at ${me.org.name} (${me.org.id})`,
      );
    });
}
