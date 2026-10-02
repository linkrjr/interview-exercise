#!/usr/bin/env node
import {
  AccessTokenService,
  createServices,
  generateKeyPairPem,
  DbAuditWriter,
  systemClock,
  type Logger,
} from '@mc/core';
import { createDb } from '@mc/db';
import type { FastifyInstance } from 'fastify';
import { buildApp, loggerOptions } from '../app.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const db = createDb({ tenantUrl: config.tenantUrl, platformUrl: config.platformUrl });

let keys = { privateKeyPem: config.jwtPrivateKey, publicKeyPem: config.jwtPublicKey };
if (!keys.privateKeyPem || !keys.publicKeyPem) {
  // Only reachable outside production (see loadConfig): tokens stop working on restart.
  keys = await generateKeyPairPem();
}
const accessTokens = await AccessTokenService.create({
  privateKeyPem: keys.privateKeyPem!,
  publicKeyPem: keys.publicKeyPem!,
});

// The identity services need a logger before the Fastify instance (and its logger) exists.
const holder: { app?: FastifyInstance } = {};
const logger: Logger = {
  info: (obj, msg) => holder.app?.log.info(obj, msg),
  warn: (obj, msg) => holder.app?.log.warn(obj, msg),
};

const app = buildApp({
  services: createServices({
    db,
    audit: new DbAuditWriter(systemClock),
    clock: systemClock,
    logger,
    accessTokens,
  }),
  accessTokens,
  operatorToken: config.operatorToken,
  loginRate: config.loginRate,
  trustProxy: config.trustProxy,
  logger: loggerOptions(config.logLevel),
});

holder.app = app;

if (!config.jwtPrivateKey) {
  app.log.warn('No JWT keys configured: using an ephemeral key pair; tokens die on restart');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
