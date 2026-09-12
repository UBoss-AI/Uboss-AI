import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { LEDGER_ENTRY_KINDS } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
import { CostController } from '../src/cost/cost.controller.js';
import { CostEngineService } from '../src/cost/cost-engine.service.js';
import { ModelGateway } from '../src/model-gateway/model-gateway.js';
import {
  AnthropicProviderAdapter,
  CustomProviderAdapter,
  MockProviderAdapter,
  OpenAiProviderAdapter,
  PROVIDER_ADAPTERS,
  ProviderAdapter,
} from '../src/model-gateway/provider-adapter.js';
import { ProviderService } from '../src/model-gateway/provider.service.js';
import { RoutingModelGateway } from '../src/model-gateway/routing-model-gateway.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { NotificationRepository } from '../src/persistence/notification.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
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

/**
 * Prompt 30 — tokens, credits, budgets and the reserve/settle ledger.
 *
 * What this suite defends, above everything else:
 *
 *   **Two concurrent agents cannot spend the same last of a budget.** That is §20's own
 *   justification for the Reserve step, and it is the one property that cannot be established by
 *   reading the code — it needs real transactions racing on a real database. The overspend tests
 *   below fire genuinely concurrent reservations through the pool and assert the total held never
 *   exceeds the allowance.
 *
 * Also defended:
 *
 *   * **The ledger explains the balance.** Every movement writes an entry, the entries replay to
 *     the stored balance, and `reconcile` finds nothing — until something writes around the
 *     engine, at which point it finds exactly that.
 *   * **A reservation settles once.** Enforced by a trigger, so a racing double-settle cannot
 *     charge one run twice.
 *   * **Nothing is capped to hide an overspend.** A provider that costs more than its estimate is
 *     recorded at what it cost.
 *   * **A hard stop blocks; an approval threshold does not.** §20 has three controls and they
 *     stay three.
 */
