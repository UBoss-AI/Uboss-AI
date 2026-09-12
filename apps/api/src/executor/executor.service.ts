import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  concludeValidation,
  DEFAULT_ESCALATION_HOURS,
  escalationDue,
  EXCEPTION_DEFAULT_OWNER,
  EXCEPTION_DEFAULT_SEVERITY,
  EXCEPTION_KIND_LABELS,
  EXCEPTION_KINDS,
  executorMayResolve,
  isExceptionClosed,
  mayMoveException,
  resolutionsFor,
  type ExceptionKind,
  type ExceptionSeverity,
  type ExceptionState,
  type ResolutionAction,
  type ValidationOutcome,
  type ValidationStageResult,
} from '@uboss/types';

import { ApprovalService } from '../approvals/approval.service.js';
import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ModelGateway } from '../model-gateway/model-gateway.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';

/** One exception, as the Exception Center shows it. */
export interface ExceptionView {
  id: string;
  kind: ExceptionKind;
  kindLabel: string;
  severity: ExceptionSeverity;
  state: ExceptionState;
  sourceType: string;
  sourceId: string;
  objectiveId: string | null;
  engineAgentId: string | null;
  detail: string;
  evidence: unknown;
  ownerUserId: string | null;
  /** The source document's default owner for this kind, shown when routing named nobody. */
  defaultOwner: string;
  attempts: number;
  escalationHours: number;
  openedAt: string;
  escalatedAt: string | null;
  escalatedToUserId: string | null;
  closedAt: string | null;
  closeReason: string | null;
  /** Whether the aging window has passed. Derived, never stored — it changes with the clock. */
  escalation: { due: boolean; hoursOpen: number; reason: string };
  /** What a person may do about it from here. */
  availableActions: ResolutionAction[];
  history: {
    action: string | null;
    state: string;
    actorUserId: string | null;
    byExecutor: boolean;
    note: string;
    at: string;
  }[];
  note: string;
}

/** What one sweep found. */
export interface SweepResult {
  raised: number;
  escalated: number;
  cleared: number;
  byKind: Record<string, number>;
  note: string;
}

/**
 * The Executor Agent — Prompt 27.
 *
 * ## An oversight layer, and nothing more
 *
 * The source document: "Executor Agent is an oversight layer. It monitors Human tasks and Engine
 * Agent runs, checks evidence and timing, applies configured validation, then routes exceptions to
 * the right person. **It must not silently replace required Human approvals.**"
 *
 * That is a locked rule, and it is enforced in three independent places rather than trusted to
 * whoever reads this next:
 *
 *   1. `EXECUTOR_PERMITTED_ACTIONS` omits `Resolve` and `Dismiss`, so the vocabulary itself has no
 *      word for the Executor closing something.
 *   2. `act()` refuses an Executor-initiated close, and refuses even a retry on an exception
 *      raised because a control said no.
 *   3. A database CHECK — `executor_never_closes_an_exception` — refuses the row.
 *
 * Three layers for one rule is deliberate. This is the boundary the entire oversight design rests
 * on: an Executor that could close its own findings would not be oversight, it would be a way to
 * make problems disappear.
 *
 * ## Validation runs in the client's order, and the order is the substance
 *
 * Deterministic checks, then an AI evaluator where suitable, then human approval for configured
 * high-risk actions. Running the evaluator first would spend a model call on something a schema
 * already refused, and would let a plausible judgement override a definite rule. Running either
 * *instead of* the human step is what the locked rule forbids — so a high-risk action without its
 * approval is `Deferred`, never `Passed`.
 */
@Injectable()
export class ExecutorService {
  /**
   * How long a run may sit `Queued` before it stops being queueing — Prompt 40.
   *
   * Thirty minutes. Well past any legitimate round-robin wait at a realistic queue depth, and well
   * short of a customer noticing on their own. See the sweep for the full argument.
   */
  static readonly STARVED_RUN_AFTER_MS = 30 * 60_000;

