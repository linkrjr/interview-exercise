import { defineConfig } from 'vitest/config';

// Runs against a live docker-compose stack (see run.sh), never on its own as part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    globalSetup: ['./src/wait-for-api.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
