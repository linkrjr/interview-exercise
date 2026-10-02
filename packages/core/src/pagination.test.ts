import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, toPage } from './pagination.js';

const id = (n: number) => `0199aaaa-bbbb-7ccc-8ddd-${String(n).padStart(12, '0')}`;

describe('cursor', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(id(1)))).toBe(id(1));
  });

  it.each([
    'not base64 json',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('{"id":"nope"}').toString('base64url'),
    Buffer.from('null').toString('base64url'),
  ])('rejects invalid cursor %j', (cursor) => {
    expect(() => decodeCursor(cursor)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
    );
  });
});

describe('toPage', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1) }));

  it('returns a next cursor only when an extra row signals more', () => {
    const page = toPage(rows(3), 2, (r) => r.id);
    expect(page.items).toEqual([id(1), id(2)]);
    expect(decodeCursor(page.nextCursor!)).toBe(id(2));
  });

  it('has no cursor on the last page, exactly full or not', () => {
    expect(toPage(rows(2), 2, (r) => r.id).nextCursor).toBeNull();
    expect(toPage(rows(1), 2, (r) => r.id).nextCursor).toBeNull();
    expect(toPage([], 2, (r: { id: string }) => r.id)).toEqual({ items: [], nextCursor: null });
  });
});
