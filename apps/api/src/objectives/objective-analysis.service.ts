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
  TOOL_ACTION_CATEGORIES,
  validateWorkflowDraft,
  type AiUsageEstimate,
  type AnalysisEdge,
  type AnalysisNode,
  type AnalysisRisk,
  type AnalysisRunStatus,
  type AnalysisStage,
  type ToolActionCategory,
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
  /**
   * How each step divides between a model and a person — the analysis's answer, not the grid's.
   *
   * Both halves are nullable and **a step may have both**. That is the point: the client's
   * example is a step somebody assigned to the Engine where part of the work is something a model
   * does and part is something only the person can, and the plan has to say which is which rather
   * than round the whole step to one or the other.
   *
   * Each side holds the model's own words for that portion, which become the node's label — so
   * the workflow reads "reconcile the ledger against the statement" and "call the branch about
   * each mismatch" rather than repeating the original row twice.
   *
   * Empty until `classifyWork` fills it, and the run fails rather than continuing if it cannot.
   * Keyed by position, which is what the grid and the nodes already agree on.
   */
  classification: Map<number, { aiWork: string | null; humanWork: string | null; why: string }>;
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
/**
 * Read a model's answer about action categories, and believe only the part that is already ours.
 *
 * ## The shape it is asked for, and why it is not trusted
 *
 * One line per step, `"<number>: Read, Write"`. That is what the instruction asks for and it is
 * not what every reply will be — a model may number from zero, wrap the list in prose, repeat a
 * step, invent an eighth category or answer in a paragraph. None of that is an error worth
 * failing an analysis over, so each line is taken only as far as it parses and anything else is
 * ignored. A step with no usable line keeps the caller's fallback.
 *
 * ## Why matching against the enum is the whole safety argument
 *
 * `TOOL_ACTION_CATEGORIES` is seven fixed words. A reply can only ever select from them, so the
 * worst outcome is a category chosen badly — never a tool the company does not have, which is
 * the risk that kept this answer discarded for so long. Case is ignored because a model writes
 * `write` as readily as `Write`, and that difference carries no meaning.
 */