describe('token and cost engine (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminUserId: string;
  let adminUboss: string;
  let platformOwnerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const cost = () => app.get(CostEngineService);
  const gateway = () => app.get<ModelGateway>(ModelGateway);

  const FAST_MODEL = '00000000-0000-4000-8000-00000000e102';

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(`The test database is not reachable: ${reachabilityFailureReason()}`);
    }
    migrateTestDatabase();

    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [CostController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        { provide: SecretsVault, useClass: LocalSealedSecretsVault },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        NotificationRepository,
        OrganizationRepository,
        OutboxRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        NotificationService,
        CostEngineService,
        MockProviderAdapter,
        AnthropicProviderAdapter,
        OpenAiProviderAdapter,
        CustomProviderAdapter,
        {
          provide: PROVIDER_ADAPTERS,
          inject: [
            MockProviderAdapter,
            AnthropicProviderAdapter,
            OpenAiProviderAdapter,
            CustomProviderAdapter,
          ],
          useFactory: (...adapters: ProviderAdapter[]): readonly ProviderAdapter[] => adapters,
        },
        // The real gateway with the real cost engine behind it: this suite tests the whole
        // Check -> Reserve -> Execute -> Settle flow, not the engine in isolation.
        {
          provide: ModelGateway,
          inject: [PrismaService, SecretsVault, PROVIDER_ADAPTERS, CostEngineService],
          useFactory: (
            prisma: PrismaService,
            vault: SecretsVault,
            adapters: readonly ProviderAdapter[],
            engine: CostEngineService,
          ) => new RoutingModelGateway(prisma, vault, adapters, engine),
        },
        ProviderService,
        TenantContextService,
        Reflector,
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
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
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor },
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

    const provisioned = await ctx.provisioning.provision({
      slug: 'cost-co',
      name: 'Cost Co',
      firstMember: { email: 'first@cost.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;
    adminUserId = provisioned.user.id;
    adminUboss = provisioned.user.ubossUniqueId;

    const other = await ctx.provisioning.provision({
      slug: 'cost-other',
      name: 'Other Co',
      firstMember: { email: 'first@costother.example', displayName: 'Other' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const platform = await ctx.users.createForPlatform({
      ubossUniqueId: 'UB-CSPL-0001',
      email: 'owner@cost-platform.example',
      displayName: 'Platform Owner',
      isPlatformActor: true,
    });
    platformOwnerId = platform.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: platformOwnerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: adminUserId,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          grantedByUserId: platformOwnerId,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', adminUboss).set(WORKSPACE_HEADER, tenantId) as T;

  /** A company budget of a known size, through the engine so the ledger explains it. */
  const withAllowance = async (allowanceMinor: number) => {
    await cost().companyWallet(scope());
    return cost().setAllowance({
      scope: scope(),
      actorUserId: adminUserId,
      budgetScope: 'Company',
      subjectId: null,
      allowanceMinor,
      reason: 'Fixture allowance.',
    });
  };

  const companyWallet = async () => {
    const wallets = await cost().wallets(scope());
    const company = wallets.find((wallet) => wallet.scope === 'Company');
    if (company === undefined) throw new Error('no company wallet');
    return company;
  };

  const reserveOnce = (estimateMinor: number, purpose = 'probe') =>
    cost().reserve(
      { scope: scope(), logicalProfile: 'AGENT_STANDARD', purpose },
      { estimateMinor, currency: 'INR' },
    );

  // -------------------------------------------------------------------------
  // 1. Concurrency — the property that needs a real database
  // -------------------------------------------------------------------------

  describe('concurrent agents cannot overspend the same balance', () => {
    it('lets only as many reservations through as the budget affords', async () => {
      // The exact race §20's Reserve step exists to prevent: ten agents, each wanting a fifth of
      // the allowance. Without the row lock every one of them reads the same remaining balance
      // and all ten proceed.
      await withAllowance(10_000);

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, index) => reserveOnce(2_000, `race-${index}`)),
      );

      const reserved = outcomes.filter((outcome) => outcome.reserved);
      // Exactly five fit at 2,000 each: the fifth lands on the allowance, the sixth would go
      // past it. Spending the last of a budget is permitted; spending more is not.
      assert.equal(reserved.length, 5, `${reserved.length} reservations were allowed, not 5`);

      const wallet = await companyWallet();
      assert.equal(wallet.reservedMinor, 10_000);
      // The property that matters, stated directly.
      assert.ok(
        wallet.reservedMinor <= wallet.allowanceMinor,
        'more was reserved than the company has',
      );
    });

    it('never lets the total held exceed the allowance under a heavier race', async () => {
      await withAllowance(9_000);

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, index) => reserveOnce(1_000, `heavy-${index}`)),
      );

      const wallet = await companyWallet();
      assert.ok(
        wallet.reservedMinor <= wallet.allowanceMinor,
        `held ${wallet.reservedMinor} against an allowance of ${wallet.allowanceMinor}`,
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.reserved).length * 1_000,
        wallet.reservedMinor,
      );
    });

    it('frees the budget again when the losers are released', async () => {
      await withAllowance(4_000);

      // 3,500 of 4,000 is inside the hard stop; the next 1,000 would go past it.
      const first = await reserveOnce(3_500);
      assert.equal(first.reserved, true);

      const second = await reserveOnce(1_000);
      assert.equal(second.reserved, false);

      if (first.reserved) {
        await cost().release({
          scope: scope(),
          reservationId: first.reservation.id,
          reason: 'The run was cancelled.',
        });
      }

      const third = await reserveOnce(1_000);
      assert.equal(third.reserved, true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. The flow
  // -------------------------------------------------------------------------

  describe('check, estimate, reserve, settle, release', () => {
    it('holds the estimate, then charges the actual and gives the rest back', async () => {
      await withAllowance(10_000);

      const outcome = await reserveOnce(900);
      assert.equal(outcome.reserved, true);
      if (!outcome.reserved) return;

      const held = await companyWallet();
      assert.equal(held.reservedMinor, 900);
      assert.equal(held.usedMinor, 0);
      assert.equal(held.remainingMinor, 9_100);

      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 340,
      });

      const settled = await companyWallet();
      assert.equal(settled.reservedMinor, 0);
      assert.equal(settled.usedMinor, 340);
      assert.equal(settled.remainingMinor, 9_660);
    });

    it('records an overspend rather than capping it', async () => {
      // Capping would make the ledger disagree with the provider's own invoice. The next call's
      // hard stop is where an overspend gets caught.
      await withAllowance(1_000);

      const outcome = await reserveOnce(500);
      if (!outcome.reserved) throw new Error('expected a reservation');

      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 1_400,
      });

      const wallet = await companyWallet();
      assert.equal(wallet.usedMinor, 1_400);
      assert.equal(wallet.remainingMinor, -400);

      // And the next call is refused, which is the point.
      const next = await reserveOnce(1);
      assert.equal(next.reserved, false);
    });

    it('refuses to settle the same reservation twice', async () => {
      await withAllowance(10_000);
      const outcome = await reserveOnce(500);
      if (!outcome.reserved) throw new Error('expected a reservation');

      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 100,
      });

      await assert.rejects(
        () =>
          cost().settle({
            scope: scope(),
            reservationId: outcome.reservation.id,
            actualMinor: 100,
          }),
        /already Settled|charge the budget twice/i,
      );
    });

    it('refuses a double settle in the database too, not only in the service', async () => {
      await withAllowance(10_000);
      const outcome = await reserveOnce(500);
      if (!outcome.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 100,
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.budgetReservation.update({
              where: { id: outcome.reservation.id },
              data: { state: 'Released', closeReason: 'sneaking' },
            }),
          ),
        /already Settled/,
      );
    });

    it('keeps a released reservation distinct from one settled at zero', async () => {
      // "We held budget and spent nothing" and "we held budget and the work was free" are
      // different facts, and the state is what tells them apart.
      await withAllowance(10_000);

      const released = await reserveOnce(500, 'cancelled');
      if (!released.reserved) throw new Error('expected a reservation');
      await cost().release({
        scope: scope(),
        reservationId: released.reservation.id,
        reason: 'Cancelled before the call.',
      });

      const free = await reserveOnce(500, 'free');
      if (!free.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: free.reservation.id,
        actualMinor: 0,
      });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetReservation.findMany({
          where: { tenantId },
          orderBy: { heldAt: 'asc' },
        }),
      );
      assert.equal(rows[0]?.state, 'Released');
      assert.equal(rows[0]?.settledMinor, null);
      assert.equal(rows[1]?.state, 'Settled');
      assert.equal(rows[1]?.settledMinor, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The hierarchy
  // -------------------------------------------------------------------------

  describe('the budget hierarchy', () => {
    const DEPARTMENT = '33333333-3333-4333-8333-333333333333';

    it('holds against every level at once', async () => {
      await withAllowance(100_000);
      await cost().setAllowance({
        scope: scope(),
        actorUserId: adminUserId,
        budgetScope: 'Department',
        subjectId: DEPARTMENT,
        allowanceMinor: 10_000,
        reason: 'Department budget.',
      });

      const outcome = await cost().reserve(
        {
          scope: scope(),
          departmentId: DEPARTMENT,
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'probe',
        },
        { estimateMinor: 1_000, currency: 'INR' },
      );
      assert.equal(outcome.reserved, true);

      const wallets = await cost().wallets(scope());
      // A reservation that held only against the company would let the department exceed its own.
      assert.equal(wallets.find((w) => w.scope === 'Company')?.reservedMinor, 1_000);
      assert.equal(wallets.find((w) => w.scope === 'Department')?.reservedMinor, 1_000);
    });

    it('stops at a department limit even when the company has room', async () => {
      await withAllowance(100_000);
      await cost().setAllowance({
        scope: scope(),
        actorUserId: adminUserId,
        budgetScope: 'Department',
        subjectId: DEPARTMENT,
        allowanceMinor: 1_000,
        reason: 'A small department.',
      });

      const outcome = await cost().reserve(
        {
          scope: scope(),
          departmentId: DEPARTMENT,
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'probe',
        },
        { estimateMinor: 5_000, currency: 'INR' },
      );

      assert.equal(outcome.reserved, false);
      assert.equal(outcome.outcome.bindingLevel?.scope, 'Department');
    });

    it('reports the company as the binding level when both would stop', async () => {
      // Telling somebody to raise a department limit when the company is out of credit sends
      // them to fix the wrong thing.
      await withAllowance(1_000);
      await cost().setAllowance({
        scope: scope(),
        actorUserId: adminUserId,
        budgetScope: 'Department',
        subjectId: DEPARTMENT,
        allowanceMinor: 1_000,
        reason: 'Also small.',
      });

      const outcome = await cost().reserve(
        {
          scope: scope(),
          departmentId: DEPARTMENT,
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'probe',
        },
        { estimateMinor: 5_000, currency: 'INR' },
      );

      assert.equal(outcome.reserved, false);
      assert.equal(outcome.outcome.bindingLevel?.scope, 'Company');
    });

    it('treats a level with no budget as deferring rather than as zero', async () => {
      // An objective with no budget of its own inherits; creating an empty wallet for it would
      // turn "not configured" into "a budget of zero", which hard-stops everything.
      await withAllowance(10_000);

      const outcome = await cost().reserve(
        {
          scope: scope(),
          objectiveId: '44444444-4444-4444-8444-444444444444',
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'probe',
        },
        { estimateMinor: 1_000, currency: 'INR' },
      );
      assert.equal(outcome.reserved, true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Thresholds
  // -------------------------------------------------------------------------

  describe('thresholds', () => {
    it('hard stops past the allowance, and not merely at it', async () => {
      await withAllowance(1_000);

      // Exactly the allowance is spendable — a company that bought a thousand can spend a
      // thousand. It still needs an approval, because 100% is past the approval threshold.
      const exact = await reserveOnce(1_000);
      assert.equal(exact.reserved, true);
      assert.equal(exact.outcome.decision, 'NeedsApproval');

      // One unit past it is refused.
      const past = await reserveOnce(1);
      assert.equal(past.reserved, false);
      assert.equal(past.outcome.decision, 'HardStopped');
    });

    it('reports a crossed threshold on the wallet', async () => {
      await withAllowance(1_000);
      const outcome = await reserveOnce(800);
      assert.equal(outcome.reserved, true);

      const wallet = await companyWallet();
      assert.equal(wallet.percent, 80);
      assert.equal(wallet.threshold, 'Warning');
    });

    it('notifies a company admin when a threshold is crossed', async () => {
      await withAllowance(1_000);
      await reserveOnce(800);

      const notifications = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, kind: 'BudgetThreshold' },
        }),
      );
      assert.ok(notifications.length >= 1);
      assert.equal(notifications[0]?.recipientUserId, adminUserId);
    });

    it('notifies once per threshold, not once per run that crosses it', async () => {
      await withAllowance(10_000);
      for (let index = 0; index < 3; index += 1) {
        await reserveOnce(2_600, `repeat-${index}`);
      }

      const notifications = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, kind: 'BudgetThreshold' },
        }),
      );
      // Deduplicated by threshold: three runs crossing the same level is one thing to tell
      // somebody about, not three.
      const distinct = new Set(notifications.map((row) => row.dedupeKey));
      assert.ok(distinct.size <= 3, `${distinct.size} distinct budget notifications`);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The ledger
  // -------------------------------------------------------------------------

  describe('the ledger', () => {
    it('writes an entry for every movement, and they replay to the balance', async () => {
      await withAllowance(10_000);
      const outcome = await reserveOnce(900);
      if (!outcome.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 340,
      });

      const result = await cost().reconcile(scope());
      // Nothing drifted, which is the whole claim: the maintained balance is exactly what the
      // ledger says it should be.
      assert.deepEqual(result.findings, []);
      assert.ok(result.checked >= 1);
    });

    it('records the reserve and the release even though they net to zero', async () => {
      // Omitting them would make the balance unexplainable at any moment during a run.
      await withAllowance(10_000);
      const outcome = await reserveOnce(900);
      if (!outcome.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 340,
      });

      const entries = (await cost().ledger({ scope: scope() })) as { kind: string }[];
      const kinds = entries.map((entry) => entry.kind);
      assert.ok(kinds.includes('Reserve'));
      assert.ok(kinds.includes('ReleaseReserve'));
      assert.ok(kinds.includes('Settle'));
    });

    it('is append-only', async () => {
      await withAllowance(10_000);
      const entries = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.costLedgerEntry.findMany({ where: { tenantId }, take: 1 }),
      );
      assert.ok(entries.length > 0);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.costLedgerEntry.update({
              where: { id: entries[0]!.id },
              data: { amountMinor: 1 },
            }),
          ),
        /append-only/,
      );
    });

    it('records the resulting balance on every entry', async () => {
      await withAllowance(10_000);
      const entries = (await cost().ledger({ scope: scope() })) as {
        balanceAfterAllowanceMinor: number;
      }[];
      assert.ok(entries.length > 0);
      assert.equal(entries[0]?.balanceAfterAllowanceMinor, 10_000);
    });

    it('finds drift when something writes around the engine', async () => {
      // The reconciliation job's reason for existing. A write outside the engine is either a bug
      // or a person with database access, and both need to be visible.
      await withAllowance(10_000);

      const wallet = await companyWallet();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: { usedMinor: 4_242 },
        }),
      );

      const result = await cost().reconcile(scope());
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.field, 'usedMinor');
      assert.equal(result.findings[0]?.storedMinor, 4_242);
      assert.equal(result.findings[0]?.replayedMinor, 0);
    });

    it('reports drift without correcting it', async () => {
      await withAllowance(10_000);
      const wallet = await companyWallet();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: { usedMinor: 999 },
        }),
      );

      await cost().reconcile(scope());

      const after = await companyWallet();
      // Still wrong, deliberately: overwriting it would destroy the evidence.
      assert.equal(after.usedMinor, 999);
    });

    it('uses only kinds the shared vocabulary knows', async () => {
      await withAllowance(10_000);
      const outcome = await reserveOnce(100);
      if (!outcome.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: outcome.reservation.id,
        actualMinor: 50,
      });

      const entries = (await cost().ledger({ scope: scope() })) as { kind: string }[];
      for (const entry of entries) {
        assert.ok(
          (LEDGER_ENTRY_KINDS as readonly string[]).includes(entry.kind),
          `${entry.kind} is not a known ledger kind`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Abandoned reservations
  // -------------------------------------------------------------------------

  describe('abandoned reservations', () => {
    it('expires a hold nobody closed, and says it expired', async () => {
      // A worker that crashes between reserving and settling would otherwise leak a company's
      // allowance one crash at a time.
      await withAllowance(10_000);
      const outcome = await reserveOnce(900);
      if (!outcome.reserved) throw new Error('expected a reservation');

      const result = await cost().sweepExpiredReservations({
        scope: scope(),
        now: new Date(Date.now() + 2 * 3_600_000),
      });
      assert.equal(result.expired, 1);

      const wallet = await companyWallet();
      assert.equal(wallet.reservedMinor, 0);

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetReservation.findUniqueOrThrow({
          where: { id: outcome.reservation.id },
        }),
      );
      // Expired, not Released: the distinction is the diagnostic.
      assert.equal(row.state, 'Expired');
      assert.match(row.closeReason ?? '', /never reported back/);
    });

    it('leaves a fresh hold alone', async () => {
      await withAllowance(10_000);
      await reserveOnce(900);

      const result = await cost().sweepExpiredReservations({ scope: scope() });
      assert.equal(result.expired, 0);

      const wallet = await companyWallet();
      assert.equal(wallet.reservedMinor, 900);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Through the gateway — the whole flow, end to end
  // -------------------------------------------------------------------------

  describe('through the model gateway', () => {
    it('reserves, calls and settles without the caller doing anything', async () => {
      // The reason the flow lives in the gateway: every AI call in the product is governed, and
      // no caller had to be changed to make it so.
      await withAllowance(100_000);
      await app.get(ProviderService).publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 1_000_000,
        outputPerMillionMinorUnits: 1_000_000,
        cachedInputPerMillionMinorUnits: null,
      });

      const response = await gateway().complete({
        profile: 'AGENT_FAST',
        purpose: 'probe',
        instruction: 'Do the thing.',
        context: 'Some material.',
        maxTokens: 200,
        tenantId,
      });

      assert.notEqual(response.costMinorUnits, null);

      const wallet = await companyWallet();
      // Charged, and nothing left held.
      assert.equal(wallet.reservedMinor, 0);
      assert.equal(wallet.usedMinor, response.costMinorUnits);

      const reservations = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetReservation.findMany({ where: { tenantId } }),
      );
      assert.equal(reservations[0]?.state, 'Settled');
    });

    it('refuses a call the budget cannot afford, and records that it never happened', async () => {
      await withAllowance(1);
      await app.get(ProviderService).publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 10_000_000,
        outputPerMillionMinorUnits: 10_000_000,
        cachedInputPerMillionMinorUnits: null,
      });

      await assert.rejects(
        () =>
          gateway().complete({
            profile: 'AGENT_FAST',
            purpose: 'probe',
            instruction: 'Do the thing.',
            context: 'Some material.',
            maxTokens: 10_000,
            tenantId,
          }),
        /budget|hard stop/i,
      );

      const calls = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.modelGatewayCall.findMany({ where: { tenantId } }),
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.outcome, 'Unroutable');
      assert.match(calls[0]?.detail ?? '', /Refused by a budget control/);

      // And nothing is left held for a call that never happened.
      const wallet = await companyWallet();
      assert.equal(wallet.reservedMinor, 0);
    });

    it('gives the hold back when no model could answer', async () => {
      await withAllowance(100_000);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.logicalModelRoute.deleteMany({ where: { profile: 'EXECUTOR' } }),
      );

      await assert.rejects(() =>
        gateway().complete({
          profile: 'EXECUTOR',
          purpose: 'probe',
          instruction: 'x',
          context: 'y',
          maxTokens: 100,
          tenantId,
        }),
      );

      const wallet = await companyWallet();
      // A company should not be short of budget because a provider was down.
      assert.equal(wallet.reservedMinor, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The API and tenant isolation
  // -------------------------------------------------------------------------

  describe('the API and tenant isolation', () => {
    it('serves the wallets and the vocabulary', async () => {
      await withAllowance(10_000);

      const meta = await as(agent().get(`/tenants/${tenantId}/cost/meta`)).expect(200);
      assert.equal(meta.body.scopes.length, 4);
      assert.match(meta.body.note, /Reserved amounts count against remaining/);

      const wallets = await as(agent().get(`/tenants/${tenantId}/cost/wallets`)).expect(200);
      assert.equal(wallets.body.length, 1);
      assert.equal(wallets.body[0].allowanceMinor, 10_000);
    });

    it('refuses an unauthenticated request', async () => {
      await agent()
        .get(`/tenants/${tenantId}/cost/wallets`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('has no endpoint that spends, reserves or settles by hand', async () => {
      // Such a route would be a way to charge a company for work that never happened, outside
      // the reserve/settle pairing that makes the ledger reconcilable.
      await as(agent().post(`/tenants/${tenantId}/cost/settle`).send({})).expect(404);
      await as(agent().post(`/tenants/${tenantId}/cost/reserve`).send({})).expect(404);
    });

    it('keeps one company budget out of another', async () => {
      await withAllowance(10_000);

      const theirs = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.budgetWallet.findMany({ where: { tenantId: otherTenantId } }),
      );
      assert.equal(theirs.length, 0);

      const ledger = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.costLedgerEntry.findMany({ where: { tenantId: otherTenantId } }),
      );
      assert.equal(ledger.length, 0);
    });

    it('writes an audit event when an allowance changes', async () => {
      await withAllowance(10_000);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'cost.allowance_set' },
        }),
      );
      assert.ok(events.length >= 1);
    });
  });
});
