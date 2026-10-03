import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { PerformanceService } from './performance.service.js';

/** How often the sweep runs when nothing overrides it. Fifteen minutes. */
const DEFAULT_INTERVAL_MS = 15 * 60_000;

/**
 * The statuses a task can be missed from.
 *
 * `Completed` and `Cancelled` are finished. `Submitted` and `WaitingApproval` mean the person did
 * the work and it is sitting with somebody else — if that submission is eventually approved the
 * completion path scores it, late or not, and charging them for a queue they do not control would
 * be scoring somebody else's delay.
 *
 * `Waiting` is left out for the same reason in a different direction: the task has not been
 * released yet because something upstream has not finished. Nobody can miss work they have not
 * been given.
 *
 * `Blocked` and `NeedsInput` **are** included, and that is deliberate rather than harsh. The
 * policy already has the mechanism for forgiving them — an approved `BlockerNeutralised` cancels
 * the event, fully or by half, as the company chose. Quietly exempting them here would make that
 * switch mean nothing and would hide the deadline instead of forgiving it.
 */
const MISSABLE_STATUSES = ['Assigned', 'InProgress', 'Blocked', 'NeedsInput'] as const;

/**
 * Turns a deadline that came and went into a score.
 *
 * ## Why this exists
 *
 * `Missed` has been a performance event kind since the engine was written, `missedPoints` has sat
 * in every company's policy at −15, and the badge ladder has counted it. Nothing ever wrote one.
 * Completion was scored, rejection was not, and a task nobody ever did cost nothing at all —
 * which meant the safest way to protect a score was to ignore the work.
 *
 * ## Why a timer rather than a scheduler
 *
 * No dependency is added for this. `@nestjs/schedule` would bring a cron parser and a registry to
 * run one sweep on a fixed interval, and the interval is the only thing being expressed. The
 * handle is `unref`'d so it can never be the reason this process stays alive — a background timer
 * holding the event loop open is how a container stops shutting down cleanly.
 *
 * ## Running twice is harmless, so nothing elects a leader
 *
 * `recordEvent` deduplicates on (subject, source kind, source id, kind), and the source here is
 * the task itself. Two API instances sweeping the same minute write one row between them, and the
 * second is told `alreadyRecorded`. That is what makes this safe to run on every instance instead
 * of needing a lock, a lease or a designated node.
 *
 * ## Missed and late are one penalty, not two
 *
 * A task charged as missed and then finished is not charged again — `HumanTaskService` checks for
 * a `Missed` event before recording a late completion. One deadline, one penalty. Both events
 * would each be true, but charging both would mean a company's stated −5 for lateness silently
 * became −20 for the same slip.
 */
@Injectable()
export class OverdueTaskSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverdueTaskSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly performance: PerformanceService,
  ) {}

  onModuleInit(): void {
    /*
     * Off under test.
     *
     * The suite builds and tears down an application per spec file, and a sweep firing partway
     * through one of them would write performance events no test asked for — which is the kind of
     * cross-test interference that reads as flakiness. The sweep itself is a public method, so
     * the tests drive it directly and assert on what it did.
     */
    if (process.env['NODE_ENV'] === 'test' || process.env['UBOSS_DISABLE_BACKGROUND_SWEEPS']) {
      this.logger.log('Overdue-task sweep is off in this environment.');
      return;
    }

    const interval = Number(process.env['UBOSS_OVERDUE_SWEEP_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
    const every = Number.isInteger(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.sweepQuietly();
    }, every);
    this.timer.unref();
    this.logger.log(`Overdue-task sweep every ${Math.round(every / 60_000)} minutes.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The timer's entry point: a sweep that fails is reported and never reaches the timer. */
  private async sweepQuietly(): Promise<void> {
    if (this.running) {
      // The previous sweep is still going. Skipped rather than queued: a sweep that cannot finish
      // inside its own interval must not have a second one piling up behind it.
      return;
    }
    this.running = true;
    try {
      const result = await this.sweep();
      if (result.recorded > 0) {
        this.logger.log(
          `Scored ${result.recorded} missed deadline(s) across ${result.tenants} company(ies).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `The overdue-task sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Score every deadline that has passed its company's window without the work being done.
   *
   * Reads across companies once on the platform plane, then writes inside each company's own
   * scope — so nothing crosses a tenant boundary, and one company's unreachable policy cannot
   * stop another company being scored.
   *
   * @param now injected by the tests, which have to place "overdue" somewhere they control.
   */
  async sweep(now: Date = new Date()): Promise<{ tenants: number; recorded: number }> {
    /*
     * Every company that has a task past due at all.
     *
     * The window is per company, so the widest possible window cannot be known here — this reads
     * everything already past its due date and each company's own policy decides which of those
     * have crossed its line. The index on (tenant_id, status, due_at) is what keeps that cheap.
     */
    const candidates = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.humanTask.findMany({
        where: {
          dueAt: { lt: now },
          status: { in: [...MISSABLE_STATUSES] },
        },
        select: {
          id: true,
          tenantId: true,
          title: true,
          assignedToUserId: true,
          dueAt: true,
        },
        // Bounded, because a sweep is not a migration. Whatever is left is picked up next time,
        // and the events are keyed on the task so nothing is scored twice for waiting a cycle.
        take: 5_000,
        orderBy: { dueAt: 'asc' },
      }),
    );

    const byTenant = new Map<string, typeof candidates>();
    for (const task of candidates) {
      const held = byTenant.get(task.tenantId);
      if (held === undefined) byTenant.set(task.tenantId, [task]);
      else held.push(task);
    }

    let recorded = 0;
    for (const [tenantId, tasks] of byTenant) {
      try {
        recorded += await this.sweepOneCompany(tenantId, tasks, now);
      } catch (error) {
        // One company's failure is one company's failure. Reported, and the sweep continues:
        // the alternative is a single unreachable policy stopping everybody else being scored.
        this.logger.warn(
          `Could not score missed deadlines for company ${tenantId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { tenants: byTenant.size, recorded };
  }

  private async sweepOneCompany(
    tenantId: string,
    tasks: readonly { id: string; title: string; assignedToUserId: string; dueAt: Date | null }[],
    now: Date,
  ): Promise<number> {
    const scope = tenantScopeForPlatformOperation(tenantId);
    const policy = await this.performance.activePolicy(scope);
    const windowMs = policy.missedAfterHours * 3_600_000;

    let recorded = 0;
    for (const task of tasks) {
      if (task.dueAt === null) continue;
      if (now.getTime() - task.dueAt.getTime() < windowMs) continue;

      const outcome = await this.performance.recordEvent({
        scope,
        subjectUserId: task.assignedToUserId,
        kind: 'Missed',
        sourceKind: 'human_task',
        sourceId: task.id,
        // The moment the window closed, not the moment the sweep noticed. A sweep that ran late,
        // or was down for a day, must not move when the deadline was missed.
        occurredAt: new Date(task.dueAt.getTime() + windowMs),
      });
      if (!outcome.alreadyRecorded) recorded += 1;
    }

    return recorded;
  }
}
