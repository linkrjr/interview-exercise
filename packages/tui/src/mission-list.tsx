import type { MissionSummary } from '@mc/contracts';
import { useCallback } from 'react';
import type { Column } from './data-table.js';
import type { MissionsApi } from './missions-api.js';
import { PagedList } from './paged-list.js';

const COLUMNS: readonly Column<MissionSummary>[] = [
  { header: 'NAME', value: (m) => m.name },
  { header: 'STATUS', value: (m) => m.status },
  { header: 'START', value: (m) => m.startDate },
  { header: 'END', value: (m) => m.endDate },
  { header: 'LEAD', value: (m) => m.leadName ?? m.leadId },
];

export interface MissionListProps {
  api: MissionsApi;
  title: string;
  /** Only missions in these statuses (the approvals list is `pending_approval`); none means all. Pass a stable array: a new one reloads the list. */
  status?: string[];
  emptyText: string;
  /** False while a mission is open on top of the list: the list keeps its place but reads no keys. */
  active: boolean;
  onOpen(mission: MissionSummary): void;
}

/** Missions as a scrollable, selectable table. */
export function MissionList({ api, status, ...rest }: MissionListProps) {
  const fetchPage = useCallback(
    (cursor: string | undefined) => api.list({ status, cursor }),
    [api, status],
  );
  return <PagedList fetchPage={fetchPage} columns={COLUMNS} rowKey={(m) => m.id} {...rest} />;
}
