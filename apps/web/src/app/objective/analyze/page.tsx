'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { ANALYSIS_RUN_STATUS_TONES, TIME_UNIT_LABELS, type AnalysisNode } from '@uboss/types';
import {
  AppShell,
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
  type AnalysisRunView,
  type MeResponse,
  type ObjectiveView,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/**
 * One node, drawn in the shape its kind requires.
 *
 * The mapping is not decided here — `node.shape` comes from the API, which derives it from
 * `NODE_SHAPE_BY_KIND` and refuses to store a draft whose shapes contradict their kinds. This
 * component's only job is to draw what it is told, so the locked rule (Human is a rectangle, AI is
 * a diamond, the Goal is distinct) cannot be broken by a restyle here.
 */
function WorkflowNode({ node }: { node: AnalysisNode }) {
  if (node.shape === 'goal') {
    return <div className="uboss-wf-goal">{node.label}</div>;
  }

  if (node.shape === 'diamond') {
    return (
      <div className="uboss-wf-ai">
        <div className="uboss-wf-ai-diamond" />
        <div className="uboss-wf-ai-label">
          <b>{node.label}</b>
          <small>{node.skillName ?? 'No approved Skill yet'}</small>
        </div>
      </div>
    );
  }

  if (node.shape === 'gate') {
    return (
      <div className="uboss-wf-approve">
        <Icon name="shield" size={15} /> {node.label}
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
          <>Owner: {node.ownerDesignation ?? 'assigned'}</>
        )}
        <br />
        Evidence required
      </div>
    </div>
  );
}

/**
 * Analyze / Generate Workflow — the reference's `objAnalyze()`.
 *
 * The prompt's frontend requirements, in its words: **keep the Objective Form on the left, open a
 * right-side UBoss panel, and show real progress stages.** So the layout is the reference's
 * `1fr 380px` grid, the left card carries the objective, and the right card is the analysis panel
 * with the seven stages.
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

  const stages: ProgressStepItem[] =
    run === null
      ? []
      : run.stages.map((entry) => ({
          id: entry.stage,
          label: entry.label,
          state: entry.state,
        }));

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Objective analysis' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Analyzing objective"
        description="Real AI decomposition progress — no fake completion."
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
                {run === null ? 'Analyze & Generate Workflow' : 'Re-analyse'}
              </Button>
            )}
          </>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}

      {usesRealModel === false ? (
        // Stated prominently and unprompted. Presenting mock output as a model's judgement is
        // exactly the fabrication the client's rules forbid.
        <Banner tone="warn">
          <Icon name="alert" size={16} />
          No AI provider is configured, so this analysis runs against a <b>mock model</b>. The draft
          it produces exercises the real pipeline, but nothing in it is a model’s judgement.
        </Banner>
      ) : null}

      <div className="uboss-grid" style={{ gridTemplateColumns: '1fr 380px' }}>
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
              <b>AI analysis</b>
              {run === null ? null : (
                <StatusBadge
                  tone={ANALYSIS_RUN_STATUS_TONES[run.status] as StatusTone}
                  status={run.statusLabel}
                />
              )}
            </div>

            {run === null ? (
              <p className="uboss-muted">
                This objective has not been analysed. Press <b>Analyze &amp; Generate Workflow</b>{' '}
                to decompose its Form 2 grid into a draft workflow.
              </p>
            ) : (
              <>
                <ProgressStep label="AI analysis stages" items={stages} />

                {run.failureReason === null ? null : (
                  <Banner tone="danger">
                    <Icon name="alert" size={16} />
                    {run.failureReason}
                  </Banner>
                )}

                {run.status === 'Cancelled' ? (
                  <Banner tone="info">
                    <Icon name="shield" size={16} />
                    Cancelled. Nothing was published and the objective is unchanged.
                  </Banner>
                ) : null}

                {run.unreadableReason === null ? null : (
                  <Banner tone="warn">
                    <Icon name="alert" size={16} />
                    {run.unreadableReason}
                  </Banner>
                )}

                {run.draft === null ? null : (
                  <>
                    <div className="uboss-section-label">Draft workflow</div>

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
                      {run.draft.nodes.map((node, index) => (
                        <div key={node.id} style={{ textAlign: 'center' }}>
                          {index === 0 ? null : <div className="uboss-wf-connector" />}
                          <WorkflowNode node={node} />
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
                        {/* Shown, not hidden. An analysis that concealed its blind spots would
                            look complete and be wrong. */}
                        <div className="uboss-section-label">What the analysis could not do</div>
                        {run.draft.gaps.map((gap, index) => (
                          <p className="uboss-notice-min" key={index}>
                            <Icon name="alert" size={14} />
                            {gap}
                          </p>
                        ))}
                      </>
                    )}

                    <Banner tone="info">
                      <Icon name="shield" size={16} />
                      {run.note}
                    </Banner>

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
    </AppShell>
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
