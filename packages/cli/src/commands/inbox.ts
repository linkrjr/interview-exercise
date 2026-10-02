import type { Notification, Page } from '@mc/contracts';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { emit } from '../context.js';
import { table } from '../io.js';

function summary(n: Notification): string {
  const p = n.payload as { missionName?: string; reason?: string; comment?: string };
  const detail = p.reason ? ` (${p.reason})` : p.comment ? ` (${p.comment})` : '';
  return `${p.missionName ?? ''}${detail}`.trim();
}

export function inboxCommands(program: Command, ctx: Context): void {
  const inbox = program.command('inbox').description('Your notifications');

  inbox
    .command('list', { isDefault: true })
    .description('List your notifications, newest first (the default)')
    .option('--unread', 'only unread ones')
    .option('--limit <n>', 'page size (1-100, default 25)')
    .option('--cursor <cursor>', 'continue from a previous page')
    .action(async (o: { unread?: boolean; limit?: string; cursor?: string }, command: Command) => {
      const page = await ctx.client.request<Page<Notification>>('GET', '/v1/notifications', {
        auth: 'user',
        query: { limit: o.limit, cursor: o.cursor, ...(o.unread ? { unread: 'true' } : {}) },
      });
      emit(command, ctx, page, () => {
        const rows = page!.items.map((n) => [
          n.id,
          n.readAt ? '' : '*',
          n.createdAt,
          n.type,
          summary(n),
        ]);
        const text = rows.length
          ? table(['ID', 'NEW', 'TIME (UTC)', 'TYPE', 'ABOUT'], rows)
          : 'Your inbox is empty';
        return page!.nextCursor ? `${text}\n\nMore: mc inbox --cursor ${page!.nextCursor}` : text;
      });
    });

  inbox
    .command('read')
    .argument('<id>', 'notification ID')
    .description('Mark a notification as read')
    .action(async (id: string, _o, command: Command) => {
      const n = await ctx.client.request<Notification>(
        'POST',
        `/v1/notifications/${encodeURIComponent(id)}/read`,
        { auth: 'user' },
      );
      emit(command, ctx, n, () => `Marked as read: ${n!.type} ${summary(n!)}`.trim());
    });
}
