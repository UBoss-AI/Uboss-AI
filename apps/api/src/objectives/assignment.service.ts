import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ASSIGNMENT_CHECK_LABELS,
  incompleteDodFields,
  isObjectiveWorkAssignable,
  upgradeWorkflowDraft,
  validateWorkflowDraft,
  type AgentSetupPrefill,
  type AnalysisNode,
  type AssignmentCheck,
  type AssignmentRefusal,
  type ObjectiveStatus,
  type WorkflowDraft,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

import { WorkflowEditorService } from './workflow-editor.service.js';

/** What Approve & Assign produced. */
export interface AssignmentResult {
  objectiveId: string;
  objectiveVersionId: string;
  versionNumber: number;
  workflowDraftId: string;
  humanTaskIds: string[];
  aiAssignmentIds: string[];
  approvalRequestIds: string[];
  executorExpectationIds: string[];
  /** AI steps that still need Agent Builder setup, so the caller can send somebody there. */
  nodesAwaitingAgentSetup: string[];
  notificationsRaised: number;
  note: string;
}

/**
 * Approve & Assign — the transactional boundary between a plan and actual work.
 *
 * ## Why this is one transaction and not seven steps
 *
 * Publishing a workflow creates human tasks, AI assignments, approval requests and monitoring
 * expectations, and moves the objective version live. Half of that is worse than none: people
 * assigned work for a version that never went live, or a live version whose approval gate nobody
 * was asked to pass. Every row this creates is written inside one `runInTenantTransaction`, so a
 * failure at any point leaves the company exactly where it started. Notifications are sent
 * **after** the commit, because telling an approver about work that then rolled back is worse
 * than telling them a moment late.
 *
 * ## Validation happens before anything is written
 *
 * The client lists seven checks. All of them run first and **all** failures are collected, because
 * a manager fixing one blocker at a time and re-running is a bad afternoon. The refusal names the
 * check and the node.
 *
 * ## Retrying is safe
 *
 * Every row this creates is unique on `(tenant, version, node)`. A retry after a partial network
 * failure cannot produce a second copy of somebody's work, and the assigned draft is frozen by a
 * database trigger the moment this succeeds.
 *
 * ## What this deliberately does not do
 *
 *   * **It does not approve.** The version must already be approved. Nothing goes live without an
 *     approval and approving is a separate act with its own permission — the Manager who assigns
 *     usually does not hold it. Refusing with a clear message is better than quietly approving on
 *     somebody's behalf.
 *   * **It does not create Engine Agents.** Recurring work creates Runs, not agents. An AI node
 *     either maps to an agent that already exists or records that setup is still needed.
 *   * **It does not execute anything.** The Run Engine is a later prompt.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly notifications: NotificationService,
    /// Reused rather than re-derived: the readiness rules live with the editor that shows them.
    private readonly workflow: WorkflowEditorService,
  ) {}

  /**
   * Publish an approved workflow and assign the work in it.
   *
   * `objective:Assign` — the action the role templates give a Manager, which is who the client's
   * journey has doing this.
   */
  async approveAndAssign(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    /**
     * Acknowledge the plan's warnings. Recorded on the audit event; it does not gate anything,
     * because a warning that blocked would be a blocker. Blockers are never acceptable this way.
     */
    acceptWarnings?: boolean | undefined;
  }): Promise<AssignmentResult> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Assign' });

    // ---- Phase 1: read the state, outside any write transaction ----
    //
    // The readiness summary and the notification engine both establish their own scope, and
    // `runAsPlatformOperation` **refuses** to escalate from inside a tenant transaction. So this
    // is three phases rather than one: read, validate, then write. The write phase re-checks
    // every invariant it depends on, which is what actually makes it safe — a validation result
    // computed a moment earlier is advice, and the transaction trusts only what it re-reads.
    const loaded = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const objective = await this.prisma.client.objective.findFirst({
        where: { id: input.objectiveId },
      });
      if (objective === null) {
        throw new NotFoundException('There is no such objective you can see.');
      }

      await this.authorization.assertCan(context, {
        module: 'objective',
        action: 'Assign',
        resource: {
          id: objective.id,
          ownerUserId: objective.objectiveOwnerUserId,
          departmentId: objective.departmentId,
          ...(objective.createdByUserId === null
            ? {}
            : { createdByUserId: objective.createdByUserId }),
        },
      });

      const draft = await this.prisma.client.objectiveWorkflowDraft.findFirst({
        where:
          input.versionId === undefined
            ? { objectiveId: objective.id }
            : { objectiveVersionId: input.versionId },
        orderBy: { createdAt: 'desc' },
      });
      if (draft === null) {
        throw new NotFoundException(
          'This objective has no workflow to assign. Analyse it and open the workflow editor ' +
            'first.',
        );
      }
      if (draft.assignedAt !== null) {
        throw new ConflictException(
          'This workflow has already been assigned. Assigning it again would create a second ' +
            'copy of work people are already doing; an authorised change opens a new objective ' +
            'version.',
        );
      }

      const version = await this.prisma.client.objectiveVersion.findFirst({
        where: { id: draft.objectiveVersionId },
      });
      if (version === null) {
        throw new NotFoundException('The version this workflow plans no longer exists.');
      }

      const graph = upgradeWorkflowDraft(draft.graph);
      if (graph === null) {
        throw new ConflictException(
          `This workflow was written with schema version ${draft.schemaVersion}, which this ` +
            'build does not read. Re-open and re-save it before assigning.',
        );
      }

      return { objective, draft, version, graph };
    });

    // ---- Phase 2: the client's seven checks, all of them, before anything is written ----
    const { refusals, budgetNote } = await this.validate({
      scope: input.scope,
      actorUserId: input.actorUserId,
      objectiveId: loaded.objective.id,
      versionId: loaded.draft.objectiveVersionId,
      versionStatus: loaded.version.status,
      versionApprovedAt: loaded.version.approvedAt,
      graph: loaded.graph,
    });

    if (refusals.length > 0) {
      throw new BadRequestException(
        'This workflow cannot be assigned yet.\n' +
          refusals
            .map(
              (refusal) =>
                `• ${ASSIGNMENT_CHECK_LABELS[refusal.check]}` +
                (refusal.nodeId === null ? '' : ` (${refusal.nodeId})`) +
                `: ${refusal.reason}`,
            )
            .join('\n'),
      );
    }

    // ---- Phase 3: write everything, in one transaction ----
    const graph = loaded.graph;
    const committed = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const objective = loaded.objective;

      // Re-read the two rows the decision hinges on. Between phase one and here somebody else
      // could have assigned this plan, and the uniqueness constraints would then refuse
      // half-way through — a correct outcome reached by an unreadable route.
      const draft = await this.prisma.client.objectiveWorkflowDraft.findUniqueOrThrow({
        where: { id: loaded.draft.id },
      });
      if (draft.assignedAt !== null) {
        throw new ConflictException(
          'This workflow was assigned by somebody else while this request was being checked.',
        );
      }

      const version = await this.prisma.client.objectiveVersion.findUniqueOrThrow({
        where: { id: loaded.version.id },
      });
      if (version.approvedAt === null) {
        throw new ConflictException(
          'This version is no longer approved. Nothing goes live without an approval on record.',
        );
      }
      if (version.status === 'Active') {
        throw new ConflictException('This version is already live.');
      }

      // ---- Publish the version ----
      const previous = await this.prisma.client.objectiveVersion.findFirst({
        // Named for the partial index `(tenant_id, objective_id) WHERE status = 'Active'`, which
        // is unreachable without the tenant column. RLS still does the confining (ADR-271).
        where: { tenantId: input.scope.tenantId, objectiveId: objective.id, status: 'Active' },
      });
      if (previous !== null && previous.id !== version.id) {
        // The live pointer holds a key to the version being archived, so it is cleared first.
        await this.prisma.client.objective.update({
          where: { id: objective.id },
          data: { activeVersionId: null },
        });
        await this.prisma.client.objectiveVersion.update({
          where: { id: previous.id },
          data: { status: 'Archived', version: { increment: 1 } },
        });
      }

      const published = await this.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: { status: 'Active', publishedAt: new Date(), version: { increment: 1 } },
      });

      await this.prisma.client.objective.update({
        where: { id: objective.id },
        data: {
          activeVersionId: published.id,
          departmentId: published.departmentId,
          objectiveOwnerUserId: published.objectiveOwnerUserId,
          version: { increment: 1 },
        },
      });

      // ---- Turn the graph into work ----
      const assignedAt = new Date();
      const humanTaskIds: string[] = [];
      const aiAssignmentIds: string[] = [];
      const approvalRequestIds: string[] = [];
      const executorExpectationIds: string[] = [];
      const nodesAwaitingAgentSetup: string[] = [];
      const notifiedApprovers: { userId: string; approvalId: string; title: string }[] = [];

      for (const node of graph.nodes) {
        if (node.kind === 'Human') {
          const dueAt = this.dueTimeFor(node, published.targetCompletionTime, published.timeUnit);

          const task = await this.prisma.client.humanTask.create({
            data: {
              tenantId: input.scope.tenantId,
              objectiveId: objective.id,
              objectiveVersionId: published.id,
              workflowDraftId: draft.id,
              nodeId: node.id,
              title: node.label,
              // Checked above: a human node with no owner is a blocker, so this is never null.
              assignedToUserId: node.ownerUserId as string,
              assignedByUserId: input.actorUserId,
              inputDescription: this.inputDescriptionFor(node, graph),
              ...(dueAt === null ? {} : { dueAt }),
              triggerDescription: node.triggerEvent ?? '',
              expectedOutput: node.dod.expectedOutput,
              evidenceRequirement: node.dod.evidence,
              dependsOnNodeIds: node.dod.dependencies,
              ...(node.dod.approval === null ? {} : { approvalKind: node.dod.approval }),
              status: 'Assigned',
            },
          });
          humanTaskIds.push(task.id);

          // The Executor is told what to watch. An expectation nobody recorded cannot be unmet.
          if (dueAt !== null) {
            const expectation = await this.prisma.client.executorExpectation.create({
              data: {
                tenantId: input.scope.tenantId,
                objectiveId: objective.id,
                objectiveVersionId: published.id,
                nodeId: node.id,
                kind: 'HumanTaskOverdue',
                subjectType: 'HumanTask',
                subjectId: task.id,
                detail: `"${node.label}" is due by ${dueAt.toISOString()}.`,
                dueAt,
                registeredByUserId: input.actorUserId,
              },
            });
            executorExpectationIds.push(expectation.id);
          }

          if (node.dod.evidence.trim() !== '') {
            const expectation = await this.prisma.client.executorExpectation.create({
              data: {
                tenantId: input.scope.tenantId,
                objectiveId: objective.id,
                objectiveVersionId: published.id,
                nodeId: node.id,
                kind: 'MissingCompletionEvidence',
                subjectType: 'HumanTask',
                subjectId: task.id,
                detail: `"${node.label}" requires evidence: ${node.dod.evidence}`,
                registeredByUserId: input.actorUserId,
              },
            });
            executorExpectationIds.push(expectation.id);
          }
          continue;
        }

        if (node.kind === 'Ai') {
          const prefill: AgentSetupPrefill = {
            suggestedAgentName: node.label,
            objectiveCode: objective.code,
            objectiveName: published.objectiveName,
            assignedWork: node.label,
            // The person the plan named for this step, and only then the objective owner. The
            // source document prefills an "employee/business owner" and has the employee complete
            // their own agent's setup; defaulting straight to the objective owner put every
            // agent in front of the manager instead, and an `OwnWork` employee could not reach
            // the work assigned to them.
            ownerUserId: node.ownerUserId ?? published.objectiveOwnerUserId,
            skillVersionIds: node.skillVersionId === null ? [] : [node.skillVersionId],
            toolCategories: node.dod.tools,
            approvalRequired: node.dod.approval !== null && node.dod.approval !== 'NotRequired',
            completionEvidence: node.dod.evidence,
          };

          const assignment = await this.prisma.client.aiWorkAssignment.create({
            data: {
              tenantId: input.scope.tenantId,
              objectiveId: objective.id,
              objectiveVersionId: published.id,
              workflowDraftId: draft.id,
              nodeId: node.id,
              title: node.label,
              // Always awaiting setup at this prompt: the Engine Agent registry does not exist
              // yet, so there is nothing to map to. The mapping branch is a column and a
              // constraint, ready for the registry prompt — claiming a mapping now would be a
              // lie the "OR existing approved reusable Engine Agent" branch does not license.
              status: 'AwaitingAgentSetup',
              setupPrefill: prefill as unknown as object,
              assignedByUserId: input.actorUserId,
            },
          });
          aiAssignmentIds.push(assignment.id);
          nodesAwaitingAgentSetup.push(node.id);

          for (const category of node.dod.tools) {
            const expectation = await this.prisma.client.executorExpectation.create({
              data: {
                tenantId: input.scope.tenantId,
                objectiveId: objective.id,
                objectiveVersionId: published.id,
                nodeId: node.id,
                kind: 'ConnectionRequired',
                subjectType: 'AiWorkAssignment',
                subjectId: assignment.id,
                detail: `"${node.label}" needs a live "${category}" connection to run.`,
                registeredByUserId: input.actorUserId,
              },
            });
            executorExpectationIds.push(expectation.id);
            // One expectation per node per kind, so the first tool category stands for the node.
            break;
          }
          continue;
        }

        if (node.kind === 'Approval') {
          const approval = await this.prisma.client.approvalRequest.create({
            data: {
              tenantId: input.scope.tenantId,
              type: 'WorkflowStepApproval',
              status: 'Pending',
              title: node.label,
              detail:
                `Approval gate in ${objective.code} V${published.versionNumber}. ` +
                (node.dod.expectedOutput.trim() === ''
                  ? 'The plan records no expected output for this gate.'
                  : `Expected output: ${node.dod.expectedOutput}`),
              subjectType: 'ObjectiveWorkflowNode',
              objectiveId: objective.id,
              objectiveVersionId: published.id,
              workflowNodeId: node.id,
              requestedByUserId: input.actorUserId,
              ...(node.ownerUserId === null ? {} : { namedApproverUserId: node.ownerUserId }),
              ...(node.approvalKind === null || node.approvalKind === 'NotRequired'
                ? {}
                : { approverRoleKind: node.approvalKind }),
            },
          });
          approvalRequestIds.push(approval.id);

          const expectation = await this.prisma.client.executorExpectation.create({
            data: {
              tenantId: input.scope.tenantId,
              objectiveId: objective.id,
              objectiveVersionId: published.id,
              nodeId: node.id,
              kind: 'ApprovalPending',
              subjectType: 'ApprovalRequest',
              subjectId: approval.id,
              detail: `"${node.label}" is waiting on an approval decision.`,
              registeredByUserId: input.actorUserId,
            },
          });
          executorExpectationIds.push(expectation.id);

          if (node.ownerUserId !== null) {
            notifiedApprovers.push({
              userId: node.ownerUserId,
              approvalId: approval.id,
              title: node.label,
            });
          }
        }
      }

      // ---- Freeze the plan ----
      await this.prisma.client.objectiveWorkflowDraft.update({
        where: { id: draft.id },
        data: {
          assignedAt,
          assignedByUserId: input.actorUserId,
          revision: { increment: 1 },
          version: { increment: 1 },
        },
      });

      // ---- Audit ----
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.approved_and_assigned',
        resourceType: 'objective',
        resourceId: objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${objective.code} V${published.versionNumber}`,
        resourceVersion: published.version,
        summary:
          `Assigned V${published.versionNumber}: ${humanTaskIds.length} human task(s), ` +
          `${aiAssignmentIds.length} AI assignment(s), ${approvalRequestIds.length} approval(s). ` +
          'The version is now live and the workflow is frozen.',
        metadata: {
          versionId: published.id,
          versionNumber: published.versionNumber,
          workflowDraftId: draft.id,
          humanTaskCount: humanTaskIds.length,
          aiAssignmentCount: aiAssignmentIds.length,
          approvalRequestCount: approvalRequestIds.length,
          executorExpectationCount: executorExpectationIds.length,
          supersededVersionId: previous?.id ?? null,
          // Audit metadata takes scalars, so the node list travels as text rather than silently
          // stringifying into [object Object].
          nodesAwaitingAgentSetup: nodesAwaitingAgentSetup.join(', '),
          // Recorded rather than enforced. See the budget check: the estimate cannot be priced
          // against a currency allowance yet, and the manager's acceptance of the plan's
          // warnings is worth having on the record even though warnings do not block.
          budgetCheck: budgetNote,
          warningsAccepted: input.acceptWarnings === true,
        },
      });

      return {
        objectiveId: objective.id,
        objectiveVersionId: published.id,
        versionNumber: published.versionNumber,
        workflowDraftId: draft.id,
        humanTaskIds,
        aiAssignmentIds,
        approvalRequestIds,
        executorExpectationIds,
        nodesAwaitingAgentSetup,
        notifiedApprovers,
      };
    });

    // ---- Phase 4: tell the people now waiting on a decision ----
    //
    // After the commit, deliberately. A notification is an outward-facing side effect: sending it
    // inside a transaction that might still roll back would tell an approver about work that was
    // never assigned. This way round, a failed notification leaves a correct assignment somebody
    // can be reminded about — which is the recoverable failure of the two.
    //
    // Approvers are told because somebody is now waiting on them and nothing in their day would
    // otherwise say so. Assignees get no separate notification: the approved catalogue has no
    // assignment kind, and its `Overdue` kind is explicitly this prompt's — new work appears in
    // the To-do list, and lateness is what raises an alert. Adding a seventh kind would change an
    // approved vocabulary with no source asking for it.
    let notificationsRaised = 0;
    for (const approver of committed.notifiedApprovers) {
      const raised = await this.notifications.raise({
        tenantId: input.scope.tenantId,
        recipientUserId: approver.userId,
        kind: 'ApprovalWaiting',
        title: `Approval needed: ${approver.title}`,
        body:
          `${loaded.objective.code} V${committed.versionNumber} was assigned and this step is ` +
          'waiting on your decision.',
        deepLink: `/approvals/${approver.approvalId}`,
        resourceType: 'approval_request',
        resourceId: approver.approvalId,
        isAssignedToRecipient: true,
        dedupeKey: `approval-request:${approver.approvalId}`,
      });
      if (raised.notification !== null) notificationsRaised += 1;
    }

    return {
      objectiveId: committed.objectiveId,
      objectiveVersionId: committed.objectiveVersionId,
      versionNumber: committed.versionNumber,
      workflowDraftId: committed.workflowDraftId,
      humanTaskIds: committed.humanTaskIds,
      aiAssignmentIds: committed.aiAssignmentIds,
      approvalRequestIds: committed.approvalRequestIds,
      executorExpectationIds: committed.executorExpectationIds,
      nodesAwaitingAgentSetup: committed.nodesAwaitingAgentSetup,
      notificationsRaised,
      // Conditional, because a note that mentions AI steps to a plan that has none is a small
      // untruth on a screen somebody reads once and believes.
      note:
        committed.nodesAwaitingAgentSetup.length === 0
          ? 'The workflow is live and frozen. All of its work is human, so nothing waits on an ' +
            'agent.'
          : `The workflow is live and frozen. ${committed.nodesAwaitingAgentSetup.length} AI ` +
            'step(s) await Agent Builder setup; nothing runs until an agent is configured and ' +
            'activated.',
    };
  }

  // -------------------------------------------------------------------------
  // The seven checks
  // -------------------------------------------------------------------------

  /**
   * Everything the client requires before a publish, collected rather than short-circuited.
   *
   * Returning all failures at once is the whole design: a manager who fixes one blocker, re-runs,
   * and hits the next is being told the truth one seventh at a time.
   */
  private async validate(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId: string;
    versionStatus: string;
    versionApprovedAt: Date | null;
    graph: WorkflowDraft;
  }): Promise<{ refusals: AssignmentRefusal[]; budgetNote: string }> {
    const refusals: AssignmentRefusal[] = [];
    const refuse = (check: AssignmentCheck, nodeId: string | null, reason: string) =>
      refusals.push({ check, nodeId, reason });

    // 1. Workflow schema and version.
    for (const problem of validateWorkflowDraft(input.graph)) {
      refuse('WorkflowSchemaVersion', null, problem);
    }

    if (isObjectiveWorkAssignable(input.versionStatus as ObjectiveStatus)) {
      refuse(
        'WorkflowSchemaVersion',
        null,
        'This version is already live. Assigning it again would duplicate work people are doing.',
      );
    }

    // 2. Owners and assignees, and 4. required approvals.
    for (const node of input.graph.nodes) {
      const missing = incompleteDodFields(node.dod);
      if (missing.length > 0) {
        refuse(
          'OwnersAndAssignees',
          node.id,
          `Its Definition of Done is incomplete: ${missing.join(', ')} not stated.`,
        );
      }

      if (node.kind === 'Human' && node.ownerUserId === null) {
        refuse(
          'OwnersAndAssignees',
          node.id,
          'No owner. Publishing would put work in front of nobody.',
        );
      }

      if (node.kind === 'Ai' && node.skillVersionId === null) {
        refuse(
          'RequiredApprovals',
          node.id,
          'No approved, published Skill stands behind this AI step, so nothing could perform it.',
        );
      }

      if (node.kind === 'Approval' && node.ownerUserId === null && node.approvalKind === null) {
        refuse(
          'RequiredApprovals',
          node.id,
          'This approval gate names neither an approver nor a role, so nobody would be asked.',
        );
      }
    }

    // 3. Permissions: every assignee must still be able to receive work here.
    const assigneeIds = [
      ...new Set(
        input.graph.nodes
          .filter((node) => node.kind === 'Human')
          .map((node) => node.ownerUserId)
          .filter((userId): userId is string => userId !== null),
      ),
    ];

    // Scoped explicitly, and read one at a time.
    //
    // Both halves have bitten this codebase before. An unscoped read under Row-Level Security
    // returns nothing rather than failing, which here reads as "this person has no active
    // membership" and refuses a perfectly valid publish. And `Promise.all` inside an open
    // interactive transaction loses the AsyncLocalStorage scope, producing the same empty result
    // by a different route. This block ran outside a transaction at first and did exactly that —
    // the comment warning about it was already here.
    const inactiveAssignees = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const inactive: string[] = [];
      for (const userId of assigneeIds) {
        const membership = await this.prisma.client.tenantMembership.findFirst({
          where: { userId, accountState: 'Active' },
        });
        if (membership === null) inactive.push(userId);
      }
      return inactive;
    });

    for (const userId of inactiveAssignees) {
      refuse(
        'Permissions',
        null,
        `A step is assigned to somebody with no active membership in this company (${userId}).`,
      );
    }

    // 5. Missing config / connection readiness, 6. budget, 7. prohibited high-risk paths.
    //
    // Reused from the Pre-Publish Summary rather than re-derived. Two implementations of
    // "is this ready?" would eventually disagree, and the one the manager read on screen is the
    // one they are entitled to rely on.
    const summary = await this.workflow.prePublishSummary({
      scope: input.scope,
      actorUserId: input.actorUserId,
      objectiveId: input.objectiveId,
      versionId: input.versionId,
    });

    for (const category of summary.missingConnections) {
      refuse(
        'ConnectionReadiness',
        null,
        `The plan needs a "${category}" tool and no live connection provides one.`,
      );
    }

    for (const finding of summary.findings) {
      if (finding.severity !== 'Blocker') continue;
      if (!/high-risk/.test(finding.summary)) continue;
      refuse('NoProhibitedHighRiskPath', finding.nodeId, finding.summary);
    }

    // 6. Budget estimate policy — evaluated honestly, which today means not evaluated.
    //
    // The company's budget policy is denominated in **money minor units** (a monthly allowance, an
    // approval threshold, a hard stop). The plan's estimate is in **tokens**, and no provider
    // pricing exists until the AI Provider Profiles prompt. Converting one to the other would mean
    // inventing a price, and inventing a price next to a hard-stop threshold is the worst place in
    // the product to guess.
    //
    // So this check reports that it could not be evaluated and **permits**. That is the right
    // default here and not merely the convenient one: the hard stop is enforced when work actually
    // runs — the Run Engine prompt has a `Blocked by Budget` run state for exactly this — so
    // refusing every publish until pricing exists would block the product to protect a limit that
    // is already protected downstream. The unevaluated outcome is recorded in the audit rather
    // than reported as a pass.
    const budgetPolicy = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tenantAiBudgetPolicy.findFirst({}),
    );

    const budgetNote =
      budgetPolicy === null
        ? 'No AI budget policy is configured, so there is no limit to check the estimate against.'
        : 'A budget policy is configured in currency and the estimate is in tokens. No provider ' +
          'pricing exists yet, so the estimate cannot be priced against the allowance. The hard ' +
          'stop is enforced when work runs.';

    // Warnings do not block. `PrePublishSummary` already says so, and the previous version of this
    // code refused every warning under the budget check — which both blocked publishes for
    // non-budget reasons and told the manager the wrong thing about why. An explicit acceptance is
    // still worth recording, so it goes to the audit rather than to a gate.

    // The version must already be approved. Approving is a separate act with its own permission,
    // and the Manager who assigns usually does not hold it — quietly approving on somebody's
    // behalf is exactly the substitution the Executor Agent rule forbids elsewhere.
    if (input.versionApprovedAt === null) {
      refuse(
        'RequiredApprovals',
        null,
        'This version has not been approved. Approving and assigning are separate acts, and ' +
          'nothing goes live without an approval on record.',
      );
    }

    return { refusals, budgetNote };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * When a task is due.
   *
   * Derived from the objective's own target completion time, because that is the only deadline
   * Form 2 records. Returning null when the objective set none is deliberate: a task with an
   * invented due date would be reported overdue against a date nobody agreed to.
   */
  private dueTimeFor(
    _node: AnalysisNode,
    targetCompletionTime: number | null,
    timeUnit: string | null,
  ): Date | null {
    if (targetCompletionTime === null || timeUnit === null) return null;

    const days =
      timeUnit === 'Hours'
        ? targetCompletionTime / 24
        : timeUnit === 'Weeks'
          ? targetCompletionTime * 7
          : timeUnit === 'Months'
            ? targetCompletionTime * 30
            : // `Days` and `WorkingDays`. Working days are not calendar days, but no working
              // calendar is modelled yet, so this is a calendar approximation — and it is the
              // reason the Executor's overdue expectation quotes the date it was given.
              targetCompletionTime;

    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /** The client's "input" column: what the person works from, and where it comes from. */
  private inputDescriptionFor(node: AnalysisNode, graph: WorkflowDraft): string {
    const incoming = graph.edges
      .filter((edge) => edge.toNodeId === node.id)
      .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.fromNodeId))
      .filter((candidate): candidate is AnalysisNode => candidate !== undefined)
      .filter((candidate) => candidate.kind !== 'Goal');

    if (incoming.length === 0) {
      return 'No upstream step; start from the objective itself.';
    }

    return `From: ${incoming.map((candidate) => candidate.label).join(', ')}.`;
  }
}
