import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

import { RunQueue, type RunJob } from './run-queue.js';
import type { QueueHealth } from './run-queue.js';

/** The one queue name. Kept here so the producer and the worker cannot disagree about it. */
export const RUN_QUEUE_NAME = 'uboss.agent.runs';

/**
 * BullMQ custom job IDs cannot contain `:`. Encode the UUID before adding the attempt so the
 * retry remains deterministic without relying on that reserved character or a delimiter that
 * could also appear in a caller-provided ID.
 */
export function retryJobId(runId: string, attempt: number): string {
  if (runId.length === 0) throw new Error('A retry job requires a run id.');
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('A retry job attempt must be a positive safe integer.');
  }
  return `retry-${Buffer.from(runId, 'utf8').toString('base64url')}-${attempt}`;
}

/**
 * The shipping queue: BullMQ on Redis, as the approved architecture requires.
 *
 * ## What BullMQ is and is not responsible for
 *
 * It moves work between processes and it remembers a delayed job across a restart. It does **not**
 * decide whether a run may proceed, how many attempts it gets, or what a failure means — all of
 * that is the run engine's, on the durable row. That division matters because the two disagree
 * about retries by default: BullMQ has its own attempt counter and backoff, and if both were in
 * charge a run could be attempted twice as often as the company configured.
 *
 * So `attempts: 1` here. One BullMQ attempt per engine attempt, and the engine re-enqueues
 * deliberately with its own delay when its own classification says a retry is warranted. The
 * queue's opinion about retrying is switched off rather than merged.
 *
 * ## Idempotency
 *
 * The job id is the run id. BullMQ refuses a duplicate job id while the job exists, which is a
 * second line of defence behind the unique index on the run's idempotency key — but only the
 * index is load-bearing, because a job id is forgotten once the job completes and the index is
 * not.
 */
@Injectable()
export class BullMqRunQueue extends RunQueue implements OnModuleInit, OnModuleDestroy {
  readonly kind = 'bullmq';
  readonly isDurableTransport = true;

  private readonly logger = new Logger(BullMqRunQueue.name);
  private readonly connection: ConnectionOptions;
  private queue: Queue<RunJob> | null = null;
  private worker: Worker<RunJob> | null = null;
  private handler: ((job: RunJob) => Promise<void>) | null = null;

  constructor(redisUrl?: string) {
    super();
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (!url) {
      throw new Error(
        'REDIS_URL is not set. Start the local broker with ' +
          '`docker compose -f infra/docker-compose.yml up -d redis`, or register `InlineRunQueue` ' +
          'instead for a single-process deployment.',
      );
    }

    const parsed = new URL(url);
    this.connection = {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      ...(parsed.password === '' ? {} : { password: parsed.password }),
      // BullMQ requires this: with a finite retry count a blocking command can give up and the
      // worker stops consuming silently.
      maxRetriesPerRequest: null,
    };
  }

  /**
   * Register the function that performs a run, whenever that happens.
   *
   * ## Why this starts the worker rather than only remembering the handler
   *
   * It used to only assign `this.handler`, and `onModuleInit` started a worker if a handler was
   * already there. That made the behaviour depend on the order Nest runs lifecycle hooks — and
   * the order is fixed, and it is the wrong way round: `RunQueue` is a *dependency* of
   * `RunEngineService`, so Nest constructs and initialises the queue first, and the engine
   * registers its handler afterwards. The check therefore always saw `null`.
   *
   * The result was silent and total: with `REDIS_URL` set, every boot logged "this process
   * produces but does not consume", no `Worker` was ever created, and runs enqueued to Redis
   * were never performed. Proven against the running product — that line appears at every start
   * in the development log, and `package.json` defines no separate worker process for anything
   * else to consume them.
   *
   * Registering late is now enough. If the queue is already up, the worker starts here; if it is
   * not, `onModuleInit` starts it. Either order gives a consuming process.
   */
  onRun(handler: (job: RunJob) => Promise<void>): void {
    this.handler = handler;
    if (this.queue !== null && this.worker === null) {
      this.startWorker(handler);
    }
  }

