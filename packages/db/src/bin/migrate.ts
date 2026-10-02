#!/usr/bin/env node
import { runMigrations } from '../migrate.js';
import { provisionRoles } from '../provision.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const migratorUrl = required('DATABASE_URL_MIGRATOR');

await runMigrations(migratorUrl);
await provisionRoles(migratorUrl, {
  app_tenant: required('APP_TENANT_PASSWORD'),
  app_platform: required('APP_PLATFORM_PASSWORD'),
  app_scheduler: required('APP_SCHEDULER_PASSWORD'),
});
console.log('Migrations applied and application roles provisioned.');
