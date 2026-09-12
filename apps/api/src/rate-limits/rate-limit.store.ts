import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  consumeToken,
  freshBucket,
  type BucketState,
  type LimitDecision,
  type RateLimit,
} from '@uboss/types';

/**
 * Where a token bucket lives.
 *
 * ## Why this is a seam and not a Map
 *
 * Because the answer is different in the two deployments UBoss actually has, and getting it wrong
 * is a security hole rather than an inefficiency.
 *
 * A per-process Map is correct for the single-process API that runs today. Behind a load balancer
 * with four instances, the *same* Map gives every caller **four times** the configured limit — the
 * limit silently becomes whatever the instance count happens to be, and nothing surfaces it. The
 * metrics look healthy, the tests pass, and the number in the documentation is wrong.
 *
 * So the shipping implementation is Redis (the broker BullMQ already requires), the in-process one
 * is the single-process and test implementation, and **`isSharedAcrossProcesses` says which you
 * have** — so a status endpoint can report the truth rather than a claim. Same shape as
 * `RunQueue`, `StorageAdapter`, `MalwareScanner` and the provider adapters.
 */
@Injectable()
export abstract class RateLimitStore {
  abstract readonly kind: string;

  /**
   * False when each process keeps its own buckets, so the effective limit is multiplied by the
   * number of instances. Read by the status endpoint, because a limit that is really four times
   * what it says is a thing an operator must be told rather than discover.
   */
  abstract readonly isSharedAcrossProcesses: boolean;

  /**
   * Take one token for `key`, or refuse.
   *
   * The decision logic itself is `consumeToken` in `@uboss/types` for every implementation — a
   * store decides *where* the state lives, never *what* the limit means. Two implementations that
   * each did their own arithmetic would eventually disagree, and the one you could not test would
   * be the one that was wrong.
   */
  abstract consume(key: string, limit: RateLimit, now: number): Promise<LimitDecision>;

  /** Forget everything. Tests only — a production caller resetting limits is an abuse bypass. */
  abstract reset(): Promise<void>;
}

/**
 * The single-process and test implementation.
 *
 * ## Pruning without a timer
 *
 * An unbounded Map keyed by user id is a memory leak with a slow fuse: every person who ever
 * signs in leaves a bucket behind. A `setInterval` would fix it and would also keep the Node
 * process alive at the end of every test run, which is its own kind of bug.
 *
 * So pruning is opportunistic — every `PRUNE_EVERY` calls, entries that have refilled to full and
 * not been touched for two windows are dropped. A full bucket carries no information: recreating
 * it costs one allocation and grants exactly the same decision. The pruning is therefore
 * **behaviour-preserving**, which is what makes it safe to do on a whim rather than on a schedule.
 */
@Injectable()
export class InProcessRateLimitStore extends RateLimitStore {
  readonly kind = 'in-process';
  readonly isSharedAcrossProcesses = false;

  private static readonly PRUNE_EVERY = 2_000;

  private readonly buckets = new Map<string, BucketState>();
  private callsSincePrune = 0;

  async consume(key: string, limit: RateLimit, now: number): Promise<LimitDecision> {
    this.maybePrune(limit, now);

    const state = this.buckets.get(key) ?? freshBucket(limit, now);
    const result = consumeToken({ state, limit, now });
    this.buckets.set(key, result.state);
    return result.decision;
  }

  async reset(): Promise<void> {
    this.buckets.clear();
    this.callsSincePrune = 0;
  }

  /** How many buckets are held. Asserted by a test, so the leak cannot come back unnoticed. */
  size(): number {
    return this.buckets.size;
  }

