'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  ENGINE_AGENT_STATUS_LABELS,
  ENGINE_AGENT_STATUS_TONES,
  WEEKDAYS,
  type AgentSchedule,
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
  Modal,
  PageHeader,
  FormField,
  SearchField,
  StatusBadge,
  type StatusTone,
  RunState,
  EmptyState,
} from '@uboss/ui';

import {
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

  /** The standalone create form -- PRD 5.1. */
  const [creating, setCreating] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: '', purpose: '' });

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
              Two ways to make an agent, because there are two ways companies need one -- PRD 5.1.

              **Build agent** goes to the Objective-driven builder, which is the normal path and
              the better one: the analysis decides the agent's skills, approvals and evidence from
              work that already exists, so what comes out is configured and active.

              **New agent** is for the case the client described: somebody has an agent in mind
              and no Objective to hang it on. Without this the only way through was to invent an
              Objective in order to reach the builder, which puts a fiction in the record of what
              the company is trying to do. It arrives in DraftSetup, because nothing has been
              decided for it yet.
            */}
            {can(access, 'agent-builder', 'Create') ? (
              <>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={16} />
                  New agent
                </Button>
                <Link href="/agent-builder">
                  <Button variant="primary" size="sm">
                    <Icon name="build" size={16} />
                    Build agent
                  </Button>
                </Link>
              </>
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
      {/*
        A new agent with no Objective behind it -- PRD 5.1.

        Two fields, and the second one is not a formality. This agent arrives with no skills, no
        tools, no approval rule and no evidence, because nothing has analysed any work for it. The
        sentence somebody writes is the only record of why it exists, and it is what the next
        person reads when they find it sitting in Draft setup weeks later.

        It is created in Draft setup, not active. Saying otherwise would be a row claiming to run
        work it has not been given.
      */}
      <Modal
        open={creating}
        title="New agent"
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={
                busy ||
                tenantId === null ||
                newAgent.name.trim().length < 3 ||
                newAgent.purpose.trim().length < 10
              }
              onClick={() => {
                if (tenantId === null) return;
                setBusy(true);
                setError(null);
                setNotice(null);
                engineAgentsApi
                  .createStandalone(tenantId, {
                    name: newAgent.name.trim(),
                    purpose: newAgent.purpose.trim(),
                  })
                  .then((created) => {
                    setCreating(false);
                    setNewAgent({ name: '', purpose: '' });
                    setNotice(
                      `"${created.name}" was created in Draft setup. It has no skills or approval ` +
                        'rule yet, so it cannot run until somebody configures it.',
                    );
                    load();
                  })
                  .catch((caught: unknown) =>
                    setError(
                      caught instanceof ApiError
                        ? caught.message
                        : 'That agent could not be created.',
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Creating…' : 'Create agent'}
            </Button>
          </>
        }
      >
        <FormField
          label="Name"
          required
          hint="How people will refer to it. Unique in this company."
        >
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={newAgent.name}
              maxLength={200}
              onChange={(event) => setNewAgent({ ...newAgent, name: event.target.value })}
              placeholder="Weekly branch reconciliation"
            />
          )}
        </FormField>

        <FormField
          label="What is it for"
          required
          hint="One or two sentences. This is the only record of why it was created."
        >
          {(wiring) => (
            <textarea
              {...wiring}
              className="uboss-input"
              rows={3}
              maxLength={2000}
              value={newAgent.purpose}
              onChange={(event) => setNewAgent({ ...newAgent, purpose: event.target.value })}
              placeholder="Reconciles the branch cash submissions each Monday and reports the mismatches."
            />
          )}
        </FormField>

        <p className="uboss-muted-3">
          It is created in <b>Draft setup</b>. An agent built from an Objective arrives configured
          and active because the analysis decided its skills and approvals; this one has none of
          that yet, so it cannot run until somebody gives it some.
        </p>
      </Modal>
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ''}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
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
