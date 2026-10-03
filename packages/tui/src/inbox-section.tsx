import type { Notification } from '@mc/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Column } from './data-table.js';
import { time } from './format.js';
import type { InboxApi } from './inbox-api.js';
import { InfoPopup, type Fact } from './info-popup.js';
import { ListSection } from './list-section.js';

/** What a notification is about, as the CLI words it: the mission, and the reason or comment. */
export function aboutOf(n: Notification): string {
  const p = n.payload as { missionName?: string; reason?: string; comment?: string };
  const detail = p.reason ? ` (${p.reason})` : p.comment ? ` (${p.comment})` : '';
  return `${p.missionName ?? ''}${detail}`.trim();
}

const COLUMNS: readonly Column<Notification>[] = [
  { header: 'NEW', value: (n) => (n.readAt ? '' : '●') },
  { header: 'TIME (UTC)', value: (n) => time(n.createdAt) },
  { header: 'TYPE', value: (n) => n.type },
  { header: 'ABOUT', value: aboutOf },
];

const factsOf = (n: Notification): Fact[] => [
  { label: 'Time', value: n.createdAt },
  { label: 'Type', value: n.type },
  { label: 'About', value: aboutOf(n) || '-' },
  { label: 'Read', value: n.readAt ?? 'not yet' },
  { label: 'Id', value: n.id },
];

/** Opening a notification marks it read, like `mc inbox read`; the popup then shows when. */
function NotificationPopup(props: {
  api: InboxApi;
  notification: Notification;
  onClose(): void;
  onRead(): void;
}) {
  const { api, notification } = props;
  const onRead = useRef(props.onRead);
  onRead.current = props.onRead;
  const [current, setCurrent] = useState(notification);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    if (notification.readAt) return;
    let cancelled = false;
    api
      .markRead(notification.id)
      .then((read) => {
        if (cancelled) return;
        setCurrent(read);
        onRead.current();
      })
      .catch(
        (e) => !cancelled && setProblem(e instanceof Error ? e.message : 'Could not mark it read'),
      );
    return () => {
      cancelled = true;
    };
    // Once, when the popup opens: whatever the parent re-renders, a notification is marked read once.
  }, [api, notification]);

  const payload = Object.entries(current.payload).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
  );
  return (
    <InfoPopup
      // A new key per read state: the popup keeps its facts, so it is rebuilt when they change.
      key={current.readAt ?? 'unread'}
      title={current.type}
      facts={factsOf(current)}
      bodyLines={problem ? [problem, '', ...payload] : payload}
      onClose={props.onClose}
    />
  );
}

/** The signed-in user's notifications, newest first; unread ones carry a dot. */
export function InboxSection({ api }: { api: InboxApi }) {
  const fetchPage = useCallback((cursor: string | undefined) => api.list({ cursor }), [api]);
  return (
    <ListSection
      fetchPage={fetchPage}
      columns={COLUMNS}
      rowKey={(n) => n.id}
      title="Inbox"
      emptyText="Your inbox is empty."
      renderPopup={({ row, close, changed }) => (
        <NotificationPopup api={api} notification={row} onClose={close} onRead={changed} />
      )}
    />
  );
}
