import { Injectable, Logger } from '@nestjs/common';

import {
  providerBackoffMs,
  providerFailureIsRetryable,
  PROVIDER_BACKOFF_CEILING_MS,
  type RateLimit,
} from '@uboss/types';

import { MetricsService } from '../observability/metrics.service.js';
import { RateLimitStore } from './rate-limit.store.js';

/** What the gateway learns about one model. In memory: it is a few seconds of history. */
interface ModelState {
  /** Consecutive retryable failures. Reset by a success. */
  consecutiveFailures: number;
  /** Epoch ms before which this model should not be called. */
  cooldownUntil: number;
  /** The last thing the provider said, for the status endpoint. */
  lastReason: string | null;
}

export type ProviderGate =
  { proceed: true } | { proceed: false; reason: string; retryAfterMs: number };

/**
 * Provider and model quota-aware throttling and backoff — Prompt 40.
 *
 * ## Two mechanisms, because providers tell you their limits in two different ways
 *
 * **Declared**: `ProviderModel.quotaRequestsPerMinute`, when somebody transcribed the contract.
 * Enforced with the same token bucket the API uses, through the same store — a rate limit is a
 * rate limit, and a second implementation of one would be a second thing to get wrong.
 *
 * **Observed**: when the quota is not declared, or is declared wrongly, the provider says "429"
 * and UBoss learns. Consecutive failures raise a cooldown via `providerBackoffMs`, and a success
 * clears it. This is the mechanism that actually runs today, because no contract figures have been
 * supplied.
 *
 * ## Why the jitter matters more than the backoff
 *
 * Four workers throttled at the same instant, all retrying after exactly 2,000ms, re-trigger the
 * same limit together — and the second refusal is at the same instant too. A brief throttle
 * becomes a sustained outage produced entirely by the retry policy. Full jitter spreads them, and
 * the cost is that one retry may go earlier than a plain backoff would allow. That is a trade worth
 * making; the alternative is a self-inflicted thundering herd.
 *
 * ## Why the state is in memory
 *
 * Because it is worth seconds. A cooldown that survived a restart would describe a provider's
 * behaviour from before the restart, and the first call after a deploy would be refused on
 * evidence that is no longer current. Losing it on restart costs at most one refused call, which
 * the backoff then handles correctly.
 *
 * **The consequence is stated rather than hidden**: with several API instances, each learns
 * separately, so a rate-limited provider is discovered once per process. The declared quota goes
 * through the shared store and does not have that property, which is the argument for declaring
 * it.
 */
@Injectable()
export class ProviderThrottleService {
  private readonly logger = new Logger(ProviderThrottleService.name);

  private readonly states = new Map<string, ModelState>();

  constructor(
    private readonly store: RateLimitStore,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Should this model be called right now?
   *
   * Checks the learned cooldown first, because it is free, and the declared quota second, because
   * it costs a store round trip. A model in cooldown is not worth a quota check.
   */
  async mayCall(input: {
    providerModelId: string;
    /** From `ProviderModel.quotaRequestsPerMinute`. Null when the provider never told us. */
    quotaRequestsPerMinute?: number | null;
    now?: number;
  }): Promise<ProviderGate> {
    const now = input.now ?? Date.now();
    const state = this.states.get(input.providerModelId);

    if (state !== undefined && state.cooldownUntil > now) {
      return {
        proceed: false,
        retryAfterMs: state.cooldownUntil - now,
        reason:
          'The AI provider is rate-limiting us, so UBoss is holding off before calling it again. ' +
          'The run stays queued rather than failing.',
      };
    }

    const quota = input.quotaRequestsPerMinute;
    if (quota === undefined || quota === null || quota < 1) return { proceed: true };

    const limit: RateLimit = {
      scope: 'Provider',
      limit: quota,
      windowSeconds: 60,
      // A fifth of the minute's allowance in one moment. A provider quota is a sustained rate, and
      // spending the whole minute in two seconds is how a compliant client still gets a 429.
      burst: Math.max(1, Math.ceil(quota / 5)),
    };

    const decision = await this.store.consume(`provider:${input.providerModelId}`, limit, now);
    if (decision.allowed) return { proceed: true };

    this.metrics.increment('rate_limit_refusals', { scope: 'Provider' });
    return {
      proceed: false,
      retryAfterMs: decision.retryAfterSeconds * 1000,
      reason:
        'This AI model has reached the request limit its provider allows for the next moment, so ' +
        'UBoss is waiting rather than being refused. The run stays queued.',
    };
  }

  /**
   * The provider refused or failed. Raise the cooldown if trying again could ever help.
   *
   * A non-retryable failure — a rejected request, a refused credential — sets no cooldown at all.
   * Backing off from a call that will be refused identically next time spends the customer's wait
   * to reach the same answer.
   */
  recordFailure(input: {
    providerModelId: string;
    /** From the adapter's classification: `RateLimited`, `Timeout`, `Unavailable`, `ServerError`… */
    reason: string;
    /** The provider's own `Retry-After`, in seconds, when it sent one. */
    retryAfterSeconds?: number | undefined;
    now?: number;
  }): { cooldownMs: number } {
    const now = input.now ?? Date.now();

    if (!providerFailureIsRetryable(input.reason)) {
      this.states.set(input.providerModelId, {
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastReason: input.reason,
      });
      return { cooldownMs: 0 };
    }

    const previous = this.states.get(input.providerModelId);
    const failures = (previous?.consecutiveFailures ?? 0) + 1;

    const cooldownMs = providerBackoffMs({
      attempt: failures,
      ...(input.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: input.retryAfterSeconds }),
    });

    this.states.set(input.providerModelId, {
      consecutiveFailures: failures,
      cooldownUntil: now + cooldownMs,
      lastReason: input.reason,
    });

    this.logger.debug(
      `Model ${input.providerModelId} backed off ${cooldownMs}ms after ${failures} ` +
        `consecutive ${input.reason} failures.`,
    );

    return { cooldownMs };
  }

  /**
   * The provider answered. Clear the cooldown.
   *
   * Fully, not gradually. A model that just worked is working, and a decaying counter would keep
   * throttling a recovered provider on the strength of a problem that is over.
   */
  recordSuccess(providerModelId: string): void {
    this.states.delete(providerModelId);
  }

  /** What the gateway currently believes about each model. Never a provider name. */
  snapshot(now = Date.now()): {
    providerModelId: string;
    consecutiveFailures: number;
    cooldownMsRemaining: number;
    lastReason: string | null;
  }[] {
    return [...this.states.entries()].map(([providerModelId, state]) => ({
      providerModelId,
      consecutiveFailures: state.consecutiveFailures,
      cooldownMsRemaining: Math.max(0, state.cooldownUntil - now),
      lastReason: state.lastReason,
    }));
  }

  /** The ceiling, so a caller can bound its own waiting. */
  static get maxCooldownMs(): number {
    return PROVIDER_BACKOFF_CEILING_MS;
  }

  /** Tests only. */
  reset(): void {
    this.states.clear();
  }
}
