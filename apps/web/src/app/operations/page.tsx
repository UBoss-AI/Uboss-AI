'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  engineAgentsApi,
  todoApi,
  type EngineAgentView,
  type HumanTaskView,
  type MeResponse,
} from '../../lib/api-client';

import { RunAgentPanel } from '../../components/RunAgentPanel';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { useNotificationBell } from '../../lib/use-notification-bell';

/**
 * Operations — the one screen somebody who does the work needs.
 *
 * ## What it is for
 *
 * A person who is given work should not have to understand the product to do it. They should open
 * one screen and see: what can I start now, what am I waiting on, and what have I finished. This
 * is that screen, and for a default Employee it is the whole application.
 *
 * ## The three groups, and why the middle one exists
 *
 * **Ready now** is what this person can actually act on. **Waiting** is work that is theirs but
 * cannot begin, because something earlier in the objective has not finished — and it is shown
 * rather than hidden on purpose. Hiding it would leave somebody wondering whether they had been
 * forgotten; showing it, with what it is waiting for, is the difference between a queue and a
 * black box. **Completed** is the record, because "did I do that?" is a real question.
 *
 * ## Nothing here is new data
 *
 * Every row is the server's: human tasks come from the To-do service and agent work from the
 * engine agent registry, both already scoped to this person by the same authorization that guards
 * their own screens. This component adds no endpoint, computes no status and invents no number —
 * it groups what those two already return, by the status they already carry.
 *
 * ## What it deliberately does not do
 *
 * It does not build anything. There is no objective editor, no agent builder and no hierarchy
 * here, and that is the point: this person operates work, they do not define it. The controls to
 * define it are a different permission and a different screen.
 */

const TONE: Record<string, StatusTone> = {
  Waiting: 'grey',
  Assigned: 'blue',
  InProgress: 'teal',
  Blocked: 'danger',
  NeedsInput: 'warn',
  WaitingApproval: 'warn',
  Submitted: 'purple',
  Completed: 'success',
  Cancelled: 'grey',
  Overdue: 'danger',
};

/** Statuses a person can pick up and move. Everything else is waiting or finished. */
const ACTIONABLE = new Set(['Assigned', 'InProgress', 'NeedsInput']);
const FINISHED = new Set(['Completed', 'Cancelled']);

