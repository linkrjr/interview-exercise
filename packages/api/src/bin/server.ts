#!/usr/bin/env node
import { createApplication } from '../bootstrap.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const { app, close } = await createApplication(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