  onModuleInit(): void {
    this.queue = new Queue<RunJob>(RUN_QUEUE_NAME, { connection: this.connection });

    if (this.handler === null) {
      /*
       * Producer-only, for now.
       *
       * Still legitimate — an API instance that enqueues while separate workers consume — and
       * still logged rather than thrown, because throwing would stop a correctly configured
       * deployment. But it is no longer final: `onRun` starts the worker if a handler arrives
       * after this point, which is what happens in a single-process deployment.
       */
      this.logger.log('No run handler registered yet; this process produces until one is.');
      return;
    }

    this.startWorker(this.handler);
  }

  /** Bring up the consuming worker. Called from whichever of the two arrives second. */
  private startWorker(handler: (job: RunJob) => Promise<void>): void {
    this.worker = new Worker<RunJob>(
      RUN_QUEUE_NAME,
      async (job) => {
        await handler(job.data);
      },
      {
        connection: this.connection,
        /**
         * How many runs this worker performs at once — Prompt 40.
         *
         * Configurable, because it was hardcoded to four and four is a guess about a machine
         * nobody has measured. It is the **process-wide** ceiling; the per-company ceiling is
         * `RunFairnessService`, and the two answer different questions: this one is about how much
         * this box can carry, that one is about whose work gets to use it.
         *
         * Raising it without raising the database pool is the trap — every concurrent run holds a
         * connection for its state transitions, so a worker concurrency above the pool size turns
         * into pool exhaustion, which looks like a slow database rather than a misconfiguration.
         */
        concurrency: Math.max(1, Number(process.env['RUNS_WORKER_CONCURRENCY'] ?? 4)),
      },
    );

    this.logger.log('Run worker started; this process consumes the run queue.');

    this.worker.on('failed', (job, error) => {
      // The engine has already written the failure to the run row. This is operator-facing noise,
      // not the record.
      this.logger.warn(
        `Run job ${job?.data.runId ?? 'unknown'} failed in the worker: ${error.message}`,
      );
    });
  }

  async enqueue(job: RunJob): Promise<void> {
    await this.requireQueue().add(RUN_QUEUE_NAME, job, {
      jobId: job.runId,
      // The engine owns retries. See the note on this class.
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }

  async enqueueAfter(job: RunJob, delayMs: number): Promise<void> {
    await this.requireQueue().add(RUN_QUEUE_NAME, job, {
      // A distinct id per attempt. BullMQ rejects custom IDs containing `:`.
      jobId: retryJobId(job.runId, job.attempt),
      delay: delayMs,
      attempts: 1,
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    });
  }

  private requireQueue(): Queue<RunJob> {
    if (this.queue === null) {
      throw new Error('The run queue is not started yet.');
    }
    return this.queue;
  }

  /**
   * Real depths from the broker, or a `down` reading if it cannot be reached.
   *
   * A failure here must never throw: System Health calling this is *how* an operator finds out
   * the broker is unreachable, and an exception would take the whole health page with it.
   */
  async health(): Promise<QueueHealth> {
    if (this.queue === null) {
      return {
        kind: this.kind,
        isDurableTransport: this.isDurableTransport,
        waiting: null,
        active: null,
        failed: null,
        measured: false,
        detail: 'The queue has not started yet.',
      };
    }

    try {
      const counts = await this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
      return {
        kind: this.kind,
        isDurableTransport: this.isDurableTransport,
        waiting: (counts['waiting'] ?? 0) + (counts['delayed'] ?? 0),
        active: counts['active'] ?? 0,
        failed: counts['failed'] ?? 0,
        measured: true,
        detail: 'Counts read from the broker.',
      };
    } catch (error) {
      return {
        kind: this.kind,
        isDurableTransport: this.isDurableTransport,
        waiting: null,
        active: null,
        failed: null,
        measured: false,
        // The message only, never the connection options — those carry a host and a password.
        detail: `The broker could not be reached: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    // The worker first: closing the queue from under a running job leaves the run row mid-flight.
    await this.worker?.close();
    await this.queue?.close();
  }
}
