import { Global, Module } from '@nestjs/common';

import { BullMqRunQueue } from './bullmq-run-queue.js';
import { RunEngineService } from './run-engine.service.js';
import { RunProgressGateway } from './run-progress.gateway.js';
import { RunQueue, InlineRunQueue } from './run-queue.js';
import { RunSchedulerService } from './run-scheduler.service.js';
import { RunController } from './run.controller.js';

/**
 * The run engine, its queue and its scheduler.
 *
 * ## Which queue ships
 *
 * BullMQ when `REDIS_URL` is set, which is what the approved architecture requires and what the
 * local compose file provides. `InlineRunQueue` otherwise — a single-process fallback that runs
 * work on the spot.
 *
 * The fallback is not a stub: it genuinely performs the run, so a deployment without a broker
 * still works correctly, just without cross-process distribution or a delayed retry surviving a
 * restart. `RunQueue.isDurableTransport` reports which is in play, and the runs endpoint returns
 * it, so nobody has to guess whether their queue survives a restart.
 *
 * Choosing by environment rather than by a flag is deliberate: the failure mode of a missing
 * `REDIS_URL` should be a working single process, not a crash at startup or — worse — a queue
 * that silently accepts work nothing consumes.
 */
@Global()
@Module({
  controllers: [RunController],
  providers: [
    RunProgressGateway,
    {
      provide: RunQueue,
      useFactory: () => (process.env['REDIS_URL'] ? new BullMqRunQueue() : new InlineRunQueue()),
    },
    RunEngineService,
    RunSchedulerService,
  ],
  exports: [RunEngineService, RunSchedulerService, RunProgressGateway, RunQueue],
})
export class RunsModule {}
