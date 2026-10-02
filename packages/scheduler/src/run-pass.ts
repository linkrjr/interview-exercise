import { AlertCodes } from '@mc/contracts';
import { todayIn, type Clock, type MissionService, type SystemTransitionResult } from '@mc/core';
import { newId, schema, type Db } from '@mc/db';
import { lt } from 'drizzle-orm';
import type { SchedulerLogger } from './logger.js';

export const ALERT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SchedulerDeps {
  db: Db;
  missions: Pick<MissionService, 'runSystemTransitions'>;
  clock: Clock;
  logger: SchedulerLogger;
}

export interface PassOptions {
  /**
   * Process every organisation as if this `YYYY-MM-DD` were today. Only the test-only endpoint
   * passes it; the scheduler itself always uses each organisation's own date.
   */
  today?: string;
}

export type OrganisationOutcome =
  | { organisationId: string; status: 'ok'; today: string; result: SystemTransitionResult }
  | { organisationId: string; status: 'failed'; alertWritten: boolean };

export type PassResult =
  /** Another instance holds the advisory lock, so nothing ran. */
  { ran: false } | { ran: true; organisations: OrganisationOutcome[]; alertsPurged: number };

/** The numeric part of a driver error code, if any, e.g. a Postgres SQLSTATE. Never the message. */
function errorSummary(error: unknown): { name: string; code?: string } {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null) ?? {};
  const pgCode = typeof code.code === 'string' ? code.code : code.cause?.code;
  return {
    name: error instanceof Error ? error.name : typeof error,
    ...(typeof pgCode === 'string' ? { code: pgCode } : {}),
  };
}

/**
 * One scheduler pass (DESIGN.md §16): for every organisation, in turn, expire, activate and complete
 * missions as of the organisation's own "today", each organisation in its own transaction. An
 * organisation that fails is rolled back as a whole, logged and alerted on, and does not stop the
 * others; the next pass retries it. Only one instance runs a pass at a time.
 */
export async function runPass(deps: SchedulerDeps, options: PassOptions = {}): Promise<PassResult> {
  const { db, logger } = deps;
  const locked = await db.withSchedulerLock(async () => {
    const organisations = await db.withScheduler((tx) =>
      tx
        .select({ id: schema.organisations.id, timeZone: schema.organisations.timeZone })
        .from(schema.organisations)
        .orderBy(schema.organisations.id),
    );
    const outcomes: OrganisationOutcome[] = [];
    for (const organisation of organisations) {
      outcomes.push(await processOrganisation(deps, organisation, options));
    }
    return { organisations: outcomes, alertsPurged: await purgeAlerts(deps) };
  });
  if (!locked) {
    logger.info({}, 'another scheduler instance holds the lock; skipping this run');
    return { ran: false };
  }
  return { ran: true, ...locked.value };
}

async function processOrganisation(
  deps: SchedulerDeps,
  organisation: { id: string; timeZone: string },
  options: PassOptions,
): Promise<OrganisationOutcome> {
  const { db, missions, clock, logger } = deps;
  const organisationId = organisation.id;
  let stage: 'time_zone' | 'transitions' = 'time_zone';
  let today = options.today;
  try {
    today ??= todayIn(clock.now(), organisation.timeZone);
    stage = 'transitions';
    const day = today;
    const result = await db.withTenant(organisationId, (tx) =>
      missions.runSystemTransitions(tx, day),
    );
    if (result.expired || result.activated || result.completed) {
      logger.info({ organisationId, today, ...result }, 'scheduler applied transitions');
    }
    return { organisationId, status: 'ok', today, result };
  } catch (error) {
    const summary = errorSummary(error);
    logger.error({ organisationId, stage, error: summary }, 'scheduler failed for organisation');
    const alertWritten = await raiseAlert(deps, organisationId, {
      stage,
      ...(today ? { today } : {}),
      ...(stage === 'time_zone' ? { timeZone: organisation.timeZone } : {}),
      error: summary,
    });
    return { organisationId, status: 'failed', alertWritten };
  }
}

/** One alert per failed run, in its own transaction so it survives the organisation's rollback. */
async function raiseAlert(
  deps: SchedulerDeps,
  organisationId: string,
  details: object,
): Promise<boolean> {
  const { db, clock, logger } = deps;
  try {
    await db.withScheduler((tx) =>
      tx.insert(schema.alerts).values({
        id: newId(),
        orgId: organisationId,
        source: 'scheduler',
        code: AlertCodes.SCHEDULER_RUN_FAILED,
        message:
          'The scheduler could not process this organisation. Its changes for this run were rolled back and will be retried on the next run.',
        details,
        occurredAt: clock.now(),
      }),
    );
    return true;
  } catch (error) {
    logger.error({ organisationId, error: errorSummary(error) }, 'could not write the alert');
    return false;
  }
}

/** Alerts older than the retention period are deleted on every run. */
async function purgeAlerts(deps: SchedulerDeps): Promise<number> {
  const { db, clock, logger } = deps;
  const cutoff = new Date(clock.now().getTime() - ALERT_RETENTION_DAYS * DAY_MS);
  try {
    const deleted = await db.withScheduler((tx) =>
      tx.delete(schema.alerts).where(lt(schema.alerts.occurredAt, cutoff)),
    );
    return deleted.rowCount ?? 0;
  } catch (error) {
    logger.error({ error: errorSummary(error) }, 'could not purge old alerts');
    return 0;
  }
}
