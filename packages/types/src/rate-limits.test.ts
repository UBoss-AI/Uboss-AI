import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  concurrencySlotsFor,
  consumeToken,
  DEFAULT_LIMITS,
  decideIdempotency,
  fairOrder,
  FAIRNESS_STANCE,
  freshBucket,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_STANCE,
  IDEMPOTENCY_WINDOW_HOURS,
  IDEMPOTENT_METHODS,
  LIMIT_MESSAGES,
  LIMIT_SCOPE_LABELS,
  LIMIT_SCOPES,
  limitProblems,
  PROVIDER_BACKOFF_CEILING_MS,
  providerBackoffMs,
  providerFailureIsRetryable,
  refusalFor,
  RETRYABLE_PROVIDER_REASONS,
  routeIsUnlimited,
  UNLIMITED_ROUTES,
  WAF_ASSUMPTIONS,
  type BucketState,
  type LimitScope,
  type PendingJob,
} from './rate-limits.js';

describe('the limit vocabulary', () => {
  it('labels and messages every scope', () => {
    for (const scope of LIMIT_SCOPES) {
      assert.ok(LIMIT_SCOPE_LABELS[scope].length > 0, scope);
      assert.ok(LIMIT_MESSAGES[scope].length > 0, scope);
    }
    assert.equal(Object.keys(LIMIT_SCOPE_LABELS).length, LIMIT_SCOPES.length);
    assert.equal(Object.keys(LIMIT_MESSAGES).length, LIMIT_SCOPES.length);
  });

  it('has a default for every scope the application enforces itself', () => {
    // Provider quota is the provider's number, not ours, so it deliberately has no default.
    const ours = LIMIT_SCOPES.filter((scope) => scope !== 'Provider');
    assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [...ours].sort());
    for (const scope of ours) {
      const limit = DEFAULT_LIMITS[scope as Exclude<LimitScope, 'Provider'>];
      assert.equal(limit.scope, scope);
    }
  });

  it('accepts every default', () => {
    for (const limit of Object.values(DEFAULT_LIMITS)) {
      assert.deepEqual(limitProblems(limit), [], limit.scope);
    }
  });

  it('gives a company more headroom than one person', () => {
    // Otherwise the per-user limit would be unreachable: one busy person would exhaust the company.
    assert.ok(DEFAULT_LIMITS.Tenant.limit > DEFAULT_LIMITS.User.limit);
  });

  it('refuses a burst larger than the limit', () => {
    const problems = limitProblems({ scope: 'User', limit: 10, windowSeconds: 60, burst: 11 });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /burst larger than the limit/i);
  });

  it('refuses a nonsense limit', () => {
    assert.ok(limitProblems({ scope: 'User', limit: 0, windowSeconds: 60, burst: 1 }).length > 0);
    assert.ok(limitProblems({ scope: 'User', limit: 1.5, windowSeconds: 60, burst: 1 }).length > 0);
    assert.ok(
      limitProblems({ scope: 'User', limit: 500_000, windowSeconds: 60, burst: 1 }).length > 0,
    );
    assert.ok(limitProblems({ scope: 'User', limit: 10, windowSeconds: 0, burst: 1 }).length > 0);
  });

  it('does not require a window on a concurrency ceiling', () => {
    // Runs is a ceiling on work in flight, not a rate, so windowSeconds is meaningless there.
    assert.deepEqual(limitProblems(DEFAULT_LIMITS.Runs), []);
    assert.equal(DEFAULT_LIMITS.Runs.windowSeconds, 0);
  });
});

