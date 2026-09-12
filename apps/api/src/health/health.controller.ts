import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import type { HealthResponse } from '@uboss/types';

import { AllowAnonymous } from '../tenancy/tenancy.decorators.js';
import { HealthService } from './health.service.js';

/**
 * Unauthenticated liveness endpoint, used by verification and by infrastructure probes.
 *
 * It must never disclose tenant, actor or configuration detail — anything tenant-owned requires authenticated
 * membership and server-side permission checks (working rule E).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  // Explicitly public: infrastructure probes must reach it unauthenticated. The guard denies
  // every route without a policy decorator, so this is a conscious decision, not a default.
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  getHealth(): Promise<HealthResponse> {
    return this.healthService.getHealth();
  }
}
