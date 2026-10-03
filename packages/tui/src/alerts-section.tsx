import type { Alert } from '@mc/contracts';
import { useCallback } from 'react';
import type { AlertsApi } from './alerts-api.js';
import type { Column } from './data-table.js';
import { jsonLines, time } from './format.js';
import { InfoPopup } from './info-popup.js';
import { ListSection } from './list-section.js';

const COLUMNS: readonly Column<Alert>[] = [
  { header: 'TIME (UTC)', value: (a) => time(a.occurredAt) },
  { header: 'CODE', value: (a) => a.code },
  { header: 'MESSAGE', value: (a) => a.message },
];

/** Operational alerts, such as scheduler failures, newest first (Directors). */
export function AlertsSection({ api }: { api: AlertsApi }) {
  const fetchPage = useCallback((cursor: string | undefined) => api.list({ cursor }), [api]);
  return (
    <ListSection
      fetchPage={fetchPage}
      columns={COLUMNS}
      rowKey={(a) => a.id}
      title="Alerts"
      emptyText="No alerts."
      renderPopup={({ row, close }) => (
        <InfoPopup
          title={row.code}
          facts={[
            { label: 'Time', value: row.occurredAt },
            { label: 'Code', value: row.code },
            { label: 'Source', value: row.source },
            { label: 'Message', value: row.message },
            { label: 'Id', value: row.id },
          ]}
          bodyLines={['Details', ...jsonLines(row.details).map((l) => `  ${l}`)]}
          onClose={close}
        />
      )}
    />
  );
}
