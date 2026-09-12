/**
 * Rate limits, abuse protection and execution fairness — Prompt 40.
 *
 * ## What already existed, and what this adds
 *
 * **Login abuse throttling** has been in place since Prompt 5: `AUTH_MAX_FAILED_ATTEMPTS` (five),
 * `lockoutMinutes`, and the `accountLocked` / `loginBlockedLockout` security events. **Request body
 * and file size limits** arrived at Prompt 35 — a per-route JSON ceiling and an upload validator.
 * **Retry caps** are on the run row as `maxAttempts`, and **token and cost caps** are the Prompt 30
 * budget reservations. None of those is rebuilt here.
 *
 * What is genuinely missing and what this module is for: **per-user and per-tenant API rate
 * limits**, **queue fairness**, **idempotency for retried mutating requests**, **per-tenant run
 * concurrency**, and **provider quota-aware backoff**.
 *
 * ## The one that is a real algorithm rather than a counter
 *
 * *"Queue fairness so one tenant cannot starve others."* A FIFO queue with four workers and one
 * tenant holding a thousand queued runs starves every other customer completely — and it does so
 * silently, because nothing is broken. `fairOrder` is the answer: round-robin across tenants, so
 * a tenant with a thousand runs and a tenant with one both get a worker.
 *
 * It is a **pure function over the pending set**, which is why it can be tested properly. A
 * fairness rule buried inside a queue adapter is a fairness rule nobody can prove.
 */

// ---------------------------------------------------------------------------
// What is being limited
// ---------------------------------------------------------------------------

/**
 * The things this module limits.
 *
 * Each is a different question with a different answer, which is why they are separate rather than
 * one global cap:
 *
 * * a **user** hammering the API is usually a broken script;
 * * a **tenant** exceeding its share is a commercial question;
 * * a **run** exceeding concurrency is a fairness question;
 * * a **provider** refusing us is somebody else's limit that we must respect.
 */
export const LIMIT_SCOPES = ['User', 'Tenant', 'Runs', 'Provider'] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const LIMIT_SCOPE_LABELS: Record<LimitScope, string> = {
  User: 'Per person',
  Tenant: 'Per company',
  Runs: 'Agent run concurrency',
  Provider: 'AI provider quota',
};

export interface RateLimit {
  scope: LimitScope;
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
  /**
   * How many can arrive at once before the window matters.
   *
   * A token bucket, not a fixed window. A fixed window lets twice the limit through across a
   * boundary — 100 at 11:59:59 and 100 at 12:00:00 — which is the classic mistake and the reason
   * a "100 per minute" limit does not actually cap concurrency at 100.
   */
  burst: number;
}

/**
 * The defaults, and why each number.
 *
 * The approved documents state no figures, so these are configuration with documented defaults.
 * Each is chosen against what a *legitimate* user does, not against a round number.
 */
export const DEFAULT_LIMITS: Record<Exclude<LimitScope, 'Provider'>, RateLimit> = {
  /**
   * 300 per minute per person.
   *
   * A person filling in Form 2 with autosave, a dashboard polling, and a file upload in another
   * tab together come nowhere near five a second. A script in a loop passes it immediately, which
   * is exactly the distinction worth drawing.
   */
  User: { scope: 'User', limit: 300, windowSeconds: 60, burst: 60 },

  /**
   * 3,000 per minute per company.
   *
   * Ten times the per-user limit, so a company of thirty active people is unconstrained and a
   * company whose integration has gone wrong is stopped before it affects anybody else.
   */
  Tenant: { scope: 'Tenant', limit: 3_000, windowSeconds: 60, burst: 300 },

  /**
   * 8 concurrent runs per company.
   *
   * Not a rate — a ceiling on work in flight. Paired with `fairOrder`: the concurrency cap stops
   * one company monopolising the workers, and the round-robin stops it monopolising the *queue*.
   * Either alone is insufficient, which is why both exist.
   */
  Runs: { scope: 'Runs', limit: 8, windowSeconds: 0, burst: 8 },
};

export const MAX_CONFIGURABLE_LIMIT = 100_000;