/** When it is due, in the shortest form that is still unambiguous. */
function due(iso: string | null): string {
  if (iso === null) return '—';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '—';
  const days = Math.round((when.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days}d`;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function OperationsPage() {
  const router = useRouter();
  const navGroups = useCompanyNavigation();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [tasks, setTasks] = useState<HumanTaskView[] | null>(null);
  const [agents, setAgents] = useState<EngineAgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * Agent work is optional, and its absence is not an error.
   *
   * A default Employee holds `agents` and a guest may not. A refusal there must not blank the
   * human tasks beside it — so it is loaded separately and a refusal simply means that section is
   * not this person's to see.
   */
  const [agentsRefused, setAgentsRefused] = useState(false);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);
  const accountMenu = useAccountMenu(me);
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
    if (tenantId === null) return;
    setError(null);

    void todoApi
      .list(tenantId, { filter: 'mine' })
      .then((result) => setTasks(result.tasks))
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your work.'),
      );

    void engineAgentsApi
      .list(tenantId, false)
      .then((result) => setAgents(result.agents))
      .catch(() => {
        setAgents([]);
        setAgentsRefused(true);
      });
  }, [tenantId]);

  useEffect(load, [load]);

  /** The agent whose run form is open. Null when nobody is starting one. */
  const [running, setRunning] = useState<EngineAgentView | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const all = tasks ?? [];
    return {
      ready: all.filter((task) => ACTIONABLE.has(task.status)),
      waiting: all.filter(
        (task) => !ACTIONABLE.has(task.status) && !FINISHED.has(task.status),
      ),
      done: all.filter((task) => FINISHED.has(task.status)),
    };
  }, [tasks]);

  /** The agents this person can actually run, which is what "agent work" means to them. */
  const runnable = useMemo(
    () => (agents ?? []).filter((agent) => agent.status === 'Active'),
    [agents],
  );

  const taskColumns = [
    {
      key: 'what',
      header: 'Work',
      render: (task: HumanTaskView) => (
        <>
          <b>{task.title}</b>
          <br />
          <small className="uboss-muted-3">{task.objectiveName}</small>
        </>
      ),
    },
    {
      key: 'output',
      header: 'Expected result',
      render: (task: HumanTaskView) => (
        <>
          <small className="uboss-muted-3">{task.expectedOutput || '—'}</small>
          {/*
            What the wait is for.

            The one thing that turns a queue into something a person can trust. Rendered from the
            server's own list of unfinished predecessors, so it cannot say a step is waiting on
            something that has in fact finished — if it had, the server would have released it.
          */}
          {task.waitingOn.length === 0 ? null : (
            <>
              <br />
              <small className="uboss-muted-3">
                Waiting on: <b>{task.waitingOn.join(', ')}</b>
              </small>
            </>
          )}
        </>
      ),
    },
    {
      key: 'due',
      header: 'Due',
      render: (task: HumanTaskView) => (
        <span className={task.overdue ? 'uboss-danger-text' : undefined}>{due(task.dueAt)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (task: HumanTaskView) => (
        <StatusBadge status={task.displayStatus} tone={TONE[task.displayStatus] ?? 'grey'} />
      ),
    },
    {
      key: 'open',
      header: '',
      render: (task: HumanTaskView) => (
        <Button onClick={() => router.push(`/todo/detail?taskId=${encodeURIComponent(task.id)}`)}>
          Open
        </Button>
      ),
    },
  ];

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={
        resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantName ?? '—'
      }
      groups={navGroups}
      activeKey="operations"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Operations"
        description="Everything assigned to you, and what it is waiting on."
        breadcrumbs={[{ label: 'Operations' }]}
        actions={<Button onClick={load}>Refresh</Button>}
      />

      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {runNotice !== null ? <Banner tone="ok">{runNotice}</Banner> : null}

      {/* What can be started now. First, because it is the only section with anything to do in it. */}
      <Card>
        <CardHeader
          title="Ready now"
          aside={
            tasks === null ? null : (
              <StatusBadge
                status={`${grouped.ready.length} to do`}
                tone={grouped.ready.length === 0 ? 'grey' : 'blue'}
              />
            )
          }
        />
        <CardBody>
          {tasks === null ? (
            <SkeletonText lines={3} />
          ) : grouped.ready.length === 0 ? (
            <EmptyState
              title="Nothing is waiting on you"
              description={
                grouped.waiting.length > 0
                  ? 'You have work further down that cannot start until somebody else finishes theirs.'
                  : 'When work is assigned to you it appears here, and you are notified.'
              }
            />
          ) : (
            <DataTable
              caption="Work you can start now"
              columns={taskColumns}
              rows={grouped.ready}
              rowKey={(task) => task.id}
            />
          )}
        </CardBody>
      </Card>

      {/* Agent work: the agents this person operates, not ones they build. */}
      {agentsRefused ? null : (
        <Card>
          <CardHeader
            title="Agent work"
            aside={
              agents === null ? null : (
                <StatusBadge
                  status={`${runnable.length} available`}
                  tone={runnable.length === 0 ? 'grey' : 'teal'}
                />
              )
            }
          />
          <CardBody>
            {agents === null ? (
              <SkeletonText lines={2} />
            ) : runnable.length === 0 ? (
              <EmptyState
                title="No agent is assigned to you"
                description="An agent appears here once one built for your work has been activated."
              />
            ) : (
              <DataTable
                caption="Agents you can run"
                columns={[
                  {
                    key: 'agent',
                    header: 'Agent',
                    render: (agent: EngineAgentView) => <b>{agent.name}</b>,
                  },
                  {
                    key: 'trigger',
                    header: 'Runs',
                    render: (agent: EngineAgentView) => (
                      <small className="uboss-muted-3">
                        {agent.scheduleOrTrigger ?? 'When you run it'}
                      </small>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (agent: EngineAgentView) => (
                      <StatusBadge status={agent.status} tone="success" />
                    ),
                  },
                  {
                    key: 'open',
                    header: '',
                    render: (agent: EngineAgentView) => (
                      <div className="uboss-actions">
                        {/*
                          Run is the primary action here, and Open is the secondary one.

                          This person operates the agent; they do not configure it. Sending them to
                          the agent's own screen to find a button was the long way round to the one
                          thing they came to do.
                        */}
                        <Button variant="primary" size="sm" onClick={() => setRunning(agent)}>
                          <Icon name="bolt" size={16} />
                          Run
                        </Button>
                        <Button
                          size="sm"
                          onClick={() =>
                            router.push(`/agents?agentId=${encodeURIComponent(agent.id)}`)
                          }
                        >
                          Open
                        </Button>
                      </div>
                    ),
                  },
                ]}
                rows={runnable}
                rowKey={(agent) => agent.id}
              />
            )}
          </CardBody>
        </Card>
      )}

      {/* Waiting. Shown rather than hidden — see the note at the top of this file. */}
      {grouped.waiting.length === 0 ? null : (
        <Card>
          <CardHeader
            title="Waiting on something else"
            aside={<StatusBadge status={`${grouped.waiting.length}`} tone="warn" />}
          />
          <CardBody>
            <DataTable
              caption="Your work that cannot start yet, and what each piece is waiting for"
              columns={taskColumns}
              rows={grouped.waiting}
              rowKey={(task) => task.id}
            />
          </CardBody>
        </Card>
      )}

      {grouped.done.length === 0 ? null : (
        <Card>
          <CardHeader
            title="Completed"
            aside={<StatusBadge status={`${grouped.done.length}`} tone="success" />}
          />
          <CardBody>
            <DataTable
              caption="Work you have finished"
              columns={taskColumns}
              rows={grouped.done}
              rowKey={(task) => task.id}
            />
          </CardBody>
        </Card>
      )}
      {/*
        Operating the agent, from the screen the work is listed on.

        Mounted beside the cards rather than inside the table, so closing it never unmounts the row
        that opened it while a request is still in flight.
      */}
      {tenantId === null ? null : (
        <RunAgentPanel
          tenantId={tenantId}
          agent={running}
          onClose={() => setRunning(null)}
          onStarted={(message) => {
            setRunNotice(message);
            load();
          }}
        />
      )}
    </RoutedAppShell>
  );
}
