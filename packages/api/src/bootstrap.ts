import {
  AccessTokenService,
  createServices,
  DbAuditWriter,
  generateKeyPairPem,
  systemClock,
  type Clock,
} from '@mc/core';
import { createDb, type Db } from '@mc/db';
import type { Solver } from '@mc/matcher';
import { createHighsSolver } from '@mc/matcher/highs';
import type { FastifyInstance } from 'fastify';
import { buildApp, loggerOptions } from './app.js';
import type { Config } from './config.js';
import { createTestSupport } from './test-support.js';

export interface Application {
  app: FastifyInstance;
  db: Db;
  /** Stops accepting requests and closes the database pools. */
  close(): Promise<void>;
}

/**
 * Wires a running API from its configuration: database, keys, services, and the routes. The test-only
 * endpoints are built here, and only when the environment is not production (DESIGN.md §16).
 */
export async function createApplication(
  config: Config,
  overrides: { solver?: Solver; clock?: Clock } = {},
): Promise<Application> {
  const clock = overrides.clock ?? systemClock;
  const db = createDb({
    tenantUrl: config.tenantUrl,
    platformUrl: config.platformUrl,
    schedulerUrl: config.schedulerUrl,
  });

  let keys = { privateKeyPem: config.jwtPrivateKey, publicKeyPem: config.jwtPublicKey };
  if (!keys.privateKeyPem || !keys.publicKeyPem) {
    // Only reachable outside production (see loadConfig): tokens stop working on restart.
    keys = await generateKeyPairPem();
  }
  const accessTokens = await AccessTokenService.create({
    privateKeyPem: keys.privateKeyPem!,
    publicKeyPem: keys.publicKeyPem!,
  });
  const solver = overrides.solver ?? (await createHighsSolver());

  // The services need a logger before the Fastify instance (and its logger) exists.
  const holder: { app?: FastifyInstance } = {};
  const logger = {
    info: (obj: object, msg?: string) => holder.app?.log.info(obj, msg),
    warn: (obj: object, msg?: string) => holder.app?.log.warn(obj, msg),
    error: (obj: object, msg?: string) => holder.app?.log.error(obj, msg),
  };

  const app = buildApp({
    services: createServices({
      db,
      audit: new DbAuditWriter(clock),
      clock,
      logger,
      accessTokens,
      solver,
    }),
    accessTokens,
    operatorToken: config.operatorToken,
    loginRate: config.loginRate,
    matchRate: config.matchRate,
    bodyLimit: config.bodyLimitBytes,
    hstsMaxAgeSeconds: config.hstsMaxAgeSeconds,
    trustProxy: config.trustProxy,
    logger: loggerOptions(config.logLevel),
    clock,
    testSupport:
      config.env !== 'production' && config.testEndpoints
        ? createTestSupport({
            db,
            hasSchedulerLogin: config.schedulerUrl !== undefined,
            accessTokens,
            solver,
            logger,
            clock,
          })
        : undefined,
  });
  holder.app = app;

  if (!config.jwtPrivateKey) {
    app.log.warn('No JWT keys configured: using an ephemeral key pair; tokens die on restart');
  }
  if (config.env !== 'production' && config.testEndpoints) {
    app.log.warn('Test-only endpoints (/v1/test/*) are enabled: this is not a production build');
  }

  return {
    app,
    db,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
