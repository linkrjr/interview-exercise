import { SignJWT, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { TestClock } from '../testing/harness.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenService,
  generateKeyPairPem,
} from './access-tokens.js';

const claims = {
  userId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001',
  orgId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002',
  role: 'lead',
};

let clock: TestClock;
let service: AccessTokenService;
let keys: Awaited<ReturnType<typeof generateKeyPairPem>>;

beforeAll(async () => {
  keys = await generateKeyPairPem();
});

const fresh = async () => {
  clock = new TestClock();
  service = await AccessTokenService.create({ ...keys, clock });
};

describe('AccessTokenService', () => {
  it('signs EdDSA tokens carrying sub, org, role, iat and exp with a key id', async () => {
    await fresh();
    const token = await service.sign(claims);
    const [header, payload] = token
      .split('.')
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p!, 'base64url').toString()));
    expect(header).toEqual({ alg: 'EdDSA', kid: 'mc-1' });
    expect(payload).toMatchObject({ sub: claims.userId, org: claims.orgId, role: 'lead' });
    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('verifies a token into an actor', async () => {
    await fresh();
    const actor = await service.verify(await service.sign(claims));
    expect(actor).toEqual({
      kind: 'user',
      userId: claims.userId,
      orgId: claims.orgId,
      role: 'lead',
    });
  });

  it('rejects an expired token with a distinct message', async () => {
    await fresh();
    const token = await service.sign(claims);
    clock.advance((ACCESS_TOKEN_TTL_SECONDS + 1) * 1000);
    await expect(service.verify(token)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
      detail: 'The access token has expired',
    });
  });

  it('accepts a token until the last second', async () => {
    await fresh();
    const token = await service.sign(claims);
    clock.advance((ACCESS_TOKEN_TTL_SECONDS - 1) * 1000);
    await expect(service.verify(token)).resolves.toMatchObject({ userId: claims.userId });
  });

  it('rejects garbage, tampered tokens and tokens signed by another key', async () => {
    await fresh();
    const token = await service.sign(claims);
    const [h, p, s] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), role: 'director' }),
    ).toString('base64url');
    const other = await AccessTokenService.create({ ...(await generateKeyPairPem()), clock });
    for (const bad of ['', 'nonsense', `${h}.${tamperedPayload}.${s}`, await other.sign(claims)]) {
      await expect(service.verify(bad)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
        status: 401,
      });
    }
  });

  it('rejects tokens with a different algorithm', async () => {
    await fresh();
    const hmac = await new SignJWT({ org: claims.orgId, role: 'lead' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    await expect(service.verify(hmac)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a validly signed token whose claims are malformed', async () => {
    await fresh();
    const pair = await generateKeyPair('EdDSA', { extractable: true });
    const { exportPKCS8, exportSPKI } = await import('jose');
    const custom = await AccessTokenService.create({
      privateKeyPem: await exportPKCS8(pair.privateKey),
      publicKeyPem: await exportSPKI(pair.publicKey),
      clock,
    });
    const badRole = await custom.sign({ ...claims, role: 'operator' });
    await expect(custom.verify(badRole)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const badSub = await custom.sign({ ...claims, userId: 'not-a-uuid' });
    await expect(custom.verify(badSub)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('honours a custom key id and lifetime', async () => {
    clock = new TestClock();
    const short = await AccessTokenService.create({ ...keys, clock, kid: 'rot-2', ttlSeconds: 60 });
    const token = await short.sign(claims);
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).kid).toBe('rot-2');
    clock.advance(61_000);
    await expect(short.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
