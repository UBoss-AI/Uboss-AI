import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { PrismaService } from '../src/persistence/prisma.service.js';
import {
  ActorResolver,
  DevHeaderActorResolver,
  DEV_ACTOR_HEADER,
} from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { getActor, getCorrelationId } from '../src/request-context/request-context.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
import { AllowAnonymous, PlatformOnly, TenantScoped } from '../src/tenancy/tenancy.decorators.js';
import {
  activateMembership,
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  setTenantLifecycle,
  type TestContext,
} from './support/test-database.js';

/**
 * Request-level tenancy tests.
 *
 * Prompt 3 proved isolation at the repository layer. These prove it at the **request** layer:
 * a signed-in person from Tenant A cannot fetch or update Tenant B's resources by asking for
 * Tenant B's workspace, even with a real, valid tenant id.
 *
 * The controllers below are declared inside the test on purpose. The application must not ship
 * a tenant-scoped feature endpoint yet — Prompt 4 builds the guard, not features — so the
 * verification surface lives here rather than becoming a real route.
 */

/** Echoes the resolved context, so a test can see exactly what the guard produced. */
@Controller('probe')
class ProbeController {
  constructor(private readonly tenantContext: TenantContextService) {}

  @Get('public')
  @AllowAnonymous()
  publicRoute() {
    return { ok: true, correlationId: getCorrelationId() };
  }

  @Get('workspace')
  @TenantScoped()
  workspaceRoute() {
    const actor = getActor();
    return { actor, scope: this.tenantContext.optionalScope() };
  }

  @Post('workspace')
  @TenantScoped()
  workspaceWrite() {
    return { written: true, actor: getActor() };
  }

  /** Reads through the scope, so the response proves what the tenant can actually see. */
  @Get('workspace/memberships')
  @TenantScoped()
  async workspaceMemberships() {
    const scope = this.tenantContext.requireScope();
    const rows = await this.tenantContext.runInScope(async () =>
      this.prismaFromContext().client.tenantMembership.findMany({ select: { id: true } }),
    );
    return { tenantId: scope.tenantId, membershipIds: rows.map((row) => row.id) };
  }

  @Get('master')
  @PlatformOnly()
  masterRoute() {
    return { actor: getActor() };
  }

  /** Deliberately undecorated, to prove the guard denies by default. */
  @Get('undecorated')
  undecorated() {
    return { reached: true };
  }

  private prismaFromContext(): PrismaService {
    return (this.tenantContext as unknown as { prisma: PrismaService }).prisma;
  }
}

