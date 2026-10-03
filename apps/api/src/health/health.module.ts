import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/*
 * `RunsModule` is deliberately **not** imported here.
 *
 * It was, so that `/health` could reach `RunQueue` and report the broker. Importing it drags the
 * whole run engine into the graph of anything that imports health — the health spec builds a
 * testing module from `HealthModule` alone and immediately failed with "Nest can't resolve
 * dependencies of the RunEngineService", which is a fair complaint: asking one question about
 * Redis should not require the thing that runs agents.
 *
 * `RunsModule` is already `@Global`, so the queue needs no import at all. It is injected
 * `@Optional`: present in the application, absent from a test module that does not include it,
 * where health reports the database alone rather than refusing to start.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  // Exported at Prompt 36: System Health composes this probe rather than writing a second one.
  exports: [HealthService],
})
export class HealthModule {}
