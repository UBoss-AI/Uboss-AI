import { Global, Logger, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyService } from './idempotency.service.js';
import { ProviderThrottleService } from './provider-throttle.service.js';
import { RateLimitInterceptor } from './rate-limit.interceptor.js';
import { RateLimitService } from './rate-limit.service.js';
import {
  InProcessRateLimitStore,
  RateLimitStore,
  RedisRateLimitStore,
} from './rate-limit.store.js';
import { RateLimitsController } from './rate-limits.controller.js';
import { RunFairnessService } from './run-fairness.service.js';

/**
 * Rate limits, abuse protection and execution fairness — Prompt 40.
 *
 * `@Global`, for the same reason as the audit and observability modules: the run engine and the
 * Model Gateway both need the fairness and throttle services, and threading them through imports
 * would have each module declare a dependency on being fair, which is true of all of them and
 * therefore says nothing.
 *
 * ## Which store is bound, and why it is decided here rather than in code
 *
 * Whichever the deployment has. `REDIS_URL` is set → the shared store, so the configured limit is
 * the limit no matter how many API instances are running. It is not set → the per-process store,
 * which is correct for a single process and *multiplies* the limit by the instance count when
 * there is more than one.
 *
 * That difference is a security property, so it is logged at startup and reported by
 * `GET /platform/limits`. The failure mode this guards against is a four-instance deployment
 * quietly enforcing four times the documented limit, which nothing else in the system would
 * notice — the metrics would look healthy and every test would pass.
 *
 * The same shape as `RunQueue`: one seam, the real implementation when the infrastructure is
 * there, an honest fallback when it is not, and a flag that says which you got.
 */
@Global()
@Module({
  controllers: [RateLimitsController],
  providers: [
    {
      provide: RateLimitStore,
      useFactory: (): RateLimitStore => {
        const logger = new Logger('RateLimitStore');
        if (process.env['REDIS_URL']) {
          logger.log('Rate limits are shared across API instances (Redis).');
          return new RedisRateLimitStore();
        }
        logger.warn(
          'REDIS_URL is not set, so rate limits are counted per API process. Behind a load ' +
            'balancer the effective limit is the configured limit multiplied by the number of ' +
            'instances. Correct for a single process; see GET /platform/limits.',
        );
        return new InProcessRateLimitStore();
      },
    },
    RateLimitService,
    RunFairnessService,
    ProviderThrottleService,
    IdempotencyService,
    // Order matters. The first-registered interceptor is the outermost, so the limiter wraps the
    // idempotency layer: a throttled request must not claim a key it never got to use — the
    // client would retry with that key and find it claimed by a request that was never served.
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [
    RateLimitStore,
    RateLimitService,
    RunFairnessService,
    ProviderThrottleService,
    IdempotencyService,
  ],
})
export class RateLimitsModule {}
