import type { TestProject } from 'vitest/node';
import { startTestDatabase, type DbUrls } from './harness.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

/**
 * Vitest `globalSetup` shared by every package with integration tests: starts one Postgres
 * container and provides its URLs to tests through `inject('dbUrls')`.
 */
export default async function setup(project: TestProject) {
  const database = await startTestDatabase();
  project.provide('dbUrls', database.urls);
  return async () => {
    await database.stop();
  };
}
