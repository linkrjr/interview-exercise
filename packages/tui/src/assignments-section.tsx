import type { Assignment } from '@mc/contracts';
import { useCallback } from 'react';
import type { AssignmentsApi } from './assignments-api.js';
import type { Column } from './data-table.js';
import { time } from './format.js';
import { InfoPopup, type Fact } from './info-popup.js';
import { ListSection } from './list-section.js';

const COLUMNS: readonly Column<Assignment>[] = [
  { header: 'MISSION', value: (a) => a.mission.name },
  { header: 'STATUS', value: (a) => a.mission.status },
  { header: 'START', value: (a) => a.mission.startDate },
  { header: 'END', value: (a) => a.mission.endDate },
  { header: 'ACKNOWLEDGED', value: (a) => (a.acknowledgedAt ? 'yes' : 'no') },
];

const factsOf = (a: Assignment): Fact[] => [
  { label: 'Mission', value: a.mission.name },
  { label: 'Status', value: a.mission.status },
  { label: 'Dates', value: `${a.mission.startDate} to ${a.mission.endDate}` },
  { label: 'Description', value: a.mission.description || '-' },
  { label: 'Acknowledged', value: a.acknowledgedAt ? time(a.acknowledgedAt) : 'not yet' },
  { label: 'Id', value: a.id },
];

/** The signed-in Crew Member's assignments; a row opens the mission and the way to acknowledge it. */
export function AssignmentsSection({ api }: { api: AssignmentsApi }) {
  const fetchPage = useCallback((cursor: string | undefined) => api.list({ cursor }), [api]);
  return (
    <ListSection
      fetchPage={fetchPage}
      columns={COLUMNS}
      rowKey={(a) => a.id}
      title="My assignments"
      emptyText="You have no assignments."
      renderPopup={({ row, close, changed }) => (
        <InfoPopup
          title={row.mission.name}
          facts={factsOf(row)}
          actions={
            row.acknowledgedAt
              ? []
              : [
                  {
                    key: 'a',
                    label: 'Acknowledge',
                    confirm: 'Acknowledge this assignment? It is binding and cannot be refused.',
                    run: async () => {
                      const done = await api.acknowledge(row.id);
                      changed();
                      return { message: 'Acknowledged.', facts: factsOf(done), hide: ['a'] };
                    },
                  },
                ]
          }
          onClose={close}
          onChanged={changed}
        />
      )}
    />
  );
}
