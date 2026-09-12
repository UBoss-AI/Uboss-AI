import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  type INestApplication,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { IsOptional, IsString } from 'class-validator';
import request from 'supertest';

import {
  consumeToken,
  DEFAULT_LIMITS,
  fairOrder,
  freshBucket,
  type BucketState,
  type PendingJob,
  type RateLimit,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { MetricsService } from '../src/observability/metrics.service.js';
import { IdempotencyInterceptor } from '../src/rate-limits/idempotency.interceptor.js';
import { IdempotencyService } from '../src/rate-limits/idempotency.service.js';
import { ProviderThrottleService } from '../src/rate-limits/provider-throttle.service.js';
import { RateLimitInterceptor } from '../src/rate-limits/rate-limit.interceptor.js';
import { LIMIT_SETTING_KEYS, RateLimitService } from '../src/rate-limits/rate-limit.service.js';
import {
  InProcessRateLimitStore,
  RateLimitStore,
  RedisRateLimitStore,
} from '../src/rate-limits/rate-limit.store.js';
import { RunFairnessService } from '../src/rate-limits/run-fairness.service.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
import { TenantScoped } from '../src/tenancy/tenancy.decorators.js';
import {
  activateMembership,
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

class ThingDto {
  @IsString() name!: string;
  @IsOptional() @IsString() fail?: string;
}

/**
 * A route to point the interceptors at.
 *
 * The interceptors are deliberately route-independent — they read the actor and the headers and
 * know nothing about what the handler does — so a synthetic route exercises exactly the same code
 * path a real one does, with none of the real one's unrelated preconditions. `calls` is what makes
 * "did the work happen twice?" answerable, which is the only question idempotency is about.
 */
@Controller('tenants/:tenantId/limit-probe')
@TenantScoped()
class LimitProbeController {
  static calls = 0;

  @Get()
  async read(): Promise<{ ok: true }> {
    LimitProbeController.calls += 1;
    return { ok: true };
  }

  @Post()
  async create(@Body() body: ThingDto): Promise<{ id: number; name: string }> {
    LimitProbeController.calls += 1;
    if (body.fail !== undefined) {
      throw new BadRequestException('Asked to fail.');
    }
    return { id: LimitProbeController.calls, name: body.name };
  }
}

/**
 * Rate limits, abuse protection and execution fairness — Prompt 40, against real PostgreSQL.
 *
 * The prompt asks for **load-oriented tests**, so the weight of this suite is on what happens
 * under volume rather than on one request at a time:
 *
 *  * a burst that exhausts a bucket and the refusal that follows it, with the headers a client
 *    needs to behave better next time;
 *  * one person's exhausted bucket **not** refusing their colleague, and one company's bucket not
 *    refusing another company;
 *  * fifty queued runs from one company **not** putting another company's single run behind them;
 *  * a retried POST doing the work once and returning the same answer, and a retry with different
 *    content being refused rather than answered;
 *  * a provider that says "slow down" being obeyed, and one that says "no" not being retried.
 */
describe('rate limits, abuse protection and fairness (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let aliceId: string;
  let aliceUboss: string;
  let bobUboss: string;
  let otherUboss: string;

  const agent = () => request(app.getHttpServer());

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(
        `The test database is not reachable: ${reachabilityFailureReason()}\n` +
          'Start it with:\n' +
          '  docker compose -f infra/docker-compose.yml up -d',
      );
    }
    migrateTestDatabase();

    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [LimitProbeController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        MetricsService,
        TenantContextService,
        Reflector,
        // The in-process store, deliberately: it is what a single-process deployment uses, and
        // the Redis store is checked separately against a real broker where one is running.
        //
        // `useExisting`, not `useClass`: registering the class twice gives two instances, and the
        // test would then read counters off a store nothing had used.
        InProcessRateLimitStore,
        { provide: RateLimitStore, useExisting: InProcessRateLimitStore },
        RateLimitService,
        RunFairnessService,
        ProviderThrottleService,
        IdempotencyService,
        {
          provide: ActorResolver,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new DevHeaderActorResolver(async (ubossUniqueId) =>
              prisma.runAsPlatformOperation(() =>
                prisma.client.user.findUnique({
                  where: { ubossUniqueId },
                  select: { id: true, ubossUniqueId: true, isPlatformActor: true },
                }),
              ),
            ),
        },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor },
        // The same order as `RateLimitsModule`: the limiter outside, so a throttled request never
        // claims an idempotency key it will not get to use.
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const middleware = new CorrelationIdMiddleware();
    app.use(middleware.use.bind(middleware));
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);
    LimitProbeController.calls = 0;
    await app.get(RateLimitStore).reset();
    app.get(RateLimitService).invalidate();
    app.get(ProviderThrottleService).reset();
    app.get(MetricsService).reset();

    const provisioned = await ctx.provisioning.provision({
      slug: 'limits-co',
      name: 'Limits Co',
      firstMember: { email: 'first@limits.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-limits-co',
      name: 'Other Limits Co',
      firstMember: { email: 'first@other-limits.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (email: string, name: string, tenant: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: tenant, userId: user.id, accountState: 'Active' },
        });
        return user;
      };
      return {
        alice: await make('alice@limits.example', 'Alice', provisioned.tenant.id),
        bob: await make('bob@limits.example', 'Bob', provisioned.tenant.id),
        outsider: await make('out@other-limits.example', 'Outsider', other.tenant.id),
      };
    });

    aliceId = people.alice.id;
    aliceUboss = people.alice.ubossUniqueId;
    bobUboss = people.bob.ubossUniqueId;
    otherUboss = people.outsider.ubossUniqueId;
  });

  // ---- helpers ----

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const probe = (uboss: string, workspace = tenantId) =>
    asPerson(agent().get(`/tenants/${workspace}/limit-probe`), uboss, workspace);

  /** Lower a limit for one test, the way an operator would: a platform setting. */
  const setLimit = async (scope: 'User' | 'Tenant' | 'Runs', value: number): Promise<void> => {
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.platformSetting.upsert({
        where: { key: LIMIT_SETTING_KEYS[scope] },
        update: { value },
        create: {
          key: LIMIT_SETTING_KEYS[scope],
          value,
          section: 'Limits & fairness',
          description: 'Set by a test.',
        },
      }),
    );
    app.get(RateLimitService).invalidate();
  };

  const limits = () => app.get(RateLimitService);
  const fairness = () => app.get(RunFairnessService);
  const throttle = () => app.get(ProviderThrottleService);
  const idempotency = () => app.get(IdempotencyService);
  const metrics = () => app.get(MetricsService);

  /**
   * A run in a given state, planted directly, so a queue of fifty costs no engine time.
   *
   * A real agent and a real published version, because `agent_runs` requires both — and a run
   * that referenced nothing would be a row the fairness query could see but the product never
   * could.
   */
  const seedRun = async (tenant: string, state: string, createdAt: Date): Promise<string> =>
    ctx.prisma.runAsPlatformOperation(async () => {
      const suffix = Math.random().toString(36).slice(2, 10);

      const agentRow = await ctx.prisma.client.engineAgent.create({
        data: {
          tenantId: tenant,
          name: `Agent ${suffix}`,
          status: 'DraftSetup',
          ownerUserId: aliceId,
        },
      });

      const versionRow = await ctx.prisma.client.engineAgentVersion.create({
        data: {
          tenantId: tenant,
          engineAgentId: agentRow.id,
          versionNumber: 1,
          status: 'Published',
          config: { skillVersionIds: [] },
          publishedAt: createdAt,
          publishedByUserId: aliceId,
          createdByUserId: aliceId,
        },
      });

      const run = await ctx.prisma.client.agentRun.create({
        data: {
          tenantId: tenant,
          engineAgentId: agentRow.id,
          engineAgentVersionId: versionRow.id,
          state,
          trigger: 'Manual',
          attempt: 1,
          idempotencyKey: `fixture-${suffix}`,
          correlationId: `corr-${suffix}`,
          createdAt,
          // `Reserved` and `Running` are what "in flight" means, and both carry a constraint
          // requiring the timestamp that justifies the state.
          ...(state === 'Reserved' || state === 'Running' ? { reservedAt: createdAt } : {}),
          ...(state === 'Running' ? { startedAt: createdAt } : {}),
        },
      });
      return run.id;
    });

  // =========================================================================
  describe('the per-person API limit', () => {
    it('allows the burst and then refuses, with everything a client needs to behave', async () => {
      await setLimit('User', 10); // burst becomes 2 — a fifth, rounded up
      const inForce = await limits().limits();
      const burst = inForce.User.burst;

      for (let index = 0; index < burst; index += 1) {
        const ok = await probe(aliceUboss).expect(200);
        assert.equal(ok.headers['ratelimit-limit'], '10');
        // Visible before the refusal, which is what lets a client slow down rather than be
        // punished. A limit a caller cannot see is a limit it cannot cooperate with.
        assert.ok(Number(ok.headers['ratelimit-remaining']) >= 0);
      }

      const refused = await probe(aliceUboss).expect(429);
      const body = refused.body as {
        message: string;
        scope: string;
        limit: number;
        retryAfterSeconds: number;
      };

      assert.equal(body.scope, 'User');
      assert.equal(body.limit, 10);
      assert.ok(body.retryAfterSeconds >= 1, 'never tell a client to retry immediately');
      assert.equal(refused.headers['retry-after'], String(body.retryAfterSeconds));
      // Business-readable, as the prompt asks: it says whose limit it is and what to do.
      assert.match(body.message, /per person/i);
      assert.match(body.message, /wait/i);
    });

    it('does not refuse a colleague because of one person’s runaway script', async () => {
      await setLimit('User', 10);
      const burst = (await limits().limits()).User.burst;

      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);
      await probe(aliceUboss).expect(429);

      // The whole reason the per-person layer exists. If Alice's loop refused Bob, the limit would
      // be punishing the wrong person and the company would look broken.
      await probe(bobUboss).expect(200);
    });

    it('counts the refusal as a metric, so volume is visible without reading the trail', async () => {
      await setLimit('User', 10);
      const burst = (await limits().limits()).User.burst;
      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);

      await probe(aliceUboss).expect(429);
      await probe(aliceUboss).expect(429);
      await probe(aliceUboss).expect(429);

      assert.equal(metrics().valueOf('rate_limit_refusals', { scope: 'User' }), 3);
    });

    it('records the refusal in the security trail once, not once per refusal', async () => {
      await setLimit('User', 10);
      const burst = (await limits().limits()).User.burst;
      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);

      for (let index = 0; index < 5; index += 1) await probe(aliceUboss).expect(429);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findMany({
          where: { action: 'security.api_rate_limit_tripped' },
        }),
      );

      // Five refusals, one row. A row each would bury the rest of the security trail under the
      // noisiest client in the product — the trail would get less useful the more it was needed.
      assert.equal(events.length, 1);
      assert.equal(events[0]?.actorUserId, aliceId);
      assert.equal(events[0]?.tenantId, tenantId);
      assert.equal(events[0]?.outcome, 'Blocked');
    });
  });

  // =========================================================================
  describe('the per-company API limit', () => {
    it('refuses a second person once the company’s allowance is spent', async () => {
      // High per-person, low per-company: the only way to prove the company layer is reached at
      // all, and that it is checked *after* the person's own.
      await setLimit('User', 100_000);
      await setLimit('Tenant', 10);
      const burst = (await limits().limits()).Tenant.burst;

      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);

      const refused = await probe(bobUboss).expect(429);
      const body = refused.body as { scope: string; message: string };
      assert.equal(body.scope, 'Tenant');
      // Names the company rather than the person, and points at the usual cause.
      assert.match(body.message, /company/i);
      assert.match(body.message, /integration/i);
    });

    it('does not refuse another company because this one is busy', async () => {
      await setLimit('User', 100_000);
      await setLimit('Tenant', 10);
      const burst = (await limits().limits()).Tenant.burst;

      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);
      await probe(bobUboss).expect(429);

      // Tenant isolation applies to capacity too: a noisy neighbour must not be able to refuse
      // requests for anybody else.
      await probe(otherUboss, otherTenantId).expect(200);
    });

    it('refuses the person’s own limit first, so the refusal names the real cause', async () => {
      await setLimit('User', 10);
      await setLimit('Tenant', 100_000);
      const burst = (await limits().limits()).User.burst;
      for (let index = 0; index < burst; index += 1) await probe(aliceUboss).expect(200);

      const refused = await probe(aliceUboss).expect(429);
      assert.equal((refused.body as { scope: string }).scope, 'User');
    });
  });

  // =========================================================================
  describe('what the limiter will not do', () => {
    it('falls back to the code default rather than applying a nonsense limit', async () => {
      // A typed zero in a platform setting would refuse every request from every customer — a
      // total outage produced by one keystroke. The validator is the same one the unit tests use.
      await setLimit('User', 0);
      const inForce = await limits().limits();
      assert.equal(inForce.User.limit, DEFAULT_LIMITS.User.limit);
      await probe(aliceUboss).expect(200);
    });

    it('reports whether the limit it is applying is the limit it says', () => {
      const described = limits().describe();
      assert.equal(described.store, 'in-process');
      // The caveat that matters: per-process counting multiplies the effective limit by the
      // instance count, and a status endpoint claiming otherwise would be reporting a figure that
      // is not in force.
      assert.equal(described.sharedAcrossProcesses, false);
    });

    it('does not leak a bucket per person who ever signed in', async () => {
      const store = app.get(InProcessRateLimitStore);
      await store.reset();
      await probe(aliceUboss).expect(200);
      await probe(bobUboss).expect(200);
      // Two people, two buckets, plus the company's. Asserted so the Map cannot quietly become
      // unbounded state nobody is watching.
      assert.equal(store.size(), 3);
    });
  });

  // =========================================================================
  describe('idempotency for a retried mutating request', () => {
    const post = (uboss: string, key: string | null, body: unknown) => {
      const test = asPerson(agent().post(`/tenants/${tenantId}/limit-probe`), uboss);
      if (key !== null) test.set('Idempotency-Key', key);
      return test.send(body as object);
    };

    it('does the work once and returns the same answer to the retry', async () => {
      const first = await post(aliceUboss, 'key-1', { name: 'Thing' }).expect(201);
      const second = await post(aliceUboss, 'key-1', { name: 'Thing' }).expect(201);

      // The point is not "the second was refused" — it is that the client got the *same answer*,
      // so it can carry on with the id it never received the first time.
      assert.deepEqual(second.body, first.body);
      assert.equal(LimitProbeController.calls, 1, 'the handler must run once');
      assert.equal(second.headers['idempotent-replay'], 'true');
      assert.equal(first.headers['idempotent-replay'], undefined);
    });

    it('does the work twice without a key, because nothing said they were the same request', async () => {
      await post(aliceUboss, null, { name: 'A' }).expect(201);
      await post(aliceUboss, null, { name: 'A' }).expect(201);
      // Only the caller knows whether two identical requests are one intention or two, which is
      // why the header is opt-in rather than inferred.
      assert.equal(LimitProbeController.calls, 2);
    });

    it('refuses a reused key with different content rather than answering it', async () => {
      await post(aliceUboss, 'key-2', { name: 'First' }).expect(201);
      const conflict = await post(aliceUboss, 'key-2', { name: 'Second' }).expect(409);

      assert.match(
        (conflict.body as { message: string }).message,
        /already used for a different request/i,
      );
      // Neither applied: answering with the first response would have silently discarded the
      // second request, which is the failure idempotency exists to prevent rather than cause.
      assert.equal(LimitProbeController.calls, 1);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findMany({
          where: { action: 'security.idempotency_key_reused' },
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.outcome, 'Blocked');
    });

    it('scopes a key to the person who issued it', async () => {
      await post(aliceUboss, 'shared', { name: 'Alice' }).expect(201);
      const bob = await post(bobUboss, 'shared', { name: 'Bob' }).expect(201);

      // If the key space were global, Bob would have been handed Alice's stored response — which
      // would make idempotency a cross-actor read primitive rather than a safety net.
      assert.equal((bob.body as { name: string }).name, 'Bob');
      assert.equal(LimitProbeController.calls, 2);
    });

    it('releases the claim when the work failed, so a retry can succeed', async () => {
      await post(aliceUboss, 'key-3', { name: 'X', fail: 'yes' }).expect(400);
      // A remembered failure would replay for twenty-four hours and the client could never
      // succeed — the feature meant to help it would be the reason it could not.
      const retried = await post(aliceUboss, 'key-3', { name: 'X', fail: 'yes' }).expect(400);
      assert.equal((retried.body as { message: string }).message, 'Asked to fail.');
      assert.equal(LimitProbeController.calls, 2);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.idempotencyRecord.findMany({ where: { key: 'key-3' } }),
      );
      assert.equal(rows.length, 0);
    });

    it('refuses a key too long to be stored, rather than truncating it silently', async () => {
      // A truncated key would be written short and never match on read, so every retry would do
      // the work again — silently, which is the worst version of this bug.
      await post(aliceUboss, 'k'.repeat(201), { name: 'X' }).expect(409);
      assert.equal(LimitProbeController.calls, 0);
    });

    it('keeps one company’s records out of another company’s reach', async () => {
      await post(aliceUboss, 'private-key', { name: 'Secret' }).expect(201);

      const visibleToOther = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(otherTenantId),
        () => ctx.prisma.client.idempotencyRecord.findMany({}),
      );
      // The stored response body is the company's own content. Row-level security, not a WHERE
      // clause somebody has to remember.
      assert.deepEqual(visibleToOther, []);
    });

    it('forgets a record once its window has passed', async () => {
      await post(aliceUboss, 'key-4', { name: 'X' }).expect(201);

      // Both columns, not just the expiry: the constraint refuses a record that expired before
      // it was created, and rightly — that row would be swept the moment it was written, which
      // looks exactly like a client whose retries never work. A record made yesterday is what
      // actually happens, so that is what is simulated.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.idempotencyRecord.updateMany({
          where: { key: 'key-4' },
          data: {
            createdAt: new Date(Date.now() - 48 * 3_600_000),
            expiresAt: new Date(Date.now() - 24 * 3_600_000),
          },
        }),
      );

      // Not a replay: an expired key is a new request, which is honest. Pretending to remember
      // forever would make the table grow without bound for no benefit anybody can name.
      const after = await post(aliceUboss, 'key-4', { name: 'X' }).expect(201);
      assert.equal(after.headers['idempotent-replay'], undefined);
      assert.equal(LimitProbeController.calls, 2);
    });

    it('sweeps what it has forgotten', async () => {
      await post(aliceUboss, 'key-5', { name: 'X' }).expect(201);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.idempotencyRecord.updateMany({
          where: { key: 'key-5' },
          data: {
            createdAt: new Date(Date.now() - 48 * 3_600_000),
            expiresAt: new Date(Date.now() - 24 * 3_600_000),
          },
        }),
      );

      const swept = await idempotency().sweep();
      assert.equal(swept.deleted, 1);

      const remaining = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.idempotencyRecord.count(),
      );
      assert.equal(remaining, 0);
    });

    it('is not applied to a throttled request, so the key survives to be retried', async () => {
      await setLimit('User', 10);
      const burst = (await limits().limits()).User.burst;
      for (let index = 0; index < burst; index += 1) {
        await post(aliceUboss, `warm-${index}`, { name: 'X' }).expect(201);
      }

      await post(aliceUboss, 'throttled-key', { name: 'X' }).expect(429);

      // The claim must not exist: the client will retry with this key, and finding it claimed by a
      // request that was never served would report InFlight forever.
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.idempotencyRecord.findMany({ where: { key: 'throttled-key' } }),
      );
      assert.equal(rows.length, 0);
    });
  });

  // =========================================================================
  describe('queue fairness under load', () => {
    it('does not let fifty runs from one company put another company behind them', async () => {
      const base = Date.now();

      // The scenario that motivates the whole feature: one company floods the queue a moment
      // before another asks for one thing.
      for (let index = 0; index < 50; index += 1) {
        await seedRun(tenantId, 'Queued', new Date(base + index));
      }
      const quiet = await seedRun(otherTenantId, 'Queued', new Date(base + 10_000));

      const plan = await fairness().admissionPlan();

      const position = plan.dispatch.findIndex((job) => job.id === quiet);
      assert.notEqual(position, -1, 'the quiet company must be dispatchable');
      // Second, not fifty-first. Under FIFO it would have been behind all fifty.
      assert.equal(position, 1);
    });

    it('alternates between companies rather than draining one', async () => {
      const base = Date.now();
      for (let index = 0; index < 3; index += 1) {
        await seedRun(tenantId, 'Queued', new Date(base + index));
        await seedRun(otherTenantId, 'Queued', new Date(base + 100 + index));
      }

      const plan = await fairness().admissionPlan();
      const owners = plan.dispatch.map((job) => (job.tenantId === tenantId ? 'A' : 'B'));

      // A tenant's wait depends on how many *companies* are busy, not on the size of the busiest
      // one's backlog. That property is what this sequence encodes.
      assert.deepEqual(owners, ['A', 'B', 'A', 'B', 'A', 'B']);
    });

    it('stops a company once its runs in flight reach the ceiling', async () => {
      await setLimit('Runs', 3);
      const base = Date.now();
      for (let index = 0; index < 3; index += 1) {
        await seedRun(tenantId, 'Running', new Date(base + index));
      }

      const decision = await fairness().mayStart(tenantId);
      assert.equal(decision.admit, false);
      if (decision.admit) return;
      assert.equal(decision.inFlight, 3);
      assert.equal(decision.limit, 3);
      // Business-readable, as the prompt asks. It says what happened, that nothing was lost, and
      // that nobody else is to blame.
      assert.match(decision.reason, /queued and will start/i);
      assert.match(decision.reason, /nothing has been lost/i);

      assert.equal(metrics().valueOf('run_admission_deferrals', { reason: 'concurrency' }), 1);
    });

    it('lets a company start again as its runs finish', async () => {
      await setLimit('Runs', 2);
      const first = await seedRun(tenantId, 'Running', new Date());
      await seedRun(tenantId, 'Running', new Date());

      assert.equal((await fairness().mayStart(tenantId)).admit, false);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.update({
          where: { id: first },
          data: {
            state: 'Completed',
            finishedAt: new Date(),
            percent: 100,
            // Required by `completed_run_says_whether_the_model_was_real`: a finished run must
            // say whether a live provider or the mock produced its output, so no report can
            // present one as the other.
            producedByRealModel: false,
          },
        }),
      );

      // The count is a query over the rows, not a counter, so it recovers whatever happened to
      // the run — including a worker killed mid-flight, which no decrement would have caught.
      assert.equal((await fairness().mayStart(tenantId)).admit, true);
    });

    it('does not count another company’s runs against this one', async () => {
      await setLimit('Runs', 2);
      for (let index = 0; index < 5; index += 1) {
        await seedRun(otherTenantId, 'Running', new Date());
      }
      assert.equal((await fairness().mayStart(tenantId)).admit, true);
    });

    it('holds a deferred run back and says why on the row', async () => {
      await setLimit('Runs', 1);
      await seedRun(tenantId, 'Running', new Date());
      const waiting = await seedRun(tenantId, 'Queued', new Date());

      const decision = await fairness().mayStart(tenantId);
      assert.equal(decision.admit, false);
      if (decision.admit) return;
      await fairness().recordDeferral(waiting, tenantId, decision.reason);

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.findUnique({ where: { id: waiting } }),
      );
      // Still queued — nothing failed — with an explanation somebody looking at the run can read.
      assert.equal(row?.state, 'Queued');
      assert.match(row?.progressMessage ?? '', /queued and will start/i);
    });

    it('reports who is waiting, so “why is my run not starting” is answerable', async () => {
      await setLimit('Runs', 1);
      await seedRun(tenantId, 'Running', new Date());
      await seedRun(tenantId, 'Queued', new Date());
      await seedRun(otherTenantId, 'Queued', new Date());

      const snapshot = await fairness().snapshot();
      assert.equal(snapshot.concurrencyLimit, 1);
      assert.equal(snapshot.queued, 2);
      assert.equal(snapshot.companiesWaiting, 2);
      // One company is at its ceiling and the other is not, so exactly one of the two can start.
      assert.equal(snapshot.dispatchable, 1);
      assert.equal(snapshot.deferred, 1);
    });
  });

  // =========================================================================
  describe('provider quota and backoff', () => {
    const modelId = 'model-under-test';

    it('holds off after the provider says it is rate-limiting us', async () => {
      const failure = throttle().recordFailure({ providerModelId: modelId, reason: 'RateLimited' });
      assert.ok(failure.cooldownMs > 0);

      const gate = await throttle().mayCall({ providerModelId: modelId });
      assert.equal(gate.proceed, false);
      if (gate.proceed) return;
      assert.match(gate.reason, /rate-limiting us/i);
      // The run stays queued rather than failing — a provider being busy is not the customer's
      // work going wrong.
      assert.match(gate.reason, /stays queued/i);
    });

    it('obeys the provider’s own Retry-After rather than guessing', () => {
      const failure = throttle().recordFailure({
        providerModelId: modelId,
        reason: 'RateLimited',
        retryAfterSeconds: 30,
      });
      assert.equal(failure.cooldownMs, 30_000);
    });

    it('backs off further each time, so a persistent problem is not hammered', () => {
      const first = throttle().recordFailure({ providerModelId: modelId, reason: 'Timeout' });
      const second = throttle().recordFailure({ providerModelId: modelId, reason: 'Timeout' });
      const third = throttle().recordFailure({ providerModelId: modelId, reason: 'Timeout' });

      // Jittered, so exact values are not asserted — the *ceilings* are, which is the property
      // that matters: the interval grows.
      assert.ok(first.cooldownMs <= 500);
      assert.ok(second.cooldownMs <= 1_000);
      assert.ok(third.cooldownMs <= 2_000);
    });

    it('does not back off from a failure that will happen again identically', async () => {
      // A rejected prompt or a refused credential will be refused next time too, so waiting spends
      // a customer's time to reach the same answer.
      const failure = throttle().recordFailure({
        providerModelId: modelId,
        reason: 'Unauthorized',
      });
      assert.equal(failure.cooldownMs, 0);
      assert.equal((await throttle().mayCall({ providerModelId: modelId })).proceed, true);
    });

    it('clears the cooldown completely when the provider answers', async () => {
      throttle().recordFailure({ providerModelId: modelId, reason: 'RateLimited' });
      throttle().recordSuccess(modelId);
      // Fully, not gradually: a model that just worked is working, and a decaying counter would
      // keep throttling a provider whose problem is over.
      assert.equal((await throttle().mayCall({ providerModelId: modelId })).proceed, true);
      assert.deepEqual(throttle().snapshot(), []);
    });

    it('respects a declared quota before the provider has to refuse anything', async () => {
      // Ten a minute means a burst of two. Respecting a stated limit is cheaper than discovering
      // it, because discovering it costs a refused call each time.
      const gates: boolean[] = [];
      for (let index = 0; index < 4; index += 1) {
        const gate = await throttle().mayCall({
          providerModelId: 'quota-model',
          quotaRequestsPerMinute: 10,
        });
        gates.push(gate.proceed);
      }
      assert.deepEqual(gates, [true, true, false, false]);
      assert.ok(metrics().valueOf('rate_limit_refusals', { scope: 'Provider' }) >= 1);
    });

    it('does not throttle a model whose provider never declared a limit', async () => {
      for (let index = 0; index < 20; index += 1) {
        const gate = await throttle().mayCall({
          providerModelId: 'undeclared-model',
          quotaRequestsPerMinute: null,
        });
        assert.equal(gate.proceed, true);
      }
    });

    it('never names a provider in what it reports', () => {
      throttle().recordFailure({ providerModelId: modelId, reason: 'RateLimited' });
      const serialised = JSON.stringify(throttle().snapshot());
      // The locked rule: provider names do not leave the Model Gateway, and a status endpoint is
      // exactly where one would leak into a dashboard.
      for (const name of ['anthropic', 'openai', 'claude', 'gpt']) {
        assert.equal(serialised.toLowerCase().includes(name), false, name);
      }
    });
  });

  // =========================================================================
  describe('the two stores agree', () => {
    /**
     * The contract test that makes the Lua script trustworthy.
     *
     * The arithmetic exists twice — once in `consumeToken` and once in Redis — and two
     * implementations that each did their own reasoning would eventually disagree, with the one
     * that only runs in production being the wrong one. Skipped rather than failed where no broker
     * is running, and reported as skipped rather than passing silently.
     */
    it('gives the same decisions from Redis as from memory, where a broker is running', async () => {
      const url = process.env['REDIS_URL'];
      if (url === undefined || url === '') {
        console.warn('    (skipped: REDIS_URL is not set, so the shared store cannot be checked)');
        return;
      }

      let redis: RedisRateLimitStore;
      try {
        redis = new RedisRateLimitStore(url);
        await redis.reset();
      } catch {
        console.warn('    (skipped: the broker could not be reached)');
        return;
      }

      const memory = new InProcessRateLimitStore();
      const limit: RateLimit = { scope: 'User', limit: 60, windowSeconds: 60, burst: 5 };
      const now = Date.now();
      const key = `contract-${now}`;

      const fromRedis: boolean[] = [];
      const fromMemory: boolean[] = [];
      for (let index = 0; index < 8; index += 1) {
        fromRedis.push((await redis.consume(key, limit, now)).allowed);
        fromMemory.push((await memory.consume(key, limit, now)).allowed);
      }

      assert.deepEqual(fromRedis, fromMemory);
      assert.deepEqual(fromRedis, [true, true, true, true, true, false, false, false]);

      // And the refusal says the same thing.
      const refusedByRedis = await redis.consume(key, limit, now);
      const refusedByMemory = await memory.consume(key, limit, now);
      assert.equal(refusedByRedis.allowed, false);
      assert.equal(refusedByMemory.allowed, false);
      if (!refusedByRedis.allowed && !refusedByMemory.allowed) {
        assert.equal(refusedByRedis.retryAfterSeconds, refusedByMemory.retryAfterSeconds);
      }

      assert.equal(redis.isSharedAcrossProcesses, true);
      assert.equal(redis.failures(), 0, 'the store must not have fallen back to allowing');

      await redis.reset();
      await redis.onModuleDestroy();
    });

    it('allows the request when the store cannot be reached, and says it did', async () => {
      // Fail **open**, unlike every authorization check in the product. A failing limiter that
      // allows a request removes a protection against load; failing closed would take the whole
      // API down for every customer over a Redis blip — converting a capacity protection into the
      // outage it exists to prevent.
      const broken = new RedisRateLimitStore('redis://127.0.0.1:1/');
      const decision = await broken.consume('anything', DEFAULT_LIMITS.User, Date.now());
      assert.equal(decision.allowed, true);
      assert.equal(broken.failures(), 1);
      await broken.onModuleDestroy();
    });
  });

  // =========================================================================
  describe('the pure decisions the layers are built on', () => {
    it('refills continuously, so a boundary does not let twice the limit through', () => {
      // The classic fixed-window bug: 100 at 11:59:59 and 100 at 12:00:00 is 200 in one second
      // under a "100 per minute" limit. Asserted here as well as in the unit suite because it is
      // the reason the store is a token bucket at all.
      const limit: RateLimit = { scope: 'User', limit: 60, windowSeconds: 60, burst: 3 };
      let state: BucketState = freshBucket(limit, 0);
      for (let index = 0; index < 3; index += 1) {
        state = consumeToken({ state, limit, now: 0 }).state;
      }
      assert.equal(consumeToken({ state, limit, now: 0 }).decision.allowed, false);
      assert.equal(consumeToken({ state, limit, now: 1_000 }).decision.allowed, true);
    });

    it('orders a thousand jobs across ten companies without starving any of them', () => {
      const pending: PendingJob[] = [];
      for (let index = 0; index < 1_000; index += 1) {
        pending.push({ id: `noisy-${index}`, tenantId: 'noisy', queuedAt: index });
      }
      for (let index = 0; index < 9; index += 1) {
        pending.push({ id: `quiet-${index}`, tenantId: `quiet-${index}`, queuedAt: 5_000 });
      }

      const ordered = fairOrder(pending);

      // Every quiet company is served in the first pass — ten jobs — rather than after a thousand.
      const worst = Math.max(
        ...Array.from({ length: 9 }, (_, index) =>
          ordered.findIndex((job) => job.id === `quiet-${index}`),
        ),
      );
      assert.ok(worst < 10, `the worst-placed quiet company was at ${worst}`);
      assert.equal(ordered.length, pending.length);
    });
  });
});
