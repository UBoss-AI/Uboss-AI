import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_STAGE_LABELS,
  ANALYSIS_STAGES,
  analysisStageIndex,
  isReadableSchemaVersion,
  mayCancelAnalysis,
  upgradeWorkflowDraft,
  nodeShapeFor,
  validateWorkflowDraft,
  type AiUsageEstimate,
  type AnalysisEdge,
  type AnalysisNode,
  type AnalysisRisk,
  type AnalysisRunStatus,
  type AnalysisStage,
  type WorkflowDraft,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ObjectiveAnalysisRun, ObjectiveWorkflowStep } from '../generated/prisma/client.js';
import { ModelGateway } from '../model-gateway/model-gateway.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SkillRouterService } from '../skills/skill-router.service.js';

export interface AnalysisStageView {
  stage: AnalysisStage;
  label: string;
  state: 'done' | 'running' | 'todo';
}

export interface AnalysisRunView {
  id: string;
  objectiveId: string;
  objectiveVersionId: string;
  status: AnalysisRunStatus;
  statusLabel: string;
  stage: AnalysisStage | null;
  stagesCompleted: number;
  /** The seven stages with their state, so the panel renders real progress. */
  stages: AnalysisStageView[];
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  failureReason: string | null;
  /** Null until the run completes, or when this build cannot read its schema version. */
  draft: WorkflowDraft | null;
  schemaVersion: number;
  /** Set when a stored draft's schema is not readable by this build. */
  unreadableReason: string | null;
  /** An opaque capability label. **Never a provider or model name.** */
  modelCapability: string | null;
  /** **Whether a real model produced this.** False for every adapter that ships today. */
  producedByRealModel: boolean;
  promptTokens: number;
  completionTokens: number;
  note: string;
}

/** Everything one stage of the pipeline may read or add to. */
interface PipelineState {
  scope: TenantScope;
  actorUserId: string;
  runId: string;
  objectiveId: string;
  objectiveCode: string;
  departmentId: string;
  objectiveOwnerUserId: string;
  objectiveName: string;
  expectedFinalResult: string;
  steps: ObjectiveWorkflowStep[];
  /** Who is in the objective owner's reporting subtree, for owner assignment. */
  teamUserIds: string[];
  nodes: AnalysisNode[];
  edges: AnalysisEdge[];
  risks: AnalysisRisk[];
  gaps: string[];
  promptTokens: number;
  completionTokens: number;
  capability: string | null;
  producedByRealModel: boolean;
}

/**
 * Objective AI analysis — Analyze / Generate Workflow.
 *
 * ## The output is always a Draft
 *
 * This service proposes; it never publishes. It moves the objective version to `AiAnalysis` while
 * it works and to `WorkflowDraft` when it finishes, and both are pre-approval states. The only
 * path to live is the Prompt 20 approve-then-publish sequence, performed by people. Nothing here
 * can shorten it, and `objective_analysis_runs` deliberately has no approval columns at all.
 *
 * ## Every model call goes through the Model Gateway
 *
 * The client's locked rule. `ModelGateway` is the only way to reach a model, provider names never
 * leave it, and what ships is a mock whose responses carry `producedByRealModel: false`. That flag
 * is persisted on the run and reported on every read, so no screen or report can present mock
 * output as a model's judgement.
 *
 * ## The analysis decomposes Form 2 rather than inventing work
 *
 * Each node comes from a row of the objective's own workflow grid, and `fromStepPosition` records
 * which. That is the honest shape: the company wrote down its process, and the analysis reads it,
 * classifies it, matches Skills to the AI parts and assigns owners to the human parts. What it
 * **cannot** work out goes into `gaps` — an analysis that silently omitted its own blind spots
 * would look complete and be wrong, and the approved UI's own instruction is "no fake completion".
 *
 * ## Progress is durable and cancellation is real
 *
 * The reference promises that you can leave the screen and come back. So the run, its stage and
 * its counters are rows written at each stage boundary, and the pipeline re-reads its own status
 * between stages — a cancellation from another tab stops it at the next boundary rather than
 * being ignored.
 */
