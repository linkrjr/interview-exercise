import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters: 19 MiB of memory, 2 iterations, 1 lane.
// `algorithm: 2` is Argon2id (the library's `Algorithm` const enum cannot be imported under isolatedModules).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /**
   * Verifies a password. With no stored hash (unknown user) it still performs a full argon2
   * verification against a throwaway hash, so response time does not reveal whether the user exists.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (storedHash) {
      try {
        return await verify(storedHash, password);
      } catch {
        return false;
      }
    }
    this.dummy ??= this.hash('mission-control-dummy-password');
    await verify(await this.dummy, password);
    return false;
  }
}
