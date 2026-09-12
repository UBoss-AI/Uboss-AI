'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import {
  STEP_APPROVAL_KINDS,
  STEP_APPROVAL_LABELS,
  WORKFLOW_EDGE_KIND_LABELS,
  WORKFLOW_EDGE_KINDS,
  type AnalysisNode,
  type StepApprovalKind,
} from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  CardBody,
  Drawer,
  Icon,
  PageHeader,
  StatusBadge,
} from '@uboss/ui';

import { WorkflowCanvasNode } from '../../../components/WorkflowCanvasNode';
import {
  ApiError,
  authApi,
  objectivesApi,
  workflowEditorApi,
  type MeResponse,
  type ObjectiveView,
  type WorkflowDraftView,
} from '../../../lib/api-client';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';

/**
 * The workflow graph editor — the reference's `objWorkflow()`.
 *
 * Its layout: Form 2 read-only on the left, the generated flow on the right, the node legend, and
 * "Add node" / "Assign AI node → Agent Builder" / "Pre-Publish" in the action row.
 *
 * ## What a manager can do here
 *
 * The client's list: edit title and details, change the assignee, convert Human ↔ AI where
 * allowed, add and delete nodes, reconnect edges with a kind (sequential, parallel, IF/ELSE,
 * failure), set dependencies, and fill in each node's seven-part Definition of Done. Selecting a
 * node opens the drawer that does all of it.
 *
 * ## Every edit carries a revision
 *
 * The server refuses a stale one and says so, rather than silently overwriting another manager's
 * change. Two people on one plan is a real situation and this is a consequential document.
 *
 * ## Nothing here publishes
 *
 * Pre-Publish is a summary and Approve & Assign is Prompt 23's transaction.
 */