@Injectable()
export class ObjectiveAnalysisService {
  private readonly logger = new Logger(ObjectiveAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly organization: OrganizationRepository,
    private readonly skillRouter: SkillRouterService,
    private readonly modelGateway: ModelGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Starting and running
  // -------------------------------------------------------------------------

  /**
   * Analyse an objective version.
   *
   * `objective:EditDraft` — analysis produces a draft, and producing a draft is drafting. It is
   * deliberately not `Approve`: nothing here decides anything.
   */
  async start(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<AnalysisRunView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    const prepared = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const objective = await this.prisma.client.objective.findUnique({
        where: { id: input.objectiveId },
      });
      if (!objective) {
        throw new NotFoundException('There is no such objective you can see.');
      }

      await this.authorization.assertCan(context, {
        module: 'objective',
        action: 'EditDraft',
        resource: {
          id: objective.id,
          ownerUserId: objective.objectiveOwnerUserId,
          departmentId: objective.departmentId,
          ...(objective.createdByUserId === null
            ? {}
            : { createdByUserId: objective.createdByUserId }),
        },
      });

      const versions = await this.prisma.client.objectiveVersion.findMany({
        // Named for `(tenant_id, objective_id, version_number DESC)` (ADR-271).
        where: { tenantId: input.scope.tenantId, objectiveId: objective.id },
        include: { steps: { orderBy: { position: 'asc' } } },
        orderBy: { versionNumber: 'desc' },
      });

      const target =
        input.versionId === undefined
          ? versions.find(
              (version) =>
                version.status === 'Draft' ||
                version.status === 'UnderReview' ||
                version.status === 'AiAnalysis' ||
                version.status === 'WorkflowDraft',
            )
          : versions.find((version) => version.id === input.versionId);

      if (!target) {
        throw new ConflictException(
          'There is no version of this objective to analyse. Analysis runs on a draft; a live ' +
            'version is analysed by opening the next draft first.',
        );
      }

      if (target.steps.length === 0) {
        throw new BadRequestException(
          'This version has no workflow steps. The analysis decomposes the objective’s own ' +
            'Form 2 grid, so there is nothing to read.',
        );
      }

      const alreadyRunning = await this.prisma.client.objectiveAnalysisRun.findFirst({
        where: { objectiveVersionId: target.id, status: { in: ['Queued', 'Running'] } },
      });
      if (alreadyRunning) {
        throw new ConflictException(
          'An analysis of this version is already running. Cancel it before starting another.',
        );
      }

      const run = await this.prisma.client.objectiveAnalysisRun.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveId: objective.id,
          objectiveVersionId: target.id,
          status: 'Queued',
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          requestedByUserId: input.actorUserId,
        },
      });

      // The version enters `AiAnalysis` — a pre-approval state, so nothing becomes assignable.
      if (target.status === 'Draft' || target.status === 'UnderReview') {
        await this.prisma.client.objectiveVersion.update({
          where: { id: target.id },
          data: { status: 'AiAnalysis', version: { increment: 1 } },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.analysis_started',
        resourceType: 'objective',
        resourceId: objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${objective.code} V${target.versionNumber}`,
        summary:
          `Started AI analysis of V${target.versionNumber}. The output is a draft workflow; ` +
          'nothing goes live without a person approving and publishing it.',
        metadata: {
          runId: run.id,
          versionId: target.id,
          versionNumber: target.versionNumber,
          stepCount: target.steps.length,
          modelCapability: this.modelGateway.capability,
          usesRealModel: this.modelGateway.usesRealModel,
        },
      });

      return {
        runId: run.id,
        objective,
        version: target,
        steps: target.steps,
      };
    });

    await this.runPipeline({
      scope: input.scope,
      actorUserId: input.actorUserId,
      runId: prepared.runId,
      objectiveId: prepared.objective.id,
      objectiveCode: prepared.objective.code,
      departmentId: prepared.version.departmentId,
      objectiveOwnerUserId: prepared.version.objectiveOwnerUserId,
      objectiveName: prepared.version.objectiveName,
      expectedFinalResult: prepared.version.expectedFinalResult,
      steps: prepared.steps,
    });

    return this.view({
      scope: input.scope,
      actorUserId: input.actorUserId,
      runId: prepared.runId,
    });
  }

  /**
   * The seven stages, in the client's order.
   *
   * Written as an explicit sequence rather than a loop over handlers, because each stage genuinely
   * does something different and a table of handlers would hide that behind indirection. What is
   * shared — the model call, the cancellation check, the progress write — is factored out.
   */
  private async runPipeline(seed: {
    scope: TenantScope;
    actorUserId: string;
    runId: string;
    objectiveId: string;
    objectiveCode: string;
    departmentId: string;
    objectiveOwnerUserId: string;
    objectiveName: string;
    expectedFinalResult: string;
    steps: ObjectiveWorkflowStep[];
  }): Promise<void> {
    const state: PipelineState = {
      ...seed,
      teamUserIds: [],
      nodes: [],
      edges: [],
      risks: [],
      gaps: [],
      promptTokens: 0,
      completionTokens: 0,
      capability: null,
      producedByRealModel: false,
    };

    try {
      await this.enterStage(state, 'UnderstandingObjective');
      await this.understandObjective(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'ReadingTeamStructure');
      await this.readTeamStructure(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'DetectingHumanWork');
      await this.detectHumanWork(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'IdentifyingAiWork');
      await this.identifyAiWork(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'MatchingSkills');
      await this.matchSkills(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'AssigningOwners');
      await this.assignOwners(state);

      if (await this.stopIfCancelled(state)) return;
      await this.enterStage(state, 'BuildingWorkflow');
      await this.buildWorkflow(state);
    } catch (caught) {
      // A failure is recorded in words a person can act on, never a stack trace. The run is a
      // durable record and somebody will read this months later.
      const reason =
        caught instanceof Error ? caught.message : 'The analysis failed for an unknown reason.';
      this.logger.warn(`Analysis run ${state.runId} failed: ${reason}`);

      await this.prisma.runInTenantTransaction(state.scope, async () => {
        const current = await this.prisma.client.objectiveAnalysisRun.findUnique({
          where: { id: state.runId },
        });
        // A cancelled run is frozen; do not try to overwrite it with a failure.
        if (current && !['Completed', 'Cancelled', 'Failed'].includes(current.status)) {
          await this.prisma.client.objectiveAnalysisRun.update({
            where: { id: state.runId },
            data: {
              status: 'Failed',
              failureReason: reason.slice(0, 2000),
              ...this.usageColumns(state),
              version: { increment: 1 },
            },
          });
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // The stages
  // -------------------------------------------------------------------------

  /** Read the objective and make the Goal node. The Goal is what the whole plan is for. */
  private async understandObjective(state: PipelineState): Promise<void> {
    await this.ask(state, 'objective.analysis.understand', 'Summarise the objective.', [
      state.objectiveName,
      state.expectedFinalResult,
    ]);

    state.nodes.push({
      id: 'goal',
      kind: 'Goal',
      label: `GOAL · ${state.objectiveName}`,
      shape: nodeShapeFor('Goal'),
      fromStepPosition: null,
      ownerUserId: state.objectiveOwnerUserId,
      ownerDesignation: null,
      skillVersionId: null,
      skillName: null,
      dod: {
        expectedOutput: state.expectedFinalResult,
        criteria: state.expectedFinalResult,
        evidence:
          'The expected final result, evidenced by whatever the last step produces and the ' +
          'approvals recorded along the way.',
        dependencies: [],
        tools: [],
        approval: null,
        // Left blank rather than invented: the grid does not say what failing the whole
        // objective looks like, and the Pre-Publish Summary will report it as incomplete.
        failureCondition: '',
      },
      approvalKind: null,
      triggerEvent: null,
    });
  }

  /** Read the hierarchy, so owners can be assigned to real people later. */
  private async readTeamStructure(state: PipelineState): Promise<void> {
    await this.ask(state, 'objective.analysis.team', 'Read the team structure.', [
      state.departmentId,
    ]);

    state.teamUserIds = await this.organization.reportingSubtreeUserIds({
      tenantId: state.scope.tenantId,
      managerUserId: state.objectiveOwnerUserId,
    });

    if (state.teamUserIds.length === 0) {
      state.gaps.push(
        'The objective owner has no reporting subtree on record, so human owners could not be ' +
          'matched to people. Assign them by hand, or complete the hierarchy and re-analyse.',
      );
    }
  }

  /** Human rows of the grid become rectangle nodes. */
  private async detectHumanWork(state: PipelineState): Promise<void> {
    const human = state.steps.filter((step) => step.whoEngine === 'Human');

    await this.ask(
      state,
      'objective.analysis.human-work',
      'Classify which steps are human work.',
      human.map((step) => step.whatExactWork),
    );

    for (const step of human) {
      state.nodes.push({
        id: `step-${step.position}`,
        kind: 'Human',
        label: step.whatExactWork,
        shape: nodeShapeFor('Human'),
        fromStepPosition: step.position,
        ownerUserId: null,
        ownerDesignation: step.whoDesignation,
        skillVersionId: null,
        skillName: null,
        dod: {
          expectedOutput: step.outputWhatIsProduced ?? '',
          criteria: '',
          evidence:
            step.outputWhatIsProduced === null
              ? ''
              : `${step.outputWhatIsProduced}, recorded against this step.`,
          dependencies: [],
          tools: [],
          approval: step.approval === 'NotRequired' ? null : step.approval,
          failureCondition: step.currentProblem ?? '',
        },
        approvalKind: null,
        triggerEvent: null,
      });

      if (step.outputWhatIsProduced === null) {
        state.gaps.push(
          `Step ${step.position} does not say what it produces, so its definition of done and ` +
            'its evidence had to be left general.',
        );
      }
    }
  }

  /** Engine, Sub-Engine and Executor rows become diamond nodes. */
  private async identifyAiWork(state: PipelineState): Promise<void> {
    const machine = state.steps.filter((step) => step.whoEngine !== 'Human');

    await this.ask(
      state,
      'objective.analysis.ai-work',
      'Identify which steps are AI work and what tools they need.',
      machine.map((step) => step.whatExactWork),
    );

    for (const step of machine) {
      // An Executor step is a checking step, never a doing-the-work step — the locked naming
      // rule. It is still an AI node, and the risk note says what it is for.
      const isExecutor = step.whoEngine === 'Executor';

      state.nodes.push({
        id: `step-${step.position}`,
        kind: 'Ai',
        label: step.whatExactWork,
        shape: nodeShapeFor('Ai'),
        fromStepPosition: step.position,
        ownerUserId: null,
        ownerDesignation: null,
        skillVersionId: null,
        skillName: null,
        dod: {
          expectedOutput: step.outputWhatIsProduced ?? '',
          criteria: '',
          evidence:
            'The AI output, its inputs and the Skill version that produced it, recorded for ' +
            'review.',
          dependencies: [],
          tools: step.inputReceivedFrom === null ? ['Read'] : ['Read', 'Write'],
          approval: step.approval === 'NotRequired' ? null : step.approval,
          failureCondition: '',
        },
        approvalKind: null,
        triggerEvent: null,
      });

      if (isExecutor) {
        state.risks.push({
          nodeId: `step-${step.position}`,
          severity: 'Low',
          summary:
            'This is an Executor step: it monitors and validates. It must never approve ' +
            'high-risk work or replace a required human decision.',
        });
      }
    }
  }

  /**
   * Match each AI node to an approved, published Skill version.
   *
   * Reuses the Prompt 18 Skill Router rather than matching here: it already refuses to return an
   * unapproved version and already raises a Skill Candidate when nothing applies. A second
   * matcher would be a second thing that could reach a draft Skill.
   *
   * `raiseCandidateIfMissing` is **false**. An analysis is exploratory and may be run repeatedly
   * while a draft is edited; raising a governance item on every run would bury the ones a person
   * actually filed. The gap is recorded on the draft instead, where the reviewer sees it.
   */
  private async matchSkills(state: PipelineState): Promise<void> {
    const aiNodes = state.nodes.filter((node) => node.kind === 'Ai');

    await this.ask(
      state,
      'objective.analysis.match-skills',
      'Match approved Skills to the AI work.',
      aiNodes.map((node) => node.label),
    );

    for (const node of aiNodes) {
      const step = state.steps.find((candidate) => candidate.position === node.fromStepPosition);
      if (!step) continue;

      const outcome = await this.skillRouter.route({
        scope: state.scope,
        actorUserId: state.actorUserId,
        context: {
          objectiveId: state.objectiveId,
          departmentId: state.departmentId,
          aiTask: step.whatExactWork,
          availableInputs: step.inputWhatIsUsed === null ? [] : [step.inputWhatIsUsed],
          ...(step.outputWhatIsProduced === null
            ? {}
            : { requiredOutput: step.outputWhatIsProduced }),
          allowedToolCategories: node.dod.tools,
          requiresApproval: step.approval !== 'NotRequired',
        },
        raiseCandidateIfMissing: false,
      });

      const best = outcome.matches[0];
      if (best) {
        node.skillVersionId = best.skillVersionId;
        node.skillName = best.skillName;
      } else {
        state.gaps.push(
          `No approved Skill matches step ${node.fromStepPosition} ("${node.label}"). A Skill ` +
            'has to be authored and approved before this step can run as AI work.',
        );
        state.risks.push({
          nodeId: node.id,
          severity: 'High',
          summary:
            'This AI step has no approved Skill behind it. It cannot run until one is authored ' +
            'and approved.',
        });
      }
    }
  }

  /** Match the grid's named people to real members of the team. */
  private async assignOwners(state: PipelineState): Promise<void> {
    await this.ask(state, 'objective.analysis.assign-owners', 'Assign owners to human work.', [
      String(state.teamUserIds.length),
    ]);

    const employments = await this.prisma.runInTenantTransaction(state.scope, () =>
      this.prisma.client.employmentRecord.findMany({
        // `(tenant_id, user_id)` is the only index covering this column (ADR-271).
        where: { tenantId: state.scope.tenantId, userId: { in: state.teamUserIds } },
        include: { user: { select: { id: true, displayName: true } } },
      }),
    );

    // Human **and** AI nodes. An AI node has no person performing the work, but it does have an
    // accountable one, and the grid names them on the Engine row for exactly that reason: the
    // source document requires an Engine Agent to carry an "accountable owner", and Agent
    // Builder to prefill an "employee/business owner". Leaving AI nodes unowned made that
    // prefill fall back to the objective owner for everything, which put every agent's setup in
    // front of the manager instead of the employee the plan named.
    //
    // Safe for the diagram and the readiness report: the canvas only draws an owner line for
    // Human nodes, and both `affectedUserIds` and the "human step has no owner" blocker filter
    // to Human nodes explicitly.
    for (const node of state.nodes.filter(
      (candidate) => candidate.kind === 'Human' || candidate.kind === 'Ai',
    )) {
      const step = state.steps.find((candidate) => candidate.position === node.fromStepPosition);
      const named = step?.whoPersonName?.trim() ?? '';

      if (named === '' || named === '—') {
        state.gaps.push(
          `Step ${node.fromStepPosition} names nobody, so no owner could be assigned to it.`,
        );
        continue;
      }

      // Matched on display name, because that is what the grid holds. A near-miss is left
      // unassigned rather than guessed at: assigning the wrong person is worse than assigning
      // nobody, and the reviewer can see the gap.
      const match = employments.find(
        (employment) => employment.user.displayName.toLowerCase() === named.toLowerCase(),
      );

      if (match) {
        node.ownerUserId = match.userId;
        node.ownerDesignation = match.designation ?? node.ownerDesignation;
      } else {
        state.gaps.push(
          `Step ${node.fromStepPosition} names "${named}", who is not in the objective owner’s ` +
            'team on record. The owner was left unassigned rather than guessed at.',
        );
      }
    }
  }

  /** Assemble the draft: approval gates, edges, usage, then validate and store. */
  private async buildWorkflow(state: PipelineState): Promise<void> {
    await this.ask(state, 'objective.analysis.build-workflow', 'Assemble the workflow.', [
      String(state.nodes.length),
    ]);

    // Approval gates, from the grid's own Approval column. A gate is a node so the diagram shows
    // where a decision sits, rather than an attribute somebody has to hover to discover.
    for (const step of state.steps) {
      if (step.approval === 'NotRequired') continue;

      state.nodes.push({
        id: `approval-${step.position}`,
        kind: 'Approval',
        label: `${step.approval} sign-off`,
        shape: nodeShapeFor('Approval'),
        fromStepPosition: step.position,
        ownerUserId: null,
        ownerDesignation: null,
        skillVersionId: null,
        skillName: null,
        dod: {
          expectedOutput: `A ${step.approval} decision.`,
          criteria: `A ${step.approval} approver has decided.`,
          evidence: 'The decision, its author and its time, recorded in the audit trail.',
          dependencies: [],
          tools: [],
          approval: step.approval,
          failureCondition: 'The approver refuses, or the decision is not made in time.',
        },
        approvalKind: step.approval,
        triggerEvent: null,
      });

      if (step.approval === 'FourEyes') {
        state.risks.push({
          nodeId: `approval-${step.position}`,
          severity: 'Medium',
          summary:
            'Four-eyes means two different people. The approval engine has to refuse the same ' +
            'person twice, not merely require a senior one.',
        });
      }
    }

    // Edges: the Goal leads into step 1, each step leads to its approval gate if it has one and
    // then to the next step. Derived from the grid's order, which is what the client's `Step`
    // column means.
    const ordered = [...state.steps].sort((left, right) => left.position - right.position);
    let previousId = 'goal';

    for (const step of ordered) {
      const stepNodeId = `step-${step.position}`;
      // Schema version 2: every edge declares how it leads. The analysis produces a plain
      // chain; the manager introduces parallel, condition and failure edges in the editor.
      state.edges.push({
        fromNodeId: previousId,
        toNodeId: stepNodeId,
        kind: 'Sequential',
        condition: null,
      });

      const gateId = `approval-${step.position}`;
      if (state.nodes.some((node) => node.id === gateId)) {
        state.edges.push({
          fromNodeId: stepNodeId,
          toNodeId: gateId,
          kind: 'Sequential',
          condition: null,
        });
        previousId = gateId;
      } else {
        previousId = stepNodeId;
      }
    }

    const draft: WorkflowDraft = {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      goalNodeId: 'goal',
      nodes: state.nodes,
      edges: state.edges,
      usage: this.estimateUsage(state),
      risks: state.risks,
      gaps: state.gaps,
    };

    const problems = validateWorkflowDraft(draft);
    if (problems.length > 0) {
      // Refused rather than stored. A malformed draft in the database is worse than none: a
      // screen will try to render it, and the failure will surface far from its cause.
      throw new Error(
        `The analysis produced a draft that does not satisfy its own schema: ${problems.join(' ')}`,
      );
    }

    await this.prisma.runInTenantTransaction(state.scope, async () => {
      await this.prisma.client.objectiveAnalysisRun.update({
        where: { id: state.runId },
        data: {
          status: 'Completed',
          stage: 'BuildingWorkflow',
          stagesCompleted: ANALYSIS_STAGES.length,
          completedAt: new Date(),
          draft: draft as unknown as object,
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          ...this.usageColumns(state),
          version: { increment: 1 },
        },
      });

      // The version moves to `WorkflowDraft` — still pre-approval, still not assignable.
      const version = await this.prisma.client.objectiveVersion.findUnique({
        where: { id: (await this.currentRun(state.scope, state.runId)).objectiveVersionId },
      });
      if (version && version.status === 'AiAnalysis') {
        await this.prisma.client.objectiveVersion.update({
          where: { id: version.id },
          data: { status: 'WorkflowDraft', version: { increment: 1 } },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(state.scope.tenantId, {
        action: 'objective.analysis_completed',
        resourceType: 'objective',
        resourceId: state.objectiveId,
        actorUserId: state.actorUserId,
        resourceRef: state.objectiveCode,
        summary:
          `AI analysis produced a workflow draft with ${draft.nodes.length} nodes and ` +
          `${draft.gaps.length} recorded gaps. **It is a draft** — nothing is live until a ` +
          'person approves and publishes it.',
        metadata: {
          runId: state.runId,
          schemaVersion: ANALYSIS_SCHEMA_VERSION,
          nodeCount: draft.nodes.length,
          aiNodeCount: draft.usage.aiNodeCount,
          gapCount: draft.gaps.length,
          riskCount: draft.risks.length,
          modelCapability: state.capability,
          // The flag that matters: mock output must never read as a model's judgement.
          producedByRealModel: state.producedByRealModel,
          promptTokens: state.promptTokens,
          completionTokens: state.completionTokens,
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Cancellation and reading
  // -------------------------------------------------------------------------

  /**
   * Cancel a run.
   *
   * `objective:EditDraft`. Takes effect at the next stage boundary — the pipeline re-reads its own
   * status between stages, so a cancellation from another tab actually stops it rather than being
   * recorded and ignored.
   */
  async cancel(input: {
    scope: TenantScope;
    actorUserId: string;
    runId: string;
  }): Promise<AnalysisRunView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.objectiveAnalysisRun.findUnique({
        where: { id: input.runId },
      });
      if (!run) {
        throw new NotFoundException('There is no such analysis run you can see.');
      }

      if (!mayCancelAnalysis(run.status as AnalysisRunStatus)) {
        throw new ConflictException(
          `This analysis is ${run.status.toLowerCase()} and can no longer be cancelled.`,
        );
      }

      await this.prisma.client.objectiveAnalysisRun.update({
        where: { id: run.id },
        data: {
          status: 'Cancelled',
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          ...(run.startedAt === null ? { startedAt: new Date() } : {}),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.analysis_cancelled',
        resourceType: 'objective',
        resourceId: run.objectiveId,
        actorUserId: input.actorUserId,
        summary: 'Cancelled the AI analysis. Nothing was published; the objective is unchanged.',
        metadata: {
          runId: run.id,
          stagesCompleted: run.stagesCompleted,
          stage: run.stage,
        },
      });
    });

    return this.view({ scope: input.scope, actorUserId: input.actorUserId, runId: input.runId });
  }

  /** One run, with its progress and its draft. `objective:View`. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    runId: string;
  }): Promise<AnalysisRunView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.objectiveAnalysisRun.findUnique({
        where: { id: input.runId },
      });
      if (!run) {
        throw new NotFoundException('There is no such analysis run you can see.');
      }
      return this.viewOf(run);
    });
  }

  /** The most recent run for an objective, for a screen that is reopened. `objective:View`. */
  async latestFor(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<AnalysisRunView | null> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.objectiveAnalysisRun.findFirst({
        where: { objectiveId: input.objectiveId },
        orderBy: { createdAt: 'desc' },
      });
      return run === null ? null : this.viewOf(run);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One model call, through the gateway, with its usage accumulated.
   *
   * Every stage makes one. That is deliberate rather than decorative: it means the gateway seam is
   * genuinely on the path of every stage, so a real provider changes the analysis's behaviour
   * everywhere at once rather than in whichever stage somebody remembered to wire.
   */
  private async ask(
    state: PipelineState,
    purpose: string,
    instruction: string,
    context: string[],
  ): Promise<void> {
    const response = await this.modelGateway.complete({
      // Section 18 names this one exactly: OBJECTIVE_PLANNER is "objective analysis/workflow
      // draft", with "high reasoning, schema-constrained output, conservative fallback".
      profile: 'OBJECTIVE_PLANNER',
      purpose,
      instruction,
      context: context.join('\n'),
      maxTokens: 2000,
      tenantId: state.scope.tenantId,
      // Prompt 30: an analysis has an objective and no run, so it is checked against the
      // company and objective budgets and not against an agent's per-run limit.
      objectiveId: state.objectiveId,
    });

    state.promptTokens += response.promptTokens;
    state.completionTokens += response.completionTokens;
    state.capability = response.capability;
    // Latched: if any call in the run reached a real model, the run says so.
    state.producedByRealModel = state.producedByRealModel || response.producedByRealModel;
  }

  /** Record that a stage has begun, so a reopened screen shows real progress. */
  private async enterStage(state: PipelineState, stage: AnalysisStage): Promise<void> {
    await this.prisma.runInTenantTransaction(state.scope, async () => {
      await this.prisma.client.objectiveAnalysisRun.update({
        where: { id: state.runId },
        data: {
          status: 'Running',
          stage,
          stagesCompleted: analysisStageIndex(stage),
          ...(analysisStageIndex(stage) === 0 ? { startedAt: new Date() } : {}),
          ...this.usageColumns(state),
          version: { increment: 1 },
        },
      });
    });
  }

  /**
   * Has somebody cancelled this run?
   *
   * Checked between stages rather than inside them, so a cancellation is honoured at a point where
   * the run's recorded progress is coherent. A run cancelled mid-stage would say it had completed
   * a stage it abandoned.
   */
  private async stopIfCancelled(state: PipelineState): Promise<boolean> {
    const run = await this.currentRun(state.scope, state.runId);
    if (run.status === 'Cancelled') {
      this.logger.debug(`Analysis run ${state.runId} stopped: cancelled at ${run.stage}.`);
      return true;
    }
    return false;
  }

  /**
   * Re-read the run.
   *
   * **Scoped explicitly**, and that is not defensive tidiness: reading outside a tenant
   * transaction returns nothing under Row-Level Security, so an unscoped read here would report
   * that the run had vanished and fail every analysis. `runInTenantTransaction` joins an existing
   * transaction, so this is safe from inside one too.
   */
  private async currentRun(scope: TenantScope, runId: string): Promise<ObjectiveAnalysisRun> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const run = await this.prisma.client.objectiveAnalysisRun.findUnique({
        where: { id: runId },
      });
      if (!run) {
        throw new Error('The analysis run disappeared while it was running.');
      }
      return run;
    });
  }

  private usageColumns(state: PipelineState) {
    return {
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      producedByRealModel: state.producedByRealModel,
      ...(state.capability === null ? {} : { modelCapability: state.capability }),
    };
  }

  /**
   * The estimated AI usage, as a range.
   *
   * A range and not a number because nobody knows what a run will cost until it has run, and a
   * single figure next to real money reads as a quote. The basis is stated so a reader can judge
   * it: this is derived from what the analysis itself consumed per AI node, which is a mock today
   * and says so.
   */
  private estimateUsage(state: PipelineState): AiUsageEstimate {
    const aiNodeCount = state.nodes.filter((node) => node.kind === 'Ai').length;
    const perNode = aiNodeCount === 0 ? 0 : Math.ceil(state.promptTokens / aiNodeCount);

    return {
      minTokens: perNode * aiNodeCount,
      // Doubled, because retries, longer inputs and larger outputs are all normal. A range whose
      // ends were equal would not be a range.
      maxTokens: perNode * aiNodeCount * 2,
      aiNodeCount,
      basis: state.producedByRealModel
        ? `Derived from what this analysis consumed across ${aiNodeCount} AI step(s). An ` +
          'estimate, not a quote: a run consumes what its inputs and retries require.'
        : `Derived from what this analysis consumed across ${aiNodeCount} AI step(s). **The ` +
          'analysis ran against a mock model**, so treat this as a shape rather than a figure.',
    };
  }

  private viewOf(run: ObjectiveAnalysisRun): AnalysisRunView {
    const status = run.status as AnalysisRunStatus;
    const stage = run.stage === null ? null : (run.stage as AnalysisStage);

    // A draft this build cannot read is reported as unreadable rather than handed over. The
    // whole point of stamping a schema version is that a later reader refuses knowingly.
    // `upgradeWorkflowDraft` both checks readability and lifts an older draft into the current
    // shape, so a version 1 draft written at Prompt 21 still renders rather than being refused.
    const readable = isReadableSchemaVersion(run.schemaVersion);
    const draft = run.draft === null ? null : upgradeWorkflowDraft(run.draft);

    return {
      id: run.id,
      objectiveId: run.objectiveId,
      objectiveVersionId: run.objectiveVersionId,
      status,
      statusLabel:
        status === 'Completed'
          ? 'Workflow draft ready'
          : status.charAt(0) + status.slice(1).toLowerCase(),
      stage,
      stagesCompleted: run.stagesCompleted,
      stages: ANALYSIS_STAGES.map((candidate, index) => ({
        stage: candidate,
        label: ANALYSIS_STAGE_LABELS[candidate],
        state:
          index < run.stagesCompleted
            ? 'done'
            : candidate === stage && status === 'Running'
              ? 'running'
              : 'todo',
      })),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      cancelledAt: run.cancelledAt?.toISOString() ?? null,
      cancelledByUserId: run.cancelledByUserId,
      failureReason: run.failureReason,
      draft,
      schemaVersion: run.schemaVersion,
      unreadableReason:
        run.draft !== null && !readable
          ? `This draft was written with schema version ${run.schemaVersion}, which this build ` +
            'does not read. It is refused rather than guessed at — re-analyse the objective.'
          : null,
      modelCapability: run.modelCapability,
      producedByRealModel: run.producedByRealModel,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      note:
        'The analysis output is always a **draft**. Nothing is live until a person approves and ' +
        'publishes it, and no work is assignable before that.',
    };
  }
}
