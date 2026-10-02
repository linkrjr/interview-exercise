import { defineConfig } from 'vitest/config';

// The coverage gate (≥ 90%, DESIGN.md §19) counts unit and integration tests together.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['@mc/db/testing/global-setup'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/index.ts'],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
