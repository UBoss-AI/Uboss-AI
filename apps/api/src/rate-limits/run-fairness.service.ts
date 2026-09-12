import { Injectable, Logger } from '@nestjs/common';

import { concurrencySlotsFor, fairOrder, type PendingJob } from '@uboss/types';

import { MetricsService } from '../observability/metrics.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { RateLimitService } from './rate-limit.service.js';

/** States in which a run is occupying a worker. */
const IN_FLIGHT_STATES = ['Reserved', 'Running'] as const;

export type AdmissionDecision =
  | { admit: true; slotsLeft: number }
  | { admit: false; inFlight: number; limit: number; reason: string };

/**
 * Per-company run concurrency and queue fairness — Prompt 40.
 *
 * ## The problem, stated as it actually happens
 *
 * One company schedules a thousand runs at nine o'clock. The queue is FIFO and there are four
 * workers. Every other company's work — a manager waiting on one approval summary — sits behind a
 * thousand jobs. Nothing has failed. No alert fires. The queue depth metric looks like a busy
 * morning. And the product is unusable for everybody except the company that caused it.
 *
 * ## Two controls, because one is not enough
 *
 * **The cap** limits how many runs one company has in flight. Without it, a company can hold every
 * worker for as long as its work takes.
 *
 * **The order** is round-robin across companies, oldest first within each (`fairOrder`). Without
 * it, a capped company still owns the whole *queue*: as each of its runs finishes, the next job in
 * line is another of its own, and a company with one run waits for the backlog to drain.
 *
 * Either alone leaves the starvation intact, which is why both are here and why the distinction is
 * worth the two paragraphs.
 *
 * ## Why the in-flight count is a query and not a counter
 *
 * Because a counter drifts. A worker killed mid-run decrements nothing, and after a few crashes the
 * cap is permanently consumed by runs that no longer exist — a company quietly limited to zero with
 * no way to see why. `COUNT(*) WHERE state IN ('Reserved','Running')` is derived from the rows that
 * *are* the truth, so it self-heals: whatever state the rows end up in, the count agrees with them.
 * It costs an indexed count per job, which is the right price.
 */
@Injectable()
export class RunFairnessService {
  private readonly logger = new Logger(RunFairnessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: RateLimitService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * May this company start another run right now?
   *
   * Called by the worker at pickup rather than by the producer at enqueue, deliberately. At
   * enqueue the answer would be stale by the time the job ran, and a run refused at enqueue would
   * have to be refused *to the person who asked for it* — but the work is not being refused, only
   * ordered. The durable row is created either way; only its start is deferred.
   */
  async mayStart(tenantId: string): Promise<AdmissionDecision> {
    const limit = (await this.limits.limits()).Runs.limit;
    const inFlight = await this.inFlightFor(tenantId);
    const slots = concurrencySlotsFor({ inFlight, limit });

    if (slots > 0) return { admit: true, slotsLeft: slots - 1 };

    this.metrics.increment('run_admission_deferrals', { reason: 'concurrency' });
    return {
      admit: false,
      inFlight,
      limit,
      reason:
        `Your company already has ${inFlight} agent runs in progress, which is the limit. This ` +
        'one is queued and will start as those finish — nothing has been lost, and no other ' +
        'company is holding your place.',
    };
  }

  /** How many runs this company has in flight. */
  async inFlightFor(tenantId: string): Promise<number> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.agentRun.count({
        where: { tenantId, state: { in: [...IN_FLIGHT_STATES] } },
      }),
    );
  }

  /**
   * The queued runs in the order they should be started.
   *
   * Reads every waiting run across every company, orders them with `fairOrder`, and then filters
   * to the ones whose company has a free slot — in that order, so a company's second run is only
   * considered after every other company's first.
   *
   * ## Why this is a read and a plan rather than a mutation
   *
   * Because "what would happen next" is the question a test and an operator both want answered,
   * and a scheduler that only *acts* can be checked in no other way than by watching it. The plan
   * is returned; `redispatch` is what acts on it.
   */
  async admissionPlan(
    options: { limitRows?: number } = {},
  ): Promise<{ dispatch: PendingJob[]; deferred: PendingJob[]; concurrencyLimit: number }> {
    const concurrencyLimit = (await this.limits.limits()).Runs.limit;

    const [queued, inFlight] = await this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.agentRun.findMany({
        where: { state: 'Queued' },
        select: { id: true, tenantId: true, createdAt: true, correlationId: true, attempt: true },
        orderBy: { createdAt: 'asc' },
        // Bounded, because a plan over a million rows would be a memory problem rather than a
        // fairness one. The bound is generous relative to any realistic worker count.
        take: options.limitRows ?? 1_000,
      });

      const busy = await this.prisma.client.agentRun.groupBy({
        by: ['tenantId'],
        where: { state: { in: [...IN_FLIGHT_STATES] } },
        _count: { _all: true },
      });

      return [rows, busy] as const;
    });

    const used = new Map<string, number>();
    for (const row of inFlight) {
      used.set(row.tenantId, row._count._all);
    }

    const pending: PendingJob[] = queued.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      queuedAt: row.createdAt.getTime(),
    }));

    const dispatch: PendingJob[] = [];
    const deferred: PendingJob[] = [];

    for (const job of fairOrder(pending)) {
      const already = used.get(job.tenantId) ?? 0;
      if (concurrencySlotsFor({ inFlight: already, limit: concurrencyLimit }) > 0) {
        used.set(job.tenantId, already + 1);
        dispatch.push(job);
      } else {
        deferred.push(job);
      }
    }

    return { dispatch, deferred, concurrencyLimit };
  }

  /** What fairness looks like right now, for the status endpoint and the runbook. */
  async snapshot(): Promise<{
    concurrencyLimit: number;
    companiesWaiting: number;
    queued: number;
    dispatchable: number;
    deferred: number;
  }> {
    const plan = await this.admissionPlan();
    const companies = new Set([
      ...plan.dispatch.map((job) => job.tenantId),
      ...plan.deferred.map((job) => job.tenantId),
    ]);
    return {
      concurrencyLimit: plan.concurrencyLimit,
      companiesWaiting: companies.size,
      queued: plan.dispatch.length + plan.deferred.length,
      dispatchable: plan.dispatch.length,
      deferred: plan.deferred.length,
    };
  }

  /** Note that a run was held back, on the row, so somebody looking at it can see why. */
  async recordDeferral(runId: string, tenantId: string, reason: string): Promise<void> {
    try {
      await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.agentRun.updateMany({
          // Only while it is still queued: a run that has moved on must not have its progress
          // message overwritten by a stale deferral note.
          where: { id: runId, tenantId, state: 'Queued' },
          data: { progressMessage: reason.slice(0, 500) },
        }),
      );
    } catch (error) {
      this.logger.debug(
        `Could not note the deferral of run ${runId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
