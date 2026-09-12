'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { HUMAN_TASK_STATUS_LABELS, HUMAN_TASK_STATUSES, type HumanTaskStatus } from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  DataTable,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  todoApi,
  type HumanTaskView,
  type MeResponse,
  type TaskListView,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

type Filter = 'mine' | 'team' | 'blocked';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'mine', label: 'My work' },
  { key: 'team', label: 'Team' },
  { key: 'blocked', label: 'Blocked' },
];

/** The server sends the tone with the status, so two screens cannot colour one status differently. */
function toneOf(task: HumanTaskView): StatusTone {
  return task.displayTone as StatusTone;
}

/** When a task is due, in the words the reference uses — a date, or the event that starts it. */
function dueLabel(task: HumanTaskView): string {
  if (task.dueAt !== null) {
    return new Date(task.dueAt).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  // Not "—": a task triggered by an event has a real answer, and it is more useful than a dash.
  return task.triggerDescription.trim() === '' ? '—' : task.triggerDescription;
}

/**
 * The To-do List — the reference's Pending Jobs table.
 *
 * ## Not "To-do & Approvals"
 *
 * The reference titles this screen "To-do & Approvals" and mixes approval rows into the same
 * table. That is one of its defects, and the locked rule is explicit: never merge To-do and
 * Approvals, and never show Approvals twice. This screen is a person's own work. The Approvals
 * queue is its own sidebar entry, built by the Approval Engine prompt.
 *
 * ## Every row came from a published workflow
 *
 * Nothing here is created by hand. That is worth saying on the screen, because a list of work
 * with no visible origin invites somebody to look for an "add task" button that should not exist.
 */
export default function TodoPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [data, setData] = useState<TaskListView | null>(null);
  const [filter, setFilter] = useState<Filter>('mine');
  const [status, setStatus] = useState<HumanTaskStatus | ''>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);

    void todoApi
      .list(tenantId, {
        filter,
        ...(status === '' ? {} : { status }),
        ...(search.trim() === '' ? {} : { search }),
      })
      .then((result) => {
        setData(result);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load your work.');
        setLoading(false);
      });
  }, [filter, search, status, tenantId]);

  useEffect(load, [load]);

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="todo"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'To-do List' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="To-do List"
        description="Human work assigned from published workflows."
        breadcrumbs={[{ label: 'To-do List' }]}
        actions={
          <Link href="/dashboard">
            <Button size="sm">
              <Icon name="back" size={16} />
              Dashboard
            </Button>
          </Link>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}

      {data !== null && data.counts.overdue > 0 ? (
        <Banner tone="warn">
          <Icon name="clock" size={16} />
          {data.counts.overdue} {data.counts.overdue === 1 ? 'task is' : 'tasks are'} past the time
          the objective set for them.
        </Banner>
      ) : null}

      <Card>
        <div className="uboss-toolbar">
          <div className="uboss-seg">
            {FILTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={filter === entry.key ? 'is-on' : undefined}
                onClick={() => setFilter(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <SearchField
            label="Search tasks"
            placeholder="Search tasks"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          <select
            className="uboss-filter"
            value={status}
            onChange={(event) => setStatus(event.target.value as HumanTaskStatus | '')}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {HUMAN_TASK_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {HUMAN_TASK_STATUS_LABELS[entry]}
              </option>
            ))}
          </select>
        </div>

        <DataTable
          caption="Work assigned to you"
          loading={loading}
          rowKey={(row: HumanTaskView) => row.id}
          rows={data?.tasks ?? []}
          emptyTitle="Nothing assigned"
          emptyDescription={
            filter === 'mine'
              ? 'No work has been assigned to you from a published workflow yet.'
              : 'No work matches this filter.'
          }
          columns={[
            {
              key: 'task',
              header: 'Task',
              render: (row: HumanTaskView) => (
                <Link href={`/todo/detail?taskId=${encodeURIComponent(row.id)}`}>
                  <b>{row.title}</b>
                  <br />
                  <small className="uboss-muted-3 uboss-mono">{row.objectiveCode}</small>
                </Link>
              ),
            },
            {
              key: 'type',
              header: 'Type',
              // Always Human on this screen. Kept because the reference's column is there and
              // because the Approvals and Agent rows live on their own screens, not merged here.
              render: () => <StatusBadge tone="blue" status="Human" />,
            },
            {
              key: 'objective',
              header: 'Objective',
              render: (row: HumanTaskView) => row.objectiveName,
            },
            {
              key: 'due',
              header: 'Due / trigger',
              render: (row: HumanTaskView) => dueLabel(row),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row: HumanTaskView) => (
                <StatusBadge tone={toneOf(row)} status={row.displayStatus} dot />
              ),
            },
          ]}
        />
      </Card>

      {data === null ? null : (
        <p className="uboss-notice-min">
          <Icon name="shield" size={14} />
          {data.note}
        </p>
      )}
    </AppShell>
  );
}
