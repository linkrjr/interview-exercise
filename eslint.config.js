import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const rawConnectionMessage =
  'Tenant data is reached only through @mc/db (withTenant / withPlatform / withScheduler). ' +
  'Raw database connections may only be imported inside packages/db (DESIGN.md §11, §21).';

const pureMessage =
  'The matcher engine is pure (DESIGN.md §21): no Node I/O and no imports from db, api or core. ' +
  'The HiGHS adapter, src/highs.ts, is the one place that loads a runtime.';

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
  {
    // The pure engine: everything in the matcher except its tests and the HiGHS adapter.
    files: ['packages/matcher/src/**/*.ts'],
    ignores: [
      'packages/matcher/src/highs.ts',
      'packages/matcher/src/**/*.test.ts',
      'packages/matcher/src/test-support.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'fs',
            'fs/promises',
            'path',
            'crypto',
            'os',
            'child_process',
            'http',
            'https',
            'net',
            'stream',
            'url',
            'util',
            'worker_threads',
            'pg',
            'drizzle-orm',
            'fastify',
          ].map((name) => ({ name, message: pureMessage })),
          patterns: [
            { group: ['node:*'], message: pureMessage },
            { group: ['@mc/*'], message: pureMessage },
            { group: ['highs', 'highs/*'], message: pureMessage },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: pureMessage },
        { name: 'Buffer', message: pureMessage },
      ],
    },
  },
);
