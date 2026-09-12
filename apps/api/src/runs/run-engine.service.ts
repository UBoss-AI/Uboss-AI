import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';

import {
  DEFAULT_MAX_RUN_ATTEMPTS,
  DEFAULT_OVERLAP_POLICY,
  isRunFinished,
  mayCancelRun,
  mayMoveRun,
  mayRetryRun,
  overlapDecision,
  retryDelayMs,
  runIdempotencyKey,
  type OverlapPolicy,
  type Retryability,
  type RunProgressEvent,
  type RunState,
  type RunTrigger,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { BudgetRefusedError, ModelGateway } from '../model-gateway/model-gateway.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import {
  createRequestContext,
  runWithRequestContext,
} from '../request-context/request-context.js';
import { RunFairnessService } from '../rate-limits/run-fairness.service.js';
import { RunProgressGateway } from './run-progress.gateway.js';
import { RunQueue, type RunJob } from './run-queue.js';

/** What one run looks like to a caller. */
export interface AgentRunView {
  id: string;
  engineAgentId: string;
  engineAgentVersionId: string;
  aiWorkAssignmentId: string | null;
  objectiveId: string | null;
  state: RunState;
  trigger: RunTrigger;
  idempotencyKey: string;
  correlationId: string;
  attempt: number;
  maxAttempts: number;
  retryability: Retryability | null;
  scheduledFor: string | null;
  reservedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  percent: number | null;
  progressMessage: string | null;
  output: unknown;
  failureReason: string | null;
  /** False when the mock gateway did the work. Never presented as a real provider result. */
  producedByRealModel: boolean | null;
  cancelledAt: string | null;
  deadLetteredAt: string | null;
  events: { state: string | null; percent: number | null; message: string; at: string }[];
  note: string;
}

/** Raised by an executor to say what kind of failure this was. */
export class RunFailure extends Error {
  constructor(
    message: string,
    readonly retryability: Retryability,
    /** Set to move the run to a specific blocked state instead of failing it. */
    readonly blockedState?: RunState,
  ) {
    super(message);
    this.name = 'RunFailure';
  }
}

/**
 * The Run Engine — Prompt 26.
 *
 * ## The ordering that matters
 *
 * A durable Run row is written **before** anything is enqueued, and before any work starts. The
 * architecture requires it, and the reason is recoverability: a worker that dies mid-run leaves a
 * row somebody can find, not work that silently never happened. Everything else here follows from
 * that — the queue is transport, the row is the truth, and a WebSocket message is a convenience.
 *
 * ## Queued → Reserved → Running, never Queued → Running
 *
 * `Reserved` is where budget is set aside. Letting a run reach `Running` without it would have
 * work start spending before anything checked it could. The transition table refuses the shortcut
 * and a database CHECK refuses the row.
 *
 * ## Retries are the engine's, not the queue's
 *
 * BullMQ is configured with `attempts: 1` so its own retry machinery is off. This service
 * classifies the failure, decides whether another attempt is warranted, and re-enqueues with its
 * own backoff. Two retry mechanisms would attempt a run twice as often as the company configured.
 *
 * ## A retry is a new attempt on the same run, but a *rerun* is a new run
 *
 * `Retrying → Reserved` keeps one row with an incrementing attempt, so one occurrence has one
 * history. Re-running a finished run creates a new row with its own idempotency key, because a
 * terminal state leads nowhere and provider calls have to be attributable to one attempt.
 */
@Injectable()
export class RunEngineService implements OnModuleInit {
  private readonly logger = new Logger(RunEngineService.name);

