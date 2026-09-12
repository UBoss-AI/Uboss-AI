import { Controller, Get, Post } from '@nestjs/common';

import {
  DEFAULT_LIMITS,
  FAIRNESS_STANCE,
  IDEMPOTENCY_STANCE,
  IDEMPOTENCY_WINDOW_HOURS,
  LIMIT_MESSAGES,
  LIMIT_SCOPE_LABELS,
  LIMIT_SCOPES,
  UNLIMITED_ROUTES,
  WAF_ASSUMPTIONS,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { IdempotencyService } from './idempotency.service.js';
import { ProviderThrottleService } from './provider-throttle.service.js';
import { LIMIT_SETTING_KEYS, RateLimitService } from './rate-limit.service.js';
import { RunFairnessService } from './run-fairness.service.js';

/**
 * What the limits are and what they are doing — Prompt 40.
 *
 * Platform-only. A company cannot read another company's queue position or another company's
 * throttling, and its *own* limits reach it the way every other limit does: in the 429 it gets,
 * which carries the scope, the limit and the retry — a screen needs nothing from here.
 *
 * The stances are served verbatim rather than summarised, because each one is a claim somebody
 * would otherwise overstate: that UBoss protects against a volumetric flood (it does not — that is
 * the proxy's), that limits are shared across instances (only with Redis), and that fairness is a
 * priority system (it is not — it is round-robin, and the difference matters).
 */
@Controller('platform/limits')
@PlatformOnly()
export class RateLimitsController {
  constructor(
    private readonly limits: RateLimitService,
    private readonly fairness: RunFairnessService,
    private readonly providers: ProviderThrottleService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The layers, their configured values, and the honest caveats. */
  @Get()
  @RequirePermission({ module: 'system-health', action: 'View' })
  async overview(): Promise<unknown> {
    const inForce = await this.limits.limits();
    const limiter = this.limits.describe();

    return {
      scopes: LIMIT_SCOPES.map((scope) => ({
        key: scope,
        label: LIMIT_SCOPE_LABELS[scope],
        message: LIMIT_MESSAGES[scope],
        configuredBy: scope === 'Provider' ? null : (LIMIT_SETTING_KEYS[scope] ?? null),
      })),
      inForce,
      defaults: DEFAULT_LIMITS,
      limiter,
      /**
       * The caveat that matters most, stated where somebody will see it.
       *
       * With a per-process store behind a load balancer, the effective limit is multiplied by the
       * number of instances. That is not a bug in the limiter; it is what the store means, and a
       * status endpoint that reported the configured number without this would be reporting a
       * figure that is not in force.
       */
      caveat: limiter.sharedAcrossProcesses
        ? 'Limits are shared across API instances.'
        : 'Limits are counted per API process. Behind a load balancer the effective limit is ' +
          'this figure multiplied by the number of instances — configure REDIS_URL and register ' +
          'RedisRateLimitStore for a shared limit.',
      unlimitedRoutes: UNLIMITED_ROUTES,
      wafAssumptions: WAF_ASSUMPTIONS,
      fairnessStance: FAIRNESS_STANCE,
      idempotency: { windowHours: IDEMPOTENCY_WINDOW_HOURS, stance: IDEMPOTENCY_STANCE },
    };
  }

  /** Who is waiting, and what would start next. */
  @Get('fairness')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async fairnessSnapshot(): Promise<unknown> {
    const plan = await this.fairness.admissionPlan();
    return {
      ...(await this.fairness.snapshot()),
      // The order itself, not just the counts: "why is my run not starting" is answerable only
      // from the sequence, and an operator asked that question has nowhere else to look.
      nextUp: plan.dispatch.slice(0, 20).map((job, index) => ({
        position: index + 1,
        runId: job.id,
        tenantId: job.tenantId,
        queuedAt: new Date(job.queuedAt).toISOString(),
      })),
    };
  }

  /** What the gateway has learned about each model's limits. Never a provider name. */
  @Get('providers')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async providerState(): Promise<unknown> {
    return {
      models: this.providers.snapshot(),
      maxCooldownMs: ProviderThrottleService.maxCooldownMs,
      note:
        'Learned in this process and lost on restart, deliberately — a cooldown that survived a ' +
        'restart would describe a provider’s behaviour from before it. A declared ' +
        'quotaRequestsPerMinute goes through the shared store instead and does not have that ' +
        'limitation.',
    };
  }

  /**
   * Delete expired idempotency records.
   *
   * `dev-ops:EditDraft` — it writes. Nothing schedules it: the eighth job waiting on the Prompt 26
   * business-cron scheduler. A route is the honest way to ship a reachable, tested sweep in the
   * meantime, and the runbook says so rather than implying it runs.
   */
  @Post('idempotency/sweep')
  @RequirePermission({ module: 'dev-ops', action: 'EditDraft' })
  async sweep(): Promise<unknown> {
    return this.idempotency.sweep();
  }
}