export function parseToolCategories(
  answer: string,
  stepCount: number,
): (ToolActionCategory[] | undefined)[] {
  const chosen: (ToolActionCategory[] | undefined)[] = new Array(stepCount).fill(undefined);
  const known = new Map(
    TOOL_ACTION_CATEGORIES.map((category) => [category.toLowerCase(), category]),
  );

  for (const line of answer.split('\n')) {
    const match = /^\s*(\d+)\s*[:.)-]\s*(.+)$/.exec(line);
    if (!match) continue;

    // The instruction asks for 1-based numbering, which is what a person reading the grid uses.
    const position = Number(match[1]) - 1;
    if (!Number.isInteger(position) || position < 0 || position >= stepCount) continue;

    const categories = [
      ...new Set(
        match[2]!
          .split(/[,/|]/)
          .map((word) => known.get(word.trim().toLowerCase()))
          .filter((category): category is ToolActionCategory => category !== undefined),
      ),
    ];

    // A line that named nothing recognisable is not an answer of "no categories".
    if (categories.length > 0) chosen[position] = categories;
  }

  return chosen;
}

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
    /**
     * Whether to wait for the pipeline before answering.
     *
     * **The HTTP layer passes `false`.** The whole pipeline takes the better part of a minute, and
     * holding an HTTP request open for that long is wrong twice over: any proxy or load balancer
     * between the browser and the API will give up first — which is exactly what happened, the
     * caller seeing a 500 for a run that had in fact started and would go on to succeed — and it
     * contradicts what this screen already promises, that the analysis is a durable job you can
     * walk away from. The run row is committed before the pipeline begins, so returning early
     * hands back something real that the screen polls.
     *
     * Defaults to `true` so every in-process caller keeps a deterministic answer. A test that
     * starts an analysis and asserts on the workflow it produced should not have to poll for it.
     */
    awaitCompletion?: boolean | undefined;
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

    /*
     * Not awaited when the caller asked not to wait.
     *
     * Safe to leave running because `runPipeline` never throws: it catches its own failure and
     * writes the reason onto the run, which is the same row the screen is polling. So a failure
     * after this point is reported in the place somebody is already looking, rather than being
     * lost to an unhandled rejection.
     */
    const pipeline = this.runPipeline({
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

    if (input.awaitCompletion === false) {
      // Queued, and really queued: the row is committed and the stages will be written onto it.
      return this.view({
        scope: input.scope,
        actorUserId: input.actorUserId,
        runId: prepared.runId,
      });
    }

    await pipeline;

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
      classification: new Map(),
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

  /**
   * Read the objective and make the Goal node. The Goal is what the whole plan is for.
   *
   * No model call. There was one — "Summarise the objective" — and its answer went nowhere: the
   * Goal node below is built from the objective's own name and expected final result, which the
   * company typed and which need no summarising. A paid call whose reply is discarded is not a
   * stage doing less than it looks; it is a stage that was doing nothing extra at all.
   */
  private async understandObjective(state: PipelineState): Promise<void> {
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

  /**
   * Read the hierarchy, so owners can be assigned to real people later.
   *
   * No model call. "Read the team structure" was asked of a model and discarded; the structure
   * is then read from the database below, which is the only place it exists. A model cannot know
   * a company's reporting lines and was never being asked to — it was handed a department id.
   */
  private async readTeamStructure(state: PipelineState): Promise<void> {
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

  /**
   * **The model decides which steps need a person**, and the rows it names become rectangles.
   *
   * ## What this used to do
   *
   * `state.steps.filter((step) => step.whoEngine === 'Human')` — it partitioned on a column
   * somebody had chosen in the grid, after asking a model the same question and discarding the
   * answer. The screen said the AI was classifying the work; the AI's reply reached nothing, and
   * the company was billed for seven calls whose output was read by no line of code.
   *
   * ## Why the person no longer picks it
   *
   * What the client asked for — somebody writing an objective says which machine layer a step
   * belongs to — Engine, Sub-Engine or Executor — and the analysis works out which parts of that
   * work a model can actually do and which parts need a person. Deciding that at the moment the
   * form is filled in means deciding it before anybody knows what the AI can do, which is how
   * every step ends up marked Human.
   *
   * (Worded without the word that names a model's orders followed by a colon: the prompt-injection
   * scan reads every line of this directory and does not strip comments, so that phrasing in prose
   * reports itself as a computed instruction. The test is right to be literal-minded; the comment
   * is the thing that should move.)
   *
   * `whoEngine` still means something: it is the layer, and `Executor` still marks a checking
   * step. What it no longer decides is who does the work.
   *
   * ## Why an unusable answer stops the run
   *
   * The client's decision, and the only safe one. The alternatives were to fall back on the grid
   * column — which would quietly reinstate the behaviour this replaces, under a screen claiming
   * the AI had decided — or to call everything human, which hands a company a 25-step objective
   * their team now owns because a provider was down. A refusal says what happened; both of the
   * others are a wrong answer wearing a right one's clothes.
   *
   * It also means an analysis cannot complete without a real model, including against the mock
   * adapter, whose output does not parse as a classification. That is the honest consequence of
   * the screen's own promise.
   */
  private async detectHumanWork(state: PipelineState): Promise<void> {
    await this.classifyWork(state);

    const human = state.steps.filter(
      (step) => state.classification.get(step.position)?.humanWork !== null,
    );

    for (const step of human) {
      const part = state.classification.get(step.position);
      state.nodes.push({
        id: workNodeId(state, step.position, 'Human'),
        kind: 'Human',
        /*
         * The person's own portion, in the analysis's words — not the whole grid row.
         *
         * On a step that divides, labelling both nodes with the original row would put the same
         * sentence on a diamond and a rectangle and leave somebody reading the plan to guess
         * which half each one meant.
         */
        label: part?.humanWork ?? step.whatExactWork,
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

  /** The steps the classification left to a model become diamond nodes. */
  private async identifyAiWork(state: PipelineState): Promise<void> {
    const machine = state.steps.filter(
      (step) => state.classification.get(step.position)?.aiWork !== null,
    );

    /*
     * This call's answer is now read, and the reason it was safe to start reading it is that the
     * answer cannot be anything the product does not already recognise.
     *
     * It used to be discarded, on the stated grounds that the tool list had "no field to land in
     * yet" and that inventing one from an unvalidated reply is how a plan ends up citing tools a
     * company does not have. The first half was wrong — `dod.tools` has always been that field —
     * and the second half does not apply, because `TOOL_ACTION_CATEGORIES` is a **closed set of
     * seven**. A model choosing from a fixed vocabulary cannot name a tool nobody has; the worst
     * it can do is choose badly, and anything outside the seven is dropped below.
     *
     * What it replaces mattered more than the saving. Every AI node was given
     * `['Read']` or `['Read', 'Write']` from one line of guesswork — whether the step had an
     * input — so **no AI step in any plan was ever marked `FinancialChange`, `ProductionChange`
     * or `SensitiveExport`**, and those are exactly the categories `isHighRiskToolCategory`
     * exists to flag. A step that moves money looked, to every later check, like a step that
     * reads a file.
     *
     * ## Why the seven words are written out below
     *
     * They were `${TOOL_ACTION_CATEGORIES.join(', ')}`, which is in step with the enum by
     * construction — and a `${` inside an instruction, which is the one thing
     * `prompt-injection.spec.ts` forbids this service. The bright line is worth more than the
     * convenience: a frozen constant is safe to interpolate today, and the rule's value is that
     * nobody has to work out whether the *next* value somebody reaches for is. "Is this
     * instruction built from data" stays a question with a one-glance answer.
     *
     * It sat there unnoticed because that test reads only the first line of the argument and the
     * interpolation was on the second. Passing by accident rather than by agreement is not
     * passing.
     *
     * The cost is that the sentence can drift from the enum, so `tool-categories.spec.ts`
     * compares the two and fails if a category is added without being named here. This note is
     * above the call rather than beside the argument for the dull reason that a comment in the
     * argument list is what that test then reads as the instruction.
     */
    const answer = await this.ask(
      state,
      'objective.analysis.ai-work',
      'For each numbered step, say which of these action categories the work needs: ' +
        'Read, Write, Delete, ExternalBulkSend, SensitiveExport, FinancialChange, ' +
        'ProductionChange. ' +
        'Answer one line per step, as "<number>: <categories, comma separated>". ' +
        'Use only those words. Read is the safe default; name a stronger category only when ' +
        'the step plainly does that thing.',
      machine.map((step, index) => `${index + 1}. ${step.whatExactWork}`),
    );

    const chosen = parseToolCategories(answer, machine.length);

    for (const [index, step] of machine.entries()) {
      // An Executor step is a checking step, never a doing-the-work step — the locked naming
      // rule. It is still an AI node, and the risk note says what it is for. This is the one
      // thing `whoEngine` still decides, and it is a layer rather than a doer.
      const isExecutor = step.whoEngine === 'Executor';
      const part = state.classification.get(step.position);
      const nodeId = workNodeId(state, step.position, 'Ai');

      state.nodes.push({
        id: nodeId,
        kind: 'Ai',
        // The agent's own portion, in the analysis's words. See the human node for why.
        label: part?.aiWork ?? step.whatExactWork,
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
          /*
           * What the model chose, when it chose something this product recognises.
           *
           * The old guess is kept as the fallback rather than deleted: a model that returns
           * nothing usable must not leave a step with no categories at all, because an empty
           * list reads downstream as "this does nothing" rather than as "nobody knows".
           */
          tools: chosen[index] ?? (step.inputReceivedFrom === null ? ['Read'] : ['Read', 'Write']),
          /*
           * Nobody has looked at this list yet, and the Pre-Publish Summary weighs it accordingly.
           *
           * True for the fallback as well as for the model's answer: a guess made from one line of
           * step text and a guess made from whether the step has an input are both guesses, and
           * neither is a manager saying "yes, this step moves money". It becomes false the moment
           * somebody edits the tools on this node.
           */
          toolsInferred: true,
          approval: step.approval === 'NotRequired' ? null : step.approval,
          failureCondition: '',
        },
        approvalKind: null,
        triggerEvent: null,
      });

      if (isExecutor) {
        state.risks.push({
          nodeId,
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

    /*
     * No model call, and this was the clearest of the six.
     *
     * "Match approved Skills to the AI work" was asked of a model, discarded, and then answered
     * properly three lines below by `skillRouter.route` — the Prompt 18 router, which matches
     * against this company's published Skills and refuses to return a draft one. The model was
     * being asked a question the product already answers correctly, and paid for.
     */
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

        /*
         * The Skill is right; the data may not be there yet.
         *
         * The router matches a step's inputs to a Skill's declared ones by meaning rather than by
         * spelling, so a capability is no longer lost to a difference in wording. What it will
         * not do is pretend an input exists: an input the step cannot supply comes back named,
         * and it is recorded here as a gap so the administrator reads *which* input is missing
         * rather than "no Skill matches".
         */
        if (best.unmetInputs.length > 0) {
          state.gaps.push(
            `Step ${node.fromStepPosition} ("${node.label}") will use "${best.skillName}", which ` +
              `still needs ${best.unmetInputs.join(', ')}. Name that input in the step's "what is ` +
              'used" column, or the step cannot run.',
          );
          state.risks.push({
            nodeId: node.id,
            severity: 'Medium',
            summary:
              `"${best.skillName}" is the right capability for this step, but ` +
              `${best.unmetInputs.join(', ')} is not available to it here.`,
          });
        }
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

  /**
   * Match the grid's named people to real members of the team.
   *
   * No model call. "Assign owners to human work" was asked with one piece of context — the
   * *number* of people on the team, as a string — so the model was handed `"7"` and invited to
   * assign owners it had never been shown. The matching below is done against the company's own
   * employment records, by name, which is the only way it could ever have been right.
   */
  private async assignOwners(state: PipelineState): Promise<void> {
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

  /**
   * Assemble the draft: approval gates, edges, usage, then validate and store.
   *
   * No model call. "Assemble the workflow" was asked with the *number* of nodes as its only
   * context, and discarded. The assembly below is deterministic and has to be: the gates come
   * from the grid's Approval column, the edges from step order, and the result is put through
   * `validateWorkflowDraft` before it is stored. A model has nothing to add to that and could
   * only disagree with it.
   */
  private async buildWorkflow(state: PipelineState): Promise<void> {
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
      /*
       * A step is one node or two, and the chain threads through however many it made.
       *
       * This read `step-${position}` and linked that one id. On a step the analysis divides
       * between an agent and a person, that id belongs to neither node — the chain would have
       * pointed at nothing, and both halves of the step would have hung off the diagram
       * unreachable.
       *
       * The agent's part leads: a model prepares and a person decides on what it prepared. That
       * is an assumption, so `classifyWork` records it as a gap for the manager to check rather
       * than leaving it to be discovered from the picture.
       */
      const work = state.nodes.filter(
        (node) => node.fromStepPosition === step.position && node.kind !== 'Approval',
      );
      const chain = [
        ...work.filter((node) => node.kind === 'Ai'),
        ...work.filter((node) => node.kind !== 'Ai'),
      ];

      // Schema version 2: every edge declares how it leads. The analysis produces a plain
      // chain; the manager introduces parallel, condition and failure edges in the editor.
      for (const node of chain) {
        state.edges.push({
          fromNodeId: previousId,
          toNodeId: node.id,
          kind: 'Sequential',
          condition: null,
        });
        previousId = node.id;
      }

      // The gate follows the last of the step's work, whether that was one node or two.
      const gateId = `approval-${step.position}`;
      if (state.nodes.some((node) => node.id === gateId)) {
        state.edges.push({
          fromNodeId: previousId,
          toNodeId: gateId,
          kind: 'Sequential',
          condition: null,
        });
        previousId = gateId;
      }
    }

    /*
     * The order the chain describes, written where the product actually enforces it.
     *
     * The edges above say what follows what, and until this existed that was the only place it was
     * said. `Approve & Assign` does not read edges — it copies each node's `dod.dependencies` onto
     * the task it creates, and `WorkReleaseService` reads those to decide what may start. So a plan
     * the analysis generated had empty dependencies, every task arrived `Assigned` at once, and the
     * sequence the diagram drew was enforced only if somebody re-typed it by hand in the editor.
     *
     * Projected from the edges rather than written beside them, so there is still one source of
     * truth for the order: change an edge in the editor and the dependency follows.
     *
     * The Goal is excluded. It is a label rather than work, nothing ever completes it, and a step
     * waiting on it would wait for ever.
     */
    for (const node of state.nodes) {
      if (node.kind === 'Goal') continue;
      node.dod.dependencies = state.edges
        .filter((edge) => edge.toNodeId === node.id && edge.fromNodeId !== 'goal')
        .map((edge) => edge.fromNodeId);
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
  /**
   * Ask the model which steps need a person, and refuse to continue without a usable answer.
   *
   * ## The shape it must come back in
   *
   * One entry per step, by position, each saying `Human` or `Ai` and why. The `OBJECTIVE_PLANNER`
   * profile is schema-constrained, so the provider is already asked for JSON; this still parses
   * defensively, because "the provider was asked" and "the provider complied" are different
   * claims and only one of them is observable here.
   *
   * ## Why every step must appear
   *
   * A partial answer is the dangerous one. A model that classifies nineteen of twenty-five steps
   * leaves six that belong to nobody — they would silently become AI work, or silently vanish
   * from the plan, and either way the objective that gets approved is not the objective that was
   * written. So a missing position is a failed run, named by position so somebody can see which.
   */
  private async classifyWork(state: PipelineState): Promise<void> {
    if (state.steps.length === 0) return;

    const answer = await this.ask(
      state,
      'objective.analysis.human-work',
      'For each numbered step of this company process, split the work into the part an AI agent ' +
        'can do unaided and the part a person must do. Answer with JSON only, in the form ' +
        '{"steps":[{"position":<number>,"aiWork":"<what an agent does, or null>",' +
        '"humanWork":"<what the person does, or null>","why":"<one short sentence>"}]}. ' +
        'Include every position given, exactly once, and at least one of the two parts for each. ' +
        'Many steps divide: say so rather than rounding the whole step to one side. Put work in ' +
        'humanWork when it needs judgement about people, a physical action, an outside ' +
        'relationship, or accountability somebody must personally carry. Put work in aiWork when ' +
        'it is reading, writing, checking, calculating or moving information. Describe each part ' +
        'in the company’s own words, as an instruction somebody could follow.',
      state.steps.map((step) => `${step.position}. ${step.whatExactWork}`),
    );

    const parsed = parseClassification(answer);
    if (parsed === null) {
      throw new Error(
        'The model did not return a usable classification of which steps need a person, so no ' +
          'workflow was built. Nothing has been changed. Run the analysis again; if it keeps ' +
          'failing, the objective planner model is unavailable.',
      );
    }

    const missing = state.steps
      .map((step) => step.position)
      .filter((position) => !parsed.has(position));
    if (missing.length > 0) {
      throw new Error(
        `The model classified only some of the steps — ${missing.join(', ')} ` +
          `${missing.length === 1 ? 'was' : 'were'} left out, so no workflow was built. Nothing ` +
          'has been changed. Run the analysis again.',
      );
    }

    state.classification = parsed;

    /*
     * A split step is recorded as a gap, not because it is wrong but because its order is this
     * code's assumption rather than the analysis's answer.
     *
     * The chain puts the AI part first — a model prepares, a person decides on what it prepared —
     * which is the common shape and not a universal one. A manager reorders it in the editor, and
     * saying so is the difference between a plan that states its assumptions and one that hides
     * them inside a sort.
     */
    const split = state.steps
      .map((step) => step.position)
      .filter((position) => {
        const entry = parsed.get(position);
        return entry !== undefined && entry.aiWork !== null && entry.humanWork !== null;
      });
    if (split.length > 0) {
      state.gaps.push(
        `Step${split.length === 1 ? '' : 's'} ${split.join(', ')} divide${
          split.length === 1 ? 's' : ''
        } between an agent and a person. The agent's part is placed first, which is an assumption ` +
          'about order rather than something the analysis determined — check it in the editor.',
      );
    }
  }

  /**
   * One model call, and **its answer**.
   *
   * This returned `void` for as long as it has existed. Seven stages called it, every one of them
   * paid for a real completion, and every one of them threw the reply away — the workflow was
   * then assembled from the company's own grid and presented as the analysis's conclusion. The
   * stage literally named "Classify which steps are human work" asked the question and then
   * partitioned on the column somebody had typed by hand.
   *
   * Returning the output is the first half of fixing that. The second half is each stage actually
   * reading it, which `detectHumanWork` now does and the remaining stages do not yet.
   */
  private async ask(
    state: PipelineState,
    purpose: string,
    instruction: string,
    context: string[],
  ): Promise<string> {
    const response = await this.modelGateway.complete({
      // Section 18 names this one exactly: OBJECTIVE_PLANNER is "objective analysis/workflow
      // draft", with "high reasoning, schema-constrained output, conservative fallback".
      profile: 'OBJECTIVE_PLANNER',
      purpose,
      instruction,
      context: context.join('\n'),
      /*
       * Room for the answer **and** for whatever the model spends getting to it.
       *
       * 2000 was measured against a provider that returns only the answer. On a reasoning model
       * the thinking is charged to this same ceiling, so a planner given 2000 can spend most of
       * it reasoning and return an empty string — a run that fails after seven stages with
       * nothing to show for it, and no obvious cause.
       *
       * A real 25-step objective produced about 5,900 completion tokens across its seven calls.
       * 8000 leaves the largest single call room to think and still answer; it is a ceiling, not
       * a target, and an analysis that needs less is billed for less.
       */
      maxTokens: 8000,
      tenantId: state.scope.tenantId,
      // Prompt 30: an analysis has an objective and no run, so it is checked against the
      // company and objective budgets and not against an agent's per-run limit.
      objectiveId: state.objectiveId,
      // And against the allowance of whoever pressed Run Objective. One analysis is seven model
      // calls and the most expensive thing a person can do here in one click, which makes it the
      // first thing a per-person allowance has to see.
      actorUserId: state.actorUserId,
    });

    state.promptTokens += response.promptTokens;
    state.completionTokens += response.completionTokens;
    state.capability = response.capability;
    // Latched: if any call in the run reached a real model, the run says so.
    state.producedByRealModel = state.producedByRealModel || response.producedByRealModel;

    return response.output;
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
          'analysis ran against a mock model, so treat this as a shape rather than a figure.',
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
        'The analysis output is always a draft. Nothing is live until a person approves and ' +
        'publishes it, and no work is assignable before that.',
    };
  }
}

/**
 * Read a classification out of whatever the model actually sent.
 *
 * ## Why this is tolerant about the wrapper and strict about the contents
 *
 * A schema-constrained profile asks a provider for JSON; it does not guarantee the reply is only
 * JSON. Models wrap an answer in prose, in a fenced code block, or in an object with a different
 * key around the array. None of that changes whether the answer is right, so the wrapper is
 * peeled rather than refused.
 *
 * What is not tolerated is a row that does not say both things. A step with no `doer` is a step
 * nobody has decided, and guessing one here — defaulting to `Ai`, or to `Human` — would be this
 * function inventing the judgement the whole stage exists to obtain.
 *
 * Returns `null` when nothing usable is there, so the caller can fail the run with its own words
 * rather than throwing a parser's.
 */
function parseClassification(
  answer: string,
): Map<number, { aiWork: string | null; humanWork: string | null; why: string }> | null {
  // The first `{` to the last `}`: peels a fence, a preamble and a trailing apology in one go.
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return null;
  }

  // `steps` is what the instruction asks for; the other two are what models send instead.
  const container = parsed as Record<string, unknown>;
  const rows =
    (Array.isArray(container['steps']) && container['steps']) ||
    (Array.isArray(container['classifications']) && container['classifications']) ||
    (Array.isArray(parsed) && parsed) ||
    null;
  if (rows === null) return null;

  const classification = new Map<
    number,
    { aiWork: string | null; humanWork: string | null; why: string }
  >();

  /*
   * `null` and the string "null" and an empty string all mean "no part on this side".
   *
   * The instruction asks for JSON null, and models send all three. Treating the word "null" as a
   * description would put the literal text `null` on a node in somebody's workflow, which is a
   * defect that looks like a joke and reaches a customer.
   */
  const side = (value: unknown): string | null => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '' || text.toLowerCase() === 'null' || text.toLowerCase() === 'none') return null;
    return text;
  };

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const entry = row as Record<string, unknown>;

    const position = Number(entry['position']);
    if (!Number.isInteger(position)) continue;

    const aiWork = side(entry['aiWork']);
    const humanWork = side(entry['humanWork']);
    // A row with neither side has decided nothing. Dropping it means the caller reports the
    // position as unclassified, which is true, rather than silently creating a step with no work.
    if (aiWork === null && humanWork === null) continue;

    classification.set(position, {
      aiWork,
      humanWork,
      // The reason is reported, never relied on, so an absent one is not worth failing a run for.
      why: String(entry['why'] ?? '').trim(),
    });
  }

  return classification.size === 0 ? null : classification;
}

/**
 * The id of the node carrying one side of a step's work.
 *
 * A step that goes entirely one way keeps the plain `step-3`, because that is what every draft
 * written before the split already uses and there is no reason to churn it. A step that divides
 * gets `step-3-ai` and `step-3-human`, which are two nodes that must not collide.
 *
 * Derived from the classification rather than passed in, so the two stages that build these nodes
 * cannot disagree about which form a given step takes — they run minutes apart and the second one
 * would have no way to know what the first chose.
 */
function workNodeId(state: PipelineState, position: number, side: 'Ai' | 'Human'): string {
  const part = state.classification.get(position);
  const divides = part !== undefined && part.aiWork !== null && part.humanWork !== null;
  return divides ? `step-${position}-${side.toLowerCase()}` : `step-${position}`;
}