describe('tenancy at the request layer (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantA: { id: string; membershipId: string };
  let tenantB: { id: string; membershipId: string };
  let personA: string;
  let personB: string;
  let platformAdmin: string;

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

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        TenantContextService,
        Reflector,
        {
          // The development resolver stands in for Prompt 5's session-backed one. It still
          // verifies the person exists; what it skips is proof of possession.
          provide: ActorResolver,
          useFactory: (prisma: PrismaService) =>
            new DevHeaderActorResolver(async (ubossUniqueId) =>
              prisma.runAsPlatformOperation(() =>
                prisma.client.user.findUnique({
                  where: { ubossUniqueId },
                  select: { id: true, ubossUniqueId: true, isPlatformActor: true },
                }),
              ),
            ),
          inject: [PrismaService],
        },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(new CorrelationIdMiddleware().use.bind(new CorrelationIdMiddleware()));
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);

    const a = await ctx.provisioning.provision({
      slug: 'guard-a',
      name: 'Guard A Devices',
      firstMember: { email: 'a@guard.example', displayName: 'Person A' },
    });
    const b = await ctx.provisioning.provision({
      slug: 'guard-b',
      name: 'Guard B Diagnostics',
      firstMember: { email: 'b@guard.example', displayName: 'Person B' },
    });
    await activateTenant(ctx, a.tenant.id);
    await activateTenant(ctx, b.tenant.id);
    // Provisioning leaves the first member NotInvited; only activation grants access.
    await activateMembership(ctx, a.user.id, a.tenant.id);
    await activateMembership(ctx, b.user.id, b.tenant.id);

    tenantA = { id: a.tenant.id, membershipId: a.membership.id };
    tenantB = { id: b.tenant.id, membershipId: b.membership.id };
    personA = a.user.ubossUniqueId;
    personB = b.user.ubossUniqueId;

    const admin = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-PLAT-0001',
        email: 'platform@guard.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformAdmin = admin.ubossUniqueId;
  });

  describe('deny by default', () => {
    it('refuses a route with no tenancy decorator', async () => {
      await request(app.getHttpServer())
        .get('/probe/undecorated')
        .set(DEV_ACTOR_HEADER, personA)
        .expect(403);
    });

    it('allows an explicitly public route without authentication', async () => {
      const response = await request(app.getHttpServer()).get('/probe/public').expect(200);
      assert.equal(response.body.ok, true);
    });

    it('rejects an unauthenticated request to a tenant-scoped route with 401', async () => {
      await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(401);
    });
  });

  describe('cross-tenant denial', () => {
    it('lets a person open their own workspace', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(200);

      assert.equal(response.body.actor.kind, 'tenant');
      assert.equal(response.body.actor.tenantId, tenantA.id);
      assert.equal(response.body.scope.tenantId, tenantA.id);
    });

    it("refuses when Person A asks for Tenant B's workspace with a real tenant id", async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantB.id)
        .expect(403);

      assert.match(response.body.message, /do not have access to the selected workspace/i);
    });

    it("refuses Person A's WRITE to Tenant B", async () => {
      await request(app.getHttpServer())
        .post('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantB.id)
        .expect(403);
    });

    it('gives the same answer for a non-existent workspace as for one that is not yours', async () => {
      const notYours = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantB.id)
        .expect(403);

      const doesNotExist = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, '00000000-0000-7000-8000-0000000000ff')
        .expect(403);

      // A caller must not be able to distinguish "no such company" from "not your company",
      // or the endpoint becomes a tenant-existence oracle.
      assert.equal(notYours.body.message, doesNotExist.body.message);
    });

    it('only ever returns rows from the caller’s own workspace', async () => {
      const responseA = await request(app.getHttpServer())
        .get('/probe/workspace/memberships')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(200);

      assert.deepEqual(responseA.body.membershipIds, [tenantA.membershipId]);
      assert.ok(!responseA.body.membershipIds.includes(tenantB.membershipId));
    });

    it('rejects a malformed workspace id before it reaches the database', async () => {
      await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, "' OR 1=1 --")
        .expect(403);
    });

    it('requires a workspace to be selected at all', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .expect(403);

      assert.match(response.body.message, /No workspace was selected/i);
    });

    it('lets Person B into their own workspace, proving the fixture is symmetric', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personB)
        .set(WORKSPACE_HEADER, tenantB.id)
        .expect(200);

      assert.equal(response.body.actor.tenantId, tenantB.id);
    });
  });

  describe('platform plane', () => {
    it('admits a platform actor to a platform-only route', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/master')
        .set(DEV_ACTOR_HEADER, platformAdmin)
        .expect(200);

      assert.equal(response.body.actor.kind, 'platform');
    });

    it('refuses a company person on a platform-only route', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/master')
        .set(DEV_ACTOR_HEADER, personA)
        .expect(403);

      assert.match(response.body.message, /Master Console/i);
    });

    it('refuses a platform actor inside a company workspace without a membership', async () => {
      // A platform account is not implicitly a member of every company; support access must be
      // explicit and audited, which does not exist yet.
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, platformAdmin)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(403);

      assert.match(response.body.message, /cannot act inside a company workspace/i);
    });

    it('treats an unknown actor header as anonymous rather than an error', async () => {
      // Returning 401 rather than 404 means the header cannot be used to enumerate which
      // UBoss Unique IDs exist.
      await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, 'UB-NOPE-9999')
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(401);
    });
  });

  describe('tenant lifecycle states', () => {
    const cases: {
      state: 'Provisioning' | 'PendingActivation' | 'Suspended' | 'Closed';
      expect: RegExp;
    }[] = [
      { state: 'Provisioning', expect: /still being provisioned/i },
      { state: 'PendingActivation', expect: /not yet activated/i },
      { state: 'Suspended', expect: /suspended/i },
      { state: 'Closed', expect: /closed/i },
    ];

    for (const testCase of cases) {
      it(`blocks access when the company is ${testCase.state}, with a specific reason`, async () => {
        await setTenantLifecycle(ctx, tenantA.id, testCase.state);

        const response = await request(app.getHttpServer())
          .get('/probe/workspace')
          .set(DEV_ACTOR_HEADER, personA)
          .set(WORKSPACE_HEADER, tenantA.id)
          .expect(403);

        assert.match(response.body.message, testCase.expect);
      });
    }

    it('allows reads but blocks writes when the company is ReadOnly', async () => {
      await setTenantLifecycle(ctx, tenantA.id, 'ReadOnly');

      await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(200);

      const write = await request(app.getHttpServer())
        .post('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(403);

      assert.match(write.body.message, /read-only/i);
    });

    it('allows both when the company is Active', async () => {
      await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(200);
      // 201 is Nest's default for POST; the point of this assertion is that the write is
      // permitted at all, in contrast to the ReadOnly case above.
      await request(app.getHttpServer())
        .post('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantA.id)
        .expect(201);
    });
  });

  describe('correlation ids', () => {
    it('generates one and echoes it back', async () => {
      const response = await request(app.getHttpServer()).get('/probe/public').expect(200);

      const header = response.headers['x-correlation-id'];
      assert.ok(header, 'the response must carry a correlation id');
      assert.equal(response.body.correlationId, header);
    });

    it('honours a caller-supplied correlation id', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/public')
        .set('x-correlation-id', 'trace-abc-123')
        .expect(200);

      assert.equal(response.headers['x-correlation-id'], 'trace-abc-123');
      assert.equal(response.body.correlationId, 'trace-abc-123');
    });

    it('rejects an unsafe correlation id and substitutes a generated one', async () => {
      // A value with newlines could forge log lines, so it must not be echoed verbatim.
      const response = await request(app.getHttpServer())
        .get('/probe/public')
        .set('x-correlation-id', 'bad value with spaces')
        .expect(200);

      assert.notEqual(response.headers['x-correlation-id'], 'bad value with spaces');
      assert.ok(response.headers['x-correlation-id']);
    });

    it('assigns a correlation id even to a denied request', async () => {
      const response = await request(app.getHttpServer())
        .get('/probe/workspace')
        .set(DEV_ACTOR_HEADER, personA)
        .set(WORKSPACE_HEADER, tenantB.id)
        .expect(403);

      assert.ok(
        response.headers['x-correlation-id'],
        'a refused request is exactly the one worth correlating with its logs',
      );
    });

    it('gives concurrent requests distinct correlation ids', async () => {
      const [first, second] = await Promise.all([
        request(app.getHttpServer()).get('/probe/public'),
        request(app.getHttpServer()).get('/probe/public'),
      ]);

      assert.notEqual(first.body.correlationId, second.body.correlationId);
    });
  });

  it('does not leak the actor between requests', async () => {
    // AsyncLocalStorage must not let one request's verified actor bleed into the next.
    await request(app.getHttpServer())
      .get('/probe/workspace')
      .set(DEV_ACTOR_HEADER, personA)
      .set(WORKSPACE_HEADER, tenantA.id)
      .expect(200);

    const anonymous = await request(app.getHttpServer()).get('/probe/public').expect(200);
    assert.equal(anonymous.body.ok, true);

    await request(app.getHttpServer())
      .get('/probe/workspace')
      .set(WORKSPACE_HEADER, tenantA.id)
      .expect(401);
  });
});
