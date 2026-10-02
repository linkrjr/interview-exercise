import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './passwords.js';
import { formatToken, generateSecret, parseToken, sha256Hex } from './secrets.js';

describe('secrets', () => {
  it('generates distinct URL-safe secrets with 256 bits of entropy', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it('hashes deterministically to hex SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('round-trips an organisation-prefixed token', () => {
    const orgId = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000';
    const token = formatToken(orgId, 'secret.with.dots');
    expect(parseToken(token)).toEqual({ orgId, secret: 'secret.with.dots' });
  });

  it.each(['', 'nodot', '.secret', 'not-a-uuid.secret', '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000.'])(
    'rejects malformed token %j',
    (token) => {
      expect(parseToken(token)).toBeNull();
    },
  );
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('produces argon2id hashes that verify only the right password', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'wrong password entirely')).toBe(false);
  });

  it('salts: the same password hashes differently each time', async () => {
    expect(await hasher.hash('same password 123')).not.toBe(await hasher.hash('same password 123'));
  });

  it('fails verification without a stored hash, after doing the work anyway', async () => {
    expect(await hasher.verify(null, 'whatever password')).toBe(false);
    expect(await hasher.verify(undefined, 'whatever password')).toBe(false);
  });

  it('treats a corrupt stored hash as a failed verification', async () => {
    expect(await hasher.verify('not-a-hash', 'whatever password')).toBe(false);
  });
});