  /**
   * How the assigned work is actually performed.
   *
   * The Model Gateway by default, which today is the mock. The prompt permits exactly this: "Use
   * mock Agent executor if provider gateway not complete." What is *not* permitted is pretending
   * otherwise, so every run records `producedByRealModel` from the gateway's own answer.
   */
  private executor:
    | ((run: { id: string; tenantId: string; attempt: number }) => Promise<{
        output: unknown;
        producedByRealModel: boolean;
      }>)
    | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
    private readonly queue: RunQueue,
    private readonly modelGateway: ModelGateway,
    private readonly progress: RunProgressGateway,
    /**
     * Prompt 40. Optional so a test can construct the engine without it, and so a deployment that
     * has not wired fairness still runs work rather than refusing to start — an absent fairness
     * service means "no cap", which is the behaviour before this prompt.
     */
    @Optional() private readonly fairness?: RunFairnessService | undefined,
  ) {}

  onModuleInit(): void {
    // **The correlation context is re-established around the job** — Prompt 39.
    //
    // A worker is a different async context, so the `AsyncLocalStorage` the request set up is
    // gone by the time a job runs. The run row has carried `correlationId` since Prompt 26; this
    // puts it back into scope, which is what makes the chain unbroken rather than nearly
    // unbroken: without it the model-gateway call and the cost ledger entry a run produces would
    // record no correlation at all, and "what did this click spend" would stop at the run.
    this.queue.onRun((job) =>
      runWithRequestContext(createRequestContext(job.correlationId), () => this.perform(job)),
    );
  }

  /**
   * Put a run back, or leave it for the next dispatch.
   *
   * ## Why the two transports behave differently, and why that is not a fudge
   *
   * A broker can hold a delayed job, so the run is re-enqueued with a short delay and comes back
   * on its own. The inline transport cannot: `enqueueAfter` runs the job immediately, so
   * re-enqueuing a deferred run would recurse until the stack gave out — the cap would turn into a
   * crash, which is a far worse failure than the starvation it was added to prevent.
   *
   * So on the inline transport the run is **left `Queued`** with its reason on the row, and the
   * next `admissionPlan` dispatch picks it up in fair order. That is not a weaker guarantee: in
   * both cases the work is queued, attributed, and started when a slot frees. What differs is
   * *what wakes it*, and the runbook says which one you have.
   */
  private async deferOrLeaveQueued(job: RunJob, reason: string): Promise<void> {
    if (!this.queue.isDurableTransport) {
      this.logger.debug(
        `Run ${job.runId} is held back for fairness and stays queued: ${reason}`,
      );
      return;
    }

    // A second, not the retry backoff: this is not a failure, it is a queue position. Long enough
    // that a busy company does not spin, short enough that a freed slot is used promptly.
    await this.queue.enqueueAfter(job, 1_000);
  }

  /** Replace the executor. Used by tests to steer a failure without a real provider. */
  setExecutor(
    executor:
      | ((run: { id: string; tenantId: string; attempt: number }) => Promise<{
          output: unknown;
          producedByRealModel: boolean;
        }>)
      | null,
  ): void {
    this.executor = executor;
  }

  // -------------------------------------------------------------------------
  // Creating a run
  // -------------------------------------------------------------------------

  /**
   * Create the durable row and enqueue it.
   *
   * Idempotent by construction: two callers that mean the same occurrence compute the same key,
   * and the unique index makes the second a no-op that returns the first run rather than an
   * error. That is what makes a scheduler safe to run on two instances.
   */
  async start(input: {
    scope: TenantScope;
    engineAgentId: string;
    trigger: RunTrigger;
    /** What makes this occurrence distinct. A manual start may omit it and get a nonce. */
    occurrence?: string | undefined;
    scheduledFor?: Date | undefined;
    startedByUserId?: string | undefined;
    correlationId?: string | undefined;
  }): Promise<{ run: AgentRunView; created: boolean; reason: string }> {
    const created = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.prisma.client.engineAgent.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.engineAgentId },
      });
      if (!agent) {
        throw new NotFoundException('There is no such Engine Agent you can see.');
      }
      if (agent.currentVersionId === null) {
        throw new ConflictException(
          'This agent has no configuration in force, so there is nothing to run.',
        );
      }
      if (agent.status !== 'Active') {
        throw new ConflictException(
          `This agent is ${agent.status}. Only an active agent runs — pausing an agent that could ` +
            'still be triggered would not be a pause.',
        );
      }

      // Overlap is decided before the row is written, so a skipped occurrence leaves no run at
      // all rather than a row that immediately cancels itself.
      const unfinished = await this.prisma.client.agentRun.count({
        where: {
          tenantId: input.scope.tenantId,
          engineAgentId: agent.id,
          state: { notIn: ['Completed', 'Failed', 'Cancelled'] },
        },
      });
      const policy = (agent.overlapPolicy ?? DEFAULT_OVERLAP_POLICY) as OverlapPolicy;
      const overlap = overlapDecision({ policy, unfinishedRuns: unfinished });

      if (!overlap.start && !overlap.queue) {
        return { run: null, created: false, reason: overlap.reason } as const;
      }

      const assignment = await this.prisma.client.aiWorkAssignment.findFirst({
        where: { tenantId: input.scope.tenantId, engineAgentId: agent.id },
        select: { id: true, objectiveId: true },
      });

      const idempotencyKey = runIdempotencyKey({
        engineAgentId: agent.id,
        assignmentId: assignment?.id ?? null,
        trigger: input.trigger,
        // A manual start gets a nonce: pressing the button twice means somebody wants it twice,
        // and deduplicating that would silently ignore an instruction.
        occurrence: input.occurrence ?? randomUUID(),
      });

      const existing = await this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, idempotencyKey },
      });
      if (existing) {
        return {
          run: existing,
          created: false,
          reason:
            'A run for this occurrence already exists. The idempotency key matched, so this is ' +
            'the same occurrence rather than a new one.',
        } as const;
      }

      const maxAttempts = agent.status === 'Active' ? DEFAULT_MAX_RUN_ATTEMPTS : 1;

      const row = await this.prisma.client.agentRun.create({
        data: {
          tenantId: input.scope.tenantId,
          engineAgentId: agent.id,
          engineAgentVersionId: agent.currentVersionId,
          ...(assignment === null ? {} : { aiWorkAssignmentId: assignment.id }),
          ...(assignment?.objectiveId === undefined ? {} : { objectiveId: assignment.objectiveId }),
          state: 'Queued',
          trigger: input.trigger,
          idempotencyKey,
          correlationId: input.correlationId ?? randomUUID(),
          maxAttempts,
          ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
          ...(input.startedByUserId === undefined
            ? {}
            : { startedByUserId: input.startedByUserId }),
        },
      });

      await this.appendEvent(row.id, input.scope.tenantId, {
        state: 'Queued',
        message: `Queued (${input.trigger}). ${overlap.reason}`,
        attempt: 1,
      });

      await this.prisma.client.engineAgent.update({
        where: { id: agent.id },
        data: { lastRunAt: new Date() },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.run_queued',
        resourceType: 'agent-run',
        resourceId: row.id,
        ...(input.startedByUserId === undefined ? {} : { actorUserId: input.startedByUserId }),
        resourceRef: agent.name,
        summary:
          `Queued a ${input.trigger} run of "${agent.name}" against version in force. The row ` +
          'exists before the work does, so a crash leaves something findable.',
        metadata: {
          trigger: input.trigger,
          correlationId: row.correlationId,
          overlapPolicy: policy,
          unfinishedRunsAtQueueTime: unfinished,
        },
      });

      return { run: row, created: true, reason: overlap.reason } as const;
    });

    if (created.run === null) {
      throw new ConflictException(created.reason);
    }

    if (created.created) {
      // Published after the commit, before the enqueue. The durable history already records the
      // Queued event; without this the live stream would start at Reserved and disagree with the
      // record it is meant to mirror.
      this.progress.publish(created.run.tenantId, {
        runId: created.run.id,
        engineAgentId: created.run.engineAgentId,
        state: 'Queued',
        percent: null,
        message: created.reason,
        attempt: created.run.attempt,
        at: new Date().toISOString(),
        correlationId: created.run.correlationId,
      });

      // Enqueued after the transaction commits. Enqueuing inside it can hand a worker a run id
      // that is not visible yet — the classic read-your-own-write race, and the worker's read
      // would find nothing.
      await this.queue.enqueue({
        runId: created.run.id,
        tenantId: created.run.tenantId,
        correlationId: created.run.correlationId,
        attempt: created.run.attempt,
      });
    }

    return {
      run: await this.view({ scope: input.scope, runId: created.run.id }),
      created: created.created,
      reason: created.reason,
    };
  }

  // -------------------------------------------------------------------------
  // Performing a run
  // -------------------------------------------------------------------------

  /**
   * The worker's entry point: reserve, run, then finish or fail.
   *
   * Each phase is its own transaction. Holding one open across the provider call would pin a
   * database connection for the length of a model request, which at scale is how a pool runs dry.
   */
  private async perform(job: RunJob): Promise<void> {
    const scope = tenantScopeForPlatformOperation(job.tenantId);

    // ---- Prompt 40: fairness admission, before anything is reserved ----
    //
    // **At pickup, not at enqueue.** At enqueue the answer would be stale by the time the job ran,
    // and the work is not being refused — only ordered. The durable row exists either way.
    //
    // Checked before `Reserved` deliberately: reserving budget for a run that is about to be put
    // back would take a hold against the company's wallet for work that has not started, and the
    // reservation-drift alert would then fire on a queue that was merely busy.
    if (this.fairness !== undefined) {
      const admission = await this.fairness.mayStart(job.tenantId);
      if (!admission.admit) {
        await this.fairness.recordDeferral(job.runId, job.tenantId, admission.reason);
        await this.deferOrLeaveQueued(job, admission.reason);
        return;
      }
    }

    const reserved = await this.prisma.runInTenantTransaction(scope, async () => {
      const run = await this.prisma.client.agentRun.findFirst({ where: { id: job.runId } });
      if (!run) {
        // A run the worker cannot see is not an error to retry: the row is the truth, and if it
        // is gone the work is not ours to do.
        this.logger.warn(`Run ${job.runId} no longer exists; nothing to perform.`);
        return null;
      }
      if (isRunFinished(run.state as RunState)) {
        // Cancelled while queued is the common case, and it must not start.
        return null;
      }
      if (!mayMoveRun(run.state as RunState, 'Reserved')) {
        this.logger.warn(`Run ${job.runId} is ${run.state}; it cannot be reserved.`);
        return null;
      }

      return this.move(run.id, job.tenantId, 'Reserved', {
        reservedAt: new Date(),
        // Cleared, because this attempt has not started yet. A run coming back from a retry or
        // from a resolved block still carries the previous attempt's start time, and leaving it
        // would put the start before the new reservation — both false, and refused by the
        // `run_started_after_it_was_reserved` constraint.
        startedAt: null,
        message: 'Reserved. Budget is set aside before any work starts.',
      });
    });

    if (reserved === null) return;

    const running = await this.prisma.runInTenantTransaction(scope, () =>
      this.move(job.runId, job.tenantId, 'Running', {
        startedAt: new Date(),
        percent: 0,
        message: 'Running.',
      }),
    );
    if (running === null) return;

    try {
      const outcome = await this.execute(job);

      await this.prisma.runInTenantTransaction(scope, async () => {
        await this.move(job.runId, job.tenantId, 'Completed', {
          finishedAt: new Date(),
          percent: 100,
          output: outcome.output,
          producedByRealModel: outcome.producedByRealModel,
          message: outcome.producedByRealModel
            ? 'Completed against a live model provider.'
            : 'Completed against the built-in mock model, not a live provider.',
        });
      });
    } catch (caught) {
      await this.fail(scope, job, caught);
    }
  }

  /** The work itself. The mock gateway unless a caller replaced the executor. */
  private async execute(job: RunJob): Promise<{ output: unknown; producedByRealModel: boolean }> {
    if (this.executor !== null) {
      return this.executor({ id: job.runId, tenantId: job.tenantId, attempt: job.attempt });
    }

    // Which budgets this run's spend belongs to — Prompt 30. Read here rather than carried on
    // the queue job, because a job is a durable message and adding attribution to it would mean
    // old messages in the queue lacked it. One query at the moment of use is the honest cost.
    const attribution = await this.spendAttribution(job);

    const response = await this.modelGateway.complete({
      // Section 18: "normal AI work".
      profile: 'AGENT_STANDARD',
      purpose: 'EngineAgentRun',
      instruction: 'Perform the assigned AI work for this run and report the result.',
      context: `Run ${job.runId}, attempt ${job.attempt}, correlation ${job.correlationId}`,
      maxTokens: 800,
      tenantId: job.tenantId,
      agentRunId: job.runId,
      ...(attribution.engineAgentId === null ? {} : { engineAgentId: attribution.engineAgentId }),
      ...(attribution.objectiveId === null ? {} : { objectiveId: attribution.objectiveId }),
      ...(attribution.departmentId === null ? {} : { departmentId: attribution.departmentId }),
    });

    return {
      output: { text: response.output, capability: response.capability },
      producedByRealModel: response.producedByRealModel,
    };
  }

  /**
   * Which budgets a run's spend belongs to.
   *
   * The department comes from the agent's owner rather than from the run, because a run has no
   * department of its own — the agent belongs to somebody and that person belongs to a
   * department. Any level that cannot be determined is simply omitted, and the check then
   * happens against the levels that can be: a spend attributable to fewer budgets is checked
   * against fewer, never against none, since the company level is always present.
   */
  private async spendAttribution(job: RunJob): Promise<{
    engineAgentId: string | null;
    objectiveId: string | null;
    departmentId: string | null;
  }> {
    return this.prisma.runInTenantTransaction(
      { tenantId: job.tenantId } as TenantScope,
      async () => {
        const run = await this.prisma.client.agentRun.findFirst({
          where: { tenantId: job.tenantId, id: job.runId },
          select: { engineAgentId: true, objectiveId: true },
        });
        if (run === null) {
          return { engineAgentId: null, objectiveId: null, departmentId: null };
        }

        const agent = await this.prisma.client.engineAgent.findFirst({
          where: { tenantId: job.tenantId, id: run.engineAgentId },
          select: { ownerUserId: true },
        });

        const employment =
          agent === null
            ? null
            : await this.prisma.client.employmentRecord.findFirst({
                where: { tenantId: job.tenantId, userId: agent.ownerUserId },
                select: { departmentId: true },
              });

        return {
          engineAgentId: run.engineAgentId,
          objectiveId: run.objectiveId,
          departmentId: employment?.departmentId ?? null,
        };
      },
    );
  }

  /**
   * Classify the failure, then retry or dead-letter.
   *
   * The dead-letter path preserves context rather than dropping the work, and raises an Executor
   * expectation so a person sees it. That is the architecture's requirement, and the reason a
   * spent run is `Failed` with `dead_lettered_at` set rather than quietly disappearing.
   */
  private async fail(scope: TenantScope, job: RunJob, caught: unknown): Promise<void> {
    const failure =
      caught instanceof RunFailure
        ? caught
        : caught instanceof BudgetRefusedError
          ? // Terminal, not retryable: a hard stop does not clear by trying again, and an
            // approval threshold clears when a person decides — neither is a transient fault.
            new RunFailure(caught.message, 'Terminal', 'BlockedByBudget')
          : new RunFailure(
            caught instanceof Error ? caught.message : String(caught),
            // An unclassified throw is treated as retryable: a bug that always throws burns its
            // bounded attempts and then dead-letters, which is visible. Treating it as terminal
            // would turn a transient fault into a permanent failure on the first blip.
              'Retryable',
            );

    const decision = await this.prisma.runInTenantTransaction(scope, async () => {
      const run = await this.prisma.client.agentRun.findFirst({ where: { id: job.runId } });
      if (!run || isRunFinished(run.state as RunState)) return null;

      // A blocked failure is not a retry decision: it is somebody's to resolve, and it says whose.
      if (failure.blockedState !== undefined) {
        await this.move(run.id, job.tenantId, failure.blockedState, {
          failureReason: failure.message,
          retryability: failure.retryability,
          message: failure.message,
        });
        return null;
      }

      const retry = mayRetryRun({
        retryability: failure.retryability,
        attempt: run.attempt,
        maxAttempts: run.maxAttempts,
      });

      if (!retry.allowed) {
        await this.move(run.id, job.tenantId, 'Failed', {
          finishedAt: new Date(),
          failureReason: `${failure.message} ${retry.reason}`,
          retryability: failure.retryability,
          deadLetteredAt: new Date(),
          message: `Failed and dead-lettered. ${retry.reason}`,
        });

        // No exception row is written here, and that is a boundary rather than an omission.
        // `ExecutorExpectation` is foreign-keyed to an objective *version*, which a run started
        // directly against an agent does not have — passing the agent id as an objective id
        // would be fabricated linkage, and a broken key at best. The Exception Center is the
        // next prompt, and it can find these precisely: `dead_lettered_at IS NOT NULL` with the
        // whole event history and correlation id preserved on the row. Dead-lettering here does
        // the part the architecture asks of it — it preserves context instead of dropping work.
        await this.auditEvents.appendWithinCurrentScope(job.tenantId, {
          action: 'agent.run_dead_lettered',
          resourceType: 'agent-run',
          resourceId: run.id,
          summary:
            `Run failed after ${run.attempt} attempt(s) and was dead-lettered. ${retry.reason} ` +
            'The context is preserved and an Executor exception was raised.',
          metadata: {
            attempts: run.attempt,
            retryability: failure.retryability,
            correlationId: run.correlationId,
          },
        });

        return null;
      }

      await this.move(run.id, job.tenantId, 'Retrying', {
        attempt: run.attempt + 1,
        failureReason: failure.message,
        retryability: failure.retryability,
        // The reservation was released when the attempt failed, so the next attempt takes one
        // again rather than assuming it still holds.
        reservedAt: null,
        startedAt: null,
        message: `Attempt ${run.attempt} failed: ${failure.message}. Retrying.`,
      });

      return { attempt: run.attempt + 1, correlationId: run.correlationId } as const;
    });

    if (decision === null) return;

    await this.queue.enqueueAfter(
      {
        runId: job.runId,
        tenantId: job.tenantId,
        correlationId: decision.correlationId,
        attempt: decision.attempt,
      },
      retryDelayMs(decision.attempt - 1),
    );
  }

  // -------------------------------------------------------------------------
  // Waiting, resuming, cancelling
  // -------------------------------------------------------------------------

  /** Park a run until a person or an approval arrives. */
  async waitFor(input: {
    scope: TenantScope;
    runId: string;
    state: 'WaitingForHumanInput' | 'WaitingForApproval';
    reason: string;
  }): Promise<AgentRunView> {
    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.move(input.runId, input.scope.tenantId, input.state, { message: input.reason }),
    );
    return this.view({ scope: input.scope, runId: input.runId });
  }

  /** Resume a waiting run, or re-queue a blocked one whose cause was resolved. */
  async resume(input: { scope: TenantScope; runId: string; note: string }): Promise<AgentRunView> {
    const next = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.runId },
      });
      if (!run) throw new NotFoundException('There is no such run you can see.');

      const state = run.state as RunState;
      // A waiting run goes back to Running, because it still holds its reservation. A blocked one
      // goes back to Queued, because whatever it held was released when it blocked.
      const to: RunState = mayMoveRun(state, 'Running') ? 'Running' : 'Queued';
      if (!mayMoveRun(state, to)) {
        throw new ConflictException(`A run that is ${state} cannot be resumed.`);
      }

      await this.move(run.id, input.scope.tenantId, to, {
        message: `Resumed: ${input.note}`,
        ...(to === 'Queued' ? { failureReason: null } : {}),
      });

      return { to, correlationId: run.correlationId, attempt: run.attempt } as const;
    });

    if (next.to === 'Queued') {
      await this.queue.enqueue({
        runId: input.runId,
        tenantId: input.scope.tenantId,
        correlationId: next.correlationId,
        attempt: next.attempt,
      });
    }

    return this.view({ scope: input.scope, runId: input.runId });
  }

  /**
   * Cancel a run.
   *
   * Safe from every state that has not finished, including the waiting and blocked ones — a run
   * stuck waiting for a person who has left, or a connection nobody will fix, must not be
   * un-cancellable.
   */
  async cancel(input: {
    scope: TenantScope;
    runId: string;
    actorUserId: string;
    reason: string;
  }): Promise<AgentRunView> {
    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.runId },
      });
      if (!run) throw new NotFoundException('There is no such run you can see.');

      if (!mayCancelRun(run.state as RunState)) {
        throw new ConflictException(
          `This run is ${run.state} and has already finished. Cancelling it would rewrite history.`,
        );
      }

      await this.move(run.id, input.scope.tenantId, 'Cancelled', {
        finishedAt: new Date(),
        cancelledAt: new Date(),
        cancelledByUserId: input.actorUserId,
        failureReason: input.reason,
        message: `Cancelled: ${input.reason}`,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.run_cancelled',
        resourceType: 'agent-run',
        resourceId: run.id,
        actorUserId: input.actorUserId,
        summary: `Run cancelled from ${run.state}: ${input.reason}`,
        metadata: { from: run.state, correlationId: run.correlationId },
      });
    });

    return this.view({ scope: input.scope, runId: input.runId });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async view(input: { scope: TenantScope; runId: string }): Promise<AgentRunView> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const run = await this.prisma.client.agentRun.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.runId },
        include: { events: { orderBy: { occurredAt: 'asc' } } },
      });
      if (!run) throw new NotFoundException('There is no such run you can see.');
      return this.viewOf(run);
    });
  }

  async listForAgent(input: {
    scope: TenantScope;
    engineAgentId: string;
    limit?: number | undefined;
  }): Promise<{ runs: AgentRunView[]; note: string }> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const runs = await this.prisma.client.agentRun.findMany({
        where: { tenantId: input.scope.tenantId, engineAgentId: input.engineAgentId },
        include: { events: { orderBy: { occurredAt: 'asc' } } },
        orderBy: { createdAt: 'desc' },
        take: Math.min(input.limit ?? 50, 200),
      });

      return {
        runs: runs.map((run) => this.viewOf(run)),
        note:
          'Every run cites the immutable agent version that produced it, so what settings ' +
          'produced an output stays answerable.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The single place a run changes state.
   *
   * Refuses any move the transition table does not permit, writes the durable event, and pushes
   * the live update — in that order, so a client never sees a state the database has not accepted.
   */
  private async move(
    runId: string,
    tenantId: string,
    to: RunState,
    change: {
      message: string;
      attempt?: number;
      percent?: number;
      output?: unknown;
      failureReason?: string | null;
      retryability?: Retryability;
      producedByRealModel?: boolean;
      reservedAt?: Date | null;
      startedAt?: Date | null;
      finishedAt?: Date;
      cancelledAt?: Date;
      cancelledByUserId?: string;
      deadLetteredAt?: Date;
    },
  ) {
    const run = await this.prisma.client.agentRun.findFirst({ where: { id: runId } });
    if (!run) throw new NotFoundException('There is no such run you can see.');

    const from = run.state as RunState;
    if (from !== to && !mayMoveRun(from, to)) {
      throw new ConflictException(
        `A run cannot move from ${from} to ${to}. That is not a transition the engine permits.`,
      );
    }

    const updated = await this.prisma.client.agentRun.update({
      where: { id: runId },
      data: {
        state: to,
        progressMessage: change.message.slice(0, 500),
        ...(change.attempt === undefined ? {} : { attempt: change.attempt }),
        ...(change.percent === undefined ? {} : { percent: change.percent }),
        ...(change.output === undefined ? {} : { output: change.output as object }),
        ...(change.failureReason === undefined ? {} : { failureReason: change.failureReason }),
        ...(change.retryability === undefined ? {} : { retryability: change.retryability }),
        ...(change.producedByRealModel === undefined
          ? {}
          : { producedByRealModel: change.producedByRealModel }),
        ...(change.reservedAt === undefined ? {} : { reservedAt: change.reservedAt }),
        ...(change.startedAt === undefined ? {} : { startedAt: change.startedAt }),
        ...(change.finishedAt === undefined ? {} : { finishedAt: change.finishedAt }),
        ...(change.cancelledAt === undefined ? {} : { cancelledAt: change.cancelledAt }),
        ...(change.cancelledByUserId === undefined
          ? {}
          : { cancelledByUserId: change.cancelledByUserId }),
        ...(change.deadLetteredAt === undefined ? {} : { deadLetteredAt: change.deadLetteredAt }),
        version: { increment: 1 },
      },
    });

    await this.appendEvent(runId, tenantId, {
      state: to,
      message: change.message,
      attempt: updated.attempt,
      ...(change.percent === undefined ? {} : { percent: change.percent }),
    });

    // After the row is written, never before. A client that acted on a state the database then
    // refused would be acting on something that never happened.
    const event: RunProgressEvent = {
      runId,
      engineAgentId: updated.engineAgentId,
      state: to,
      percent: updated.percent,
      message: change.message,
      attempt: updated.attempt,
      at: new Date().toISOString(),
      correlationId: updated.correlationId,
    };
    this.progress.publish(tenantId, event);

    return updated;
  }

  private async appendEvent(
    runId: string,
    tenantId: string,
    event: { state?: string | null; percent?: number; message: string; attempt: number },
  ): Promise<void> {
    await this.prisma.client.agentRunEvent.create({
      data: {
        tenantId,
        runId,
        ...(event.state === undefined ? {} : { state: event.state }),
        ...(event.percent === undefined ? {} : { percent: event.percent }),
        message: event.message.slice(0, 500),
        attempt: event.attempt,
      },
    });
  }

  private viewOf(run: {
    id: string;
    engineAgentId: string;
    engineAgentVersionId: string;
    aiWorkAssignmentId: string | null;
    objectiveId: string | null;
    state: string;
    trigger: string;
    idempotencyKey: string;
    correlationId: string;
    attempt: number;
    maxAttempts: number;
    retryability: string | null;
    scheduledFor: Date | null;
    reservedAt: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    percent: number | null;
    progressMessage: string | null;
    output: unknown;
    failureReason: string | null;
    producedByRealModel: boolean | null;
    cancelledAt: Date | null;
    deadLetteredAt: Date | null;
    events?: { state: string | null; percent: number | null; message: string; occurredAt: Date }[];
  }): AgentRunView {
    return {
      id: run.id,
      engineAgentId: run.engineAgentId,
      engineAgentVersionId: run.engineAgentVersionId,
      aiWorkAssignmentId: run.aiWorkAssignmentId,
      objectiveId: run.objectiveId,
      state: run.state as RunState,
      trigger: run.trigger as RunTrigger,
      idempotencyKey: run.idempotencyKey,
      correlationId: run.correlationId,
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      retryability: run.retryability as Retryability | null,
      scheduledFor: run.scheduledFor?.toISOString() ?? null,
      reservedAt: run.reservedAt?.toISOString() ?? null,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      percent: run.percent,
      progressMessage: run.progressMessage,
      output: run.output,
      failureReason: run.failureReason,
      producedByRealModel: run.producedByRealModel,
      cancelledAt: run.cancelledAt?.toISOString() ?? null,
      deadLetteredAt: run.deadLetteredAt?.toISOString() ?? null,
      events: (run.events ?? []).map((event) => ({
        state: event.state,
        percent: event.percent,
        message: event.message,
        at: event.occurredAt.toISOString(),
      })),
      note:
        'The run row is the record. Live progress is a convenience: a client that missed an ' +
        'update re-reads this and loses nothing but the animation.',
    };
  }
}
