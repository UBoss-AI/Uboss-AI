import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

/** One unit of work handed to the queue. The run row already exists when this is enqueued. */
export interface RunJob {
  runId: string;
  tenantId: string;
  correlationId: string;
  attempt: number;
}

/**
 * The queue seam.
 *
 * ## Why this is an abstract class and not `new Queue(...)` inline
 *
 * The same reason the Model Gateway and the payout adapter are seams. Two things need to be true
 * at once: the shipping implementation is BullMQ on Redis, as the approved architecture requires;
 * and the run engine's behaviour — its state machine, its idempotency, its retry classification,
 * its dead-letter path — has to be testable without a broker, deterministically, in a suite that
 * runs a thousand other things.
 *
 * A test that needs Redis up, a worker polling, and a sleep to see whether a state changed is a
 * test that will be flaky forever. `InlineRunQueue` runs the handler on the spot, so the engine's
 * logic is exercised exactly and the *transport* is the only thing not covered — which is the
 * right thing to leave to an integration check rather than to thirteen state-machine tests.
 *
 * ## What the queue is not
 *
 * Not the source of truth. The durable Run row exists before anything is enqueued, so a lost
 * queue costs a restart, not the work. Anything that reads "is this run done?" reads the row.
 */
@Injectable()
export abstract class RunQueue {
  /** How this queue delivers work, for reports and honest status output. */
  abstract readonly kind: string;

  /** True only when a real broker is behind it. */
  abstract readonly isDurableTransport: boolean;

  /** Hand a run to the queue. The row must already exist. */
  abstract enqueue(job: RunJob): Promise<void>;

  /** Hand a run to the queue after a delay, for a bounded retry. */
  abstract enqueueAfter(job: RunJob, delayMs: number): Promise<void>;

  /** Register the function that performs a run. Called once, at startup. */
  abstract onRun(handler: (job: RunJob) => Promise<void>): void;

  /**
   * What the queue looks like right now, for System Health (Prompt 36).
   *
   * On the abstraction rather than in a monitoring service that reaches into BullMQ, because a
   * service that knew how runs are transported would be a second answer to that question — and
   * the whole point of this class is that there is one.
   *
   * `measured` is false when the reading is structural rather than probed. The inline queue has
   * no depth to report because it has no backlog by construction, and reporting a confident
   * "0 waiting" would let a health screen show a green figure nothing measured.
   */
  abstract health(): Promise<QueueHealth>;
}

/** A queue's state, in the terms System Health shows. */
export interface QueueHealth {
  kind: string;
  isDurableTransport: boolean;
  /** Jobs waiting to be picked up. Null when the transport cannot say. */
  waiting: number | null;
  /** Jobs being worked on now. Null when the transport cannot say. */
  active: number | null;
  /** Jobs that failed and were not retried. Null when the transport cannot say. */
  failed: number | null;
  /** False when the figures are structural rather than probed. */
  measured: boolean;
  /** One sentence a person reads. Never a host, a password or a connection string. */
  detail: string;
}

/**
 * The test and single-process implementation: run it here, now.
 *
 * Deliberately not a fake that records calls and does nothing. The engine's contract is that
 * enqueuing leads to execution, and a queue that swallowed the job would let every test pass
 * while the real thing never ran. `enqueueAfter` ignores the delay for the same reason a test
 * must not sleep — the delay is the transport's concern, and `retryDelayMs` is unit-tested on its
 * own.
 */
@Injectable()
export class InlineRunQueue extends RunQueue implements OnModuleDestroy {
  readonly kind = 'inline';
  readonly isDurableTransport = false;

  private readonly logger = new Logger(InlineRunQueue.name);
  private handler: ((job: RunJob) => Promise<void>) | null = null;

  /**
   * The last error a handler threw, kept so it is not invisible.
   *
   * The catch below is deliberate — the engine records failures on the run row, and rethrowing
   * would surface the same failure twice. But a swallowed error no test can see cost a debugging
   * cycle: a run stopped mid-flight and the only evidence was a state that had not advanced.
   * A spec can now assert this is null.
   */
  lastFailure: Error | null = null;
  /** Tracked so shutdown can wait: a half-finished run at teardown is a torn database row. */
  private readonly inFlight = new Set<Promise<void>>();

  onRun(handler: (job: RunJob) => Promise<void>): void {
    this.handler = handler;
  }

  async enqueue(job: RunJob): Promise<void> {
    if (this.handler === null) {
      throw new Error(
        'No run handler is registered. The run engine registers one at startup; enqueuing before ' +
          'that would leave a durable run row with nothing to pick it up.',
      );
    }

    const work = this.handler(job).catch((caught: unknown) => {
      // Swallowed here on purpose: the engine records the failure on the run row itself, and
      // rethrowing would surface the same failure twice — once as a rejected enqueue, which no
      // caller can act on, and once on the row, which is where it belongs.
      this.lastFailure = caught instanceof Error ? caught : new Error(String(caught));
      this.logger.warn(`Run ${job.runId} threw out of its handler: ${this.lastFailure.message}`);
    });

    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    await work;
  }

  async enqueueAfter(job: RunJob, _delayMs: number): Promise<void> {
    await this.enqueue(job);
  }

  /**
   * The inline queue has no backlog, by construction: `enqueue` runs the job.
   *
   * So the depths are **null rather than zero**. Zero would be a measurement, and this is the
   * absence of one — the same distinction `scannedByRealScanner` and `producedByRealModel` draw.
   * What it *can* report honestly is how many runs are in flight right now.
   */
  async health(): Promise<QueueHealth> {
    return {
      kind: this.kind,
      isDurableTransport: this.isDurableTransport,
      waiting: null,
      active: this.inFlight.size,
      failed: null,
      measured: false,
      detail:
        'Runs execute in this process as they are enqueued, so there is no queue to measure. ' +
        'Nothing survives a restart — this is the single-process transport, not a broker.',
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
