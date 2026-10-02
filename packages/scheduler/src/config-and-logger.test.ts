import { describe, expect, it } from 'vitest';
import { loadSchedulerConfig } from './config.js';
import { createLogger } from './logger.js';

const env = {
  DATABASE_URL_TENANT: 'postgres://t',
  DATABASE_URL_SCHEDULER: 'postgres://s',
};

describe('loadSchedulerConfig', () => {
  it('defaults to a five-minute interval and info logging', () => {
    expect(loadSchedulerConfig(env)).toEqual({
      logLevel: 'info',
      tenantUrl: 'postgres://t',
      schedulerUrl: 'postgres://s',
      intervalMs: 300_000,
    });
  });

  it('reads the interval in seconds', () => {
    expect(loadSchedulerConfig({ ...env, SCHEDULER_INTERVAL_SECONDS: '60' }).intervalMs).toBe(
      60_000,
    );
  });

  it('reports every problem at once', () => {
    expect(() => loadSchedulerConfig({ SCHEDULER_INTERVAL_SECONDS: '0' })).toThrow(
      /DATABASE_URL_TENANT[\s\S]*DATABASE_URL_SCHEDULER[\s\S]*SCHEDULER_INTERVAL_SECONDS/,
    );
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line in the Fastify shape', () => {
    const lines: string[] = [];
    const log = createLogger(
      'info',
      (l) => lines.push(l),
      () => 1234,
    );
    log.warn({ organisationId: 'o1' }, 'careful');
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 40,
      time: 1234,
      name: 'scheduler',
      organisationId: 'o1',
      msg: 'careful',
    });
  });

  it('drops what is below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.info({}, 'quiet');
    log.error({}, 'loud');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('loud');
  });

  it('is silent at the silent level', () => {
    const lines: string[] = [];
    createLogger('silent', (l) => lines.push(l)).error({}, 'nothing');
    expect(lines).toEqual([]);
  });
});
