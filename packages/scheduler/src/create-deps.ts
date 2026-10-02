import {
  DbAuditWriter,
  MissionService,
  NotificationService,
  policy,
  systemClock,
  type Clock,
} from '@mc/core';
import type { Db } from '@mc/db';
import type { SchedulerLogger } from './logger.js';
import type { SchedulerDeps } from './run-pass.js';

/** The scheduler's dependencies, wired the way the API wires the same services. */
export function createSchedulerDeps(options: {
  db: Db;
  logger: SchedulerLogger;
  clock?: Clock;
}): SchedulerDeps {
  const clock = options.clock ?? systemClock;
  const notifications = new NotificationService({ db: options.db, clock, policy });
  const missions = new MissionService({
    db: options.db,
    audit: new DbAuditWriter(clock),
    clock,
    policy,
    notifications,
  });
  return { db: options.db, missions, clock, logger: options.logger };
}
