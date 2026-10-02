import { defineConfig } from 'drizzle-kit';

// Migrations are hand-written SQL (extensions, roles, RLS, exclusion constraints are
// outside what drizzle-kit can generate); drizzle-kit only scaffolds files and the journal.
export default defineConfig({
  dialect: 'postgresql',
  out: './migrations',
  schema: './src/schema/index.ts',
});