describe('the token bucket', () => {
  const limit = { scope: 'User' as const, limit: 60, windowSeconds: 60, burst: 10 };

  it('starts full, so the first request after a deploy is never refused', () => {
    const bucket = freshBucket(limit, 1_000);
    assert.equal(bucket.tokens, limit.burst);
    const { decision } = consumeToken({ state: bucket, limit, now: 1_000 });
    assert.equal(decision.allowed, true);
  });

  it('allows exactly the burst at one instant and refuses the next', () => {
    let state: BucketState = freshBucket(limit, 1_000);
    for (let index = 0; index < limit.burst; index += 1) {
      const result = consumeToken({ state, limit, now: 1_000 });
      assert.equal(result.decision.allowed, true, 'request ' + String(index + 1) + ' of the burst');
      state = result.state;
    }
    const overflow = consumeToken({ state, limit, now: 1_000 });
    assert.equal(overflow.decision.allowed, false);
  });

  it('refills continuously rather than per window', () => {
    // The whole point of a token bucket. A fixed window would let twice the limit through across a
    // boundary; here one second of a 60-per-60s limit buys exactly one token.
    let state: BucketState = freshBucket(limit, 0);
    for (let index = 0; index < limit.burst; index += 1) {
      state = consumeToken({ state, limit, now: 0 }).state;
    }
    assert.equal(consumeToken({ state, limit, now: 0 }).decision.allowed, false);
    assert.equal(consumeToken({ state, limit, now: 1_000 }).decision.allowed, true);
  });

  it('never refills past the burst, however long it has been idle', () => {
    const state: BucketState = { tokens: 0, refilledAt: 0 };
    const afterAnHour = consumeToken({ state, limit, now: 3_600_000 });
    assert.equal(afterAnHour.decision.allowed, true);
    // Nine left, not thousands: an idle hour must not buy a caller an unlimited burst.
    assert.equal(afterAnHour.state.tokens, limit.burst - 1);
  });

  it('never tells a client to retry immediately', () => {
    // A Retry-After of 0 turns a rate limit into a busy loop, which is worse than no limit.
    const generous = { scope: 'User' as const, limit: 60_000, windowSeconds: 60, burst: 1 };
    const spent = consumeToken({ state: freshBucket(generous, 0), limit: generous, now: 0 }).state;
    const refused = consumeToken({ state: spent, limit: generous, now: 0 }).decision;
    assert.equal(refused.allowed, false);
    if (refused.allowed) return;
    assert.ok(refused.retryAfterSeconds >= 1, 'got ' + String(refused.retryAfterSeconds));
  });

  it('reports a retry that is actually long enough to succeed', () => {
    const slow = { scope: 'Tenant' as const, limit: 6, windowSeconds: 60, burst: 1 };
    let state: BucketState = freshBucket(slow, 0);
    state = consumeToken({ state, limit: slow, now: 0 }).state;
    const refused = consumeToken({ state, limit: slow, now: 0 });
    assert.equal(refused.decision.allowed, false);
    if (refused.decision.allowed) return;
    const waited = refused.decision.retryAfterSeconds * 1000;
    // Honouring the advertised wait must work, or the header is a lie clients learn to ignore.
    assert.equal(
      consumeToken({ state: refused.state, limit: slow, now: waited }).decision.allowed,
      true,
    );
  });

  it('names the scope and the limit in a refusal, so a refusal is actionable', () => {
    const tiny = { scope: 'Tenant' as const, limit: 5, windowSeconds: 60, burst: 1 };
    const spent = consumeToken({ state: freshBucket(tiny, 0), limit: tiny, now: 0 }).state;
    const decision = consumeToken({ state: spent, limit: tiny, now: 0 }).decision;
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    const refusal = refusalFor(decision);
    assert.equal(refusal.scope, 'Tenant');
    assert.equal(refusal.limit, 5);
    assert.equal(refusal.message, LIMIT_MESSAGES.Tenant);
    assert.ok(refusal.retryAfterSeconds >= 1);
  });

  it('tells a caller how much it has left', () => {
    const result = consumeToken({ state: freshBucket(limit, 0), limit, now: 0 });
    assert.equal(result.decision.allowed, true);
    if (!result.decision.allowed) return;
    assert.equal(result.decision.remaining, limit.burst - 1);
  });

  it('does not go backwards when the clock does', () => {
    // Clock skew between processes is real; a negative elapsed time must not drain the bucket.
    const state: BucketState = { tokens: 5, refilledAt: 10_000 };
    const result = consumeToken({ state, limit, now: 9_000 });
    assert.equal(result.decision.allowed, true);
    assert.equal(result.state.tokens, 4);
  });
});

