import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from '../migrate.js';
import { provisionRoles } from '../provision.js';

export interface DbUrls {
  /** Superuser: migrations and test fixtures only (bypasses RLS). */
  migrator: string;
  tenant: string;
  platform: string;
  scheduler: string;
}

export interface TestDatabase {
  urls: DbUrls;
  stop(): Promise<void>;
}

const PASSWORDS = {
  app_tenant: 'tenant-test-password',
  app_platform: 'platform-test-password',
  app_scheduler: 'scheduler-test-password',
} as const;

/** Starts a disposable Postgres 16, applies the migrations and provisions the role logins. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16').start();
  const migrator = container.getConnectionUri();
  await runMigrations(migrator);
  await provisionRoles(migrator, PASSWORDS);

  const withLogin = (role: keyof typeof PASSWORDS): string => {
    const url = new URL(migrator);
    url.username = role;
    url.password = PASSWORDS[role];
    return url.toString();
  };

  return {
    urls: {
      migrator,
      tenant: withLogin('app_tenant'),
      platform: withLogin('app_platform'),
      scheduler: withLogin('app_scheduler'),
    },
    stop: async () => {
      await container.stop();
    },
  };
}
