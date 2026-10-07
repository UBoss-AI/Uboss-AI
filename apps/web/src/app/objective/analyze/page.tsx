'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import {
  ANALYSIS_RUN_STATUS_TONES,
  EXECUTION_STAGE_LABELS,
  executionDepths,
  executionStages,
  TIME_UNIT_LABELS,
  type AnalysisNode,
  type ExecutionStage,
} from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  Icon,
  PageHeader,
  ProgressStep,
  StatusBadge,
  type ProgressStepItem,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  objectivesApi,
  organizationApi,
  type AnalysisRunView,
  type MeResponse,
  type ObjectiveView,
} from '../../../lib/api-client';
import { useAccountMenu } from '../../../lib/use-account-menu';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

interface GapGroup {
  key: string;
  summary: string;
  count: number;
  /** The step numbers this covers, so a reader can go straight to them. */
  steps: number[];
  /** Who was named, for the group that is about unmatched names. Empty otherwise. */
  subjects: string[];
  examples: string[];
}

/**
 * The analysis's gaps, gathered by what is actually wrong.
 *
 * ## Why this is grouping and not filtering
 *
 * Every gap is kept — an analysis that hid what it could not do would look complete and be wrong,
 * and that rule has not changed. What changed is that a 25-step objective produces 25 of them, and
 * printed flat they are a wall of sentences differing by one number. The reader's question is not
 * "which steps" but "what do I have to go and do", and there were only ever two answers in that
 * wall: fill in the names, or put those people in the owner's team.
 *
 * ## Why the shapes are matched rather than a kind being read off the gap
 *
 * Gaps are free text produced by the service; they carry no kind. Matching the two sentences it
 * actually writes is narrow on purpose — anything else falls through to its own group and is shown
 * whole, so a gap this does not recognise is never swallowed. If the service ever grows a kind
 * field, this should read it instead.
 */
function groupGaps(gaps: readonly string[]): GapGroup[] {
  const NAMES_NOBODY = /^Step (\d+) names nobody/;
  const NOT_IN_TEAM = /^Step (\d+) names "([^"]+)", who is not in the objective owner/;

  const groups = new Map<string, GapGroup>();
  const add = (
    key: string,
    summary: string,
    step: number | null,
    subject: string | null,
    text: string,
  ) => {
    const existing = groups.get(key) ?? {
      key,
      summary,
      count: 0,
      steps: [],
      subjects: [],
      examples: [],
    };
    existing.count += 1;
    if (step !== null) existing.steps.push(step);
    if (subject !== null && !existing.subjects.includes(subject)) existing.subjects.push(subject);
    if (existing.examples.length < 3) existing.examples.push(text);
    groups.set(key, existing);
  };

  for (const gap of gaps) {
    const nobody = NAMES_NOBODY.exec(gap);
    if (nobody) {
      add(
        'nobody',
        'name nobody, so no owner could be assigned. An AI step names the person accountable for it, not the one performing it.',
        Number(nobody[1]),
        null,
        gap,
      );
      continue;
    }

    const outside = NOT_IN_TEAM.exec(gap);
    if (outside) {
      add(
        'outside-team',
        "name somebody who is not in the objective owner's team, so the owner was left unassigned rather than guessed at.",
        Number(outside[1]),
        outside[2] ?? null,
        gap,
      );
      continue;
    }

    // Anything this does not recognise stands on its own, whole.
    add(gap, gap, null, null, gap);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * One node, drawn in the shape its kind requires.
 *
 * The mapping is not decided here — `node.shape` comes from the API, which derives it from
 * `NODE_SHAPE_BY_KIND` and refuses to store a draft whose shapes contradict their kinds. This
 * component's only job is to draw what it is told, so the locked rule (Human is a rectangle, AI is
 * a diamond, the Goal is distinct) cannot be broken by a restyle here.
 */
