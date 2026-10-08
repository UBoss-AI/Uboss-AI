'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ANALYSIS_NODE_KINDS,
  STEP_ENGINE_LABELS,
  WORKFLOW_EDGE_KIND_LABELS,
  WORKFLOW_EDGE_KINDS,
  type AnalysisNode,
  type AnalysisNodeKind,
} from '@uboss/types';
import {
  Banner,
  Button,
  Card,
  CardBody,
  Drawer,
  FormField,
  Icon,
  Modal,
  PageHeader,
  StatusBadge,
} from '@uboss/ui';

import { WorkflowCanvas, type NodeActivity } from '../../../components/WorkflowCanvas';
import { useRunStream } from '../../../lib/use-run-stream';

import { useAccountMenu } from '../../../lib/use-account-menu';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
import {
  ApiError,
  authApi,
  objectivesApi,
  organizationApi,
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
  /*
   * The people an owner can be set to, from the same place Form 2's owner list comes from — the
   * company's own hierarchy. Loaded here because the draft carries an owner's id, and an id is
   * not something a manager can choose between.
   */
  const [people, setPeople] = useState<{ userId: string; label: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * What a new node is, what it is called, and where it goes.
   *
   * Add node used to send `{ kind: 'Human', label: 'New human step' }` and nothing else — so every
   * press produced the same human step with the same name, dropped wherever the server puts a node
   * with no predecessor. The three things somebody adding a step actually wants to say were all
   * absent, and all three were already accepted by the endpoint: `AddNodeDto` takes `kind`, a
   * 1–300 character `label`, and `afterNodeId`, "wire a sequential edge from this node to the new
   * one".
   *
   * So this asks for them. `Goal` is not offered: a plan has one goal, it is the thing every other
   * node leads to, and a second would be a second plan.
   */
  const [adding, setAdding] = useState(false);
  const [newNode, setNewNode] = useState<{
    kind: AnalysisNodeKind;
    label: string;
    afterNodeId: string;
  }>({ kind: 'Human', label: '', afterNodeId: '' });

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

  /*
   * The live channel, used as a signal rather than as a source.
   *
   * Every event here was written to the run's own history before it was published, and the server
   * already resolves what each node is doing from that record. So an event means "something
   * changed, read it again" — not "here is the new truth". Joining assignments to nodes in the
   * browser would be a second translation of the same thing, free to drift from the first.
   *
   * The cost is one request per state change, and a run reports a handful of those. The benefit is
   * that the canvas can never show a state the server would not agree with.
   */
  const runStream = useRunStream(tenantId);
  const lastSeen = useRef<string | null>(null);

  useEffect(() => {
    const newest = [...runStream.byRun.values()].sort((a, b) => b.at.localeCompare(a.at))[0];
    if (newest === undefined || newest.at === lastSeen.current) return;
    lastSeen.current = newest.at;
    load();
  }, [runStream, load]);

  /**
   * The plan's nodes in the canvas's own vocabulary.
   *
   * One field differs, and the rename is the point: the canvas asks for a `subtitle`, and on an
   * objective's plan the honest answer is whose job the step is. On the agent builder's canvas the
   * answer to the same question is something else entirely, which is why the renderer does not
   * know the word "designation".
   */
  const canvasNodes = useMemo(
    () =>
      (draft?.graph.nodes ?? []).map((node) => ({
        id: node.id,
        kind: node.kind,
        label: node.label,
        shape: node.shape,
        subtitle: node.ownerDesignation,
      })),
    [draft],
  );

  /** The server's own answer, in the shape the canvas draws. */
  const activity = useMemo(() => {
    const map = new Map<string, NodeActivity>();
    for (const row of draft?.activity ?? []) {
      map.set(
        row.nodeId,
        row.state === 'working'
          ? { state: 'working', percent: row.percent, message: row.message }
          : row.state === 'waiting'
            ? { state: 'waiting', message: row.message }
            : row.state === 'failed'
              ? { state: 'failed', message: row.message }
              : { state: 'done' },
      );
    }
    return map;
  }, [draft]);

  useEffect(() => {
    if (tenantId === null) return;
    void organizationApi
      .hierarchy(tenantId)
      .then((view) =>
        setPeople(
          view.list.map((row) => ({
            userId: row.userId,
            label:
              row.designation === '' ? row.displayName : `${row.displayName} — ${row.designation}`,
          })),
        ),
      )
      .catch(() => setPeople([]));
  }, [tenantId]);

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
              onClick={() => {
                // Defaulted to the end of the plan, which is where a step is most often added,
                // and changeable to any node in it.
                const last = (draft?.graph.nodes ?? []).at(-1);
                setNewNode({ kind: 'Human', label: '', afterNodeId: last?.id ?? '' });
                setAdding(true);
              }}
            >
              <Icon name="plus" size={16} />
              Add node
            </Button>
            {/* The reference's "Assign AI node → Agent Builder". Agent Builder opens from an
                assignment and reads nothing else, so there is nothing to open it with while
                this workflow is still a draft. */}
            <Button
              size="sm"
              disabled
              title="Available once the objective is published and this node is assigned — Agent Builder opens from the assignment, not from a draft node."
            >
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

      {error === null ? null : <Banner tone="danger">{error}</Banner>}
      {draft !== null && !draft.editable ? (
        <Banner tone="warn">
          This workflow has already been assigned, so it is read-only. Editing what people are
          already working to is what versioning exists to prevent — open a new objective version
          instead.
        </Banner>
      ) : null}

      {/*
        A newer analysis exists and this workflow is not it.

        The draft is seeded once and a later analysis deliberately does not overwrite it, so that
        re-analysing cannot discard edits somebody made here. What that left was silent: a manager
        who re-analysed because a step had no owner watched the run succeed and saw nothing change.
        Saying it is the whole fix — the choice of what to do about it is theirs, and both answers
        are already on this screen.
      */}
      {draft !== null && draft.editable && draft.supersededByRunId !== null ? (
        <Banner tone="info">
          A newer analysis of this version has finished since this workflow was opened, and it has
          not been applied — your edits here are kept instead. Change what you need on this canvas,
          or start a new version if you want the newer analysis to be the basis.
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
                    {/*
                      The layer the step was written against, not a claim about who does it.

                      This read `whoEngine === 'Human' ? 'Human' : 'AI'`, and since `Human` stopped
                      being something anybody can choose, every source step printed "AI" — beside a
                      plan showing human nodes, on the same screen. The source says which machine
                      layer the step belongs to; what a person still has to do is the analysis's
                      answer and it is already drawn two inches to the right.
                    */}
                    <span className="uboss-kv-key">
                      {step.position}. {STEP_ENGINE_LABELS[step.whoEngine] ?? step.whoEngine}
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
              /*
                The plan, drawn from its edges.

                This was a single vertical column of nodes in array order, with a plain connector
                between each — so two steps that run **at the same time** were drawn one after the
                other, and the edges that said so were listed in a separate card below. The picture
                did not merely omit the shape of the plan; it contradicted it.

                The canvas lays nodes out by depth, which puts concurrent steps on the same row,
                draws each edge as what it is, and shows what every node is doing.
              */
              <div style={{ padding: '18px 10px' }}>
                <WorkflowCanvas
                  nodes={canvasNodes}
                  edges={draft.graph.edges}
                  activity={activity}
                  live={runStream.live}
                  {...(draft.editable
                    ? {
                        onOpenNode: setSelected,
                        /*
                         * The plus on each node opens the same dialog with the position already
                         * answered, so the one question the picture can answer better than a list
                         * is not asked at all. The dropdown stays for the keyboard and for the
                         * case of adding a step with nothing before it.
                         */
                        onAddAfter: (nodeId: string) => {
                          setNewNode({ kind: 'Human', label: '', afterNodeId: nodeId });
                          setAdding(true);
                        },
                      }
                    : {})}
                />
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
                                ? 'teal'
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

      {/*
        Adding a step: what it is, what it is called, and where it sits.

        All three go to the endpoint that already accepted them. Before this the button sent one
        fixed human step called "New human step" with no position, so a plan could only ever grow
        the same anonymous node at the same place.
      */}
      <Modal
        open={adding}
        title="Add a step to this workflow"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || newNode.label.trim() === ''}
              onClick={() => {
                const { kind, label, afterNodeId } = newNode;
                setAdding(false);
                edit((tenant, objectiveKey, revision) =>
                  workflowEditorApi.addNode(tenant, objectiveKey, {
                    revision,
                    kind,
                    label: label.trim(),
                    // Omitted rather than sent empty: no predecessor is a real answer, and an
                    // empty string is not a node id.
                    ...(afterNodeId === '' ? {} : { afterNodeId }),
                  }),
                )();
              }}
            >
              <Icon name="plus" size={16} />
              Add it
            </Button>
          </>
        }
      >
        <FormField
          label="What kind of step"
          required
          hint="Human work, AI work, an approval, a condition, or an event that starts something."
        >
          {(wiring) => (
            <select
              {...wiring}
              className="uboss-input"
              value={newNode.kind}
              onChange={(event) =>
                setNewNode({ ...newNode, kind: event.target.value as AnalysisNodeKind })
              }
            >
              {/*
                Every kind the plan has, except Goal: a plan has one goal, every other node leads
                to it, and a second would be a second plan.
              */}
              {ANALYSIS_NODE_KINDS.filter((kind) => kind !== 'Goal').map((kind) => (
                <option key={kind} value={kind}>
                  {kind === 'Ai' ? 'AI work' : kind === 'Human' ? 'Human work' : kind}
                </option>
              ))}
            </select>
          )}
        </FormField>

        <FormField
          label="What happens in it"
          required
          hint="The words that will appear on the node. This is what the next person reads."
        >
          {(wiring) => (
            <input
              {...wiring}
              className="uboss-input"
              value={newNode.label}
              maxLength={300}
              onChange={(event) => setNewNode({ ...newNode, label: event.target.value })}
              placeholder="Check the branch totals against the ledger"
            />
          )}
        </FormField>

        <FormField
          label="After which step"
          hint="The new step is wired to run after this one. Leave it at the top of the list to add it with nothing before it."
        >
          {(wiring) => (
            <select
              {...wiring}
              className="uboss-input"
              value={newNode.afterNodeId}
              onChange={(event) => setNewNode({ ...newNode, afterNodeId: event.target.value })}
            >
              <option value="">Nothing — it starts on its own</option>
              {(draft?.graph.nodes ?? []).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          )}
        </FormField>
      </Modal>

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

            {/*
              Who this step belongs to.

              `editNode` has always accepted an owner; the panel simply never offered one, so a node
              that came back from the analysis without an owner could not be given one from
              anywhere in the product — and Approve & Assign refuses to publish a human step that
              nobody owns. Nothing new is decided here: this is the existing patch field, shown.

              Human and AI nodes both carry an owner. A Human node's owner does the work; an AI
              node's is the accountable person the Engine Agent is built for.
            */}
            {node.kind === 'Human' || node.kind === 'Ai' ? (
              <div className="uboss-field">
                <label htmlFor="nodeOwner">Owner</label>
                <select
                  id="nodeOwner"
                  value={node.ownerUserId ?? ''}
                  disabled={!draft?.editable}
                  onChange={(event) =>
                    edit((tenant, objectiveKey, revision) =>
                      workflowEditorApi.editNode(tenant, objectiveKey, node.id, {
                        revision,
                        ownerUserId: event.target.value === '' ? null : event.target.value,
                      }),
                    )()
                  }
                >
                  <option value="">Nobody yet</option>
                  {people.map((person) => (
                    <option key={person.userId} value={person.userId}>
                      {person.label}
                    </option>
                  ))}
                </select>
                {node.kind === 'Human' && node.ownerUserId === null ? (
                  <p className="uboss-notice-min">
                    A human step with no owner cannot be published — the workflow would put work in
                    front of nobody.
                  </p>
                ) : null}
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

            {/*
              The approval gate is not offered here either.

              It was a dropdown on every step, and setting it put a decision between two people
              that nobody in this company can make: there is an administrator who defines the work
              and an employee who does it, and no third role to stop it for. A gate set here would
              be work parked for ever.

              An approval already on a step keeps its value and still shows in the diagram; this
              only stops a new one being chosen.
            */}
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
    </RoutedAppShell>
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
