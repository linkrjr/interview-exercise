import { AppError, ErrorCodes, type Page } from '@mc/contracts';

/** Opaque cursor over a UUIDv7 id (ids are time-ordered, so id order is creation order). */
export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && UUID.test(id)) return id;
  } catch {
    // fall through
  }
  throw new AppError(ErrorCodes.INVALID_CURSOR, 400, 'The cursor is not valid');
}

/** Turns `limit + 1` fetched rows into a page: the extra row only signals that more exist. */
export function toPage<T extends { id: string }, U>(
  rows: T[],
  limit: number,
  map: (row: T) => U,
): Page<U> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}