function WorkflowNode({
  node,
  stage,
  ownerName,
  waitsFor,
}: {
  node: AnalysisNode;
  stage: ExecutionStage | undefined;
  ownerName: string | null;
  /** The labels of the steps this one waits on, already resolved from ids. */
  waitsFor: string[];
}) {
  if (node.shape === 'goal') {
    return <div className="uboss-wf-goal">{node.label}</div>;
  }

  /*
   * The three facts the client asked every step to carry.
   *
   * Which position in the chain it is, who owns it, and what has to happen first. The position is
   * derived from the dependencies rather than stored, so it can never contradict them.
   */
  const footer =
    stage === undefined && waitsFor.length === 0 ? null : (
      <div className="uboss-wf-node-meta">
        {stage === undefined ? null : (
          <span className={`uboss-wf-stage uboss-wf-stage--${stage.toLowerCase()}`}>
            {EXECUTION_STAGE_LABELS[stage]}
          </span>
        )}
        {waitsFor.length === 0 ? (
          <span className="uboss-muted-3">Starts the chain</span>
        ) : (
          <span className="uboss-muted-3">After: {waitsFor.join(', ')}</span>
        )}
      </div>
    );

  if (node.shape === 'diamond') {
    return (
      <div className="uboss-wf-ai">
        <div className="uboss-wf-ai-diamond" />
        <div className="uboss-wf-ai-label">
          <b>{node.label}</b>
          <small>Agent work — {node.skillName ?? 'no published Agent yet'}</small>
          {footer}
        </div>
      </div>
    );
  }

  if (node.shape === 'gate') {
    return (
      <div className="uboss-wf-approve">
        <Icon name="shield" size={15} /> {node.label}
        {node.approvalKind === null ? null : (
          <span className="uboss-wf-node-tag">{node.approvalKind}</span>
        )}
      </div>
    );
  }

  return (
    <div className="uboss-wf-node uboss-wf-node--human">
      <div className="uboss-wf-node-head">
        <Icon name="users" size={15} />
        {node.label}
        <span className="uboss-wf-node-tag">HUMAN</span>
      </div>
      <div className="uboss-wf-node-body">
        {node.ownerUserId === null ? (
          // Said plainly. The analysis records an unassigned owner as a gap rather than guessing,
          // and the screen must not make an unassigned step look assigned.
          <span className="uboss-muted-3">No owner assigned</span>
        ) : (
          <>Owner: {ownerName ?? node.ownerDesignation ?? 'assigned'}</>
        )}
        {node.dod.approval === null || node.dod.approval === 'NotRequired' ? null : (
          <>
            <br />
            Approval: {node.dod.approval}
          </>
        )}
        {footer}
      </div>
    </div>
  );
}

/**
 * Analyze / Generate Workflow — the reference's `objAnalyze()`.
 *
 * ## Where the workflow sits, and why that changed
 *
 * The original layout put the objective on the left and the analysis in a 380px right rail, which
 * is where the generated workflow was drawn. The client's 2026-09-25 rule is explicit that this is
 * wrong — "do not squeeze the important workflow into a tiny side panel; keep this visual in the
 * CENTER of the workspace" — so the screen now has two shapes rather than one:
 *
 *   - **Before and during the run**, the objective has the wide column and the stages sit beside
 *     it: there is nothing else to look at yet.
 *   - **Once it has produced a workflow**, the two columns swap. The panel carrying the stages and
 *     the drawn workflow becomes the wide one and the objective shrinks to a reference rail.
 *
 * The same components in both, moved rather than duplicated: a second copy of the workflow drawing
 * would be a second thing to keep truthful.
 *
 * ## The progress is real
 *
 * The reference is explicit — "no fake completion" — and the stage list comes from the run row,
 * not from a timer. A reopened screen shows where the run actually got to, because the run is
 * durable and this polls it.
 *
 * ## Two things this screen must never imply
 *
 *   1. **That the output is live.** It is always a draft. The banner says so and the action row
 *      offers no publish — publishing is the Prompt 20 path, after a person approves.
 *   2. **That a model judged anything.** `producedByRealModel` is reported, and when it is false
 *      the screen says the analysis ran against a mock. Presenting mock output as a model's
 *      judgement is the fabrication the client's rules forbid.
 */
function ObjectiveAnalyzeInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [objective, setObjective] = useState<ObjectiveView | null>(null);
  const [run, setRun] = useState<AnalysisRunView | null>(null);
  const [usesRealModel, setUsesRealModel] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * A clock, so the panel can say how long the wait has been.
   *
   * Its own second-by-second state rather than a value folded into the run, because the run is
   * polled far less often than once a second and a counter that jumped in five-second steps would
   * look like a stall. It drives the elapsed figure and nothing else — no stage advances from it.
   */
  const [tick, setTick] = useState(() => Date.now());
  /** Owner ids resolved to names. A step's owner is a person, and an id is not a person. */
  const [people, setPeople] = useState<Map<string, string>>(new Map());

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);

  const accountMenu = useAccountMenu(me);

  /*
   * What the drawn workflow needs, worked out once rather than per node.
   *
   * `hasWorkflow` decides the page's shape: until there is something to draw, the stages are the
   * point and sit in the middle; once there is, the workflow takes the centre.
   */
  /*
   * The nodes, in the order the work actually happens.
   *
   * The stored array is the order the analysis built it — every human step, then every AI step —
   * so drawing it as it comes puts a later step above an earlier one and draws a connector between
   * them. That is a picture of a sequence the plan does not describe. Sorted by how deep into the
   * chain each node is, with the stored position breaking ties so siblings keep a stable order.
   */
  const drawn = useMemo(() => {
    const nodes = run?.draft?.nodes ?? null;
    if (nodes === null) return null;
    const depth = executionDepths(nodes);
    return nodes
      .map((node, index) => ({ node, index }))
      .sort(
        (left, right) =>
          (depth.get(left.node.id) ?? 0) - (depth.get(right.node.id) ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.node);
  }, [run]);
  const hasWorkflow = drawn !== null && drawn.length > 0;
  const executionStageById = useMemo(
    () => (drawn === null ? new Map<string, ExecutionStage>() : executionStages(drawn)),
    [drawn],
  );
  const labelById = useMemo(
    () => new Map((drawn ?? []).map((node) => [node.id, node.label])),
    [drawn],
  );
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
    if (!tenantId || objectiveId === null) return;

    void objectivesApi
      .view(tenantId, objectiveId)
      .then(setObjective)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load that objective.'),
      );

    void objectivesApi
      .latestAnalysis(tenantId, objectiveId)
      .then((result) => setRun(result.run))
      .catch(() => undefined);

    void objectivesApi
      .analysisMeta(tenantId)
      .then((meta) => setUsesRealModel(meta.model.usesRealModel))
      .catch(() => undefined);
  }, [objectiveId, tenantId]);

  useEffect(() => {
    if (tenantId === null) return;
    void organizationApi
      .hierarchy(tenantId)
      .then((view) => setPeople(new Map(view.list.map((row) => [row.userId, row.displayName]))))
      // A name is a courtesy. Without it the node falls back to the designation the analysis
      // recorded, which is still true, so a failure here must not empty the screen.
      .catch(() => setPeople(new Map()));
  }, [tenantId]);

  useEffect(load, [load]);

  // Poll while a run is in flight. The reference promises you can leave and return, so the source
  // of truth is the row; this just keeps the open screen current.
  useEffect(() => {
    if (!tenantId || run === null) return;
    if (run.status !== 'Queued' && run.status !== 'Running') return;

    const timer = setInterval(() => {
      void objectivesApi
        .analysisRun(tenantId, run.objectiveId, run.id)
        .then(setRun)
        .catch(() => undefined);
    }, 1500);

    return () => clearInterval(timer);
  }, [run, tenantId]);

  const startAnalysis = useCallback(() => {
    if (!tenantId || objectiveId === null) return;
    setBusy(true);
    setError(null);

    void objectivesApi
      .startAnalysis(tenantId, objectiveId)
      .then((started) => {
        setRun(started);
        setBusy(false);
        load();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not start the analysis.');
        setBusy(false);
      });
  }, [load, objectiveId, tenantId]);

  const cancelAnalysis = useCallback(() => {
    if (!tenantId || run === null) return;
    setBusy(true);

    void objectivesApi
      .cancelAnalysis(tenantId, run.objectiveId, run.id)
      .then((cancelled) => {
        setRun(cancelled);
        setBusy(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'Could not cancel the analysis.');
        setBusy(false);
      });
  }, [run, tenantId]);

  const shown = objective?.openDraft ?? objective?.versions[0] ?? null;
  const inFlight = run !== null && (run.status === 'Queued' || run.status === 'Running');

  // Only while something is actually running: a finished run's elapsed figure is fixed, and a
  // timer left going on an idle screen is the thing the motion rules are most explicit about.
  useEffect(() => {
    if (!inFlight) return undefined;
    const handle = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [inFlight]);

  /**
   * One stage at a time: the next appears when the one before it is finished.
   *
   * The whole list used to be drawn the moment the run started, so a panel that had done nothing
   * yet already showed its ending. Seven rows sitting there waiting is a form wizard — "you are
   * here in a sequence" — and this is the opposite situation: somebody is waiting and wants to
   * see that something is happening.
   *
   * Cut at the stage that is running, so the list grows as the work does. **Nothing here decides
   * when that is.** A row appears because the server reported the stage before it done; no timer
   * advances anything, and a run that stalls stops growing, which is the truth and is the whole
   * reason not to fake it.
   *
   * Finished and failed runs show everything, because then the question has changed from "what is
   * happening" to "what happened".
   */
  const allStages: ProgressStepItem[] =
    run === null
      ? []
      : run.stages.map((entry) => ({
          id: entry.stage,
          label: entry.label,
          state: entry.state,
        }));

  const runningAt = allStages.findIndex((entry) => entry.state === 'running');
  const stages = inFlight && runningAt >= 0 ? allStages.slice(0, runningAt + 1) : allStages;

  /**
   * How long this run has taken, as a sentence rather than a timestamp.
   *
   * From `startedAt` to `completedAt`, or to now while it is still going — `tick` is what moves
   * it, and it moves nothing else. A clock that keeps counting is the cheapest honest way to say
   * "this has not hung"; it reports the wait, never progress through it.
   */
  const elapsed = (() => {
    if (run?.startedAt == null) return null;
    const from = new Date(run.startedAt).getTime();
    const to = run.completedAt === null ? tick : new Date(run.completedAt).getTime();
    const seconds = Math.max(0, Math.round((to - from) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  })();

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      user={signedInUser}
      accountMenu={accountMenu}
      {...bell.shellProps}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Run Objective"
        description="UBoss reads the objective and works out who does what, in what order. Real progress — no fake completion."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: 'Analyze' },
        ]}
        actions={
          <>
            {inFlight ? (
              <Button size="sm" onClick={cancelAnalysis} disabled={busy}>
                Cancel (safe)
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={startAnalysis} disabled={busy}>
                <Icon name="bolt" size={16} />
                {run === null ? 'Run Objective' : 'Run again'}
              </Button>
            )}
          </>
        }
      />

      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      {usesRealModel === false ? (
        // Stated prominently and unprompted. Presenting mock output as a model's judgement is
        // exactly the fabrication the client's rules forbid.
        <Banner tone="warn">
          No AI provider is configured, so this analysis runs against a <b>mock model</b>. The draft
          it produces exercises the real pipeline, but nothing in it is a model’s judgement.
        </Banner>
      ) : null}

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: hasWorkflow ? '360px 1fr' : '1fr 380px' }}
      >
        {/* ---- Left: the objective stays visible, as the prompt requires ---- */}
        <Card>
          <CardBody>
            <div className="uboss-section-label" style={{ marginTop: 0 }}>
              Objective
            </div>

            {shown === null ? (
              <p className="uboss-muted">Loading…</p>
            ) : (
              <>
                <b>{shown.content.objectiveName}</b>
                <p className="uboss-muted" style={{ marginTop: 6 }}>
                  {objective?.code} · {shown.statusLabel}
                  {shown.content.targetCompletionTime === null
                    ? ''
                    : ` · target ${shown.content.targetCompletionTime} ${
                        shown.content.timeUnit === null
                          ? ''
                          : TIME_UNIT_LABELS[shown.content.timeUnit].toLowerCase()
                      }`}
                </p>

                <div className="uboss-kv">
                  <span className="uboss-kv-key">Expected final result</span>
                  <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                    {shown.content.expectedFinalResult}
                  </span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Workflow steps</span>
                  <span className="uboss-kv-value">{shown.steps.length}</span>
                </div>

                <hr className="uboss-sep" />
                <p className="uboss-muted" style={{ fontSize: 13 }}>
                  Analysis runs as a durable job. You can leave this screen and return — progress is
                  preserved.
                </p>

                <div className="uboss-actions" style={{ marginTop: 12 }}>
                  <Link
                    href={`/objective/form?objectiveId=${encodeURIComponent(objectiveId ?? '')}`}
                  >
                    <Button size="sm">Back to Form 2</Button>
                  </Link>
                </div>
              </>
            )}
          </CardBody>
        </Card>

        {/* ---- Right: the UBoss analysis panel ---- */}
        <Card>
          <CardBody>
            <div className="uboss-spread" style={{ marginBottom: 14 }}>
              <span>
                <b>AI analysis</b>
                {/*
                  How far, and how long — both read off the run.

                  "Running" alone looks identical after ten seconds and after two minutes, which is
                  the state somebody stares at wondering whether it has hung. The count is the
                  server's own `stagesCompleted`; the clock is the gap since `startedAt` and stops
                  at `completedAt`. Neither invents anything: there is no percentage here because
                  the run reports stages and not fractions.
                */}
                {run === null ? null : (
                  <span className="uboss-muted-3" style={{ marginLeft: 8, fontSize: 12.5 }}>
                    {run.stagesCompleted} of {run.stages.length}
                    {elapsed === null ? '' : ` · ${elapsed}`}
                  </span>
                )}
              </span>
              {run === null ? null : (
                <StatusBadge
                  tone={ANALYSIS_RUN_STATUS_TONES[run.status] as StatusTone}
                  status={run.statusLabel}
                />
              )}
            </div>

            {run === null ? (
              <p className="uboss-muted">
                This objective has not been run yet. Press <b>Run Objective</b> and UBoss will read
                its grid and work out the human work, the agent work, the order and the owners.
              </p>
            ) : (
              <>
                <ProgressStep
                  label="AI analysis stages"
                  items={stages}
                  // A stage marked running here means a durable job really is working, so its
                  // indicator keeps moving. See the prop: a wizard marking position does not.
                  live={inFlight}
                />

                {run.failureReason === null ? null : (
                  <Banner tone="danger">{run.failureReason}</Banner>
                )}

                {run.status === 'Cancelled' ? (
                  <Banner tone="info">
                    Cancelled. Nothing was published and the objective is unchanged.
                  </Banner>
                ) : null}

                {run.unreadableReason === null ? null : (
                  <Banner tone="warn">{run.unreadableReason}</Banner>
                )}

                {run.draft === null ? null : (
                  <>
                    {/*
                      The way on, which this screen did not have.

                      A full workflow editor exists — Add node, an edit panel per node, and
                      Pre-Publish — and the only link to it in the whole product was on the
                      Pre-Publish screen. So the analysis finished, the draft was drawn, and the
                      one thing somebody wants next, correcting what the analysis got wrong, had
                      no route to it unless they already knew the URL.

                      Here rather than in the page header, because it only means anything once
                      there is a draft to edit: a header button that is disabled for the whole
                      run is a button nobody reads by the time it matters.
                    */}
                    <div className="uboss-spread" style={{ marginBottom: 10 }}>
                      <div className="uboss-section-label" style={{ margin: 0, border: 0 }}>
                        Draft workflow
                      </div>
                      <div className="uboss-actions">
                        <Link
                          href={`/objective/workflow?objectiveId=${encodeURIComponent(
                            objectiveId ?? '',
                          )}`}
                        >
                          <Button size="sm">
                            <Icon name="wrench" size={15} />
                            Edit the workflow
                          </Button>
                        </Link>
                      </div>
                    </div>

                    <div className="uboss-legend-nodes" style={{ marginBottom: 14 }}>
                      <div className="uboss-legend-item">
                        <span className="uboss-swatch-goal" />
                        Goal
                      </div>
                      <div className="uboss-legend-item">
                        <span className="uboss-swatch-rect" />
                        Human work (rectangle)
                      </div>
                      <div className="uboss-legend-item">
                        <span className="uboss-swatch-diamond" />
                        AI work (diamond)
                      </div>
                      <div className="uboss-legend-item">
                        <span className="uboss-swatch-gate" />
                        Approval / condition
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 0,
                      }}
                    >
                      {(drawn ?? []).map((node, index) => (
                        <div
                          key={node.id}
                          className="uboss-wf-reveal-item"
                          // Drives the reveal beat. The plan is already computed and persisted —
                          // this is the order it is read in, not a loading state, and every node
                          // is on screen in the same order if the animation never runs.
                          style={
                            { textAlign: 'center', '--uboss-row': index } as React.CSSProperties
                          }
                        >
                          {index === 0 ? null : <div className="uboss-wf-connector" />}
                          <WorkflowNode
                            node={node}
                            stage={executionStageById.get(node.id)}
                            ownerName={
                              node.ownerUserId === null
                                ? null
                                : (people.get(node.ownerUserId) ?? null)
                            }
                            waitsFor={node.dod.dependencies
                              .map((id) => labelById.get(id))
                              .filter((label): label is string => label !== undefined)}
                          />
                        </div>
                      ))}
                    </div>

                    <div className="uboss-kv" style={{ marginTop: 14 }}>
                      <span className="uboss-kv-key">Estimated AI usage</span>
                      <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                        {/* A range, never a single figure: a number next to real money reads as
                            a quote, and the basis says what it came from. */}
                        {run.draft.usage.minTokens.toLocaleString()}–
                        {run.draft.usage.maxTokens.toLocaleString()} tokens
                        <br />
                        <small className="uboss-muted-3">{run.draft.usage.basis}</small>
                      </span>
                    </div>

                    {run.draft.risks.length === 0 ? null : (
                      <>
                        <div className="uboss-section-label">Risks</div>
                        {run.draft.risks.map((risk, index) => (
                          <div className="uboss-kv" key={`${risk.nodeId ?? 'plan'}-${index}`}>
                            <span className="uboss-kv-key">
                              <StatusBadge
                                tone={
                                  risk.severity === 'High'
                                    ? 'danger'
                                    : risk.severity === 'Medium'
                                      ? 'warn'
                                      : 'grey'
                                }
                                status={risk.severity}
                              />
                            </span>
                            <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                              {risk.summary}
                            </span>
                          </div>
                        ))}
                      </>
                    )}

                    {run.draft.gaps.length === 0 ? null : (
                      <>
                        {/*
                          Shown, not hidden. An analysis that concealed its blind spots would look
                          complete and be wrong.

                          Grouped, though, because showing them all flat defeated the point. A
                          25-step objective produced twenty-five of these, printed one under
                          another, nearly all identical bar a number:

                              Step 2 names nobody, so no owner could be assigned to it.
                              Step 3 names nobody, so no owner could be assigned to it.
                              …

                          Two different problems were mixed into that wall — steps that named
                          nobody, and steps that named somebody outside the owner's team — and
                          they need different things done about them. One line per kind, with the
                          steps it covers, says the same thing in a form somebody can act on; the
                          full list is one click away for whoever wants it.
                        */}
                        <div className="uboss-section-label">What the analysis could not do</div>
                        {groupGaps(run.draft.gaps).map((group) => (
                          <p className="uboss-notice-min" key={group.key}>
                            <Icon name="alert" size={14} />
                            <span>
                              {group.count > 1 ? (
                                <>
                                  <b>
                                    {group.count} steps — {group.summary}
                                  </b>
                                  <br />
                                  <span className="uboss-muted-3">
                                    {group.subjects.length > 0
                                      ? group.subjects.join(', ') + '. '
                                      : ''}
                                    Steps {group.steps.join(', ')}.
                                  </span>
                                </>
                              ) : (
                                group.examples[0]
                              )}
                            </span>
                          </p>
                        ))}
                        <details style={{ marginTop: 6 }}>
                          <summary className="uboss-muted-3" style={{ cursor: 'pointer' }}>
                            All {run.draft.gaps.length} in full
                          </summary>
                          {run.draft.gaps.map((gap, index) => (
                            <p className="uboss-notice-min" key={index}>
                              <Icon name="alert" size={14} />
                              {gap}
                            </p>
                          ))}
                        </details>
                      </>
                    )}

                    <Banner tone="info">{run.note}</Banner>

                    <div className="uboss-actions" style={{ marginTop: 12 }}>
                      <Link
                        href={`/objective/versions?objectiveId=${encodeURIComponent(
                          objectiveId ?? '',
                        )}`}
                      >
                        <Button size="sm">Open the version history</Button>
                      </Link>
                    </div>
                  </>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </RoutedAppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function ObjectiveAnalyzePage() {
  return (
    <Suspense fallback={null}>
      <ObjectiveAnalyzeInner />
    </Suspense>
  );
}
