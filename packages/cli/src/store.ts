import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredCredentials {
  orgId?: string;
  userId?: string;
  role?: string;
  accessToken?: string;
  refreshToken?: string;
}

interface StoredConfig {
  url?: string;
}

/** Files under `~/.config/mission-control` (or `MC_CONFIG_DIR`): config.json and credentials.json (0600). */
export class Store {
  constructor(private readonly dir: string) {}

  static fromEnv(env: NodeJS.ProcessEnv): Store {
    return new Store(env.MC_CONFIG_DIR ?? join(homedir(), '.config', 'mission-control'));
  }

  async getUrl(): Promise<string | undefined> {
    return (await this.read<StoredConfig>('config.json')).url;
  }

  async setUrl(url: string): Promise<void> {
    await this.write('config.json', { url }, 0o644);
  }

  async getCredentials(): Promise<StoredCredentials> {
    return this.read<StoredCredentials>('credentials.json');
  }

  async setCredentials(credentials: StoredCredentials): Promise<void> {
    await this.write('credentials.json', credentials, 0o600);
  }

  async clearCredentials(keep: Pick<StoredCredentials, 'orgId'> = {}): Promise<void> {
    if (keep.orgId) await this.setCredentials({ orgId: keep.orgId });
    else await rm(join(this.dir, 'credentials.json'), { force: true });
  }

  private async read<T extends object>(file: string): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.dir, file), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
      throw new Error(`Cannot read ${join(this.dir, file)}: ${(error as Error).message}`);
    }
  }

  /** Writes through a temporary file created with the final mode, so secrets are never world-readable. */
  private async write(file: string, value: object, mode: number): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, file);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await chmod(temp, mode);
    await rename(temp, target);
  }
}
