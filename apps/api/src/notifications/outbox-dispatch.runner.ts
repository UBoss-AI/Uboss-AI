import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { NotificationDispatcherService } from './notification-dispatcher.service.js';

/** How often the queue is drained when nothing overrides it. */
const DEFAULT_INTERVAL_MS = 60_000;

/** How many messages one pass claims. Bounded so a backlog drains steadily, not all at once. */
const DEFAULT_BATCH = 20;

/**
 * Drains the notification outbox on a clock.
 *
 * ## Why this exists
 *
 * `NotificationOperationsController` already said it, in its own docblock: "until something calls
 * these on a timer, a queued email waits and an unacknowledged alert does not escalate." Nothing
 * ever did. Every notification the product raised went into `outbox_messages` and sat there —
 * measured on the development database, every row was `Pending` with **zero attempts**, some of
 * them weeks old.
 *
 * That is why configuring SMTP alone does not make mail work: the transport was only half the
 * answer, and the missing half was something to call it.
 *
 * ## A timer, for the same reasons as the deadline sweep
 *
 * No scheduler dependency is added to express one interval, and the handle is `unref`'d so a
 * background timer can never be the reason a container refuses to shut down. `claimDue` uses
 * `SKIP LOCKED`, so several API instances draining the same queue take different rows — nothing
 * here needs a leader.
 *
 * ## It does not decide what "sent" means
 *
 * The dispatcher owns retry, backoff and dead-lettering, and the adapter owns whether anything
 * actually leaves the building. This only decides *when to try*, which is the one thing that was
 * missing.
 */
@Injectable()
export class OutboxDispatchRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatchRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dispatcher: NotificationDispatcherService) {}

  onModuleInit(): void {
    /*
     * Off under test, and off wherever it is explicitly disabled.
     *
     * The suite builds an application per spec file; a dispatch firing partway through one would
     * deliver notifications no test raised and move attempt counters other tests assert on. The
     * platform route stays, so a test that wants a dispatch asks for one.
     */
    if (process.env['NODE_ENV'] === 'test' || process.env['UBOSS_DISABLE_BACKGROUND_SWEEPS']) {
      this.logger.log('Outbox dispatch is off in this environment.');
      return;
    }

    const configured = Number(
      process.env['UBOSS_OUTBOX_DISPATCH_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS,
    );
    const every = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.drainQuietly();
    }, every);
    this.timer.unref();
    this.logger.log(`Outbox dispatch every ${Math.round(every / 1000)}s.`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async drainQuietly(): Promise<void> {
    if (this.running) {
      // The previous pass is still going. Skipped rather than queued: a slow provider must not
      // accumulate overlapping passes that all claim from the same table.
      return;
    }
    this.running = true;
    try {
      const batch = Number(process.env['UBOSS_OUTBOX_DISPATCH_BATCH'] ?? DEFAULT_BATCH);
      const outcome = await this.dispatcher.runOnce(
        Number.isInteger(batch) && batch > 0 ? batch : DEFAULT_BATCH,
      );

      if (outcome.delivered > 0 || outcome.failed > 0) {
        this.logger.log(
          `Outbox: ${outcome.delivered} delivered, ${outcome.failed} failed, ` +
            `${outcome.skipped} skipped via ${outcome.adapter.name}.`,
        );
      }
      if (outcome.skipped > 0) {
        // A topic with a producer and no consumer. Its rows were claimed and their attempt
        // counters moved, so this would otherwise be a queue quietly eating its own retry budget.
        this.logger.warn(
          `${outcome.skipped} outbox message(s) had no consumer for their topic and were skipped.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `The outbox dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
