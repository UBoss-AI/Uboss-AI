import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ANALYSIS_SCHEMA_VERSION,
  HIGH_RISK_TOOL_CATEGORIES,
  incompleteDodFields,
  mayConvertNode,
  nodeShapeFor,
  upgradeWorkflowDraft,
  validateWorkflowDraft,
  type AnalysisNode,
  type AnalysisNodeKind,
  type DefinitionOfDone,
  type PrePublishSummary,
  type ReadinessFinding,
  type WorkflowDraft,
  type WorkflowEdgeKind,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Objective, ObjectiveWorkflowDraft } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

export interface WorkflowDraftView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  seededFromRunId: string | null;
  graph: WorkflowDraft;
  schemaVersion: number;
  /** Send this back with an edit. A stale revision is refused rather than overwriting somebody. */
  revision: number;
  assignedAt: string | null;
  assignedByUserId: string | null;
  editable: boolean;
  note: string;
}

/** What an edit says about the node it creates or changes. */
export interface NodePatch {
  label?: string | undefined;
  ownerUserId?: string | null | undefined;
  ownerDesignation?: string | null | undefined;
  triggerEvent?: string | null | undefined;
  dod?: Partial<DefinitionOfDone> | undefined;
}

/**
 * The manager-editable workflow, and the Pre-Publish Summary.
 *
 * ## Two records, on purpose
 *
 * `objective_analysis_runs` is frozen once it finishes — it is the historical record of **what the
 * AI proposed**. This service owns a separate row: **what the company decided to do**. Writing
 * edits back onto the run would destroy the record, and refusing edits to keep the record would
 * make the workflow uneditable. The link is `seededFromRunId`.
 *
 * ## Every write validates the whole graph
 *
 * A node edit can break the graph — a dependency on a node that was just deleted, an edge to
 * nothing, a converted node whose shape no longer matches its kind. So each operation rebuilds the
 * graph, runs `validateWorkflowDraft` over all of it, and refuses the write if anything is wrong.
 * Validating only the changed node would let the draft rot one edit at a time.
 *
 * ## Nothing here publishes
 *
 * The client's instruction ends "Do not publish yet; next prompt handles publish transaction."
 * There is no publish path in this service, and `readyToAssign` on the summary is a **readiness
 * report**, not permission — Prompt 23 owns Approve & Assign.
 */

/**
 * The keys of `patch` that were actually supplied.
 *
 * A validated DTO is a class instance, and every declared field exists as an own property even
 * when the request omitted it — so spreading one over stored state writes `undefined` across
 * everything the caller did not mention. That is indistinguishable from "clear this", which is
 * not what a partial edit means.
 */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

