import type { Tx } from '@mc/db';
import { describe, expect, it } from 'vitest';
import { InMemoryAuditWriter, type AuditWriter } from './index.js';

const tx = {} as Tx;

describe('InMemoryAuditWriter', () => {
  it('records events in order through the AuditWriter port', async () => {
    const writer: AuditWriter = new InMemoryAuditWriter();
    await writer.record(tx, { action: 'a', entityType: 'mission', entityId: '1', actorId: 'u' });
    await writer.record(tx, { action: 'b', entityType: 'mission', entityId: '1', actorId: null });
    expect((writer as InMemoryAuditWriter).events.map((e) => e.action)).toEqual(['a', 'b']);
  });

  it('keeps a snapshot, so later mutation of the input does not change the record', async () => {
    const writer = new InMemoryAuditWriter();
    const after = { status: 'crewing' };
    await writer.record(tx, {
      action: 'x',
      entityType: 'mission',
      entityId: '1',
      after,
      actorId: 'u',
    });
    after.status = 'changed';
    expect(writer.events[0]?.after).toEqual({ status: 'crewing' });
  });

  it('filters by entity and can be cleared', async () => {
    const writer = new InMemoryAuditWriter();
    await writer.record(tx, { action: 'a', entityType: 'mission', entityId: '1', actorId: null });
    await writer.record(tx, { action: 'b', entityType: 'skill', entityId: '1', actorId: null });
    await writer.record(tx, { action: 'c', entityType: 'mission', entityId: '2', actorId: null });
    expect(writer.forEntity('mission', '1').map((e) => e.action)).toEqual(['a']);
    writer.clear();
    expect(writer.events).toEqual([]);
  });
});
