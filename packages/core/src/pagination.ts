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

/** Opaque cursor over several string keys, for orderings that are not by id alone. */
export function encodeKeyCursor(parts: Record<string, string>): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeKeyCursor<K extends string>(
  cursor: string,
  validators: Record<K, (value: string) => boolean>,
): Record<K, string> {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    > | null;
    const keys = Object.keys(validators) as K[];
    if (
      parsed &&
      typeof parsed === 'object' &&
      keys.every((k) => typeof parsed[k] === 'string' && validators[k](parsed[k] as string))
    ) {
      return Object.fromEntries(keys.map((k) => [k, parsed[k] as string])) as Record<K, string>;
    }
  } catch {
    // fall through
  }
  throw new AppError(ErrorCodes.INVALID_CURSOR, 400, 'The cursor is not valid');
}

export const isUuid = (value: string): boolean => UUID.test(value);

/** The exact form `Date#toISOString` writes, which is what cursors carry. */
export const isIsoTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