@Injectable()
export class WorkflowEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // Opening the draft
  // -------------------------------------------------------------------------

  /**
   * The editable draft for an objective's version, seeded from its analysis on first open.
   *
   * `objective:EditDraft`. Seeding on open rather than at the end of the analysis keeps the two
   * records independent: an analysis that nobody opens leaves no editable draft behind, and
   * re-analysing does not silently discard a manager's edits.
   */
  async open(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<WorkflowDraftView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const { objective, versionId } = await this.locate(input.objectiveId, input.versionId);
      await this.assertOnObjective(context, objective, 'EditDraft');

      const existing = await this.prisma.client.objectiveWorkflowDraft.findFirst({
        where: { objectiveVersionId: versionId },
      });
      if (existing) {
        return this.viewOf(existing);
      }

      // Seed from the most recent completed analysis of this version.
      const run = await this.prisma.client.objectiveAnalysisRun.findFirst({
        where: { objectiveVersionId: versionId, status: 'Completed' },
        orderBy: { completedAt: 'desc' },
      });

      if (run === null || run.draft === null) {
        throw new ConflictException(
          'There is no completed analysis of this version to open. Run Analyze & Generate ' +
            'Workflow first, or the analysis produced no draft.',
        );
      }

      const seeded = upgradeWorkflowDraft(run.draft);
      if (seeded === null) {
        throw new ConflictException(
          `That analysis was written with schema version ${run.schemaVersion}, which this build ` +
            'does not read. Re-analyse the objective.',
        );
      }

      const problems = validateWorkflowDraft(seeded);
      if (problems.length > 0) {
        throw new ConflictException(
          `That analysis draft does not satisfy the current schema: ${problems.join(' ')}`,
        );
      }

      const created = await this.prisma.client.objectiveWorkflowDraft.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveId: objective.id,
          objectiveVersionId: versionId,
          seededFromRunId: run.id,
          graph: seeded as unknown as object,
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          createdByUserId: input.actorUserId,
          updatedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.workflow_draft_opened',
        resourceType: 'objective',
        resourceId: objective.id,
        actorUserId: input.actorUserId,
        resourceRef: objective.code,
        summary:
          'Opened the workflow for editing, seeded from the AI analysis. The analysis run is ' +
          'unchanged: it stays the record of what the AI proposed.',
        metadata: {
          draftId: created.id,
          seededFromRunId: run.id,
          nodeCount: seeded.nodes.length,
        },
      });

      return this.viewOf(created);
    });
  }

  // -------------------------------------------------------------------------
  // The manager's actions
  // -------------------------------------------------------------------------

  /** Edit a node's title, details, owner, trigger or Definition of Done. */
  async editNode(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    nodeId: string;
    patch: NodePatch;
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      const node = this.nodeOrThrow(graph, input.nodeId);

      if (input.patch.label !== undefined) {
        if (input.patch.label.trim() === '') {
          throw new BadRequestException('A node needs a label.');
        }
        node.label = input.patch.label;
      }
      if (input.patch.ownerUserId !== undefined) {
        node.ownerUserId = input.patch.ownerUserId;
      }
      if (input.patch.ownerDesignation !== undefined) {
        node.ownerDesignation = input.patch.ownerDesignation;
      }
      if (input.patch.triggerEvent !== undefined) {
        node.triggerEvent = input.patch.triggerEvent;
      }
      if (input.patch.dod !== undefined) {
        // `definedOnly` matters more than it looks. The patch arrives as a class instance, and a
        // declared TypeScript field is an own property whether or not the request set it — so a
        // plain spread writes `undefined` over every part the manager did not touch. Editing only
        // the criteria would have silently emptied the dependency and tool lists.
        node.dod = { ...node.dod, ...definedOnly(input.patch.dod) };
        // The diagram's approval badge is derived from the Definition of Done, so they cannot
        // drift apart.
        if (input.patch.dod.approval !== undefined) {
          node.approvalKind = input.patch.dod.approval;
        }
      }

      return { summary: `Edited node ${input.nodeId}.`, action: 'objective.workflow_node_edited' };
    });
  }

  /**
   * Convert a node between Human and AI.
   *
   * The allowance is `mayConvertNode` in the shared package, so the editor and any later caller
   * apply the same rule. Human → AI needs an approved published Skill already matched to the node:
   * without one the conversion would create a step nothing can perform.
   */
  async convertNode(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    nodeId: string;
    to: AnalysisNodeKind;
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      const node = this.nodeOrThrow(graph, input.nodeId);

      const decision = mayConvertNode({
        from: node.kind,
        to: input.to,
        hasApprovedSkill: node.skillVersionId !== null,
      });
      if (!decision.allowed) {
        throw new BadRequestException(decision.reason);
      }

      node.kind = input.to;
      // The shape follows the kind, always. This is the locked rule; `validateWorkflowDraft`
      // would refuse the write if these disagreed.
      node.shape = nodeShapeFor(input.to);

      if (input.to === 'Human') {
        // A human step does not run a Skill. Clearing it is the honest move: leaving it would
        // suggest an agent is still involved.
        node.skillVersionId = null;
        node.skillName = null;
      } else {
        node.ownerUserId = null;
      }

      return {
        summary: `Converted node ${input.nodeId} to ${input.to} work.`,
        action: 'objective.workflow_node_converted',
      };
    });
  }

  /** Add a node. New nodes start with a blank Definition of Done for the manager to fill. */
  async addNode(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    kind: AnalysisNodeKind;
    label: string;
    /** Insert after this node, wiring a sequential edge. Omit to leave it unconnected. */
    afterNodeId?: string | undefined;
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      if (input.kind === 'Goal') {
        throw new BadRequestException(
          'A workflow has exactly one Goal, and it already has it. The Goal is what the plan is ' +
            'for, not a step you add.',
        );
      }
      if (input.label.trim() === '') {
        throw new BadRequestException('A node needs a label.');
      }

      const id = this.freshNodeId(graph, input.kind);

      graph.nodes.push({
        id,
        kind: input.kind,
        label: input.label,
        shape: nodeShapeFor(input.kind),
        // Added by hand, so it corresponds to no Form 2 row. Recorded as null rather than
        // pointed at an unrelated row.
        fromStepPosition: null,
        ownerUserId: null,
        ownerDesignation: null,
        skillVersionId: null,
        skillName: null,
        dod: {
          expectedOutput: '',
          criteria: '',
          evidence: '',
          dependencies: [],
          tools: [],
          approval: null,
          failureCondition: '',
        },
        approvalKind: null,
        // A trigger with no event fails validation, so one is seeded and the manager names it.
        triggerEvent: input.kind === 'Trigger' ? 'To be named' : null,
      });

      if (input.afterNodeId !== undefined) {
        this.nodeOrThrow(graph, input.afterNodeId);
        graph.edges.push({
          fromNodeId: input.afterNodeId,
          toNodeId: id,
          kind: 'Sequential',
          condition: null,
        });
      }

      return {
        summary: `Added a ${input.kind} node.`,
        action: 'objective.workflow_node_added',
        nodeId: id,
      };
    });
  }

  /**
   * Delete a node.
   *
   * Its edges go with it, and so does any dependency naming it — a dangling dependency is one
   * nothing can enforce, and leaving it would make the draft fail its own validation on the next
   * unrelated edit, far from the cause.
   */
  async deleteNode(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    nodeId: string;
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      const node = this.nodeOrThrow(graph, input.nodeId);

      if (node.kind === 'Goal') {
        throw new BadRequestException(
          'The Goal cannot be deleted. It is what the whole plan is for.',
        );
      }

      graph.nodes = graph.nodes.filter((candidate) => candidate.id !== input.nodeId);
      graph.edges = graph.edges.filter(
        (edge) => edge.fromNodeId !== input.nodeId && edge.toNodeId !== input.nodeId,
      );
      for (const remaining of graph.nodes) {
        remaining.dod.dependencies = remaining.dod.dependencies.filter(
          (dependency) => dependency !== input.nodeId,
        );
      }

      return {
        summary: `Deleted node ${input.nodeId} and everything that pointed at it.`,
        action: 'objective.workflow_node_deleted',
      };
    });
  }

  /**
   * Reconnect the graph: replace its edges wholesale.
   *
   * Whole-list replacement for the same reason the Form 2 grid is replaced whole — reordering and
   * reconnecting a diagram is not a sequence of per-edge operations, and reconciling one into the
   * other would invent an order the editor never had.
   */
  async setEdges(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    edges: {
      fromNodeId: string;
      toNodeId: string;
      kind: WorkflowEdgeKind;
      condition?: string | null;
    }[];
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      graph.edges = input.edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: edge.kind,
        condition: edge.condition ?? null,
      }));

      return {
        summary: `Reconnected the workflow: ${graph.edges.length} edges.`,
        action: 'objective.workflow_reconnected',
      };
    });
  }

  /** Set a node's explicit dependencies. */
  async setDependencies(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    revision: number;
    nodeId: string;
    dependsOn: string[];
  }): Promise<WorkflowDraftView> {
    return this.mutate(input, (graph) => {
      const node = this.nodeOrThrow(graph, input.nodeId);
      node.dod.dependencies = [...new Set(input.dependsOn)];

      return {
        summary: `Set ${input.dependsOn.length} dependencies on node ${input.nodeId}.`,
        action: 'objective.workflow_dependencies_set',
      };
    });
  }

  // -------------------------------------------------------------------------
  // The Pre-Publish Summary
  // -------------------------------------------------------------------------

  /**
   * Everything the client's Pre-Publish Summary lists.
   *
   * **Computed, never stored.** A stored readiness check goes stale the moment somebody edits a
   * node, and a reviewer trusting a stale one is worse off than one reading none.
   *
   * `readyToAssign` is a **report**, not permission. Prompt 23 owns Approve & Assign and will make
   * its own decision; this tells a manager what stands in the way. Blockers are things that would
   * put unperformable work in front of people; warnings are things worth knowing.
   */
  async prePublishSummary(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<PrePublishSummary> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId, input.versionId);
    await this.assertOnObjective(context, loaded.objective, 'View');

    const graph = this.graphOf(loaded.draft);
    const findings: ReadinessFinding[] = [];

    const humanNodes = graph.nodes.filter((node) => node.kind === 'Human');
    const aiNodes = graph.nodes.filter((node) => node.kind === 'Ai');
    const approvalGates = graph.nodes.filter((node) => node.kind === 'Approval');

    // ---- Affected employees ----
    const affectedUserIds = [
      ...new Set(
        humanNodes
          .map((node) => node.ownerUserId)
          .filter((userId): userId is string => userId !== null),
      ),
    ];

    for (const node of humanNodes) {
      if (node.ownerUserId === null) {
        findings.push({
          severity: 'Blocker',
          nodeId: node.id,
          summary:
            'This human step has no owner. Publishing it would put work in front of nobody, and ' +
            'nobody would be accountable for it.',
        });
      }
    }

    // ---- New versus reusable Skills ----
    const nodesNeedingNewSkill = aiNodes
      .filter((node) => node.skillVersionId === null)
      .map((node) => node.id);
    const nodesReusingSkill = aiNodes
      .filter((node) => node.skillVersionId !== null)
      .map((node) => node.id);
    const skillVersionIds = [
      ...new Set(
        aiNodes
          .map((node) => node.skillVersionId)
          .filter((versionId): versionId is string => versionId !== null),
      ),
    ];

    for (const nodeId of nodesNeedingNewSkill) {
      findings.push({
        severity: 'Blocker',
        nodeId,
        summary:
          'This AI step has no approved, published Skill behind it. It cannot run until one is ' +
          'authored and approved.',
      });
    }

    // ---- Missing connections ----
    const neededTools = [...new Set(graph.nodes.flatMap((node) => node.dod.tools))];
    const missingConnections = await this.missingConnectionsFor(input.scope, neededTools);

    for (const category of missingConnections) {
      findings.push({
        severity: 'Blocker',
        nodeId: null,
        summary:
          `The plan needs a "${category}" tool but no live connection provides it. Configure and ` +
          'connect one, or remove the need.',
      });
    }

    // ---- High-risk actions ----
    const highRiskNodes = graph.nodes
      .filter((node) =>
        node.dod.tools.some((tool) =>
          (HIGH_RISK_TOOL_CATEGORIES as readonly string[]).includes(tool),
        ),
      )
      .map((node) => node.id);

    for (const nodeId of highRiskNodes) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      const gated =
        node?.dod.approval !== null ||
        graph.edges.some(
          (edge) =>
            edge.fromNodeId === nodeId &&
            graph.nodes.find((candidate) => candidate.id === edge.toNodeId)?.kind === 'Approval',
        );

      findings.push({
        // A high-risk step behind an approval is a decision the company has made; one with no
        // gate at all is the case worth stopping for.
        severity: gated ? 'Warning' : 'Blocker',
        nodeId,
        summary: gated
          ? 'This step performs a high-risk action. It is behind an approval.'
          : 'This step performs a high-risk action with no approval gate in front of it.',
      });
    }

    // ---- Workload conflicts ----
    const workloadConflicts = this.workloadConflicts(graph);
    for (const conflict of workloadConflicts) {
      findings.push({
        severity: 'Warning',
        nodeId: null,
        summary:
          `${conflict.nodeIds.length} steps are assigned to the same person to run at the same ` +
          'time. One of them will wait.',
      });
    }

    // ---- Incomplete fields ----
    const incompleteNodes = graph.nodes
      .map((node) => ({ nodeId: node.id, missing: incompleteDodFields(node.dod) }))
      .filter((entry) => entry.missing.length > 0);

    for (const entry of incompleteNodes) {
      findings.push({
        severity: 'Warning',
        nodeId: entry.nodeId,
        summary: `Definition of Done is missing: ${entry.missing.join(', ')}.`,
      });
    }

    const readyToAssign = !findings.some((finding) => finding.severity === 'Blocker');

    return {
      affectedUserIds,
      humanNodeCount: humanNodes.length,
      aiNodeCount: aiNodes.length,
      approvalGateCount: approvalGates.length,
      skillVersionIds,
      nodesNeedingNewSkill,
      nodesReusingSkill,
      missingConnections,
      highRiskNodes,
      estimatedUsage: graph.usage,
      workloadConflicts,
      incompleteNodes,
      findings,
      readyToAssign,
      note:
        'This is a readiness report, not permission. Approve & Assign is the transaction that ' +
        'hands the work out, and nothing is published until it runs. Warnings do not block; ' +
        'blockers describe work nobody could perform.',
    };
  }

  /** The current draft, for a screen. `objective:View`. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<WorkflowDraftView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId, input.versionId);
    await this.assertOnObjective(context, loaded.objective, 'View');
    return this.viewOf(loaded.draft);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One edit, with every check every edit needs.
   *
   * The shared shape is the point: each action differs only in what it does to the graph, and
   * writing them separately is how one of them ends up skipping the revision check, the
   * assigned-draft check or the whole-graph validation.
   */
  private async mutate(
    input: {
      scope: TenantScope;
      actorUserId: string;
      objectiveId: string;
      versionId?: string | undefined;
      revision: number;
    },
    change: (graph: WorkflowDraft) => { summary: string; action: string; nodeId?: string },
  ): Promise<WorkflowDraftView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, input.versionId, {
        alreadyInTransaction: true,
      });
      await this.assertOnObjective(context, loaded.objective, 'EditDraft');

      if (loaded.draft.assignedAt !== null) {
        throw new ConflictException(
          'This workflow has already been assigned. Editing what people are already working to ' +
            'is what versioning exists to prevent — open a new objective version instead.',
        );
      }

      if (loaded.draft.revision !== input.revision) {
        throw new ConflictException(
          `Somebody else edited this workflow: you have revision ${input.revision} and it is now ` +
            `at ${loaded.draft.revision}. Reload before editing so their change is not lost.`,
        );
      }

      const graph = this.graphOf(loaded.draft);
      const outcome = change(graph);

      // The whole graph, every time. Validating only the changed node would let the draft rot one
      // edit at a time, and the failure would surface on an unrelated edit later.
      const problems = validateWorkflowDraft(graph);
      if (problems.length > 0) {
        throw new BadRequestException(problems.join(' '));
      }

      const saved = await this.prisma.client.objectiveWorkflowDraft.update({
        where: { id: loaded.draft.id },
        data: {
          graph: graph as unknown as object,
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          revision: { increment: 1 },
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: outcome.action,
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: loaded.objective.code,
        resourceVersion: saved.version,
        summary: outcome.summary,
        metadata: {
          draftId: saved.id,
          revision: saved.revision,
          ...(outcome.nodeId === undefined ? {} : { nodeId: outcome.nodeId }),
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        },
      });

      return this.viewOf(saved);
    });
  }

  private async locate(
    objectiveId: string,
    versionId: string | undefined,
  ): Promise<{ objective: Objective; versionId: string }> {
    const objective = await this.prisma.client.objective.findUnique({ where: { id: objectiveId } });
    if (!objective) {
      throw new NotFoundException('There is no such objective you can see.');
    }

    if (versionId !== undefined) {
      const named = await this.prisma.client.objectiveVersion.findUnique({
        where: { id: versionId },
      });
      if (!named || named.objectiveId !== objective.id) {
        throw new NotFoundException('There is no such version of this objective.');
      }
      return { objective, versionId: named.id };
    }

    // The version being planned: the one in `WorkflowDraft`, else the newest editable one.
    const versions = await this.prisma.client.objectiveVersion.findMany({
      // Named for `(tenant_id, objective_id, version_number DESC)` (ADR-271).
      // From the objective already loaded under RLS, because `locate` takes no scope — and a row
      // RLS returned carries the only tenant this call can legitimately be about.
      where: { tenantId: objective.tenantId, objectiveId: objective.id },
      orderBy: { versionNumber: 'desc' },
    });
    const target =
      versions.find((version) => version.status === 'WorkflowDraft') ??
      versions.find((version) => version.status === 'AiAnalysis') ??
      versions[0];

    if (!target) {
      throw new ConflictException('This objective has no version to plan.');
    }
    return { objective, versionId: target.id };
  }

  private async load(
    scope: TenantScope,
    objectiveId: string,
    versionId: string | undefined,
    options: { alreadyInTransaction?: boolean } = {},
  ): Promise<{ objective: Objective; draft: ObjectiveWorkflowDraft }> {
    const read = async () => {
      const { objective, versionId: resolved } = await this.locate(objectiveId, versionId);
      const draft = await this.prisma.client.objectiveWorkflowDraft.findFirst({
        where: { objectiveVersionId: resolved },
      });
      if (!draft) {
        throw new NotFoundException(
          'This version has no workflow draft yet. Open the workflow editor to create one from ' +
            'the analysis.',
        );
      }
      return { objective, draft };
    };

    // Reading outside a tenant transaction returns nothing under Row-Level Security.
    return options.alreadyInTransaction === true
      ? read()
      : this.prisma.runInTenantTransaction(scope, read);
  }

  /** The stored graph, lifted to the current schema, or a refusal. */
  private graphOf(draft: ObjectiveWorkflowDraft): WorkflowDraft {
    const graph = upgradeWorkflowDraft(draft.graph);
    if (graph === null) {
      throw new ConflictException(
        `This workflow draft was written with schema version ${draft.schemaVersion}, which this ` +
          'build does not read. It is refused rather than guessed at.',
      );
    }
    return graph;
  }

  private nodeOrThrow(graph: WorkflowDraft, nodeId: string): AnalysisNode {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      throw new NotFoundException(`There is no node ${nodeId} in this workflow.`);
    }
    return node;
  }

  /** A node id nothing else uses. */
  private freshNodeId(graph: WorkflowDraft, kind: AnalysisNodeKind): string {
    const stem = kind.toLowerCase();
    let index = graph.nodes.filter((node) => node.id.startsWith(stem)).length + 1;
    while (graph.nodes.some((node) => node.id === `${stem}-${index}`)) {
      index += 1;
    }
    return `${stem}-${index}`;
  }

  /**
   * Tool categories the plan needs that no live tool grant provides.
   *
   * Reads the Prompt 16 grant table directly, because `ConnectionService` has no "which categories
   * are available" question — its `mayAgentUse` answers a narrower one, about a named agent and a
   * named connection, and an Engine Agent does not exist yet at this point in the plan.
   *
   * **A known limitation, stated rather than hidden:** this checks that a live *grant* exists for
   * the category, not that the connection behind it is currently `Connected`. Prompt 16 derives
   * connection state at read time from expiry and disablement, so a grant can outlive a usable
   * connection. The summary can therefore say a connection is present when it is expired. That is
   * the weaker of the two possible errors here — it produces a warning a manager can check rather
   * than blocking a plan that is fine — and closing it properly belongs with the Approve & Assign
   * transaction at Prompt 23, which is where a stale connection actually matters.
   */
  private async missingConnectionsFor(
    scope: TenantScope,
    neededTools: string[],
  ): Promise<string[]> {
    if (neededTools.length === 0) return [];

    const live = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionToolGrant.findMany({
        where: { revokedAt: null },
        select: { category: true },
      }),
    );
    const provided = new Set(live.map((grant) => grant.category as string));

    return neededTools.filter((tool) => !provided.has(tool));
  }

  /**
   * People assigned more than one step that the graph says runs at the same time.
   *
   * Only `Parallel` fan-outs count: two sequential steps for one person is a plan, not a conflict.
   * That distinction is why edges carry a kind.
   */
  private workloadConflicts(graph: WorkflowDraft): { userId: string; nodeIds: string[] }[] {
    const conflicts: { userId: string; nodeIds: string[] }[] = [];

    // Group parallel edges by their source: each group runs concurrently.
    const bySource = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.kind !== 'Parallel') continue;
      bySource.set(edge.fromNodeId, [...(bySource.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    }

    for (const targets of bySource.values()) {
      const byOwner = new Map<string, string[]>();
      for (const nodeId of targets) {
        const owner = graph.nodes.find((node) => node.id === nodeId)?.ownerUserId;
        if (owner === null || owner === undefined) continue;
        byOwner.set(owner, [...(byOwner.get(owner) ?? []), nodeId]);
      }
      for (const [userId, nodeIds] of byOwner) {
        if (nodeIds.length > 1) {
          conflicts.push({ userId, nodeIds });
        }
      }
    }

    return conflicts;
  }

  private async assertOnObjective(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    objective: Objective,
    action: 'View' | 'EditDraft' | 'Assign',
  ): Promise<void> {
    await this.authorization.assertCan(context, {
      module: 'objective',
      action,
      resource: {
        id: objective.id,
        ownerUserId: objective.objectiveOwnerUserId,
        departmentId: objective.departmentId,
        ...(objective.createdByUserId === null
          ? {}
          : { createdByUserId: objective.createdByUserId }),
      },
    });
  }

  private viewOf(draft: ObjectiveWorkflowDraft): WorkflowDraftView {
    return {
      id: draft.id,
      objectiveId: draft.objectiveId,
      objectiveVersionId: draft.objectiveVersionId,
      seededFromRunId: draft.seededFromRunId,
      graph: this.graphOf(draft),
      schemaVersion: draft.schemaVersion,
      revision: draft.revision,
      assignedAt: draft.assignedAt?.toISOString() ?? null,
      assignedByUserId: draft.assignedByUserId,
      editable: draft.assignedAt === null,
      note:
        'This is the workflow the company is shaping. The AI analysis it was seeded from is kept ' +
        'unchanged as the record of what was proposed. Nothing here publishes: Approve & Assign ' +
        'is a separate transaction.',
    };
  }
}
