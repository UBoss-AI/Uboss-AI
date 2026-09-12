import { Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
  // Exported at Prompt 36: System Health composes this probe rather than writing a second one.
  exports: [HealthService],
})
export class HealthModule {}
