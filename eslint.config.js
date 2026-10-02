import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const rawConnectionMessage =
  'Tenant data is reached only through @mc/db (withTenant / withPlatform / withScheduler). ' +
  'Raw database connections may only be imported inside packages/db (DESIGN.md §11, §21).';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'packages/db/migrations/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    ignores: ['packages/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: rawConnectionMessage },
            { name: 'pg-pool', message: rawConnectionMessage },
            { name: 'postgres', message: rawConnectionMessage },
          ],
          patterns: [
            {
              group: ['drizzle-orm/node-postgres', 'drizzle-orm/node-postgres/*'],
              message: rawConnectionMessage,
            },
            { group: ['@mc/db/src/*', '**/db/src/**'], message: rawConnectionMessage },
          ],
        },
      ],
    },
  },
);
