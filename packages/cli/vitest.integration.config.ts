import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    globalSetup: ['@mc/db/testing/global-setup'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
