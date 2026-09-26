'use client';

import { motion } from 'motion/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  StatusBadge,
  transition,
} from '@uboss/ui';

import {
  jobMethodApi,
  agentBuilderApi,
  type AgentBuilderMetaView,
  type AgentBuilderView,
  type AgentExecutionSetupView,
  ApiError,
  authApi,
  type MeResponse,
  organizationApi,
} from '../../lib/api-client';
import { useJustBecameTrue } from '../../lib/use-just-became-true';
import { useAccountMenu } from '../../lib/use-account-menu';
import { useSignedInUser } from '../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { useNotificationBell } from '../../lib/use-notification-bell';
import {
  AGENT_TEST_EXPECTATION_NOTE,
  AGENT_TEST_STATUS_LABELS,
  AGENT_TEST_STATUS_TONES,
  agentTestProblems,
  FIELD_SOURCE_LABELS,
  FORM3_FIELD_SOURCE,
  FORM3_JOB_LEVEL_FIELDS,
  type FieldSource,
  type JobMethodRow,
} from '@uboss/types';

import { AgentObjectiveList } from '../../components/AgentObjectiveList';
import {
  blankJobMethodRow,
  JOB_METHOD_COLUMNS,
  JobMethodGrid,
} from '../../components/JobMethodGrid';
import { JobMethodImportExport } from '../../components/JobMethodImportExport';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { can, useMyAccess } from '../../lib/use-my-access';

/**
 * Agent Builder — the reference's `agentBuilder()`.
 *
 * Its layout: a `1fr 320px` grid. Left is a card carrying the "Ready to test" banner, the
 * "Inherited from objective (read-only)" list and "Missing setup (only what's needed)". Right is
 * the Readiness card with *Test agent* and *Activate agent*.
 *
 * ## The screen's whole job is to ask as little as possible
 *
 * The ZERO-QUESTION RULE is answered by the server, not decided here: `missing` arrives already
 * computed, and this page renders exactly those controls. When it is empty the page says so and
 * offers Test / Activate, which is the client's requirement — "show Ready to Test / Activate and
 * ask nothing extra". The employee never re-enters the job method.
 *
 * ## What it deliberately does not show
 *
 * No credential, ever. A connection is chosen by identity and the server judges it; there is no
 * field here that could hold a key. The prototype's own "Destination Monday board" select is
 * rendered from the company's real answer rather than a hard-coded option, and the prototype's
 * invented cost figure is not carried forward.
 */
function AgentBuilderInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const myAccess = useMyAccess();
  // CR-03 §5 asks the import review to name the assigned employee, and the builder view carries
  // only an id. Resolved from the hierarchy, which every role that can open this screen may read.
  const [people, setPeople] = useState<Record<string, string>>({});
  const params = useSearchParams();
  const assignmentId = params.get('assignmentId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [meta, setMeta] = useState<AgentBuilderMetaView | null>(null);
  const [assignments, setAssignments] = useState<AgentBuilderView[]>([]);
  const [selected, setSelected] = useState<AgentBuilderView | null>(null);

  /**
   * Which objective's agents are being looked at.
   *
   * Separate from `selected`: closing an agent should put somebody back in the objective they
   * opened it from, not at the top of the list. Those are two different places and one piece of
   * state cannot be both.
   */
  const [openObjectiveId, setOpenObjectiveId] = useState<string | null>(null);

  /**
   * The job method's steps, as the grid holds them.
   *
   * Loaded per assignment and owned here, the way the Objective form owns its workflow rows: the
   * grid does the editing and the page does the saving, so one place knows whether anything is
   * unsaved.
   */
  const [methodRows, setMethodRows] = useState<JobMethodRow[]>([]);
  const [methodDirty, setMethodDirty] = useState(false);
  const [methodExpanded, setMethodExpanded] = useState(false);

  /**
   * The overview, composed from the four records that already answer it.
   *
   * Read rather than assembled here: Form 3 is the product's own answer to "what is already known
   * about this job", and building a second answer on this screen would be a second thing to keep
   * true. Null until it arrives, and null for an assignment that has no composed view yet.
   */
  const [overview, setOverview] = useState<Record<string, string | null> | null>(null);

  /*
   * Readiness changes while you are looking elsewhere on this screen — a connection is resolved in
   * another panel, the readiness answer comes back, and a control that was dead is live. These
   * report the moment it happens so the control can say so, and they are false on mount: a cue on
   * arrival would announce something that did not just occur.
   */
  const [testJustOpened, clearTestCue] = useJustBecameTrue(selected?.readiness.readyToTest ?? false);

  /*
   * What the test runs against.
   *
   * Held on the screen rather than saved with the draft. A sample is something somebody types to
   * try one thing; persisting it would make the next person think it was part of the agent's
   * configuration, and it is not — the agent is configured above, and this is what you throw at
   * it to see what happens.
   */
  const [sampleInput, setSampleInput] = useState('');
  const [expectedOutcome, setExpectedOutcome] = useState('');
  const testProblems = agentTestProblems({ sampleInput, expectedOutcome });

  // Newest first from the server, so the head is the run somebody just watched happen.
  const latestTest = selected?.testHistory[0] ?? null;
  const earlierTests = selected?.testHistory.slice(1) ?? [];
  const [activateJustOpened, clearActivateCue] = useJustBecameTrue(
    selected?.readiness.readyToActivate ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  /**
   * The load was refused, as opposed to having failed.
   *
   * Kept apart from `error` because the screen answers them differently. A failure leaves the
   * builder on screen — reloading may well work. A refusal is the whole answer, and everything
   * below it would be describing work this person is not allowed to know about.
   */
  const [refused, setRefused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

    void agentBuilderApi
      .meta(tenantId)
      .then(setMeta)
      .catch(() => undefined);

    void agentBuilderApi
      .list(tenantId)
      .then((result) => {
        setAssignments(result.assignments);
        /*
         * Nothing opens itself.
         *
         * This used to fall back to the first assignment, so arriving at Agent Builder dropped
         * somebody straight into a form for work they had not chosen — and the objective cards,
         * which are the way in, were never seen. A URL that names an assignment still opens it,
         * because that is somebody asking for it by name.
         */
        setSelected(
          assignmentId === null
            ? null
            : (result.assignments.find((entry) => entry.assignmentId === assignmentId) ?? null),
        );
      })
      .catch((caught: unknown) => {
        setRefused(caught instanceof ApiError && caught.statusCode === 403);
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load your assigned AI work.',
        );
      });
  }, [assignmentId, tenantId]);

  useEffect(load, [load]);

  useEffect(() => {
    if (tenantId === null) return;
    void organizationApi
      .hierarchy(tenantId)
      .then((view) => {
        const byId: Record<string, string> = {};
        for (const row of view.list) byId[row.userId] = row.displayName;
        setPeople(byId);
      })
      // A name that will not load shows as a dash rather than as an error: the import still
      // works, and the review still names the objective it landed in.
      .catch(() => undefined);
  }, [tenantId]);

  /** Every mutation funnels through here, so the busy flag and error handling are never skipped. */
  const run = useCallback(
    (work: (tenantId: string, assignmentId: string) => Promise<AgentBuilderView>) => () => {
      if (!tenantId || selected === null) return;
      setBusy(true);
      setError(null);
      setNotice(null);

      void work(tenantId, selected.assignmentId)
        .then((updated) => {
          setSelected(updated);
          setAssignments((current) =>
            current.map((entry) => (entry.assignmentId === updated.assignmentId ? updated : entry)),
          );
          setBusy(false);
        })
        .catch((caught: unknown) => {
          setError(caught instanceof ApiError ? caught.message : 'That did not work.');
          setBusy(false);
        });
    },
    [selected, tenantId],
  );

  const save = (patch: Partial<AgentExecutionSetupView>) =>
    run((tenant, assignment) => agentBuilderApi.saveSetup(tenant, assignment, patch))();

  /** One control per remaining question, in the order the server reported them. */
  /**
   * One field of the Agent form, read-only because the objective already answered it.
   *
   * Drawn in the same markup as an editable one — same label, same box, same row — because the
   * point of the form is that somebody can read the whole configuration in one place. Greying out
   * a value is how you say "this is settled"; hiding it is how you make somebody go and look for
   * it somewhere else.
   */
  const inherited = (
    id: string,
    label: string,
    value: string,
    source: FieldSource,
    required = false,
  ) => (
    <div className="uboss-field" key={id}>
      <label htmlFor={id}>
        {label} {required ? <span className="uboss-field-required">*</span> : null}
        <span className={`uboss-srcchip uboss-srcchip--${source.toLowerCase()}`}>
          {FIELD_SOURCE_LABELS[source]}
        </span>
      </label>
      <input id={id} value={value} readOnly />

    </div>
  );

  /*
   * The job method's steps follow whichever assignment is open.
   *
   * Refetched rather than carried on the builder view, because the two are edited by different
   * people at different times: the setup is the builder's, and the steps are often filled in by
   * whoever actually does the work, through the downloaded form. Reading them here means the grid
   * shows what the last upload left, not what the page happened to be holding.
   */
  useEffect(() => {
    if (tenantId === null || selected === null) {
      setMethodRows([]);
      setMethodDirty(false);
      setOverview(null);
      return;
    }

    let current = true;

    void agentBuilderApi
      .form3(tenantId, selected.assignmentId)
      .then((view) => {
        if (current) setOverview(view.jobLevel as Record<string, string | null>);
      })
      // A person who may build but not read the canonical view simply gets the fields the builder
      // already carries. Not an error worth a banner on a screen that still works.
      .catch(() => {
        if (current) setOverview(null);
      });

    void jobMethodApi
      .view(tenantId, selected.assignmentId)
      .then((view) => {
        if (!current) return;
        /*
         * Read as rows, and numbered here rather than trusted.
         *
         * The view serves them as loose records, so a row is only a `JobMethodRow` once it has a
         * step number. Renumbering on the way in also means the grid always opens with 1..n in
         * order, whatever gaps a previous import left behind.
         */
        const read = (view.rows ?? []) as Record<string, unknown>[];
        /*
         * One blank step when there is nothing yet, exactly as the Objective form does.
         *
         * A grid with a header and no rows is a spreadsheet with nowhere to type: the first thing
         * somebody has to do is find the Add button before they can start. The Objective form
         * opens on row 1 for the same reason.
         */
        setMethodRows(
          read.length === 0
            ? [blankJobMethodRow(1)]
            : read.map((row, index) => ({ ...row, step: index + 1 }) as JobMethodRow),
        );
        setMethodDirty(false);
      })
      .catch(() => {
        if (!current) return;
        // No method captured yet is the ordinary case for a new assignment, not an error worth a
        // banner. It opens on a blank first step, the way the Objective form does.
        setMethodRows([blankJobMethodRow(1)]);
        setMethodDirty(false);
      });

    return () => {
      current = false;
    };
  }, [selected, tenantId]);

  /** Save the grid. The whole method, because that is what the grid is. */
  const saveMethod = useCallback(() => {
    if (tenantId === null || selected === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    void jobMethodApi
      .saveRows(tenantId, selected.assignmentId, methodRows)
      .then((result) => {
        setMethodDirty(false);
        setNotice(result.note);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Those steps could not be saved.'),
      )
      .finally(() => setBusy(false));
  }, [methodRows, selected, tenantId]);

  const controlFor = (field: keyof AgentExecutionSetupView, label: string, why: string) => {
    if (selected === null) return null;

    if (field === 'runType') {
      return (
        <div className="uboss-field" key={field}>
          <label htmlFor={field}>{label}</label>
          <select
            id={field}
            defaultValue=""
            disabled={busy}
            onChange={(event) =>
              save({ runType: event.target.value as AgentExecutionSetupView['runType'] })
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {(meta?.runTypes ?? []).map((entry) => (
              <option key={entry.runType} value={entry.runType}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className="uboss-field-hint">{why}</span>
        </div>
      );
    }

    if (field === 'missingDataBehaviour') {
      return (
        <div className="uboss-field" key={field}>
          <label htmlFor={field}>{label}</label>
          <select
            id={field}
            defaultValue=""
            disabled={busy}
            onChange={(event) =>
              save({
                missingDataBehaviour: event.target
                  .value as AgentExecutionSetupView['missingDataBehaviour'],
              })
            }
          >
            <option value="" disabled>
              Choose…
            </option>
            {(meta?.missingDataBehaviours ?? []).map((entry) => (
              <option key={entry.behaviour} value={entry.behaviour}>
                {entry.label}
              </option>
            ))}
          </select>
          <span className="uboss-field-hint">{why}</span>
        </div>
      );
    }

    // The remaining questions are free text, including the connection id. A picker over the
    // company's approved connections belongs to the connections module's own list; until this
    // screen reads it, an id typed here is still validated by the server against the company's
    // grants, so a wrong one is refused rather than accepted.
    return (
      <div className="uboss-field" key={field}>
        <label htmlFor={field}>{label}</label>
        <input
          id={field}
          defaultValue=""
          disabled={busy}
          onBlur={(event) => {
            if (event.target.value.trim() !== '') {
              save({ [field]: event.target.value } as Partial<AgentExecutionSetupView>);
            }
          }}
        />
        <span className="uboss-field-hint">{why}</span>
      </div>
    );
  };

  const assignedToLabel =
    selected?.prefill.ownerUserId == null ? null : (people[selected.prefill.ownerUserId] ?? null);
  const askingNothing = selected !== null && selected.missing.length === 0;

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="agent-builder"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      {/*
        The actions, at the top.

        The client's rule is that the important actions are visible rather than tucked into a side
        area, so Test and Activate live here and the Readiness card beside the form keeps only the
        reasons — which is the half of it that is genuinely reference material. They are not drawn
        in both places: one button that can be disabled with a reason beats two that disagree.
      */}
      <PageHeader
        title="Agent Builder"
        description="Ask only for missing execution setup — never re-enter the whole method."
        breadcrumbs={[{ label: 'Engine Agent' }, { label: 'Builder' }]}
        actions={
          selected === null ? null : selected.engineAgent !== null ? (
            <Button size="sm" onClick={() => setSelected(null)}>
              <Icon name="back" size={16} />
              This objective
            </Button>
          ) : (
            <>
              {/*
                Back first, because leaving is the one action that is always available.

                The approved reference puts it here for the same reason: once the list is replaced
                by the form, there has to be a way back to it that does not depend on the form
                being in any particular state.
              */}
              <Button size="sm" onClick={() => setSelected(null)}>
                <Icon name="back" size={16} />
                This objective
              </Button>
              {/*
                Save Draft first, because it is the one that loses work if it is missed.

                The other two are gated on readiness and say why they are disabled; this one is
                always available and always means the same thing — what is on screen is stored.
              */}
              {/*
                Download and upload sit with the other actions, as they do on the Objective form.

                Taking the form away to be filled in is something somebody does *instead* of
                typing, so it belongs where they look before they start — not in a card below the
                grid they have already finished filling by hand.
              */}
              {tenantId === null ? null : (
                <JobMethodImportExport
                  tenantId={tenantId}
                  assignmentId={selected.assignmentId}
                  assignmentTitle={selected.prefill.assignedWork}
                  objectiveName={selected.prefill.objectiveName}
                  assignedToLabel={assignedToLabel}
                  canImport={can(myAccess, 'agent-builder', 'EditDraft')}
                  compact
                  onImported={() => void load()}
                />
              )}
              <Button
                size="sm"
                disabled={busy || !methodDirty}
                title={methodDirty ? undefined : 'Nothing has changed'}
                onClick={saveMethod}
              >
                Save Draft
              </Button>
              <span
                className={testJustOpened ? 'uboss-just-enabled' : undefined}
                onAnimationEnd={clearTestCue}
              >
                <Button
                  size="sm"
                  disabled={busy || !selected.readiness.readyToTest || testProblems.length > 0}
                  title={
                    !selected.readiness.readyToTest
                      ? 'Answer the remaining setup first — the Readiness panel lists it.'
                      : // The same sentence the Test section shows, so a disabled button is never
                        // a mystery to somebody who has not scrolled to it yet.
                        (testProblems[0] ?? undefined)
                  }
                  onClick={run((tenant, assignment) =>
                    agentBuilderApi.test(tenant, assignment, sampleInput, expectedOutcome),
                  )}
                >
                  <Icon name="bolt" size={16} />
                  Test agent
                </Button>
              </span>
              <span
                className={activateJustOpened ? 'uboss-just-enabled' : undefined}
                onAnimationEnd={clearActivateCue}
              >
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || !selected.readiness.readyToActivate}
                  title={
                    selected.readiness.readyToActivate
                      ? undefined
                      : 'A passing test and complete setup come first.'
                  }
                  onClick={run((tenant, assignment) =>
                    agentBuilderApi.activate(tenant, assignment),
                  )}
                >
                  Publish agent
                </Button>
              </span>
            </>
          )
        }
      />

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {notice === null ? null : <Banner tone="ok">{notice}</Banner>}

      {/*
        "Nothing here" is only said when it is true.

        Found in a browser proof: somebody without the grant who typed the URL got the refusal and
        then the whole builder underneath it — the filter chips, and an empty list reading "No
        objective needs an agent". Two messages, and the louder one was false: it describes a
        company with no AI work, when the truth is that this person may not see any.
      */}
      {!refused && assignments.length === 0 ? (
        <Card>
          <CardBody>
            <p className="uboss-muted">
              You have no assigned AI work awaiting setup. Work appears here once a manager approves
              and assigns an objective&apos;s workflow.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {/*
        Agent Builder, organised by objective.

        The client's rule, and the reason the flat table went: somebody arrives from an objective
        they have just defined, and the first question they have is which objectives still need
        agents. A list of unrelated AI work items cannot answer that — four rows saying "needs
        setup" might be one objective or four.
      */}
      {refused ? null : selected === null ? (
        <AgentObjectiveList
          assignments={assignments}
          openObjectiveId={openObjectiveId}
          onOpenObjective={setOpenObjectiveId}
          onOpenAgent={(assignment) => setSelected(assignment)}
        />
      ) : null}


      {/*
        Full width, one column, in the Objective form's own rhythm.

        This used to be a `1fr 320px` grid, which squeezed the overview into a half-width column
        and put a twelve-column spreadsheet in a 320px rail beside it. The Objective form is the
        page it is meant to continue from, and that form is the whole width: actions, then fields,
        then the grid underneath. Reading the two side by side is what makes this feel like one
        product rather than two.
      */}
      {selected === null ? null : (
        <>
          <Card>
            <CardBody>
              {selected.engineAgent !== null ? (
                <Banner tone="ok">
                  Active as <b>{selected.engineAgent.name}</b> (version{' '}
                  {selected.engineAgent.versionNumber}). Recurring work creates Runs on this agent —
                  never another agent.
                </Banner>
              ) : askingNothing ? (
                <Banner tone="ok">
                  Ready to test. Only missing execution setup is requested — the job method is
                  inherited from the objective.
                </Banner>
              ) : (
                <Banner tone="info">
                  {/* Keyed by the count, so answering one is a change you can see rather than a
                      digit that was different the next time you looked. */}
                  <motion.span
                    key={selected.missing.length}
                    initial={{ opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={transition('small', 'enter')}
                    style={{ display: 'inline-block' }}
                  >
                    {selected.missing.length} question
                    {selected.missing.length === 1 ? '' : 's'} left.
                  </motion.span>{' '}
                  Everything else is inherited from the objective and policy.
                </Banner>
              )}

              {/*
                A — Skill / Job Overview.

                The approved reference's own section, and its own rule: every field here is already
                answered by the objective, the workflow, the hierarchy or policy, so none of it is
                re-typed. The chip beside each label says which of those four decided it — without
                that, a greyed box reads as the product refusing to let you type rather than as a
                question somebody already answered.

                The gaps come after, as real controls, because a gap is the only thing on this
                screen that is genuinely somebody's to fill.
              */}
              <div className="uboss-af-h">
                <span className="uboss-tag">A</span> Skill / Job Overview
                <span className="uboss-muted-3">
                  prefilled from Objective · Workflow · Hierarchy · Policy — edit where allowed
                </span>
              </div>

              {overview === null ? (
                <div className="uboss-row-2">
                  {inherited(
                    'agentName',
                    'Skill / Agent Name',
                    selected.engineAgent?.name ?? selected.prefill.suggestedAgentName,
                    'Objective',
                    true,
                  )}
                  {inherited(
                    'agentObjective',
                    'Objective',
                    `${selected.prefill.objectiveCode} · ${selected.prefill.objectiveName}`,
                    'Objective',
                    true,
                  )}
                </div>
              ) : (
                /*
                 * Two to a row, in the order the document lists them.
                 *
                 * Paired by position rather than by meaning: the source document's order is what a
                 * reader is matching this against, and regrouping it into tidier pairs would make
                 * that diff harder for no gain.
                 */
                Array.from(
                  { length: Math.ceil(FORM3_JOB_LEVEL_FIELDS.length / 2) },
                  (unused, row) => FORM3_JOB_LEVEL_FIELDS.slice(row * 2, row * 2 + 2),
                ).map((pair) => (
                  <div className="uboss-row-2" key={pair[0]?.key ?? 'row'}>
                    {pair.map((field) =>
                      inherited(
                        field.key,
                        field.label,
                        overview[field.key] ?? '',
                        FORM3_FIELD_SOURCE[field.key],
                        field.required,
                      ),
                    )}
                  </div>
                ))
              )}

              {selected.engineAgent !== null ? null : (
                <>
                  {askingNothing ? null : (
                    <>
                      <div className="uboss-section-label">
                        What the objective did not answer
                      </div>
                      {selected.missing.map((entry) =>
                        controlFor(entry.field, entry.label, entry.why),
                      )}
                    </>
                  )}
                </>
              )}

              <p className="uboss-notice-min">
                <Icon name="shield" size={13} />
                Zero-question rule: everything above is already known, so nothing is re-entered.
                Your input is the Job Method below.
              </p>
            </CardBody>
          </Card>


        {selected === null || tenantId === null ? null : (
          <>
            {/*
              The Objective form's own grid header, for the same reason it has one there.

              A toolbar outside the card rather than a heading inside it: the grid is the widest
              thing on the page and its controls belong beside its title, not indented within a
              card that then has to be as wide as the grid anyway.
            */}
            <div className="uboss-wfg-toolbar">
              <div className="uboss-section-label" style={{ margin: 0, border: 0 }}>
                Job method (source grid — {JOB_METHOD_COLUMNS.length} columns)
              </div>
              <div className="uboss-wfg-toolbar-actions">
                {/*
                  A toggle, and it says which way it is about to go. It stays enabled for a reader:
                  reading a long cell is the one thing somebody without edit rights most needs.
                */}
                <Button
                  size="sm"
                  aria-pressed={methodExpanded}
                  onClick={() => setMethodExpanded((current) => !current)}
                >
                  {methodExpanded ? 'Collapse long text' : 'Expand long text'}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !methodDirty}
                  title={methodDirty ? undefined : 'Nothing has changed'}
                  onClick={saveMethod}
                >
                  Save steps
                </Button>
              </div>
            </div>

            <Card>
              <CardBody>
                <JobMethodGrid
                  rows={methodRows}
                  onChange={(rows) => {
                    setMethodRows(rows);
                    setMethodDirty(true);
                  }}
                  readOnly={!can(myAccess, 'agent-builder', 'EditDraft')}
                  expanded={methodExpanded}
                />
              </CardBody>
            </Card>
          </>
        )}


      {/*
        The test, between the form and the readiness checklist.

        Directly under what it tests and directly above the reasons it might refuse to run, which
        is the order somebody moves through: configure, try, find out why not.
      */}
      <Card>
        <CardBody>
          <div className="uboss-section-label" style={{ marginTop: 0 }}>
            Test
          </div>

          <label className="uboss-field">
            <span className="uboss-field-label">Test input *</span>
            <textarea
              className="uboss-input"
              rows={4}
              value={sampleInput}
              placeholder="Paste a real example of what this agent will receive."
              onChange={(event) => setSampleInput(event.target.value)}
            />
          </label>

          <label className="uboss-field">
            <span className="uboss-field-label">What you expect</span>
            <textarea
              className="uboss-input"
              rows={3}
              value={expectedOutcome}
              placeholder="Optional. Describe the answer you are hoping for."
              onChange={(event) => setExpectedOutcome(event.target.value)}
            />
            <span className="uboss-field-note">{AGENT_TEST_EXPECTATION_NOTE}</span>
          </label>

          {testProblems.length > 0 && sampleInput.trim() !== '' ? (
            <Banner tone="warn">{testProblems.join(' ')}</Banner>
          ) : null}

          {/*
            The result, below the form.

            The newest run in full — what went in, what came back, and what it cost in time — so
            the comparison the admin is actually making does not need two screens.
          */}
          {latestTest === null ? (
            <p className="uboss-muted-3" style={{ marginTop: 12 }}>
              Not tested yet. Give it something to work on and press Test agent.
            </p>
          ) : (
            <div className="uboss-test-result">
              <div className="uboss-kv">
                <span className="uboss-kv-key">Result</span>
                <span className="uboss-kv-value">
                  <StatusBadge
                    tone={
                      AGENT_TEST_STATUS_TONES[latestTest.status] === 'ok'
                        ? 'success'
                        : AGENT_TEST_STATUS_TONES[latestTest.status] === 'warn'
                          ? 'warn'
                          : 'danger'
                    }
                    status={AGENT_TEST_STATUS_LABELS[latestTest.status]}
                  />{' '}
                  <span className="uboss-muted-3">
                    {latestTest.durationMs} ms
                    {latestTest.capability === null ? '' : ` · ${latestTest.capability}`}
                    {latestTest.wasReal ? '' : ' · mock gateway'}
                  </span>
                </span>
              </div>

              <div className="uboss-test-pane">
                <span className="uboss-test-pane-label">Input</span>
                <pre className="uboss-pre">{latestTest.sampleInput}</pre>
              </div>

              {latestTest.expectedOutcome === null ? null : (
                <div className="uboss-test-pane">
                  <span className="uboss-test-pane-label">Expected</span>
                  <pre className="uboss-pre">{latestTest.expectedOutcome}</pre>
                </div>
              )}

              <div className="uboss-test-pane">
                <span className="uboss-test-pane-label">Output</span>
                {latestTest.output === null ? (
                  <p className="uboss-muted-3">Nothing came back.</p>
                ) : (
                  <pre className="uboss-pre">{latestTest.output}</pre>
                )}
              </div>

              {latestTest.warnings.map((warning) => (
                <Banner key={warning} tone="warn">
                  {warning}
                </Banner>
              ))}
              {latestTest.errors.map((problem) => (
                <Banner key={problem} tone="danger">
                  {problem}
                </Banner>
              ))}
            </div>
          )}

          {/*
            Everything before it.

            Publishing is a decision made by comparing attempts — "the last one dropped the tax
            line, this one keeps it" — and that comparison is impossible if each test erases the
            one before, which is what this screen used to do.
          */}
          {earlierTests.length === 0 ? null : (
            <>
              <div className="uboss-section-label">Earlier tests</div>
              <ul className="uboss-test-history">
                {earlierTests.map((entry) => (
                  <li key={entry.id}>
                    <StatusBadge
                      tone={
                        AGENT_TEST_STATUS_TONES[entry.status] === 'ok'
                          ? 'success'
                          : AGENT_TEST_STATUS_TONES[entry.status] === 'warn'
                            ? 'warn'
                            : 'danger'
                      }
                      status={AGENT_TEST_STATUS_LABELS[entry.status]}
                    />
                    <span className="uboss-muted-3">
                      {new Date(entry.at).toLocaleString()}
                      {entry.ranByName === null ? '' : ` · ${entry.ranByName}`}
                      {` · ${entry.durationMs} ms`}
                      {entry.wasReal ? '' : ' · mock'}
                    </span>
                    <span className="uboss-test-history-line">
                      {entry.output ?? entry.errors[0] ?? 'Nothing came back.'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      {/*
        Readiness, under the form rather than beside it.

        It is a checklist of reasons, read once when something is disabled and ignored the rest of
        the time — which is exactly the thing that should not take a third of the width away from
        the grid somebody is working in.
      */}
      <Card>
        <CardBody>
          <div className="uboss-section-label" style={{ marginTop: 0 }}>
            Readiness
          </div>

          <div className="uboss-kv">
            <span className="uboss-kv-key">Connection</span>
            <span className="uboss-kv-value">
              {selected.readiness.connection === null ? (
                <span className="uboss-muted-3">
                  {selected.needsConnection ? 'Not chosen' : 'Not needed'}
                </span>
              ) : (
                <StatusBadge
                  tone={
                    selected.readiness.connection.state === 'Connected' ? 'success' : 'warn'
                  }
                  status={selected.readiness.connection.state}
                />
              )}
            </span>
          </div>
          <div className="uboss-kv">
            <span className="uboss-kv-key">Schedule</span>
            <span className="uboss-kv-value">
              {selected.setup.triggerOrFrequency ??
                (selected.setup.runType === null ? '—' : 'Not required')}
            </span>
          </div>

          {selected.lastTest.at === null ? (
            <p className="uboss-notice-min">
              <Icon name="alert" size={14} />
              Not tested yet.
            </p>
          ) : (
            <>
              <div className="uboss-kv">
                <span className="uboss-kv-key">Last test</span>
                <span className="uboss-kv-value">
                  <StatusBadge
                    tone={selected.lastTest.passed ? 'success' : 'danger'}
                    status={selected.lastTest.passed ? 'Passed' : 'Failed'}
                  />
                </span>
              </div>
              {/* Never presented as a real provider result when it was not one. */}
              <p className="uboss-notice-min">
                <Icon name="shield" size={14} />
                {selected.lastTest.wasReal
                  ? 'Ran against a live model provider.'
                  : 'Ran against the built-in mock model, not a live provider.'}{' '}
                {selected.lastTest.summary}
              </p>
            </>
          )}

          {selected.readiness.findings.length > 0 ? (
            <>
              <div className="uboss-section-label">What is standing in the way</div>
              {selected.readiness.findings.map((finding) => (
                /*
                 * Keyed by what it says, not by its index, so resolving the first blocker does
                 * not rewrite the text of the second. `layout` closes the gap the resolved one
                 * left, which is what makes progress visible.
                 *
                 * The item itself is not animated out. It would stay in the accessibility tree
                 * while it left, reading out a blocker that no longer applies — the same
                 * reason a deleted workflow row goes immediately.
                 */
                <motion.p
                  className="uboss-notice-min uboss-readiness-finding"
                  key={finding.summary}
                  layout
                  transition={transition('panel', 'standard')}
                >
                  <Icon name={finding.severity === 'Blocker' ? 'shield' : 'alert'} size={14} />
                  {finding.summary}
                </motion.p>
              ))}
            </>
          ) : null}

          {selected.engineAgent === null ? (
            // The buttons for these are in the header. What stays here is the checklist above,
            // which is the reason a button is or is not enabled.
            null
          ) : (
            <p className="uboss-notice-min">
              <Icon name="bot" size={14} />
              This work runs on a reusable Engine Agent. Changing how it runs is a new version
              of that agent, not an edit here.
            </p>
          )}

          <p className="uboss-notice-min">
            <Icon name="key" size={14} />A connection is chosen by identity. No credential is
            ever shown on this screen.
          </p>
        </CardBody>
      </Card>

        </>
      )}



    </RoutedAppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function AgentBuilderPage() {
  return (
    <Suspense fallback={null}>
      <AgentBuilderInner />
    </Suspense>
  );
}