describe('queue fairness', () => {
  const job = (id: string, tenantId: string, queuedAt: number): PendingJob => ({
    id,
    tenantId,
    queuedAt,
  });

  it('loses nothing and invents nothing', () => {
    const pending = [
      job('a1', 'a', 1),
      job('b1', 'b', 2),
      job('a2', 'a', 3),
      job('c1', 'c', 4),
      job('a3', 'a', 5),
    ];
    const ordered = fairOrder(pending);
    assert.equal(ordered.length, pending.length);
    assert.deepEqual(
      ordered.map((entry) => entry.id).sort(),
      pending.map((entry) => entry.id).sort(),
    );
  });

  it('does not let one tenant starve the others, which is the whole point', () => {
    // One tenant queues a hundred runs before two other tenants queue one each. Under FIFO those
    // two would wait behind all hundred.
    const flood = Array.from({ length: 100 }, (_, index) =>
      job('flood-' + String(index), 'noisy', index),
    );
    const quiet = [job('quiet-b', 'b', 500), job('quiet-c', 'c', 501)];

    const ordered = fairOrder([...flood, ...quiet]);

    const positionOfB = ordered.findIndex((entry) => entry.id === 'quiet-b');
    const positionOfC = ordered.findIndex((entry) => entry.id === 'quiet-c');
    assert.equal(positionOfB, 1);
    assert.equal(positionOfC, 2);
    // The property rather than the index: a tenant's wait depends on how many tenants are busy,
    // not on the size of the biggest tenant's backlog.
    assert.ok(positionOfB < 3 && positionOfC < 3);
  });

  it('serves a tenant oldest-first within its own share', () => {
    const ordered = fairOrder([
      job('a-new', 'a', 300),
      job('a-old', 'a', 100),
      job('a-mid', 'a', 200),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.id),
      ['a-old', 'a-mid', 'a-new'],
    );
  });

  it('gives the longest-waiting company the first turn on every pass', () => {
    const ordered = fairOrder([
      job('b1', 'b', 20),
      job('b2', 'b', 40),
      job('a1', 'a', 10),
      job('a2', 'a', 30),
    ]);
    assert.deepEqual(
      ordered.map((entry) => entry.id),
      ['a1', 'b1', 'a2', 'b2'],
    );
  });

  it('is deterministic on a tie', () => {
    // Equal timestamps are common when a batch is enqueued in one transaction. A stable order
    // means the scheduler cannot reorder itself between two reads of the same queue.
    const pending = [job('x', 'a', 7), job('y', 'b', 7), job('z', 'a', 7)];
    const once = fairOrder(pending).map((entry) => entry.id);
    const twice = fairOrder(pending).map((entry) => entry.id);
    assert.deepEqual(once, twice);
    assert.deepEqual(once, ['x', 'y', 'z']);
  });

  it('handles an empty queue and a single tenant', () => {
    assert.deepEqual(fairOrder([]), []);
    const single = fairOrder([job('a2', 'a', 2), job('a1', 'a', 1)]);
    assert.deepEqual(
      single.map((entry) => entry.id),
      ['a1', 'a2'],
    );
  });

  it('caps how many of one company runs at once', () => {
    assert.equal(concurrencySlotsFor({ inFlight: 0, limit: 8 }), 8);
    assert.equal(concurrencySlotsFor({ inFlight: 8, limit: 8 }), 0);
    // Never negative: a limit lowered while work is in flight must not hand out slots.
    assert.equal(concurrencySlotsFor({ inFlight: 12, limit: 8 }), 0);
  });

  it('states the fairness stance in terms a customer could be shown', () => {
    assert.match(FAIRNESS_STANCE, /round-robin/i);
    assert.match(FAIRNESS_STANCE, /ceiling/i);
  });
});

describe('idempotency', () => {
  it('applies to POST only, and says why by omission', () => {
    assert.deepEqual([...IDEMPOTENT_METHODS], ['POST']);
    assert.equal(IDEMPOTENCY_WINDOW_HOURS, 24);
    assert.equal(IDEMPOTENCY_KEY_HEADER, 'idempotency-key');
  });

  it('performs an unseen key', () => {
    assert.deepEqual(decideIdempotency({ existing: null, requestHash: 'h1' }), { kind: 'Fresh' });
  });

  it('replays the stored response for a genuine retry', () => {
    const outcome = decideIdempotency({
      existing: { requestHash: 'h1', statusCode: 201, body: { id: 'run-1' } },
      requestHash: 'h1',
    });
    assert.equal(outcome.kind, 'Replay');
    if (outcome.kind !== 'Replay') return;
    assert.equal(outcome.statusCode, 201);
    assert.deepEqual(outcome.body, { id: 'run-1' });
  });

  it('refuses a reused key with different content rather than answering it', () => {
    // Answering would silently discard the second request, which is the failure mode idempotency
    // is supposed to prevent rather than cause.
    const outcome = decideIdempotency({
      existing: { requestHash: 'h1', statusCode: 201, body: { id: 'run-1' } },
      requestHash: 'h2',
    });
    assert.equal(outcome.kind, 'Conflict');
    if (outcome.kind !== 'Conflict') return;
    assert.match(outcome.reason, /different request/i);
  });

  it('distinguishes a retry that arrived while the first attempt is still running', () => {
    const outcome = decideIdempotency({
      existing: { requestHash: 'h1', statusCode: null, body: null },
      requestHash: 'h1',
    });
    assert.equal(outcome.kind, 'InFlight');
  });

  it('treats a conflicting key as a conflict even mid-flight', () => {
    const outcome = decideIdempotency({
      existing: { requestHash: 'h1', statusCode: null, body: null },
      requestHash: 'h2',
    });
    assert.equal(outcome.kind, 'Conflict');
  });

  it('explains the contract in words a client developer can act on', () => {
    assert.match(IDEMPOTENCY_STANCE, /24 hours/);
    assert.match(IDEMPOTENCY_STANCE, /refused/i);
  });
});

