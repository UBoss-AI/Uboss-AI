import { Global, Module } from '@nestjs/common';

import { PerformanceController } from './performance.controller.js';
import { PerformanceService } from './performance.service.js';

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
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
