import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_LIMITS,
  limitProblems,
  refusalFor,
  type LimitDecision,
  type LimitRefusal,
  type LimitScope,
  type RateLimit,
} from '@uboss/types';

import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { MetricsService } from '../observability/metrics.service.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { RateLimitStore } from './rate-limit.store.js';

/** The platform settings that configure the limits, seeded by this prompt's migration. */
export const LIMIT_SETTING_KEYS = {
  User: 'limits.api_requests_per_user_per_minute',
  Tenant: 'limits.api_requests_per_company_per_minute',
  Runs: 'limits.concurrent_runs_per_company',
} as const;

export type ApiLimitScope = Extract<LimitScope, 'User' | 'Tenant'>;

export interface CheckOutcome {
  allowed: boolean;
  /** Set only on a refusal. */
  refusal?: LimitRefusal;
  /** For the response headers a well-behaved client reads. */
  limit: number;
  remaining: number;
}

/**
 * Per-user and per-tenant API rate limiting — Prompt 40.
 *
 * ## Why the limits are platform configuration and not a company setting
 *
 * Every other knob in this product that affects one company lives in that company's Settings.
 * These do not, and the reason is that they are not the company's to set.
 *
 * A per-user limit protects the company from its own broken script. A **per-company** limit
 * protects *every other company* from this one — it is the API-layer counterpart of the run
 * concurrency cap. A company that could raise its own would be a company that could opt out of
 * the protection other customers depend on, which makes the control decorative. So they are rows
 * in `platform_settings`, changed by platform staff, recorded as a Critical security event by the
 * existing Master Console path, with `DEFAULT_LIMITS` as the fallback when a row is absent.
 *
 * ## Why the values are cached
 *
 * A database read per request to discover the request limit would be the single most-executed
 * query in the product, and it would make the limiter itself a load problem. Sixty seconds of
 * staleness after a change is the trade, and it is the right one: a limit takes effect within a
 * minute, which is faster than anybody can act on the reason they changed it.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  private static readonly CACHE_MS = 60_000;

  /**
   * How long between security events for the same identity hitting the same limit.
   *
   * Five minutes. A throttled client produces thousands of refusals a minute and writing a row
   * for each would bury the security trail under its noisiest caller — the trail would get less
   * useful exactly as it became more needed. The metric carries the volume; the trail carries the
   * fact, once, with a count.
   */
  private static readonly EVENT_COOLDOWN_MS = 5 * 60_000;

  private cached: { at: number; limits: Record<ApiLimitScope | 'Runs', RateLimit> } | null = null;
  private readonly lastReported = new Map<string, number>();

  constructor(
    private readonly store: RateLimitStore,
    private readonly platform: PlatformRepository,
    private readonly metrics: MetricsService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Check the layers that apply to this caller, innermost first.
   *
   * **Per-user before per-tenant, and that order is deliberate.** One person's runaway script
   * should be refused by *their* limit, naming them, before it is allowed to consume the
   * company's allowance and start refusing their colleagues. Checking the company first would
   * report the wrong cause and punish the wrong people.
   *
   * The consequence is that a request refused per-user does not consume a company token, which is
   * also correct: it was never served.
   */
  async check(input: {
    userId: string | null;
    tenantId: string | null;
    now?: number;
  }): Promise<CheckOutcome> {
    const now = input.now ?? Date.now();
    const limits = await this.limits();

    // Neither a user nor a tenant: an anonymous route. Nothing identity-scoped to limit, and
    // `WAF_ASSUMPTIONS` says volumetric protection of anonymous traffic is the proxy's job.
    // Sign-in is the exception, and it has had its own lockout since Prompt 5.
    if (input.userId === null && input.tenantId === null) {
      return { allowed: true, limit: limits.User.limit, remaining: limits.User.burst };
    }

    // The narrowest layer that allowed the request is what the headers report, because that is
    // the one the caller will hit first.
    let narrowest: CheckOutcome | null = null;

    if (input.userId !== null) {
      const outcome = await this.consume(
        `user:${input.userId}`,
        limits.User,
        now,
        input.userId,
        input.tenantId,
      );
      if (!outcome.allowed) return outcome;
      narrowest = outcome;
    }

    if (input.tenantId !== null) {
      const outcome = await this.consume(
        `tenant:${input.tenantId}`,
        limits.Tenant,
        now,
        input.userId,
        input.tenantId,
      );
      if (!outcome.allowed) return outcome;
      if (narrowest === null || outcome.remaining < narrowest.remaining) narrowest = outcome;
    }

    return narrowest ?? { allowed: true, limit: limits.User.limit, remaining: limits.User.burst };
  }

  private async consume(
    key: string,
    limit: RateLimit,
    now: number,
    userId: string | null,
    tenantId: string | null,
  ): Promise<CheckOutcome> {
    const decision: LimitDecision = await this.store.consume(key, limit, now);

    if (decision.allowed) {
      return { allowed: true, limit: limit.limit, remaining: decision.remaining };
    }

    this.metrics.increment('rate_limit_refusals', { scope: limit.scope });
    await this.reportOnce(key, limit.scope, now, userId, tenantId);

    return {
      allowed: false,
      refusal: refusalFor(decision),
      limit: limit.limit,
      remaining: 0,
    };
  }

  /**
   * Record a security event at most once per identity per cooldown.
   *
   * Deliberately **after** the metric and outside any transaction. A security event that failed
   * to write must never turn a 429 into a 500: the refusal is the control, and the record of it
   * is secondary to applying it.
   */
  private async reportOnce(
    key: string,
    scope: LimitScope,
    now: number,
    userId: string | null,
    tenantId: string | null,
  ): Promise<void> {
    const last = this.lastReported.get(key);
    if (last !== undefined && now - last < RateLimitService.EVENT_COOLDOWN_MS) return;
    this.lastReported.set(key, now);

    try {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.apiRateLimitTripped,
        ...(userId === null ? {} : { actorUserId: userId }),
        ...(tenantId === null ? {} : { tenantId }),
        resourceType: 'rate-limit',
        summary:
          scope === 'User'
            ? 'A person’s API requests were rate-limited. Usually a script in a loop rather than ' +
              'somebody working.'
            : 'A company reached its API request limit, so further requests were refused for a ' +
              'moment.',
        metadata: { scope, cooldownMinutes: 5 },
      });
    } catch (error) {
      this.logger.warn(
        `A rate-limit security event could not be recorded: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /** The limits in force, from platform settings with the code defaults behind them. */
  async limits(now = Date.now()): Promise<Record<ApiLimitScope | 'Runs', RateLimit>> {
    if (this.cached !== null && now - this.cached.at < RateLimitService.CACHE_MS) {
      return this.cached.limits;
    }

    const limits = {
      User: await this.resolve('User', DEFAULT_LIMITS.User),
      Tenant: await this.resolve('Tenant', DEFAULT_LIMITS.Tenant),
      Runs: await this.resolve('Runs', DEFAULT_LIMITS.Runs),
    };

    this.cached = { at: now, limits };
    return limits;
  }

  /** Drop the cache, so a change takes effect now. Used by the settings path and by tests. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Read one configured limit, falling back to the code default.
   *
   * ## A configured value that is nonsense falls back rather than applies
   *
   * A typed `0` in a platform setting would refuse every request in the product from every
   * customer — a total outage produced by one keystroke in a text field. `limitProblems` is the
   * same validator the unit tests use, and a value that fails it is logged and ignored. The
   * Master Console's own validation is the first line; this is the one that holds when a row is
   * edited by any other means.
   */
  private async resolve(scope: ApiLimitScope | 'Runs', fallback: RateLimit): Promise<RateLimit> {
    let raw: unknown;
    try {
      const row = await this.platform.findSetting(LIMIT_SETTING_KEYS[scope]);
      raw = row?.value;
    } catch (error) {
      // The limiter must not be the reason a request fails. Defaults are safe by construction.
      this.logger.debug(
        `Could not read ${LIMIT_SETTING_KEYS[scope]}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return fallback;
    }

    if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;

    const candidate: RateLimit = {
      ...fallback,
      limit: raw,
      // The burst scales with the limit rather than being configured separately: two numbers that
      // must hold a relationship are two numbers somebody will eventually set inconsistently.
      //
      // `Runs` is not a rate, so a fifth of it would be meaningless — a concurrency ceiling of
      // eight means eight at once, and the ceiling *is* the burst. A fifth of a per-minute rate
      // is a burst a person can produce and a loop cannot sustain.
      burst: scope === 'Runs' ? Math.max(1, raw) : Math.max(1, Math.min(raw, Math.ceil(raw / 5))),
    };

    const problems = limitProblems(candidate);
    if (problems.length > 0) {
      this.logger.warn(
        `${LIMIT_SETTING_KEYS[scope]} is set to ${raw}, which is not usable (${problems.join(
          ' ',
        )}). Using the default of ${fallback.limit}.`,
      );
      return fallback;
    }

    return candidate;
  }

  /** What the limiter is, for the status endpoint and the runbook. */
  describe(): { store: string; sharedAcrossProcesses: boolean } {
    return {
      store: this.store.kind,
      sharedAcrossProcesses: this.store.isSharedAcrossProcesses,
    };
  }
}
