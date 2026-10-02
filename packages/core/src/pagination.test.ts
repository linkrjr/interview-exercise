import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeKeyCursor,
  isIsoTimestamp,
  isUuid,
  encodeCursor,
  encodeKeyCursor,
  toPage,
} from './pagination.js';

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

describe('key cursors', () => {
  const validators = { t: isIsoTimestamp, id: isUuid };
  const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const good = { t: '2026-10-02T10:00:00.000Z', id: id(7) };

  it('round-trips several validated keys', () => {
    expect(decodeKeyCursor(encodeKeyCursor(good), validators)).toEqual(good);
  });

  it.each([
    ['not base64 json', 'garbage'],
    ['null', cursorOf(null)],
    ['a missing key', cursorOf({ t: good.t })],
    ['a non-string key', cursorOf({ t: 1, id: 'x' })],
    [
      'a bad id with a good time (would reach Postgres as an invalid uuid)',
      cursorOf({ t: good.t, id: 'x' }),
    ],
    ['an id that is almost a uuid', cursorOf({ t: good.t, id: id(7).replace(/.$/, 'z') })],
    ['a bad time with a good id', cursorOf({ t: 'nope', id: good.id })],
    ['a time that is not the ISO form we write', cursorOf({ t: '2026-10-02', id: good.id })],
    ['an impossible date', cursorOf({ t: '2026-13-45T10:00:00.000Z', id: good.id })],
  ])('rejects %s', (_name, cursor) => {
    expect(() => decodeKeyCursor(cursor, validators)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
    );
  });

  it('ignores keys it was not asked about', () => {
    expect(decodeKeyCursor(cursorOf({ ...good, extra: 'x' }), validators)).toEqual(good);
  });
});