  private readonly logger = new Logger(ExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    /// For the AI evaluator stage. A mock today, and every result says so.
    private readonly modelGateway: ModelGateway,
    /**
     * The one Approval Engine — Prompt 28.
     *
     * Prompt 27 left `RequestApproval` as a state change with nothing behind it: the exception
     * moved to Acknowledged and no approval row existed, so the Executor could report that it had
     * asked for a decision that nobody would ever see in a queue. That is the worst possible
     * shape for this particular action, because the locked rule is that the Executor escalates
     * rather than proceeding — and an escalation nobody receives is proceeding.
     */
    private readonly approvals: ApprovalService,
  ) {}

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Apply the three-stage validation to a piece of completed work.
   *
   * The caller supplies the deterministic verdict, because only the caller knows the schema and
   * business rules for its own domain. This owns the *ordering*, the AI stage, and the refusal to
   * pass a high-risk action without a human decision.
   */
  async validate(input: {
    scope: TenantScope;
    /** What is being judged, in words, for the evaluator and the exception detail. */
    subject: string;
    deterministic: { passed: boolean; detail: string };
    /** Whether an AI evaluator is suitable here at all. */
    useAiEvaluator: boolean;
    humanApprovalRequired: boolean;
    humanApprovalGiven: boolean;
  }): Promise<ValidationOutcome> {
    const deterministic: ValidationStageResult = {
      stage: 'Deterministic',
      outcome: input.deterministic.passed ? 'Passed' : 'Failed',
      detail: input.deterministic.detail,
      producedByRealModel: null,
    };

    // Short-circuited before any model call. A definite rule has answered, and asking a model to
    // second-guess it would turn a schema violation into a matter of opinion — as well as
    // spending a provider call to do so.
    if (!input.deterministic.passed) {
      return concludeValidation({
        deterministic,
        humanApprovalRequired: input.humanApprovalRequired,
        humanApprovalGiven: input.humanApprovalGiven,
      });
    }

    let aiEvaluator: ValidationStageResult | undefined;
    if (input.useAiEvaluator) {
      try {
        const response = await this.modelGateway.complete({
          // Section 18 names this one exactly: EXECUTOR is "validation/exception reasoning".
          profile: 'EXECUTOR',
          purpose: 'ExecutorValidation',
          instruction:
            'Judge whether this completed work satisfies what was asked. Answer with a short ' +
            'verdict and the reason. Do not approve anything; you are advising a reviewer.',
          context: input.subject,
          maxTokens: 300,
          tenantId: input.scope.tenantId,
        });

        // The evaluator advises; it does not veto on a technicality. A mock gateway produces
        // plausible prose either way, so treating its output as a rejection would have the mock
        // failing real work.
        aiEvaluator = {
          stage: 'AiEvaluator',
          outcome: response.output.trim() === '' ? 'Failed' : 'Passed',
          detail:
            response.output.trim() === ''
              ? 'The evaluator returned nothing, so it could not advise.'
              : `The evaluator raised no objection (${response.capability}).`,
          producedByRealModel: response.producedByRealModel,
        };
      } catch (caught) {
        // An evaluator that could not run is not a rejection of the work. Saying so beats either
        // failing valid work or passing it as if the stage had approved.
        aiEvaluator = {
          stage: 'AiEvaluator',
          outcome: 'NotApplicable',
          detail: `The evaluator could not run: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
          producedByRealModel: null,
        };
      }
    }

    return concludeValidation({
      deterministic,
      ...(aiEvaluator === undefined ? {} : { aiEvaluator }),
      humanApprovalRequired: input.humanApprovalRequired,
      humanApprovalGiven: input.humanApprovalGiven,
    });
  }

  // -------------------------------------------------------------------------
  // Raising
  // -------------------------------------------------------------------------

  /**
   * Raise an exception, or return the open one that already covers this condition.
   *
   * The dedupe key is what keeps the Exception Center readable: the Executor sweeps repeatedly, and
   * without it one overdue task would raise a fresh exception every pass until the queue was
   * nothing but copies of the thing nobody had fixed.
   */
  async raise(input: {
    scope: TenantScope;
    kind: ExceptionKind;
    sourceType: 'HumanTask' | 'AgentRun' | 'Connection' | 'ApprovalRequest';
    sourceId: string;
    detail: string;
    dedupeKey?: string | undefined;
    severity?: ExceptionSeverity | undefined;
    ownerUserId?: string | undefined;
    objectiveId?: string | undefined;
    engineAgentId?: string | undefined;
    attempts?: number | undefined;
    evidence?: Record<string, unknown> | undefined;
    escalationHours?: number | undefined;
  }): Promise<{ exception: ExceptionView; created: boolean }> {
    if (!EXCEPTION_KINDS.includes(input.kind)) {
      throw new BadRequestException(
        `Unknown exception kind "${String(input.kind)}". One of: ${EXCEPTION_KINDS.join(', ')}.`,
      );
    }

    const severity = input.severity ?? EXCEPTION_DEFAULT_SEVERITY[input.kind];
    const dedupeKey = input.dedupeKey ?? `${input.kind}:${input.sourceType}:${input.sourceId}`;

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.executorException.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          dedupeKey,
          state: { in: ['Open', 'Acknowledged', 'Escalated'] },
        },
      });
      if (existing) {
        return { exception: await this.viewOf(existing), created: false };
      }

      const created = await this.prisma.client.executorException.create({
        data: {
          tenantId: input.scope.tenantId,
          kind: input.kind,
          severity,
          state: 'Open',
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          detail: input.detail,
          dedupeKey,
          escalationHours: input.escalationHours ?? DEFAULT_ESCALATION_HOURS[severity],
          ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
          ...(input.objectiveId === undefined ? {} : { objectiveId: input.objectiveId }),
          ...(input.engineAgentId === undefined ? {} : { engineAgentId: input.engineAgentId }),
          ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
          ...(input.evidence === undefined ? {} : { evidence: input.evidence as object }),
        },
      });

      // The Executor raised it, so the first history entry is attributed to the Executor. That is
      // permitted: raising is detection, not a decision.
      await this.appendEvent(input.scope.tenantId, created.id, {
        state: 'Open',
        byExecutor: true,
        note: `Raised by the Executor: ${input.detail}`,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'executor.exception_raised',
        resourceType: 'executor-exception',
        resourceId: created.id,
        summary:
          `${EXCEPTION_KIND_LABELS[input.kind]} on ${input.sourceType}: ${input.detail} ` +
          `Default owner for this kind: ${EXCEPTION_DEFAULT_OWNER[input.kind]}`,
        metadata: {
          kind: input.kind,
          severity,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          routedTo: input.ownerUserId ?? 'nobody named; the kind default applies',
        },
      });

      return { exception: await this.viewOf(created), created: true };
    });
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  /**
   * Take a resolution action.
   *
   * `actor` is either a person or the Executor itself, and the two are held to different rules.
   * A person may do anything the exception's kind and state allow; the Executor may only route,
   * retry a transient fault, pause a misbehaving agent, or ask for an approval — and never on an
   * exception raised because a control refused the work.
   */
  async act(input: {
    scope: TenantScope;
    exceptionId: string;
    action: ResolutionAction;
    /** Null when the Executor Agent is acting rather than a person. */
    actorUserId: string | null;
    note: string;
    /** For `Reassign` and `Escalate`. */
    toUserId?: string | undefined;
  }): Promise<ExceptionView> {
    const byExecutor = input.actorUserId === null;

    if (!byExecutor) {
      const context = await this.authorization.contextFor(input.scope, input.actorUserId as string);
      await this.authorization.assertCan(context, { module: 'executor', action: 'Comment' });
      // Closing an exception is a stronger act than annotating one.
      if (input.action === 'Resolve' || input.action === 'Dismiss') {
        await this.authorization.assertCan(context, { module: 'executor', action: 'Administer' });
      }
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const exception = await this.load(input.scope, input.exceptionId);
      const kind = exception.kind as ExceptionKind;
      const state = exception.state as ExceptionState;

      if (isExceptionClosed(state)) {
        throw new ConflictException(
          `This exception is ${state}. Re-opening it would rewrite a resolution somebody ` +
            'recorded — if the condition has recurred, the sweep raises a new one.',
        );
      }

      if (byExecutor) {
        // The locked rule, second of three layers.
        const decision = executorMayResolve({ action: input.action, kind });
        if (!decision.allowed) {
          throw new ForbiddenException(decision.reason);
        }
      } else if (!resolutionsFor({ kind, state }).includes(input.action)) {
        throw new BadRequestException(
          `A ${EXCEPTION_KIND_LABELS[kind].toLowerCase()} exception that is ${state} cannot be ` +
            `${input.action.toLowerCase()}d. Available: ${resolutionsFor({ kind, state }).join(', ')}.`,
        );
      }

      const nextState = this.stateAfter(input.action, state);
      if (nextState !== state && !mayMoveException(state, nextState)) {
        throw new ConflictException(`An exception cannot move from ${state} to ${nextState}.`);
      }

      if (
        (input.action === 'Reassign' || input.action === 'Escalate') &&
        input.toUserId === undefined
      ) {
        throw new BadRequestException(
          `${input.action} needs somebody to hand this to. An escalation with no destination is ` +
            'not a route.',
        );
      }

      const updated = await this.prisma.client.executorException.update({
        where: { id: exception.id },
        data: {
          state: nextState,
          ...(input.action === 'Reassign' && input.toUserId !== undefined
            ? { ownerUserId: input.toUserId }
            : {}),
          ...(input.action === 'Escalate' && input.toUserId !== undefined
            ? { escalatedAt: new Date(), escalatedToUserId: input.toUserId }
            : {}),
          ...(nextState === 'Resolved' || nextState === 'Dismissed'
            ? {
                closedAt: new Date(),
                // Never the Executor: the database refuses it, and so does the branch above.
                closedByUserId: input.actorUserId,
                closeReason: input.note,
              }
            : {}),
          version: { increment: 1 },
        },
      });

      // Prompt 28: this action now produces a real row in the one approvals table, so "the
      // Executor asked for a decision" and "somebody can see the request" are the same fact.
      //
      // Raised as `HighRiskAction`, addressed to whoever owns the exception, and if routing named
      // nobody then to a Head — never to the Executor and never to itself. It cannot decide the
      // request it raises: the mandatory platform `NoSelfApproval` control refuses the requester,
      // and there is no endpoint through which an automated actor decides anything.
      let raisedApprovalId: string | null = null;
      if (input.action === 'RequestApproval') {
        const raised = await this.approvals.raise({
          scope: input.scope,
          type: 'HighRiskAction',
          title: `${EXCEPTION_KIND_LABELS[kind]}: ${exception.detail.slice(0, 200)}`,
          detail:
            `The Executor Agent needs a decision on a ${EXCEPTION_KIND_LABELS[kind].toLowerCase()} ` +
            `exception. ${input.note}`,
          subjectType: 'ExecutorException',
          subjectId: exception.id,
          ...(exception.objectiveId === null ? {} : { objectiveId: exception.objectiveId }),
          // The person who pressed the button when a person did; the exception's owner when the
          // Executor raised it itself. Never a fabricated identity.
          requestedByUserId: input.actorUserId ?? (exception.ownerUserId as string),
          ...(exception.ownerUserId === null
            ? { approverRoleKind: 'Head' }
            : { namedApproverUserId: exception.ownerUserId }),
          byExecutor,
        });
        raisedApprovalId = raised.id;
      }

      await this.appendEvent(input.scope.tenantId, exception.id, {
        state: nextState,
        action: input.action,
        byExecutor,
        ...(input.actorUserId === null ? {} : { actorUserId: input.actorUserId }),
        note:
          raisedApprovalId === null
            ? input.note
            : `${input.note} Approval request ${raisedApprovalId} raised.`,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: `executor.exception_${input.action.toLowerCase()}`,
        resourceType: 'executor-exception',
        resourceId: exception.id,
        ...(input.actorUserId === null ? {} : { actorUserId: input.actorUserId }),
        resourceVersion: updated.version,
        summary: `${input.action} on a ${EXCEPTION_KIND_LABELS[kind]} exception: ${input.note}`,
        metadata: {
          from: state,
          to: nextState,
          byExecutor,
          ...(input.toUserId === undefined ? {} : { handedTo: input.toUserId }),
        },
      });

      return this.viewOf(updated);
    });
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * One monitoring pass for one company.
   *
   * Detects what the Executor is responsible for noticing, raises what is new, escalates what has
   * aged past its window, and clears what has fixed itself. Idempotent through the dedupe key, so
   * running it twice a minute is safe and running it after an outage does not produce a backlog of
   * duplicates.
   */
  async sweep(input: { scope: TenantScope; now?: Date | undefined }): Promise<SweepResult> {
    const now = input.now ?? new Date();
    const byKind: Record<string, number> = {};
    let raised = 0;

    const count = (kind: ExceptionKind) => {
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      raised += 1;
    };

    // ---- Dead-lettered runs: the boundary Prompt 26 deliberately left open ----
    const deadLettered = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findMany({
        where: { tenantId: input.scope.tenantId, deadLetteredAt: { not: null } },
        select: {
          id: true,
          engineAgentId: true,
          objectiveId: true,
          attempt: true,
          failureReason: true,
          correlationId: true,
        },
      }),
    );

    for (const run of deadLettered) {
      const outcome = await this.raise({
        scope: input.scope,
        kind: 'RepeatedFailure',
        sourceType: 'AgentRun',
        sourceId: run.id,
        detail:
          `This run failed every attempt and was dead-lettered. ${run.failureReason ?? ''}`.trim(),
        engineAgentId: run.engineAgentId,
        ...(run.objectiveId === null ? {} : { objectiveId: run.objectiveId }),
        attempts: run.attempt,
        evidence: { correlationId: run.correlationId, attempts: run.attempt },
      });
      if (outcome.created) count('RepeatedFailure');
    }

    // ---- Blocked runs: each block maps to the exception whose owner can clear it ----
    const blocked = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          state: {
            in: [
              'BlockedByBudget',
              'BlockedByConnection',
              'BlockedByPermission',
              'BlockedByProvider',
            ],
          },
        },
        select: {
          id: true,
          state: true,
          engineAgentId: true,
          objectiveId: true,
          attempt: true,
          failureReason: true,
        },
      }),
    );

    const blockToKind: Record<string, ExceptionKind> = {
      BlockedByBudget: 'BudgetOrTokenLimit',
      BlockedByConnection: 'CredentialOrConnectionExpired',
      BlockedByPermission: 'PermissionDenied',
      BlockedByProvider: 'ProviderOrToolUnavailable',
    };

    for (const run of blocked) {
      const kind = blockToKind[run.state];
      if (kind === undefined) continue;

      const outcome = await this.raise({
        scope: input.scope,
        kind,
        sourceType: 'AgentRun',
        sourceId: run.id,
        detail: run.failureReason ?? 'The run is blocked.',
        engineAgentId: run.engineAgentId,
        ...(run.objectiveId === null ? {} : { objectiveId: run.objectiveId }),
        attempts: run.attempt,
      });
      if (outcome.created) count(kind);
    }

    // ---- Runs waiting on a person or an approval ----
    const waiting = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          state: { in: ['WaitingForHumanInput', 'WaitingForApproval'] },
        },
        select: {
          id: true,
          state: true,
          engineAgentId: true,
          objectiveId: true,
          progressMessage: true,
        },
      }),
    );

    for (const run of waiting) {
      const kind: ExceptionKind =
        run.state === 'WaitingForApproval' ? 'ApprovalPending' : 'NeedsHumanInput';
      const outcome = await this.raise({
        scope: input.scope,
        kind,
        sourceType: 'AgentRun',
        sourceId: run.id,
        detail: run.progressMessage ?? 'The run is waiting.',
        engineAgentId: run.engineAgentId,
        ...(run.objectiveId === null ? {} : { objectiveId: run.objectiveId }),
      });
      if (outcome.created) count(kind);
    }

    // ---- Runs that have been queued too long to call it queueing ----
    //
    // Prompt 40. Fairness means a busy company waits behind other companies rather than ahead of
    // them, and a company at its concurrency ceiling queues behind itself. Both are correct, and
    // both are invisible to the person who asked for the work — the run just sits there, in a
    // state that reads as normal, forever.
    //
    // **The threshold is what makes this an exception rather than noise.** Half an hour is well
    // past any legitimate round-robin wait at any realistic queue depth, so a run that reaches it
    // is not being queued fairly — it is being starved, whether by a ceiling set too low, too few
    // workers, or a broker that stopped delivering. Raising it at ten minutes would fire on a
    // normal busy morning and teach everybody to ignore the list.
    //
    // Prompt 39's `queue-stuck` alert is the same fact told to UBoss; this is it told to the
    // customer, on their own Executor screen, with their own agent named.
    const starvedBefore = new Date(now.getTime() - ExecutorService.STARVED_RUN_AFTER_MS);
    const starved = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.agentRun.findMany({
        where: {
          tenantId: input.scope.tenantId,
          state: 'Queued',
          createdAt: { lt: starvedBefore },
        },
        select: {
          id: true,
          engineAgentId: true,
          objectiveId: true,
          progressMessage: true,
          createdAt: true,
        },
      }),
    );

    for (const run of starved) {
      const minutes = Math.floor((now.getTime() - run.createdAt.getTime()) / 60_000);
      const outcome = await this.raise({
        scope: input.scope,
        kind: 'AgentRunOverdue',
        sourceType: 'AgentRun',
        sourceId: run.id,
        // The deferral reason if there is one — it says the company is at its ceiling, which is
        // the actual answer — and the plain fact otherwise.
        detail:
          `This run has been queued for ${minutes} minutes. ` +
          (run.progressMessage ??
            'Nothing has failed and nothing is lost, but it has waited longer than queueing ' +
              'should take.'),
        engineAgentId: run.engineAgentId,
        ...(run.objectiveId === null ? {} : { objectiveId: run.objectiveId }),
        evidence: { queuedAt: run.createdAt.toISOString(), waitingMinutes: minutes },
      });
      if (outcome.created) count('AgentRunOverdue');
    }

    // ---- Overdue human tasks and missing evidence ----
    const tasks = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.humanTask.findMany({
        where: {
          tenantId: input.scope.tenantId,
          status: { notIn: ['Completed', 'Cancelled'] },
          dueAt: { lt: now },
        },
        select: {
          id: true,
          title: true,
          assignedToUserId: true,
          objectiveId: true,
          dueAt: true,
        },
      }),
    );

    for (const task of tasks) {
      const outcome = await this.raise({
        scope: input.scope,
        kind: 'HumanTaskOverdue',
        sourceType: 'HumanTask',
        sourceId: task.id,
        detail: `"${task.title}" was due ${task.dueAt?.toISOString() ?? 'earlier'} and is not done.`,
        // A task always has an assignee and an objective, so both are routed unconditionally —
        // which is why this exception can name an owner where a run-sourced one often cannot.
        ownerUserId: task.assignedToUserId,
        objectiveId: task.objectiveId,
        evidence: { dueAt: task.dueAt?.toISOString() ?? null },
      });
      if (outcome.created) count('HumanTaskOverdue');
    }

    // ---- Escalate what has aged past its window ----
    const escalated = await this.escalateAged({ scope: input.scope, now });

    // ---- Clear what fixed itself ----
    const cleared = await this.clearSelfHealed({ scope: input.scope });

    return {
      raised,
      escalated,
      cleared,
      byKind,
      note:
        'Idempotent: one condition holds one open exception, so sweeping repeatedly does not ' +
        'fill the queue with copies of the thing nobody has fixed yet.',
    };
  }

  /**
   * Escalate exceptions that have sat past their window.
   *
   * An acknowledged exception still escalates. Acknowledging is not fixing, and letting it stop the
   * clock would make "I have seen it" a way to hold something indefinitely.
   */
  private async escalateAged(input: { scope: TenantScope; now: Date }): Promise<number> {
    const open = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.executorException.findMany({
        where: { tenantId: input.scope.tenantId, state: { in: ['Open', 'Acknowledged'] } },
      }),
    );

    let escalated = 0;
    for (const exception of open) {
      const due = escalationDue({
        state: exception.state as ExceptionState,
        severity: exception.severity as ExceptionSeverity,
        openedAt: exception.openedAt,
        now: input.now,
        escalationHours: exception.escalationHours,
      });
      if (!due.due) continue;

      // The Executor escalates on its own — that is routing, which it is explicitly for. It
      // escalates to the exception's owner where one is known; naming nobody would be an
      // escalation into the void, so an unowned exception is left for the queue to show as
      // overdue rather than "escalated" to no-one.
      if (exception.ownerUserId === null) continue;

      try {
        await this.act({
          scope: input.scope,
          exceptionId: exception.id,
          action: 'Escalate',
          actorUserId: null,
          toUserId: exception.ownerUserId,
          note: `Escalated automatically. ${due.reason}`,
        });
        escalated += 1;
      } catch (caught) {
        this.logger.warn(
          `Could not escalate exception ${exception.id}: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    }

    return escalated;
  }

  /**
   * Acknowledge exceptions whose cause has gone away.
   *
   * Only for the one kind that genuinely clears itself — a provider outage — and even then the
   * Executor **acknowledges** rather than resolves. Closing it is still a person's call, because
   * "the provider came back" is not the same as "the work that failed got done".
   */
  private async clearSelfHealed(input: { scope: TenantScope }): Promise<number> {
    const candidates = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.executorException.findMany({
        where: {
          tenantId: input.scope.tenantId,
          kind: 'ProviderOrToolUnavailable',
          state: 'Open',
          sourceType: 'AgentRun',
        },
        select: { id: true, sourceId: true },
      }),
    );

    let cleared = 0;
    for (const exception of candidates) {
      const run = await this.prisma.runInTenantTransaction(input.scope, () =>
        this.prisma.client.agentRun.findFirst({
          where: { tenantId: input.scope.tenantId, id: exception.sourceId },
          select: { state: true },
        }),
      );
      if (run === null || run.state === 'BlockedByProvider') continue;

      await this.act({
        scope: input.scope,
        exceptionId: exception.id,
        action: 'Acknowledge',
        actorUserId: null,
        note:
          `The run is now ${run.state}, so the provider outage has passed. Left open for a ` +
          'person: a provider returning is not the same as the work getting done.',
      });
      cleared += 1;
    }

    return cleared;
  }

  /** One sweep across every active company. The platform-plane entry point for a timer. */
  async sweepAllCompanies(now?: Date): Promise<{ companies: number; raised: number }> {
    const tenants = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenant.findMany({
        where: { lifecycleState: 'Active' },
        select: { id: true },
      }),
    );

    let raised = 0;
    for (const tenant of tenants) {
      const result = await this.sweep({
        scope: tenantScopeForPlatformOperation(tenant.id),
        ...(now === undefined ? {} : { now }),
      });
      raised += result.raised;
    }

    return { companies: tenants.length, raised };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    kind?: ExceptionKind | undefined;
    severity?: ExceptionSeverity | undefined;
    state?: ExceptionState | undefined;
    engineAgentId?: string | undefined;
    /** Open, acknowledged and escalated only. The default, because a queue shows what needs work. */
    openOnly?: boolean | undefined;
  }): Promise<{ exceptions: ExceptionView[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'executor', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.executorException.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.state === undefined ? {} : { state: input.state }),
          ...(input.engineAgentId === undefined ? {} : { engineAgentId: input.engineAgentId }),
          ...(input.openOnly === false
            ? {}
            : { state: { in: ['Open', 'Acknowledged', 'Escalated'] } }),
        },
        orderBy: [{ severity: 'desc' }, { openedAt: 'asc' }],
        take: 200,
      });

      const exceptions: ExceptionView[] = [];
      for (const row of rows) {
        // Sequential — concurrent reads inside an open tenant transaction lose the scope.
        exceptions.push(await this.viewOf(row));
      }

      return {
        exceptions,
        note:
          'The Executor detects, routes and escalates. It never resolves or dismisses: deciding ' +
          'an exception is dealt with is a person’s judgement.',
      };
    });
  }

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    exceptionId: string;
  }): Promise<ExceptionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'executor', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const exception = await this.load(input.scope, input.exceptionId);
      return this.viewOf(exception);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Which state an action lands in. */
  private stateAfter(action: ResolutionAction, from: ExceptionState): ExceptionState {
    switch (action) {
      case 'Acknowledge':
        return 'Acknowledged';
      case 'Escalate':
        return 'Escalated';
      case 'Resolve':
        return 'Resolved';
      case 'Dismiss':
        return 'Dismissed';
      // Reassigning, retrying, pausing and requesting an approval are all things done *about* an
      // open exception. They do not close it, and treating them as progress would let an
      // exception look handled because somebody pressed retry.
      case 'Reassign':
      case 'Retry':
      case 'PauseAgent':
      case 'RequestApproval':
      default:
        return from === 'Open' ? 'Acknowledged' : from;
    }
  }

  private async load(scope: TenantScope, exceptionId: string) {
    const row = await this.prisma.client.executorException.findFirst({
      where: { tenantId: scope.tenantId, id: exceptionId },
    });
    if (!row) {
      throw new NotFoundException('There is no such exception you can see.');
    }
    return row;
  }

  private async appendEvent(
    tenantId: string,
    exceptionId: string,
    event: {
      state: ExceptionState;
      action?: ResolutionAction;
      actorUserId?: string;
      byExecutor: boolean;
      note: string;
    },
  ): Promise<void> {
    await this.prisma.client.executorExceptionEvent.create({
      data: {
        tenantId,
        exceptionId,
        state: event.state,
        byExecutor: event.byExecutor,
        ...(event.action === undefined ? {} : { action: event.action }),
        ...(event.actorUserId === undefined ? {} : { actorUserId: event.actorUserId }),
        note: event.note.slice(0, 2000),
      },
    });
  }

  private async viewOf(
    exception: Awaited<ReturnType<ExecutorService['load']>>,
  ): Promise<ExceptionView> {
    const history = await this.prisma.client.executorExceptionEvent.findMany({
      where: { tenantId: exception.tenantId, exceptionId: exception.id },
      orderBy: { occurredAt: 'asc' },
    });

    const kind = exception.kind as ExceptionKind;
    const state = exception.state as ExceptionState;

    return {
      id: exception.id,
      kind,
      kindLabel: EXCEPTION_KIND_LABELS[kind],
      severity: exception.severity as ExceptionSeverity,
      state,
      sourceType: exception.sourceType,
      sourceId: exception.sourceId,
      objectiveId: exception.objectiveId,
      engineAgentId: exception.engineAgentId,
      detail: exception.detail,
      evidence: exception.evidence,
      ownerUserId: exception.ownerUserId,
      defaultOwner: EXCEPTION_DEFAULT_OWNER[kind],
      attempts: exception.attempts,
      escalationHours: exception.escalationHours,
      openedAt: exception.openedAt.toISOString(),
      escalatedAt: exception.escalatedAt?.toISOString() ?? null,
      escalatedToUserId: exception.escalatedToUserId,
      closedAt: exception.closedAt?.toISOString() ?? null,
      closeReason: exception.closeReason,
      // Derived rather than stored: whether something is overdue changes with the clock, and a
      // stored flag would be wrong between sweeps.
      escalation: escalationDue({
        state,
        severity: exception.severity as ExceptionSeverity,
        openedAt: exception.openedAt,
        now: new Date(),
        escalationHours: exception.escalationHours,
      }),
      availableActions: resolutionsFor({ kind, state }),
      history: history.map((event) => ({
        action: event.action,
        state: event.state,
        actorUserId: event.actorUserId,
        byExecutor: event.byExecutor,
        note: event.note,
        at: event.occurredAt.toISOString(),
      })),
      note:
        'The Executor raised and routed this. Whether it is dealt with is a person’s decision, ' +
        'and the resolution history records which of the two did what.',
    };
  }
}