export function limitProblems(limit: RateLimit): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(limit.limit) || limit.limit < 1) {
    problems.push('A limit must be at least one request.');
  } else if (limit.limit > MAX_CONFIGURABLE_LIMIT) {
    problems.push(`A limit cannot exceed ${MAX_CONFIGURABLE_LIMIT}.`);
  }
  if (!Number.isInteger(limit.burst) || limit.burst < 1) {
    problems.push('A burst must be at least one.');
  } else if (limit.burst > limit.limit) {
    problems.push(
      'A burst larger than the limit would let a caller exceed the limit in one moment, which ' +
        'is the thing the limit exists to prevent.',
    );
  }
  if (
    limit.scope !== 'Runs' &&
    (!Number.isInteger(limit.windowSeconds) || limit.windowSeconds < 1)
  ) {
    problems.push('A rate window must be at least one second.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The token bucket
// ---------------------------------------------------------------------------

export interface BucketState {
  /** Tokens available, which may be fractional between refills. */
  tokens: number;
  /** When the bucket was last refilled, in epoch milliseconds. */
  refilledAt: number;
}

export type LimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number; limit: number; scope: LimitScope };

/**
 * Consume one token, refilling first.
 *
 * A **pure function over the state and the clock**, so the limiter's storage is an implementation
 * detail and the algorithm is testable without one. Refill is continuous rather than per-window:
 * tokens accrue at `limit / windowSeconds` per second, which is what makes this a token bucket
 * rather than a fixed window — and a fixed window would let twice the limit through across a
 * boundary.
 *
 * `retryAfterSeconds` is rounded **up** and floored at one. A `Retry-After: 0` tells a client to
 * try again immediately, which is how a rate limit becomes a busy loop.
 */
export function consumeToken(input: { state: BucketState; limit: RateLimit; now: number }): {
  state: BucketState;
  decision: LimitDecision;
} {
  const perSecond = input.limit.limit / input.limit.windowSeconds;
  const elapsedSeconds = Math.max(0, (input.now - input.state.refilledAt) / 1000);

  const refilled = Math.min(input.limit.burst, input.state.tokens + elapsedSeconds * perSecond);

  if (refilled < 1) {
    // How long until one whole token exists.
    const secondsUntilOne = (1 - refilled) / perSecond;
    return {
      state: { tokens: refilled, refilledAt: input.now },
      decision: {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(secondsUntilOne)),
        limit: input.limit.limit,
        scope: input.limit.scope,
      },
    };
  }

  return {
    state: { tokens: refilled - 1, refilledAt: input.now },
    decision: { allowed: true, remaining: Math.floor(refilled - 1) },
  };
}

export function freshBucket(limit: RateLimit, now: number): BucketState {
  // Starts full, so a first request is never refused. A bucket starting empty would rate-limit
  // the very first caller after a deploy.
  return { tokens: limit.burst, refilledAt: now };
}

// ---------------------------------------------------------------------------
// Queue fairness
// ---------------------------------------------------------------------------

export interface PendingJob {
  id: string;
  tenantId: string;
  /** Epoch milliseconds. Oldest first within a tenant. */
  queuedAt: number;
}

/**
 * Reorder the pending set so no tenant can starve another.
 *
 * **Round-robin across tenants, oldest-first within each.** One pass takes the oldest job of each
 * tenant, then the second-oldest of each, and so on — so a tenant with a thousand queued runs and
 * a tenant with one both get a worker on the first pass.
 *
 * ## Why not a priority or a weight
 *
 * A weighted queue needs somebody to choose the weights, and nobody can: a company's plan does not
 * tell you whose run matters more this minute. Round-robin needs no such judgement and has the
 * property that actually matters — **a tenant's wait depends on the number of *tenants*, not on the
 * size of the biggest tenant's backlog.**
 *
 * ## Why FIFO within a tenant
 *
 * Because within one company the oldest work is the most likely to have somebody waiting on it, and
 * reordering inside a tenant would make a run's completion time unpredictable for no fairness gain.
 *
 * Stable: ties in `queuedAt` keep their input order, so the function is deterministic and a test
 * can assert an exact sequence.
 */
