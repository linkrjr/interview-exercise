import type { TestProject } from 'vitest/node';
import { startTestDatabase, type DbUrls } from '../src/testing/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}

/** One Postgres container shared by every integration test file in this package. */
export default async function setup(project: TestProject) {
  const database = await startTestDatabase();
  project.provide('dbUrls', database.urls);
  return async () => {
    await database.stop();
  };
}