function WorkflowEditorInner() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const params = useSearchParams();
  const objectiveId = params.get('objectiveId');

  const [me, setMe] = useState<MeResponse | null>(null);
  const [objective, setObjective] = useState<ObjectiveView | null>(null);
  const [draft, setDraft] = useState<WorkflowDraftView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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
      .catch(() => undefined);

    // `open` is idempotent: it returns the existing draft, or seeds one from the analysis.
    void workflowEditorApi
      .open(tenantId, objectiveId)
      .then(setDraft)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not open the workflow.'),
      );
  }, [objectiveId, tenantId]);

  useEffect(load, [load]);

  /** Every mutation goes through here, so the revision and the error handling are never skipped. */
  const edit = useCallback(
    (
      run: (tenantId: string, objectiveId: string, revision: number) => Promise<WorkflowDraftView>,
    ) =>
      () => {
        if (!tenantId || objectiveId === null || draft === null) return;
        setBusy(true);
        setError(null);

        void run(tenantId, objectiveId, draft.revision)
          .then((updated) => {
            setDraft(updated);
            setBusy(false);
          })
          .catch((caught: unknown) => {
            setError(caught instanceof ApiError ? caught.message : 'Could not apply that change.');
            setBusy(false);
          });
      },
    [draft, objectiveId, tenantId],
  );

  const node = draft?.graph.nodes.find((candidate) => candidate.id === selected) ?? null;
  const shownVersion = objective?.openDraft ?? objective?.versions[0] ?? null;

  const patchDod = (patch: Partial<AnalysisNode['dod']>) =>
    edit((tenant, objectiveKey, revision) =>
      workflowEditorApi.editNode(tenant, objectiveKey, selected ?? '', { revision, dod: patch }),
    )();

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Workflow editor' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Objective analysis — workflow"
        description="Form 2 stays visible on the left; the generated human + agent workflow is on the right."
        breadcrumbs={[
          { label: 'Objective Optimization', href: '/objective' },
          { label: `Workflow${draft === null ? '' : ` · revision ${draft.revision}`}` },
        ]}
        actions={
          <>
            <Button
              size="sm"
              disabled={busy || draft === null || !draft.editable}
              onClick={edit((tenant, objectiveKey, revision) =>
                workflowEditorApi.addNode(tenant, objectiveKey, {
                  revision,
                  kind: 'Human',
                  label: 'New human step',
                }),
              )}
            >
              <Icon name="plus" size={16} />
              Add node
            </Button>
            {/* The reference's "Assign AI node → Agent Builder". Agent Builder is Prompt 24. */}
            <Button size="sm" disabled title="Agent Builder arrives at Prompt 24">
              <Icon name="bot" size={16} />
              Assign AI node → Agent Builder
            </Button>
            <Link
              href={`/objective/prepublish?objectiveId=${encodeURIComponent(objectiveId ?? '')}`}
            >
              <Button variant="primary" size="sm" disabled={draft === null}>
                Pre-Publish
              </Button>
            </Link>
          </>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}
      {draft !== null && !draft.editable ? (
        <Banner tone="warn">
          <Icon name="alert" size={16} />
          This workflow has already been assigned, so it is read-only. Editing what people are
          already working to is what versioning exists to prevent — open a new objective version
          instead.
        </Banner>
      ) : null}

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

      <div className="uboss-grid" style={{ gridTemplateColumns: '300px 1fr' }}>
        {/* ---- Left: Form 2, read-only, as the reference requires ---- */}
        <Card>
          <CardBody>
            <div className="uboss-section-label" style={{ marginTop: 0 }}>
              Form 2 (source — read-only)
            </div>
            {shownVersion === null ? (
              <p className="uboss-muted">Loading…</p>
            ) : (
              <>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Objective</span>
                  <span className="uboss-kv-value">{shownVersion.content.objectiveName}</span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Owner</span>
                  <span className="uboss-kv-value uboss-mono uboss-muted-3">
                    {shownVersion.content.objectiveOwnerUserId.slice(0, 8)}
                  </span>
                </div>
                <div className="uboss-kv">
                  <span className="uboss-kv-key">Workload</span>
                  <span className="uboss-kv-value">
                    {shownVersion.content.currentWorkload ?? '—'} {shownVersion.content.unit ?? ''}
                  </span>
                </div>
                <hr className="uboss-sep" />
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  Steps
                </div>
                {shownVersion.steps.map((step) => (
                  <div className="uboss-kv" key={step.id}>
                    <span className="uboss-kv-key">
                      {step.position}. {step.whoEngine === 'Human' ? 'Human' : 'AI'}
                    </span>
                    <span className="uboss-kv-value" style={{ textAlign: 'left' }}>
                      {step.whatExactWork}
                    </span>
                  </div>
                ))}
              </>
            )}
          </CardBody>
        </Card>

        {/* ---- Right: the editable canvas, on the reference's dotted diagram surface ---- */}
        <div>
          <div className="uboss-canvas">
            {draft === null ? (
              <p className="uboss-muted" style={{ padding: 18 }}>
                Opening the workflow. If this objective has not been analysed yet, run{' '}
                <b>Analyze &amp; Generate Workflow</b> first.
              </p>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  padding: '26px 10px',
                }}
              >
                {draft.graph.nodes.map((candidate, index) => (
                  <div key={candidate.id} style={{ textAlign: 'center' }}>
                    {index === 0 ? null : <div className="uboss-wf-connector" />}
                    <WorkflowCanvasNode
                      node={candidate}
                      editable={draft.editable}
                      onOpen={() => setSelected(candidate.id)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {draft === null ? null : (
            <Card style={{ marginTop: 14 }}>
              <CardBody>
                <div className="uboss-section-label" style={{ marginTop: 0 }}>
                  Connections ({draft.graph.edges.length})
                </div>
                {draft.graph.edges.map((edge, index) => (
                  <div className="uboss-kv" key={`${edge.fromNodeId}-${edge.toNodeId}-${index}`}>
                    <span className="uboss-kv-key uboss-mono">
                      {edge.fromNodeId} → {edge.toNodeId}
                    </span>
                    <span className="uboss-kv-value">
                      <StatusBadge
                        tone={
                          edge.kind === 'Failure'
                            ? 'danger'
                            : edge.kind === 'Condition'
                              ? 'purple'
                              : edge.kind === 'Parallel'
                                ? 'cyan'
                                : 'grey'
                        }
                        status={WORKFLOW_EDGE_KIND_LABELS[edge.kind]}
                      />
                      {edge.condition === null || edge.condition === undefined
                        ? ''
                        : ` ${edge.condition}`}
                    </span>
                  </div>
                ))}

                <p className="uboss-notice-min">
                  <Icon name="shield" size={14} />
                  Select a node to edit its title, owner, Definition of Done and dependencies, or to
                  convert it between Human and AI work. Every edit is checked against the whole
                  graph.
                </p>
              </CardBody>
            </Card>
          )}
        </div>
      </div>

      {/* ---- The node drawer: all of the manager's per-node actions ---- */}
      <Drawer
        open={node !== null}
        onClose={() => setSelected(null)}
        title={node === null ? '' : `Edit ${node.label}`}
        footer={<Button onClick={() => setSelected(null)}>Close</Button>}
      >
        {node === null ? null : (
          <>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Kind</span>
              <span className="uboss-kv-value">
                <StatusBadge tone="blue" status={node.kind} />
              </span>
            </div>

            <div className="uboss-field">
              <label htmlFor="nodeLabel">Title</label>
              <input
                id="nodeLabel"
                defaultValue={node.label}
                readOnly={!draft?.editable}
                onBlur={(event) => {
                  if (event.target.value !== node.label) {
                    edit((tenant, objectiveKey, revision) =>
                      workflowEditorApi.editNode(tenant, objectiveKey, node.id, {
                        revision,
                        label: event.target.value,
                      }),
                    )();
                  }
                }}
              />
            </div>

            {node.kind === 'Human' || node.kind === 'Ai' ? (
              <div className="uboss-actions" style={{ marginBottom: 12 }}>
                <Button
                  size="sm"
                  disabled={busy || !draft?.editable}
                  onClick={edit((tenant, objectiveKey, revision) =>
                    workflowEditorApi.convertNode(
                      tenant,
                      objectiveKey,
                      node.id,
                      node.kind === 'Human' ? 'Ai' : 'Human',
                      revision,
                    ),
                  )}
                >
                  Convert to {node.kind === 'Human' ? 'AI' : 'Human'} work
                </Button>
              </div>
            ) : null}

            {node.kind === 'Trigger' ? (
              <div className="uboss-field">
                <label htmlFor="triggerEvent">Event</label>
                <input
                  id="triggerEvent"
                  defaultValue={node.triggerEvent ?? ''}
                  readOnly={!draft?.editable}
                  onBlur={(event) =>
                    edit((tenant, objectiveKey, revision) =>
                      workflowEditorApi.editNode(tenant, objectiveKey, node.id, {
                        revision,
                        triggerEvent: event.target.value,
                      }),
                    )()
                  }
                />
              </div>
            ) : null}

            <div className="uboss-section-label">Definition of Done</div>

            {(
              [
                ['expectedOutput', 'Expected output'],
                ['criteria', 'Criteria'],
                ['evidence', 'Evidence'],
                ['failureCondition', 'Failure condition'],
              ] as const
            ).map(([field, label]) => (
              <div className="uboss-field" key={field}>
                <label htmlFor={field}>{label}</label>
                <textarea
                  id={field}
                  rows={2}
                  defaultValue={node.dod[field]}
                  readOnly={!draft?.editable}
                  onBlur={(event) => {
                    if (event.target.value !== node.dod[field]) {
                      patchDod({ [field]: event.target.value });
                    }
                  }}
                />
              </div>
            ))}

            <div className="uboss-field">
              <label htmlFor="dodApproval">Approval</label>
              <select
                id="dodApproval"
                defaultValue={node.dod.approval ?? 'NotRequired'}
                disabled={!draft?.editable}
                onChange={(event) =>
                  patchDod({
                    approval:
                      event.target.value === 'NotRequired'
                        ? null
                        : (event.target.value as StepApprovalKind),
                  })
                }
              >
                {STEP_APPROVAL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {STEP_APPROVAL_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>

            <div className="uboss-kv">
              <span className="uboss-kv-key">Tools</span>
              <span className="uboss-kv-value">
                {node.dod.tools.length === 0 ? (
                  <span className="uboss-muted-3">None</span>
                ) : (
                  node.dod.tools.join(', ')
                )}
              </span>
            </div>
            <div className="uboss-kv">
              <span className="uboss-kv-key">Dependencies</span>
              <span className="uboss-kv-value">
                {node.dod.dependencies.length === 0 ? (
                  <span className="uboss-muted-3">None</span>
                ) : (
                  node.dod.dependencies.join(', ')
                )}
              </span>
            </div>

            {node.kind === 'Goal' ? (
              <p className="uboss-notice-min">
                <Icon name="shield" size={14} />
                The Goal cannot be deleted or converted. It is what the whole plan is for.
              </p>
            ) : (
              <div className="uboss-actions" style={{ marginTop: 14 }}>
                <Button
                  size="sm"
                  disabled={busy || !draft?.editable}
                  onClick={() => {
                    setSelected(null);
                    edit((tenant, objectiveKey, revision) =>
                      workflowEditorApi.deleteNode(tenant, objectiveKey, node.id, revision),
                    )();
                  }}
                >
                  Delete this node
                </Button>
              </div>
            )}

            <p className="uboss-notice-min">
              <Icon name="file" size={14} />
              Edge kinds available:{' '}
              {WORKFLOW_EDGE_KINDS.map((kind) => WORKFLOW_EDGE_KIND_LABELS[kind]).join(', ')}.
            </p>
          </>
        )}
      </Drawer>
    </AppShell>
  );
}

/** `useSearchParams()` needs a Suspense boundary or the production build fails outright. */
export default function WorkflowEditorPage() {
  return (
    <Suspense fallback={null}>
      <WorkflowEditorInner />
    </Suspense>
  );
}
