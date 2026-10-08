'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  AGENT_RUN_TYPE_LABELS,
  AGENT_RUN_TYPES,
  ENGINE_AGENT_STATUS_LABELS,
  ENGINE_AGENT_STATUS_TONES,
  MISSING_DATA_BEHAVIOUR_LABELS,
  MISSING_DATA_BEHAVIOURS,
  WEEKDAYS,
  type AgentRunType,
  type AgentSchedule,
  type MissingDataBehaviour,
  type Weekday,
} from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  DataTable,
  Drawer,
  Icon,
  PageHeader,
  FormField,
  SearchField,
  StatusBadge,
  RunState,
  EmptyState,
} from '@uboss/ui';

import {
  type AgentExecutionSetupView,
  ApiError,
  authApi,
  engineAgentsApi,
  type EngineAgentView,
  type MeResponse,
  agentRunsApi,
  type AgentRunSummaryView,
} from '../../lib/api-client';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import { RunAgentPanel } from '../../components/RunAgentPanel';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { MyEngineAgents } from '../../components/MyEngineAgents';
import { LiveRunStrip } from '../../components/LiveRunStrip';
import { useRunStream } from '../../lib/use-run-stream';
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
 * neither until they have run, so Health and Cost render "No runs yet" and "—" rather than a
 * green badge and a plausible number — a fabricated 100% health on an agent that has never
 * executed is worse than an empty cell, because it is the cell an operations person would trust.
 *
 * Both are now real where the rows exist. Cost is settled ledger spend net of refunds, in the
 * company's own currency; it is **not** a token count, and the view no longer carries one. Work
 * that is reserved but unfinished is excluded, because a reservation can still be released.
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

  /**
   * The agent somebody is starting, if any.
   *
   * Separate from `selected`, which is the agent being looked at. Opening the configuration card
   * and starting a run are different acts by different people — an operator starts an agent
   * without wanting to read how it was built — so one does not imply the other.
   */
  const [running, setRunning] = useState<EngineAgentView | null>(null);

  /**
   * The execution setup for an agent nothing configured -- PRD 5.1.
   *
   * Held here rather than fetched, because an agent in Draft setup has no version to read one
   * from. It is reset whenever a different agent is opened, so the answers for one never arrive
   * pre-filled on another.
   */
  const [setup, setSetup] = useState<Partial<AgentExecutionSetupView>>({
    runType: null,
    triggerOrFrequency: null,
    inputConnectionId: null,
    whereWorkHappens: null,
    outputDestination: null,
    missingDataBehaviour: null,
  });

  useEffect(() => {
    setSetup({
      runType: null,
      triggerOrFrequency: null,
      inputConnectionId: null,
      whereWorkHappens: null,
      outputDestination: null,
      missingDataBehaviour: null,
    });
  }, [selected?.id]);

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

  /*
   * Live run progress for this whole workspace, not for the selected agent.
   *
   * The strip's job is "what is my company's AI doing", and that is a question about every agent
   * at once. Subscribing per selection would mean the thing you were not looking at is the thing
   * you never saw running — and it would open and close a connection on every click.
   */
  const runStream = useRunStream(tenantId, { seedFromRecord: true });

  /** Agent ids to names, so a lane can say who is working rather than printing an id. */
  const agentNames = useMemo(
    () => new Map(agents.map((entry) => [entry.id, entry.name])),
    [agents],
  );

  /*
   * Renaming the open agent.
   *
   * The draft is held apart from `selected` so an abandoned edit changes nothing: pressing Cancel
   * or Escape leaves the agent exactly as the server last described it, with no local copy to
   * reconcile.
   */
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  /*
   * The schedule being edited.
   *
   * Held apart from `selected` so an abandoned edit changes nothing: Cancel leaves the agent
   * exactly as the server last described it. `scheduleTime` is an `<input type="time">` value —
   * `HH:MM` — which is the one format every browser's own time control agrees on.
   */
  const [scheduling, setScheduling] = useState(false);
  const [scheduleDays, setScheduleDays] = useState<Weekday[]>([]);
  const [scheduleTime, setScheduleTime] = useState('09:00');

  const applySchedule = useCallback(
    (schedule: AgentSchedule | null) => {
      if (tenantId === null || selected === null) return;
      setBusy(true);
      setError(null);
      void engineAgentsApi
        .setSchedule(tenantId, selected.id, schedule)
        .then((updated) => {
          setSelected(updated);
          setAgents((current) => current.map((row) => (row.id === updated.id ? updated : row)));
          setNotice(
            schedule === null
              ? `${updated.name} is no longer scheduled.`
              : `${updated.name} will run: ${updated.scheduleOrTrigger}.`,
          );
          setScheduling(false);
        })
        .catch((caught: unknown) =>
          setError(
            caught instanceof ApiError ? caught.message : 'That schedule could not be saved.',
          ),
        )
        .finally(() => setBusy(false));
    },
    [selected, tenantId],
  );

  const saveSchedule = useCallback(() => {
    const [hourPart, minutePart] = scheduleTime.split(':');
    const hour = Number(hourPart);
    const minute = Number(minutePart);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      setError('Pick a time of day.');
      return;
    }
    applySchedule({ weekdays: scheduleDays, hour, minute });
  }, [applySchedule, scheduleDays, scheduleTime]);

  const clearSchedule = useCallback(() => applySchedule(null), [applySchedule]);

  const saveName = useCallback(() => {
    if (tenantId === null || selected === null) return;
    const name = nameDraft.trim();
    if (name === selected.name) {
      setRenaming(false);
      return;
    }

    setBusy(true);
    setError(null);
    void engineAgentsApi
      .rename(tenantId, selected.id, name)
      .then((updated) => {
        setSelected(updated);
        // The row in the table behind the drawer, so the list and the card never disagree.
        setAgents((current) => current.map((row) => (row.id === updated.id ? updated : row)));
        setNotice(`Renamed to "${updated.name}".`);
        setRenaming(false);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That name could not be saved.'),
      )
      .finally(() => setBusy(false));
  }, [nameDraft, selected, tenantId]);

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

  /**
   * Refresh the agent the drawer is showing, as well as the list behind it.
   *
   * `load()` replaces the rows; `selected` is a snapshot taken when the drawer opened and nothing
   * in the list touches it. Saving a version and then looking for it in `selected.versions` finds
   * the state from before the save, which is how a control that should have appeared does not.
   */
  const reloadSelected = useCallback(
    (fallback?: EngineAgentView) => {
      load();
      const id = fallback?.id ?? selected?.id;
      if (tenantId === null || id === undefined) return;
      void engineAgentsApi
        .view(tenantId, id)
        .then(setSelected)
        .catch(() => {
          // The list reloaded either way; a stale drawer is not worth an error banner.
        });
    },
    [load, selected, tenantId],
  );

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
        if (live)
          setRunsError(
            caught instanceof Error ? caught.message : 'Could not read this agent\u2019s runs.',
          );
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
            {/*
              One way out of this screen, and it is the builder -- the client's correction.

              There used to be two buttons here: **New agent**, which opened the create dialog on
              this screen, and **Build agent**, which went to Agent Builder. The client said
              agents are made in one place: "agent agar banana hai to Agent Builder me hi button
              hona chahiye ... agent builder me hi agent banenge". This screen is where the
              company's agents are looked at, configured and given out; it is not where they come
              from.

              So the dialog moved to Agent Builder, behind the same `agent-builder: Create` grant
              it was always behind, and what is left here is the way to get there. The route that
              creates a standalone agent is untouched — it is the same one the moved dialog calls.
            */}
            {can(access, 'agent-builder', 'Create') ? (
              <Link href="/agent-builder">
                <Button variant="primary" size="sm">
                  <Icon name="build" size={16} />
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
        What this company's agents are doing, at this moment.

        The registry below says what exists and when each thing last ran; neither answers the
        question somebody has just after pressing Run, which is whether anything is happening.
        That answer used to require reloading the page until a row's "Last run" changed.

        Several lanes at once is the normal case, not the exception: agents are triggered by
        schedules and by workflow steps as well as by people, so an ordinary afternoon has a
        handful running side by side. The strip renders nothing at all until the stream reports
        one, so a quiet workspace stays quiet.
      */}
      <LiveRunStrip
        events={[...runStream.byRun.values()]}
        agentNames={agentNames}
        live={runStream.live}
        onOpenAgent={(agentId) => setSelected(agents.find((entry) => entry.id === agentId) ?? null)}
      />

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
                    {/*
                      The name, with the pencil beside it.

                      It was offered only inside the detail drawer, which meant renaming an agent
                      took opening a card first — and nobody looking at a list of agents thinks to
                      open one to change the word in front of them. The authority is the same
                      wherever it is pressed; the server checks it either way.
                    */}
                    <span className="uboss-row-name">
                      <b>{row.name}</b>
                      {can(access, 'agent-builder', 'EditDraft') ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Rename ${row.name}`}
                          title={`Rename ${row.name}`}
                          onClick={(event) => {
                            // The row opens the drawer; this must not do both.
                            event.stopPropagation();
                            setSelected(row);
                            setNameDraft(row.name);
                            setRenaming(true);
                          }}
                        >
                          <Icon name="build" size={14} />
                        </Button>
                      ) : null}
                    </span>
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
                    tone={ENGINE_AGENT_STATUS_TONES[row.status]}
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
                key: 'tokens',
                header: 'Tokens',
                render: (row) =>
                  row.usage.hasData && row.usage.totalTokens !== null ? (
                    <span className="uboss-mono" title={row.usage.note}>
                      {row.usage.totalTokens.toLocaleString()}
                    </span>
                  ) : (
                    // Not a zero. An agent that has never run has consumed nothing to report,
                    // and a "0" would read as a measurement rather than as an absence.
                    <span className="uboss-muted-3">—</span>
                  ),
              },
              {
                key: 'open',
                header: '',
                render: (row) => (
                  /*
                   * `uboss-actions`, not `uboss-row-actions`.
                   *
                   * The second one is used in three other places and defined in no stylesheet —
                   * the class-coverage test lists it as known-unstyled. Two buttons under it sit
                   * against each other with no gap. This one is real: inline-flex, a gap,
                   * aligned.
                   */
                  <span className="uboss-actions">
                    {/*
                      Running the agent — the employee's whole involvement with AI work.

                      `RunAgentPanel` and the two routes behind it were built and then drawn
                      nowhere: there was no Run control anywhere in the product, so a published
                      agent could be looked at, scheduled and audited, but not started by the
                      person it was published for. The only way to run one was a schedule or a
                      workflow step, which is not what "Run" means on an operations screen.

                      Offered on the row rather than only inside the card, because starting a
                      known agent is the commonest thing done here and should not need two clicks
                      through a drawer of configuration the operator does not change.

                      `agents: Run` — the grant a standard Employee holds, and the one the server
                      checks again. Only an Active agent: the engine refuses anything else, and a
                      button that is always there and sometimes refuses teaches people to ignore
                      it.
                    */}
                    {can(access, 'agents', 'Run') && row.status === 'Active' ? (
                      <Button size="sm" variant="primary" onClick={() => setRunning(row)}>
                        <Icon name="bolt" size={15} />
                        Run
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setSelected(row)}>
                      View
                    </Button>
                  </span>
                ),
              },
            ]}
            emptyTitle="No Engine Agents yet"
            emptyDescription="An agent appears here once assigned AI work is activated in Agent Builder."
          />
        </CardBody>
      </Card>

      {/*
        Starting a run, and the few things it still has to be told.

        The panel asks the server which questions apply — they come from the agent's own published
        configuration, so an agent whose builder named a destination is not asked for one. A list
        decided here would be a second opinion about the same thing, and the server refuses a run
        with the answers missing using the very function that produced the questions.

        The run history on the card is reloaded afterwards, so a run that was just started appears
        where somebody will look for it rather than after the next manual refresh.
      */}
      {tenantId === null ? null : (
        <RunAgentPanel
          tenantId={tenantId}
          agent={running}
          onClose={() => setRunning(null)}
          onStarted={(message) => {
            setNotice(message);
            setError(null);
            // Reloads the list and, when one is open, the card — so the new run appears in both.
            reloadSelected();
          }}
        />
      )}

      {/* ---- Detail drawer: the reference's agentDetail(), as far as this prompt reaches ---- */}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        footer={
          <>
            <Button onClick={() => setSelected(null)}>Close</Button>
            {/*
              And here too, because somebody who opened the card to check what an agent does is
              then in the place where they decide to run it. Same grant, same rule about Active.
            */}
            {selected !== null && can(access, 'agents', 'Run') && selected.status === 'Active' ? (
              <Button variant="primary" onClick={() => setRunning(selected)}>
                <Icon name="bolt" size={16} />
                Run it
              </Button>
            ) : null}
          </>
        }
      >
        {selected === null ? null : (
          <>
            {/*
              The name, and the one control that changes it.

              At the head of the card because that is what somebody opened the card to look at,
              and because a rename is the one thing here that is not a version: every other change
              to an agent creates a draft, since the setup a past run used has to stay answerable.
              A label does not, so this writes the name and nothing else — and says so in the
              audit trail, with both names.

              Offered only to somebody who may decide what an agent is. Running one and naming one
              are different authorities, and the server checks the same thing again.
            */}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Name</span>
              <span className="uboss-kv-value">
                {renaming ? (
                  <span className="uboss-inline-edit">
                    <input
                      className="uboss-input"
                      value={nameDraft}
                      autoFocus
                      aria-label="Agent name"
                      onChange={(event) => setNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveName();
                        if (event.key === 'Escape') setRenaming(false);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || nameDraft.trim().length < 3}
                      title={
                        nameDraft.trim().length < 3
                          ? 'An agent needs a name of at least three characters.'
                          : undefined
                      }
                      onClick={saveName}
                    >
                      Save
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => setRenaming(false)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <span className="uboss-inline-edit">
                    {selected.name}
                    {can(access, 'agent-builder', 'EditDraft') ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Rename ${selected.name}`}
                        onClick={() => {
                          setNameDraft(selected.name);
                          setRenaming(true);
                        }}
                      >
                        <Icon name="build" size={15} />
                        Rename
                      </Button>
                    ) : null}
                  </span>
                )}
              </span>
            </div>

            <div className="uboss-kv">
              <span className="uboss-kv-key">Status</span>
              <span className="uboss-kv-value">
                <StatusBadge
                  tone={ENGINE_AGENT_STATUS_TONES[selected.status]}
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
            {/*
              When it runs, set here rather than described somewhere.

              The builder has always asked for a "Trigger / Frequency" in words, and those words
              were never read by anything: the scheduler reads a cron expression and nothing in
              the product wrote one, so an agent marked Scheduled simply never ran and nobody was
              told. This is the control that actually sets it.

              Days and a time, not an expression — the server turns that into the cron the engine
              reads, so the translation happens once, in one place, and a schedule this screen
              cannot draw is shown as its raw expression rather than quietly simplified.
            */}
            <div className="uboss-kv">
              <span className="uboss-kv-key">Runs</span>
              <span className="uboss-kv-value">
                {scheduling ? (
                  <span className="uboss-schedule-edit">
                    <span className="uboss-schedule-days">
                      {WEEKDAYS.map((day) => (
                        <label key={day} title={day}>
                          <input
                            type="checkbox"
                            checked={scheduleDays.includes(day)}
                            onChange={(event) =>
                              setScheduleDays((current) =>
                                event.target.checked
                                  ? [...current, day]
                                  : current.filter((entry) => entry !== day),
                              )
                            }
                          />
                          {day.slice(0, 2)}
                        </label>
                      ))}
                    </span>
                    <span className="uboss-schedule-time">
                      <input
                        className="uboss-input"
                        type="time"
                        value={scheduleTime}
                        aria-label="Time of day"
                        onChange={(event) => setScheduleTime(event.target.value)}
                      />
                    </span>
                    <span className="uboss-schedule-actions">
                      <Button size="sm" variant="primary" disabled={busy} onClick={saveSchedule}>
                        Save
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => setScheduling(false)}>
                        Cancel
                      </Button>
                      {selected.schedule === null ? null : (
                        <Button size="sm" variant="danger" disabled={busy} onClick={clearSchedule}>
                          Stop scheduling
                        </Button>
                      )}
                    </span>
                    <span className="uboss-field-hint">
                      No days ticked means every day. The company&rsquo;s working-day and holiday
                      rules still apply, so a run due on a closed day follows the missed-run policy
                      rather than firing anyway.
                    </span>
                  </span>
                ) : (
                  <span className="uboss-inline-edit">
                    {selected.scheduleExpression !== null ? (
                      <span className="uboss-mono">{selected.scheduleExpression}</span>
                    ) : (
                      (selected.scheduleOrTrigger ?? 'Not scheduled')
                    )}
                    {can(access, 'agents', 'Schedule') ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={selected.status === 'Archived'}
                        title={
                          selected.status === 'Archived'
                            ? 'An archived agent cannot be scheduled.'
                            : undefined
                        }
                        onClick={() => {
                          const current = selected.schedule;
                          setScheduleDays(current === null ? [] : [...current.weekdays]);
                          setScheduleTime(
                            current === null
                              ? '09:00'
                              : `${String(current.hour).padStart(2, '0')}:${String(current.minute).padStart(2, '0')}`,
                          );
                          setScheduling(true);
                        }}
                      >
                        <Icon name="clock" size={15} />
                        {selected.schedule === null ? 'Schedule' : 'Change'}
                      </Button>
                    ) : null}
                  </span>
                )}
              </span>
            </div>

            {selected.nextRunAt === null ? null : (
              <div className="uboss-kv">
                <span className="uboss-kv-key">Scheduler last looked</span>
                <span className="uboss-kv-value">
                  {new Date(selected.nextRunAt).toLocaleString()}
                </span>
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
              <EmptyState icon="bolt" title="No runs yet" description={selected.health.note} />
            ) : (
              runs.map((run) => (
                <div className="uboss-kv" key={run.id}>
                  <span className="uboss-kv-key">
                    {run.startedAt === null
                      ? 'Not started'
                      : new Date(run.startedAt).toLocaleString()}
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

            {/*
              Setting up an agent that no Objective configured -- PRD 5.1.

              An agent from the builder arrives with all of this decided: the Objective's analysis
              worked out when it runs, where the work happens, where the result goes and what to do
              when something is missing. One created here has none of it, which is why it sits in
              Draft setup and cannot run.

              These are the same five questions the builder asks, in the same vocabulary, and they
              go to the same endpoint. Saving them creates version 1 as a draft; activating it is
              the second, deliberate step, with the same approval rule every other version has.
              Nothing here skips a check the builder makes.
            */}
            {selected.status !== 'DraftSetup' ? null : (
              <>
                <div className="uboss-section-label">Set this agent up</div>
                <p className="uboss-muted-3">
                  It was created without an Objective, so nothing has decided how it runs. It cannot
                  do any work until these are answered and a version is activated.
                </p>

                <FormField label="When it runs" required>
                  {(wiring) => (
                    <select
                      {...wiring}
                      className="uboss-input"
                      value={setup.runType ?? ''}
                      onChange={(event) =>
                        setSetup({ ...setup, runType: event.target.value as AgentRunType })
                      }
                    >
                      <option value="">Choose…</option>
                      {AGENT_RUN_TYPES.map((kind) => (
                        <option key={kind} value={kind}>
                          {AGENT_RUN_TYPE_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>

                <FormField
                  label="What starts it, or how often"
                  hint="A trigger for event-based work, a frequency for scheduled work."
                >
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input"
                      maxLength={200}
                      value={setup.triggerOrFrequency ?? ''}
                      onChange={(event) =>
                        setSetup({ ...setup, triggerOrFrequency: event.target.value })
                      }
                      placeholder="Every Monday at 09:00"
                    />
                  )}
                </FormField>

                <FormField label="Where the work happens" required>
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input"
                      maxLength={200}
                      value={setup.whereWorkHappens ?? ''}
                      onChange={(event) =>
                        setSetup({ ...setup, whereWorkHappens: event.target.value })
                      }
                      placeholder="The finance shared drive"
                    />
                  )}
                </FormField>

                <FormField label="Where the result goes" required>
                  {(wiring) => (
                    <input
                      {...wiring}
                      className="uboss-input"
                      maxLength={200}
                      value={setup.outputDestination ?? ''}
                      onChange={(event) =>
                        setSetup({ ...setup, outputDestination: event.target.value })
                      }
                      placeholder="The weekly consolidation sheet"
                    />
                  )}
                </FormField>

                <FormField
                  label="When something it needs is missing"
                  required
                  hint="An agent that guesses at missing data is an agent that produces work nobody can trust."
                >
                  {(wiring) => (
                    <select
                      {...wiring}
                      className="uboss-input"
                      value={setup.missingDataBehaviour ?? ''}
                      onChange={(event) =>
                        setSetup({
                          ...setup,
                          missingDataBehaviour: event.target.value as MissingDataBehaviour,
                        })
                      }
                    >
                      <option value="">Choose…</option>
                      {MISSING_DATA_BEHAVIOURS.map((kind) => (
                        <option key={kind} value={kind}>
                          {MISSING_DATA_BEHAVIOUR_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>

                <Button
                  variant="primary"
                  size="sm"
                  disabled={
                    busy ||
                    tenantId === null ||
                    setup.runType === null ||
                    (setup.whereWorkHappens ?? '').trim() === '' ||
                    (setup.outputDestination ?? '').trim() === '' ||
                    setup.missingDataBehaviour === null
                  }
                  onClick={() => {
                    if (tenantId === null) return;
                    setBusy(true);
                    setError(null);
                    setNotice(null);
                    engineAgentsApi
                      .createVersion(tenantId, selected.id, { setup })
                      .then(() => {
                        setNotice(
                          'Version 1 saved as a draft. Activate it below when you are ready — ' +
                            'the agent does no work until you do.',
                        );
                        reloadSelected();
                      })
                      .catch((caught: unknown) =>
                        setError(
                          caught instanceof ApiError
                            ? caught.message
                            : 'That setup could not be saved.',
                        ),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Save setup
                </Button>
              </>
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

            {/*
              Activating a draft version -- the second half of PRD 5.1.

              A deliberate second step, never folded into Save setup. Activation is what makes an
              agent able to act on a company's behalf, and the approval rule that governs it is
              the same one every other version has: a version that widens what an agent can reach
              needs somebody else to agree, and the server refuses a self-approval.

              Offered only for a version that is still a draft. A published one is immutable, and
              a configuration change makes a new draft rather than editing it.
            */}
            {(() => {
              const draft = selected.versions.find((version) => version.status !== 'Published');
              if (draft === undefined) return null;
              return (
                <>
                  <div className="uboss-section-label">Activate</div>
                  <p className="uboss-muted-3">
                    v{draft.versionNumber} is saved and doing nothing.
                    {draft.approvalRequired
                      ? ' It widens what this agent can reach, so somebody other than you has to approve it first.'
                      : ' Activating it is what lets this agent work.'}
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || tenantId === null}
                    onClick={() => {
                      if (tenantId === null) return;
                      setBusy(true);
                      setError(null);
                      setNotice(null);
                      engineAgentsApi
                        .activateVersion(tenantId, selected.id, draft.id)
                        .then((updated) => {
                          setNotice(
                            `"${updated.name}" is now ${ENGINE_AGENT_STATUS_LABELS[updated.status]}.`,
                          );
                          reloadSelected(updated);
                        })
                        .catch((caught: unknown) =>
                          setError(
                            caught instanceof ApiError
                              ? caught.message
                              : 'That version could not be activated.',
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                  >
                    Activate v{draft.versionNumber}
                  </Button>
                </>
              );
            })()}

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