describe('provider backoff', () => {
  it('obeys a provider that told us how long to wait', () => {
    // Guessing when we have been told is how an integration stays throttled longer than needed.
    assert.equal(providerBackoffMs({ attempt: 1, retryAfterSeconds: 30, random: 1 }), 30_000);
  });

  it('caps even an absurd Retry-After', () => {
    assert.equal(
      providerBackoffMs({ attempt: 1, retryAfterSeconds: 86_400, random: 1 }),
      PROVIDER_BACKOFF_CEILING_MS,
    );
  });

  it('grows exponentially and then stops growing', () => {
    const full = (attempt: number) => providerBackoffMs({ attempt, random: 1 });
    assert.equal(full(1), 500);
    assert.equal(full(2), 1_000);
    assert.equal(full(3), 2_000);
    assert.equal(full(4), 4_000);
    assert.equal(full(20), PROVIDER_BACKOFF_CEILING_MS);
  });

  it('spreads retries instead of synchronising them', () => {
    // Without jitter every caller throttled at the same instant retries at the same instant and
    // re-triggers the limit. This asserts the spread exists, not a particular random value.
    const early = providerBackoffMs({ attempt: 5, random: 0.01 });
    const late = providerBackoffMs({ attempt: 5, random: 0.99 });
    assert.ok(early < late, String(early) + ' is not less than ' + String(late));
    assert.ok(early >= 1, 'a backoff is never zero');
    assert.ok(late <= 8_000, 'jitter stays inside the exponential interval');
  });

  it('never returns zero, even with a zero random draw', () => {
    assert.ok(providerBackoffMs({ attempt: 1, random: 0 }) >= 1);
  });

  it('retries what is worth retrying and gives up on the rest', () => {
    for (const reason of RETRYABLE_PROVIDER_REASONS) {
      assert.equal(providerFailureIsRetryable(reason), true, reason);
    }
    // A refused key or a rejected prompt will be refused again; retrying spends money to fail.
    assert.equal(providerFailureIsRetryable('Unauthorized'), false);
    assert.equal(providerFailureIsRetryable('ContentFiltered'), false);
    assert.equal(providerFailureIsRetryable('InvalidRequest'), false);
  });
});

describe('what is never limited, and what is', () => {
  it('exempts the probes and the way out', () => {
    for (const route of UNLIMITED_ROUTES) {
      assert.equal(routeIsUnlimited(route), true, route);
    }
    assert.equal(routeIsUnlimited('/health/ready'), true);
    assert.equal(routeIsUnlimited('/platform/observability/metrics'), true);
  });

  it('does not exempt sign-in', () => {
    // Login has its own throttle (the Prompt 5 lockout) and that throttle is the entire point.
    assert.equal(routeIsUnlimited('/auth/login'), false);
    assert.equal(UNLIMITED_ROUTES.includes('/auth/login'), false);
  });

  it('does not exempt a route that merely starts with the same letters', () => {
    assert.equal(routeIsUnlimited('/healthcheck-internal'), false);
    assert.equal(routeIsUnlimited('/auth/logoutall'), false);
  });

  it('limits ordinary business routes', () => {
    assert.equal(routeIsUnlimited('/tenants/t1/objectives'), false);
    assert.equal(routeIsUnlimited('/platform/companies'), false);
  });

  it('states the WAF assumption instead of implying protection it does not have', () => {
    assert.match(WAF_ASSUMPTIONS, /reverse proxy|WAF/i);
    assert.match(WAF_ASSUMPTIONS, /does not/i);
  });
});
