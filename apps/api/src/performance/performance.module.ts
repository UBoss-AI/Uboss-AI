import { Global, Module } from '@nestjs/common';

import { AccessRepository } from '../persistence/access.repository.js';
import { OverdueTaskSweeper } from './overdue-task.sweeper.js';
import { PerformanceController } from './performance.controller.js';
import { PerformanceService } from './performance.service.js';
import { TrackerService } from './tracker.service.js';

/**
 * Performance score and badges.
 *
 * `@Global` because the modules that produce events arrive later — to-do completion, approval
 * decisions, the deadline sweeper, offboarding — and each needs `recordEvent` rather than a
 * screen. Importing this module in every one of them would be noise, and the alternative (each
 * module keeping its own scoring) is exactly the duplicate-engine mistake the reuse rule exists
 * to prevent.
 */
@Global()
@Module({
  controllers: [PerformanceController],
  /*
   * `AccessRepository` is listed here rather than imported from `AccessModule`.
   *
   * Task & Tracker needs the roster query Users & Access already runs, and nothing else from that
   * module. Importing the module instead would pull its services — invitations, offboarding, bulk
   * operations — into a `@Global` module's graph, and this one is global precisely because half
   * the product depends on it.
   */
  providers: [PerformanceService, OverdueTaskSweeper, TrackerService, AccessRepository],
  exports: [PerformanceService, OverdueTaskSweeper],
})
export class PerformanceModule {}