export function fairOrder(pending: readonly PendingJob[]): PendingJob[] {
  const byTenant = new Map<string, PendingJob[]>();

  for (const job of pending) {
    const existing = byTenant.get(job.tenantId);
    if (existing === undefined) {
      byTenant.set(job.tenantId, [job]);
    } else {
      existing.push(job);
    }
  }

  // Oldest first within each tenant. A stable sort, so equal timestamps keep input order.
  for (const jobs of byTenant.values()) {
    jobs.sort((left, right) => left.queuedAt - right.queuedAt);
  }

  // Tenant turn order is by each tenant's oldest job, so the company that has been waiting
  // longest goes first on every pass. Without this the round-robin would favour whichever tenant
  // the Map happened to see first.
  const tenants = [...byTenant.entries()].sort(
    (left, right) => (left[1][0]?.queuedAt ?? 0) - (right[1][0]?.queuedAt ?? 0),
  );

  const ordered: PendingJob[] = [];
  let pass = 0;
  let placed = 0;

  while (placed < pending.length) {
    let placedThisPass = 0;
    for (const [, jobs] of tenants) {
      const job = jobs[pass];
      if (job !== undefined) {
        ordered.push(job);
        placed += 1;
        placedThisPass += 1;
      }
    }
    // Cannot happen while `placed < pending.length`, and asserted rather than trusted: an
    // infinite loop in the queue scheduler would be the worst possible bug in this file.
    if (placedThisPass === 0) break;
    pass += 1;
  }

  return ordered;
}

/**
 * How many of a tenant's runs may be in flight.
 *
 * Separate from `fairOrder` because they solve different halves: the order decides **who is next**,
 * the cap decides **how many at once**. A queue that was fairly ordered but uncapped would still
 * let one tenant hold all four workers for an hour.
 */
export function concurrencySlotsFor(input: { inFlight: number; limit: number }): number {
  return Math.max(0, input.limit - input.inFlight);
}

export const FAIRNESS_STANCE =
  'Work is taken round-robin across companies, oldest first within each, and each company has a ' +
  'ceiling on runs in flight. So a company that queues a thousand runs waits behind one run from ' +
  'every other company rather than ahead of all of them — a tenant’s wait depends on how many ' +
  'companies are busy, not on how big the busiest one is.';

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Which HTTP methods need an idempotency key.
 *
 * `POST` only. `PUT`, `PATCH` and `DELETE` on a specific resource are idempotent by construction —
 * applying them twice reaches the same state — whereas `POST` creates, and creating twice is two
 * things. That is the whole distinction, and it is why blanket idempotency on every method would
 * be machinery for no benefit.
 */
export const IDEMPOTENT_METHODS: readonly string[] = ['POST'];

/** How long a key is remembered. */
export const IDEMPOTENCY_WINDOW_HOURS = 24;

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export type IdempotencyOutcome =
  | { kind: 'Fresh' }
  | { kind: 'Replay'; statusCode: number; body: unknown }
  | { kind: 'InFlight' }
  | { kind: 'Conflict'; reason: string };

/**
 * What to do about a key that has been seen before.
 *
 * Four outcomes, and the fourth is the one that matters. A key replayed with a **different request
 * body** is not a retry — it is a client bug or an attack, and returning the first response would
 * silently discard the second request. So it is a conflict, which is what the Stripe-style
 * contract every developer already knows does, and for the same reason.
 *
 * `InFlight` is distinct from `Replay` because a retry arriving while the first attempt is still
 * running has no stored response to return. Returning a 409 and letting the client retry is
 * correct; waiting would hold a connection open on the outcome of another request.
 */
export function decideIdempotency(input: {
  existing: { requestHash: string; statusCode: number | null; body: unknown } | null;
  requestHash: string;
}): IdempotencyOutcome {
  if (input.existing === null) return { kind: 'Fresh' };

  if (input.existing.requestHash !== input.requestHash) {
    return {
      kind: 'Conflict',
      reason:
        'That idempotency key was already used for a different request. Reusing a key with new ' +
        'content would mean one of the two requests was silently discarded, so neither is ' +
        'applied — use a new key.',
    };
  }

  if (input.existing.statusCode === null) return { kind: 'InFlight' };

  return {
    kind: 'Replay',
    statusCode: input.existing.statusCode,
    body: input.existing.body,
  };
}

export const IDEMPOTENCY_STANCE =
  'A mutating request may carry an Idempotency-Key. The first request with that key is performed ' +
  'and its response remembered for 24 hours; a retry with the same key and the same body returns ' +
  'the same response without doing the work twice. The same key with a different body is refused ' +
  'rather than answered, because answering would silently discard one of the two requests.';

// ---------------------------------------------------------------------------
// Provider quota and backoff
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter, for a provider that told us to slow down.
 *
 * **The jitter is not decoration.** Without it, every caller that was throttled at the same instant
 * retries at the same instant — a thundering herd that re-triggers the limit and turns a brief
 * throttle into a sustained outage. Full jitter (a uniform random point in the whole interval) is
 * the variant that spreads retries best, and the trade is that one retry may be sooner than a
 * plain backoff would allow.
 *
 * `attempt` is 1-based. The ceiling stops the fourth retry of a long-lived job waiting an hour.
 */
