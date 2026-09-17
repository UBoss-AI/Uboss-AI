'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ENGINE_AGENT_STATUS_LABELS, ENGINE_AGENT_STATUS_TONES } from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
  type StatusTone,
  RunState,
  EmptyState,
} from '@uboss/ui';

import { ApiError, authApi, engineAgentsApi, type EngineAgentView, type MeResponse, agentRunsApi, type AgentRunSummaryView } from '../../lib/api-client';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { MyEngineAgents } from '../../components/MyEngineAgents';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { DiscussButton } from '../../components/DiscussButton';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { can, useMyAccess } from '../../lib/use-my-access';

/**
 * Engine Agents — the reference's `SCR.agents`.
 *
 * Its table: Agent, Owner, Status, Schedule / trigger, Last run, Health, Cost. A toolbar with a
 * search box, a status filter and a primary "Build agent" going to Agent Builder, under the
 * banner explaining that agents are reusable workers and individual executions live under Runs.
 *
 * ## Where this departs from the prototype, and why
 *
 * The prototype's rows carry a health badge and a cost figure for every agent. Real agents have
 * neither until they have run: the run engine and the cost ledger are later prompts. So Health
 * and Cost render "No runs yet" and "—" rather than a green badge and a plausible number — a
 * fabricated 100% health on an agent that has never executed is worse than an empty cell,
 * because it is the cell an operations person would trust.
 *
 * `Run now` and `Open runs` appear because the status genuinely permits them, and are disabled
 * with the reason. The server has no route for either yet, deliberately.
 */
