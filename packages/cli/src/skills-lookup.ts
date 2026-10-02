import type { Page, Skill } from '@mc/contracts';
import type { Context } from './context.js';
import { CliError, ExitCode } from './errors.js';

const normalise = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Finds a skill by name (case-insensitive, as the catalogue treats names), paging through the catalogue. */
export async function resolveSkill(ctx: Context, name: string): Promise<Skill> {
  const wanted = normalise(name);
  let cursor: string | undefined;
  do {
    const page = await ctx.client.request<Page<Skill>>('GET', '/v1/skills', {
      auth: 'user',
      query: { limit: 100, cursor },
    });
    const hit = page?.items.find((s) => normalise(s.name) === wanted);
    if (hit) return hit;
    cursor = page?.nextCursor ?? undefined;
  } while (cursor);
  throw new CliError(`No skill named "${name}". See: mc skills list`, ExitCode.NOT_FOUND);
}