  private maybePrune(limit: RateLimit, now: number): void {
    this.callsSincePrune += 1;
    if (this.callsSincePrune < InProcessRateLimitStore.PRUNE_EVERY) return;
    this.callsSincePrune = 0;

    const staleBefore = now - limit.windowSeconds * 2_000;
    for (const [key, state] of this.buckets) {
      if (state.tokens >= limit.burst && state.refilledAt < staleBefore) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * The token bucket as a Lua script, so a refill and a take are one atomic step.
 *
 * ## Why Lua and not GET/SET
 *
 * Read-then-write from four processes at once is a lost-update race, and the update that gets lost
 * is a token somebody already spent. Under exactly the burst of traffic a rate limiter exists to
 * handle, a non-atomic limiter lets *more* through — it fails open, which is the worst possible
 * direction for this particular control.
 *
 * Redis runs a script to completion with nothing interleaved, so this is the one place the
 * arithmetic can be trusted across processes. The arithmetic deliberately mirrors `consumeToken`
 * line for line; the contract test asserts the two agree rather than trusting that they do.
 *
 * `KEYS[1]` bucket, `ARGV`: limit, windowSeconds, burst, now(ms).
 * Returns `{allowed, remaining, retryAfterSeconds}`.
 */
const TOKEN_BUCKET_LUA = `
local key         = KEYS[1]
local limit       = tonumber(ARGV[1])
local windowSecs  = tonumber(ARGV[2])
local burst       = tonumber(ARGV[3])
local now         = tonumber(ARGV[4])

local perSecond = limit / windowSecs

local stored = redis.call('HMGET', key, 'tokens', 'refilledAt')
local tokens = tonumber(stored[1])
local refilledAt = tonumber(stored[2])

if tokens == nil or refilledAt == nil then
  -- A fresh bucket starts full, matching freshBucket(): a first request after a deploy must
  -- never be refused.
  tokens = burst
  refilledAt = now
end

local elapsed = (now - refilledAt) / 1000
if elapsed < 0 then elapsed = 0 end

local refilled = tokens + elapsed * perSecond
if refilled > burst then refilled = burst end

local allowed = 0
local remaining = 0
local retryAfter = 0

if refilled < 1 then
  local secondsUntilOne = (1 - refilled) / perSecond
  retryAfter = math.ceil(secondsUntilOne)
  if retryAfter < 1 then retryAfter = 1 end
  tokens = refilled
else
  allowed = 1
  tokens = refilled - 1
  remaining = math.floor(tokens)
end

redis.call('HSET', key, 'tokens', tokens, 'refilledAt', now)
-- Expire two windows after the bucket would be full again, so an idle key cleans itself up.
-- Without this every user id that ever signed in stays in Redis forever.
redis.call('PEXPIRE', key, math.ceil(windowSecs * 2000))

return {allowed, remaining, retryAfter}
`;

/**
 * The shipping store: shared across processes, on the broker that is already required.
 *
 * ## Fail-open, and why that is the right call *here* specifically
 *
 * Everywhere else in UBoss the rule is fail-closed — an authorization check that cannot reach the
 * database refuses. This one is the opposite: if Redis is unreachable the request is **allowed**,
 * with a log line and a counter.
 *
 * The reasoning is about what each control protects. A failing authorization check that let a
 * request through would expose a customer's data. A failing rate limiter that let a request
 * through exposes nothing — it removes a protection against load. Failing closed would mean a
 * Redis blip takes the entire API down for every customer, which converts a capacity protection
 * into the outage it exists to prevent.
 *
 * Stated rather than assumed, because "fail open" written down is a decision and "fail open"
 * discovered in a catch block is a bug.
 */
@Injectable()
export class RedisRateLimitStore extends RateLimitStore implements OnModuleDestroy {
  readonly kind = 'redis';
  readonly isSharedAcrossProcesses = true;

  private readonly logger = new Logger(RedisRateLimitStore.name);
  private readonly redis: Redis;

  /** Counted so a status endpoint can say the limiter is degraded rather than pretend it is fine. */
  private storeFailures = 0;

  constructor(redisUrl?: string) {
    super();
    const url = redisUrl ?? process.env['REDIS_URL'];
    if (!url) {
      throw new Error(
        'REDIS_URL is not set, so rate limits cannot be shared between API instances. Register ' +
          'InProcessRateLimitStore instead for a single-process deployment, and read its note on ' +
          'what that means for the effective limit.',
      );
    }
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    this.redis.on('error', (error: Error) => {
      // Logged at debug: a limiter that spams the log during a Redis outage makes the outage
      // harder to read. The failure counter is the signal.
      this.logger.debug(`Rate-limit store error: ${error.message}`);
    });
    this.redis.defineCommand('ubossTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  }

  async consume(key: string, limit: RateLimit, now: number): Promise<LimitDecision> {
    try {
      const raw = (await (
        this.redis as unknown as {
          ubossTokenBucket(
            key: string,
            limit: number,
            windowSeconds: number,
            burst: number,
            now: number,
          ): Promise<[number, number, number]>;
        }
      ).ubossTokenBucket(
        `uboss:ratelimit:${key}`,
        limit.limit,
        limit.windowSeconds,
        limit.burst,
        now,
      )) as [number, number, number];

      const [allowed, remaining, retryAfterSeconds] = raw;
      if (allowed === 1) {
        return { allowed: true, remaining: Number(remaining) };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Number(retryAfterSeconds)),
        limit: limit.limit,
        scope: limit.scope,
      };
    } catch (error) {
      this.storeFailures += 1;
      this.logger.warn(
        'The rate-limit store is unreachable, so this request was allowed through: ' +
          (error instanceof Error ? error.message : 'unknown error'),
      );
      // See the class comment. Allowing is the deliberate direction.
      return { allowed: true, remaining: 0 };
    }
  }

  async reset(): Promise<void> {
    const keys = await this.redis.keys('uboss:ratelimit:*');
    if (keys.length > 0) await this.redis.del(...keys);
  }

  failures(): number {
    return this.storeFailures;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