export default function EngineAgentsPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  // Building an agent is a separate grant from running one; the toolbar has to know the difference.
  const access = useMyAccess();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [agents, setAgents] = useState<EngineAgentView[]>([]);
  const [selected, setSelected] = useState<EngineAgentView | null>(null);

  /*
   * The selected agent's runs, read from the run engine.
   *
   * Nothing here synthesises a run. `runs` stays null until the request answers, and an empty
   * list is shown as an empty list — this environment has no AI provider configured and no run
   * has ever executed, which is a fact about the setup and not something a screen should paper
   * over with a sample.
   */
  const [runs, setRuns] = useState<AgentRunSummaryView[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);
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

    void engineAgentsApi
      .list(tenantId, includeArchived)
      .then((result) => {
        setAgents(result.agents);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not load your agents.');
        setLoading(false);
      });
  }, [includeArchived, tenantId]);

  useEffect(load, [load]);

  /** Every mutation funnels through here so the busy flag and reload are never skipped. */
  const run = (work: (tenantId: string, agentId: string) => Promise<EngineAgentView>) => () => {
    if (!tenantId || selected === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    void work(tenantId, selected.id)
      .then((updated) => {
        setSelected(updated);
        setAgents((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setNotice(`"${updated.name}" is now ${ENGINE_AGENT_STATUS_LABELS[updated.status]}.`);
        setBusy(false);
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That did not work.');
        setBusy(false);
      });
  };

  const term = search.trim().toLowerCase();
  const shown =
    term === '' ? agents : agents.filter((entry) => entry.name.toLowerCase().includes(term));

  useEffect(() => {
    if (tenantId === null || selected === null) {
      setRuns(null);
      setRunsError(null);
      return;
    }
    let live = true;
    setRuns(null);
    setRunsError(null);
    void agentRunsApi
      .list(tenantId, selected.id)
      .then((result) => {
        if (live) setRuns(result.runs);
      })
      .catch((caught: unknown) => {
        // Said plainly rather than shown as "no runs": not knowing is different from none.
        if (live) setRunsError(caught instanceof Error ? caught.message : 'Could not read this agent\u2019s runs.');
      });
    return () => {
      live = false;
    };
  }, [selected, tenantId]);

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="agents"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Engine Agents"
        description={`Reusable AI workers — ${agents.length} in this workspace.`}
        breadcrumbs={[{ label: 'Engine Agent' }]}
        actions={
          <>
            {/*
              Prompt 40A (CR-03) §6 — Discuss the agent currently open.

              In the header rather than on every row: a Discuss button per row would be a
              column of buttons nobody reads, and the conversation is about the one agent
              somebody has actually opened.
            */}
            {selected === null ? null : (
              <DiscussButton
                tenantId={tenantId}
                contextType="EngineAgent"
                resourceId={selected.id}
              />
            )}
            {/*
              Offered only to somebody who may build.

              CR-03 made Build and Operate separate capabilities on purpose: a standard Employee
              holds `agents: [View, Comment, Run]` and no `agent-builder` grant at all, so this
              button used to send them to a screen their role cannot use. Running a released agent
              and deciding what gets released are different acts, and the toolbar should say so.
            */}
            {can(access, 'agent-builder', 'Create') ? (
              <Link href="/agent-builder">
                <Button variant="primary" size="sm">
                  <Icon name="plus" size={16} />
                  Build agent
                </Button>
              </Link>
            ) : null}
          </>
        }
      />

      <Banner tone="info">
        Engine Agents are reusable AI workers. Individual executions live under Runs. Oversight and
        exceptions are handled by the Executor.
      </Banner>

      {/*
        Prompt 40A (CR-03) §5 — OPERATIONS → Engine Agents, as the person the agent was *built
        for* sees it.

        Above the registry rather than on a screen of its own, because "the agents assigned to me"
        and "the agents this company has" are the same question asked at two scopes, and a standard
        Employee reaching a second URL for their own work would be the tell that the sidebar is
        lying to them. The registry table below is already scope-filtered, so an Employee sees their
        shared agents here and an empty table there, while a Head sees both populated.

        `showEmptyState` is false when the registry has rows: "nothing has been shared with you" is
        an explanation on an otherwise blank screen and noise above a full table.
      */}
      {tenantId === null ? null : (
        <section className="operator-section" data-testid="assigned-to-me">
          <h2 className="operator-section-title">Assigned to you</h2>
          <MyEngineAgents tenantId={tenantId} showEmptyState={agents.length === 0} />
        </section>
      )}

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="ok">{notice}</Banner>}

      <Card>
        <CardBody>
          <div className="uboss-toolbar">
            <SearchField
              label="Search agents"
              placeholder="Search agents"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="uboss-checkbox">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Include archived
            </label>
          </div>

          <DataTable
            caption="Engine Agents"
            rows={shown}
            rowKey={(row) => row.id}
            loading={loading}
            columns={[
              {
                key: 'agent',
                header: 'Agent',
                render: (row) => (
                  <>
                    <b>{row.name}</b>
                    <br />
                    <small className="uboss-mono uboss-muted-3">
                      {row.currentVersion === null
                        ? 'no version'
                        : `v${row.currentVersion.versionNumber}`}{' '}
                      · {ENGINE_AGENT_STATUS_LABELS[row.status]}
                    </small>
                  </>
                ),
              },
              {
                key: 'owner',
                header: 'Owner',
                render: (row) => (
                  <span className="uboss-mono uboss-muted-3">{row.ownerUserId.slice(0, 8)}</span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => (
                  <StatusBadge
                    tone={ENGINE_AGENT_STATUS_TONES[row.status] as StatusTone}
                    status={ENGINE_AGENT_STATUS_LABELS[row.status]}
                  />
                ),
              },
              {
                key: 'schedule',
                header: 'Schedule / trigger',
                render: (row) => row.scheduleOrTrigger ?? <span className="uboss-muted-3">—</span>,
              },
              {
                key: 'last',
                header: 'Last run',
                render: (row) =>
                  row.health.lastRunAt === null ? (
                    <span className="uboss-muted-3">No runs yet</span>
                  ) : (
                    new Date(row.health.lastRunAt).toLocaleString()
                  ),
              },
              {
                key: 'health',
                header: 'Health',
                render: (row) =>
                  row.health.hasRunData ? (
                    <StatusBadge
                      tone={row.health.failed === 0 ? 'success' : 'warn'}
                      status={`${row.health.succeeded}/${row.health.totalRuns}`}
                    />
                  ) : (
                    // Deliberately not a green badge. Health on an agent that has never run is
                    // not "good" — it is unknown, and an operations person must see which.
                    <span className="uboss-muted-3">Unknown</span>
                  ),
              },
              {
                key: 'cost',
                header: 'Cost',
                render: (row) =>
                  row.usage.hasData ? (
                    <span className="uboss-mono">{row.usage.promptTokens}</span>
                  ) : (
                    <span className="uboss-muted-3">—</span>
                  ),
              },
              {
                key: 'open',
                header: '',
                render: (row) => (
                  <Button size="sm" onClick={() => setSelected(row)}>
                    View
                  </Button>
                ),
              },
            ]}
            emptyTitle="No Engine Agents yet"
            emptyDescription="An agent appears here once assigned AI work is activated in Agent Builder."
          />
        </CardBody>
      </Card>

      {/* ---- Detail drawer: the reference's agentDetail(), as far as this prompt reaches ---- */}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {selected === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Status</span>
              <span className="uboss-kv-value">
                <StatusBadge
                  tone={ENGINE_AGENT_STATUS_TONES[selected.status] as StatusTone}
                  status={ENGINE_AGENT_STATUS_LABELS[selected.status]}
                />
              </span>
            </div>
            {selected.pausedReason === null ? null : (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Paused because</span>
                <span className="uboss-kv-value">{selected.pausedReason}</span>
              </div>
            )}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Current version</span>
              <span className="uboss-kv-value">
                {selected.currentVersion === null
                  ? '—'
                  : `v${selected.currentVersion.versionNumber}`}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Memory</span>
              <span className="uboss-kv-value">{selected.memoryMode}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Objectives</span>
              <span className="uboss-kv-value">{selected.objectiveIds.length}</span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Skills</span>
              <span className="uboss-kv-value uboss-mono">
                {selected.skillVersionIds.length === 0 ? (
                  <span className="uboss-muted-3">None</span>
                ) : (
                  selected.skillVersionIds.map((id) => id.slice(0, 8)).join(', ')
                )}
              </span>
            </div>

            <p className="uboss-notice-min">
              <Icon name="shield" size={14} />
              {selected.health.note}
            </p>

            <div className="uboss-section-label">Runs</div>
            {runsError !== null ? (
              <Banner tone="warn">{runsError}</Banner>
            ) : runs === null ? (
              <p className="uboss-notice-min">
                <Icon name="clock" size={14} />
                Reading this agent&rsquo;s runs&hellip;
              </p>
            ) : runs.length === 0 ? (
              /*
               * The truthful empty state. An agent with no runs has not succeeded and has not
               * failed — and if no provider is configured it cannot run at all, which is a setup
               * fact the operator needs rather than an absence to be styled over. The agent's own
               * readiness note says which applies, so it is shown rather than guessed at here.
               */
              <EmptyState
                icon="bolt"
                title="No runs yet"
                description={selected.health.note}
              />
            ) : (
              runs.map((run) => (
                <div className="uboss-kv" key={run.id}>
                  <span className="uboss-kv-key">
                    {run.startedAt === null ? 'Not started' : new Date(run.startedAt).toLocaleString()}
                  </span>
                  <span className="uboss-kv-value">
                    {/* The state exactly as the engine reported it. Only Running and Retrying
                        animate; waiting, blocked and finished are still. */}
                    <RunState state={run.state} />
                    {run.failureReason === null ? null : (
                      <>
                        <br />
                        <small className="uboss-muted-3">{run.failureReason}</small>
                      </>
                    )}
                    {run.producedByRealModel === false ? (
                      <>
                        <br />
                        {/* Never implied, always stated: an output from the mock model is not a
                            result, and a screen that hid this would be claiming one. */}
                        <small className="uboss-muted-3">Produced without a real model</small>
                      </>
                    ) : null}
                  </span>
                </div>
              ))
            )}

            <div className="uboss-section-label">Versions</div>
            {selected.versions.map((version) => (
              <div className="uboss-kv" key={version.id}>
                <span className="uboss-kv-key">
                  v{version.versionNumber} {version.isCurrent ? '(in force)' : ''}
                </span>
                <span className="uboss-kv-value">
                  <StatusBadge
                    tone={version.status === 'Published' ? 'success' : 'grey'}
                    status={version.status}
                  />
                  {version.approvalRequired ? ' · needs approval' : ''}
                </span>
              </div>
            ))}

            {selected.openDraft?.impact === null ||
            selected.openDraft?.impact === undefined ? null : (
              <>
                <div className="uboss-section-label">What the open draft would change</div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Fields</span>
                  <span className="uboss-kv-value">
                    {selected.openDraft.impact.changedFields.join(', ') || 'nothing'}
                  </span>
                </div>
                {selected.openDraft.impact.reasons.map((reason, index) => (
                  <p className="uboss-notice-min" key={index}>
                    <Icon name="alert" size={14} />
                    {reason}
                  </p>
                ))}
              </>
            )}

            <div className="uboss-section-label">Actions</div>
            <div className="uboss-actions">
              {/* Offered because the status permits it; disabled because the engine is next. */}
              <Button size="sm" disabled title="The run engine arrives with the next prompt">
                <Icon name="bolt" size={16} />
                Run now
              </Button>
              <Button size="sm" disabled title="Runs arrive with the next prompt">
                <Icon name="list" size={16} />
                Open runs
              </Button>
              {selected.actions.includes('Pause') ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Why is this agent being paused?');
                    if (reason === null || reason.trim() === '') return;
                    run((tenant, agentId) => engineAgentsApi.pause(tenant, agentId, reason))();
                  }}
                >
                  Pause
                </Button>
              ) : null}
              {selected.actions.includes('Resume') ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={run((tenant, agentId) => engineAgentsApi.resume(tenant, agentId))}
                >
                  Resume
                </Button>
              ) : null}
            </div>

            <p className="uboss-notice-min">
              <Icon name="file" size={14} />
              {selected.note}
            </p>
          </>
        )}
      </Drawer>
    </RoutedAppShell>
  );
}
