import type { AuditEvent } from '@mc/contracts';
import { useCallback } from 'react';
import type { AuditApi } from './audit-api.js';
import type { Column } from './data-table.js';
import { jsonLines, shortId, time } from './format.js';
import { InfoPopup } from './info-popup.js';
import { ListSection } from './list-section.js';

const COLUMNS: readonly Column<AuditEvent>[] = [
  { header: 'TIME (UTC)', value: (e) => time(e.occurredAt) },
  { header: 'ACTION', value: (e) => e.action },
  { header: 'ENTITY', value: (e) => `${e.entityType}:${shortId(e.entityId)}` },
  { header: 'ACTOR', value: (e) => (e.actorId ? shortId(e.actorId) : 'system') },
];

/** Who changed what, newest first (Directors). A row opens the event with what it changed. */
export function AuditSection({ api }: { api: AuditApi }) {
  const fetchPage = useCallback((cursor: string | undefined) => api.list({ cursor }), [api]);
  return (
    <ListSection
      fetchPage={fetchPage}
      columns={COLUMNS}
      rowKey={(e) => e.id}
      title="Audit log"
      emptyText="Nothing has been recorded yet."
      renderPopup={({ row, close }) => (
        <InfoPopup
          title={row.action}
          facts={[
            { label: 'Time', value: row.occurredAt },
            { label: 'Action', value: row.action },
            { label: 'Entity', value: `${row.entityType} ${row.entityId}` },
            { label: 'Actor', value: row.actorId ?? 'system' },
            { label: 'Id', value: row.id },
          ]}
          bodyLines={[
            'Before',
            ...jsonLines(row.before).map((l) => `  ${l}`),
            '',
            'After',
            ...jsonLines(row.after).map((l) => `  ${l}`),
          ]}
          maxHeight={26}
          onClose={close}
        />
      )}
    />
  );
}
