import type { DbUrls } from '@mc/db/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrls: DbUrls;
  }
}