export const PROVIDER_BACKOFF_BASE_MS = 500;
export const PROVIDER_BACKOFF_CEILING_MS = 60_000;

export function providerBackoffMs(input: {
  attempt: number;
  random?: number;
  retryAfterSeconds?: number | undefined;
}): number {
  // A provider that told us exactly how long to wait is obeyed. Guessing when we have been told
  // is how an integration gets rate-limited for longer than it needed to be.
  if (input.retryAfterSeconds !== undefined && input.retryAfterSeconds > 0) {
    return Math.min(PROVIDER_BACKOFF_CEILING_MS, input.retryAfterSeconds * 1000);
  }

  const exponential = Math.min(
    PROVIDER_BACKOFF_CEILING_MS,
    PROVIDER_BACKOFF_BASE_MS * 2 ** Math.max(0, input.attempt - 1),
  );
  const random = input.random ?? Math.random();
  return Math.max(1, Math.round(exponential * random));
}

/** Whether a provider failure is worth retrying at all. */
export const RETRYABLE_PROVIDER_REASONS: readonly string[] = [
  'RateLimited',
  'Timeout',
  'Unavailable',
  'ServerError',
];

export function providerFailureIsRetryable(reason: string): boolean {
  return RETRYABLE_PROVIDER_REASONS.includes(reason);
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

/**
 * A business-readable refusal.
 *
 * The prompt asks for *"business-readable 429/blocked responses"*, so a refusal says **what
 * happened, why, and what to do** — not "Too Many Requests". A person who hits a limit on a screen
 * needs to know whether to wait, whether it is them or their company, and whether to call somebody.
 */
export const LIMIT_MESSAGES: Record<LimitScope, string> = {
  User:
    'You have made a lot of requests very quickly. Wait a moment and try again — this limit is ' +
    'per person, so nobody else in your company is affected.',
  Tenant:
    'Your company has reached its request limit for the moment. This is usually an integration ' +
    'retrying in a loop rather than people working. Wait a moment; if it keeps happening, an ' +
    'administrator should check Settings · Integrations.',
  Runs:
    'Your company already has the maximum number of agent runs in progress. The rest are queued ' +
    'and will start as those finish — nothing has been lost, and no other company is holding ' +
    'your place.',
  Provider:
    'The AI provider is rate-limiting us. UBoss is backing off and will retry automatically; the ' +
    'run stays queued rather than failing.',
};

export interface LimitRefusal {
  scope: LimitScope;
  message: string;
  retryAfterSeconds: number;
  /** The limit that was hit, so a client can show it and an operator can check it. */
  limit: number;
}

export function refusalFor(decision: Extract<LimitDecision, { allowed: false }>): LimitRefusal {
  return {
    scope: decision.scope,
    message: LIMIT_MESSAGES[decision.scope],
    retryAfterSeconds: decision.retryAfterSeconds,
    limit: decision.limit,
  };
}

/**
 * Routes that are never rate-limited.
 *
 * Three, each for a concrete reason rather than convenience:
 *
 * * **`/health`** — a load balancer probes it constantly, and rate-limiting the probe would take
 *   the service out of rotation under exactly the load the limit exists to survive.
 * * **the metrics scrape** — same argument: losing observability during an incident is the worst
 *   possible time to lose it.
 * * **sign-out** — a person being refused the ability to end their own session is a security
 *   problem, not a capacity one.
 *
 * Sign-*in* is deliberately **not** here: it has its own throttle (the Prompt 5 lockout), and that
 * throttle is the whole point.
 */
export const UNLIMITED_ROUTES: readonly string[] = [
  '/health',
  '/platform/observability/metrics',
  '/auth/logout',
];

export function routeIsUnlimited(path: string): boolean {
  return UNLIMITED_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}

export const WAF_ASSUMPTIONS =
  'UBoss assumes a reverse proxy or WAF in front of it that terminates TLS, drops malformed ' +
  'requests, provides IP-level volumetric protection and sets X-Forwarded-For. The application ' +
  'does none of those and does not pretend to: its limits are per authenticated identity, which ' +
  'is the layer a proxy cannot see. An unauthenticated flood is the proxy’s job, and if there is ' +
  'no proxy then that job is nobody’s.';
