#!/usr/bin/env node
import { createDb } from '@mc/db';
import { loadSchedulerConfig } from '../config.js';
import { createSchedulerDeps } from '../create-deps.js';
import { startScheduler } from '../loop.js';
import { createLogger } from '../logger.js';

const config = loadSchedulerConfig();
const logger = createLogger(config.logLevel);
const db = createDb({ tenantUrl: config.tenantUrl, schedulerUrl: config.schedulerUrl });

const scheduler = startScheduler(createSchedulerDeps({ db, logger }), {
  intervalMs: config.intervalMs,
});
logger.info({ intervalSeconds: config.intervalMs / 1000 }, 'scheduler started');

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await scheduler.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
