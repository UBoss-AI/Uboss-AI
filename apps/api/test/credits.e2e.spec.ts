import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { DEFAULT_CREDIT_POLICY } from '@uboss/types';

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
import { CostController } from '../src/cost/cost.controller.js';
import { CostEngineService } from '../src/cost/cost-engine.service.js';
import { CreditController } from '../src/cost/credit.controller.js';
import { CreditPlatformController } from '../src/cost/credit-platform.controller.js';
import { CreditService } from '../src/cost/credit.service.js';
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
 * Prompt 31 — credit top-up, reallocation and the commercial edge cases.
 *
 * What this suite defends:
 *
 *   * **A company cannot grant itself credit.** The request and the decision are on different
 *     planes, and the company plane has no route that approves. That separation is the control;
 *     everything else is bookkeeping.
 *   * **Reallocation cannot create allowance.** It is always a pair of movements and the source
 *     must have the amount *uncommitted* — moving reserved or spent budget would invent money.
 *   * **Every commercial term is configuration.** The approved documents ask for them to be
 *     defined and state no value, so each is a policy field with a conservative default, and the
 *     defaults are asserted here because they are a decision.
 *   * **A top-up does not expire unless somebody says so.**
 *   * **Only runs blocked by budget resume.** Buying credits must not clear a governance
 *     decision.
 *   * **Nothing moves a balance without a ledger entry** — every flow here goes through the
 *     Prompt 30 engine, and `reconcile` proves it at the end.
 */
describe('credit top-up, reallocation and commercial edge cases (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let adminUserId: string;
  let adminUboss: string;
  let employeeUserId: string;
  let employeeUboss: string;
  let platformOwnerId: string;
  let platformUboss: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const credits = () => app.get(CreditService);
  const cost = () => app.get(CostEngineService);

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
      controllers: [CostController, CreditController, CreditPlatformController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
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
        CreditService,
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
      slug: 'credit-co',
      name: 'Credit Co',
      firstMember: { email: 'admin@credit.example', displayName: 'Admin' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;
    adminUserId = provisioned.user.id;
    adminUboss = provisioned.user.ubossUniqueId;

    const employee = await ctx.users.createForPlatform({
      ubossUniqueId: 'UB-CREMP-001',
      email: 'employee@credit.example',
      displayName: 'Employee',
      isPlatformActor: false,
    });
    employeeUserId = employee.id;
    employeeUboss = employee.ubossUniqueId;
    await activateMembership(ctx, employeeUserId, tenantId);

    const platform = await ctx.users.createForPlatform({
      ubossUniqueId: 'UB-CRPL-0001',
      email: 'finance@credit-platform.example',
      displayName: 'Finance',
      isPlatformActor: true,
    });
    platformOwnerId = platform.id;
    platformUboss = platform.ubossUniqueId;

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
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: employeeUserId,
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          grantedByUserId: platformOwnerId,
        },
      });
      // The plan allowance the company was provisioned with.
      await ctx.prisma.client.tenantAiBudgetPolicy.upsert({
        where: { tenantId },
        create: {
          tenantId,
          monthlyAllowanceMinor: 100_000,
          approvalThresholdMinor: 90_000,
          hardStopMinor: 100_000,
        },
        update: { monthlyAllowanceMinor: 100_000 },
      });
    });

    await cost().companyWallet(scope());
  });

  const asAdmin = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', adminUboss).set(WORKSPACE_HEADER, tenantId) as T;
  const asEmployee = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', employeeUboss).set(WORKSPACE_HEADER, tenantId) as T;
  const asPlatform = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', platformUboss) as T;

  const companyWallet = async () => {
    const wallets = await cost().wallets(scope());
    const company = wallets.find((wallet) => wallet.scope === 'Company');
    if (company === undefined) throw new Error('no company wallet');
    return company;
  };

  const submitRequest = (amountMinor = 40_000) =>
    credits().requestCredits({
      scope: scope(),
      actorUserId: adminUserId,
      amountMinor,
      reason: 'Q4 tender season.',
    });

  // -------------------------------------------------------------------------
  // 1. The separation that makes a request a request
  // -------------------------------------------------------------------------

  describe('a company cannot grant itself credit', () => {
    it('offers no company route that approves a request', async () => {
      // The whole control: the company asks and Finance decides. A route here would let a
      // company set its own commercial terms.
      const submitted = await submitRequest();
      await asAdmin(
        agent().post(`/tenants/${tenantId}/credits/requests/${submitted.id}/decide`).send({}),
      ).expect(404);
      await asAdmin(agent().post(`/tenants/${tenantId}/credits/grants`).send({})).expect(404);
    });

    it('refuses an employee asking for credits', async () => {
      // The prompt's own words: "Employees cannot increase company credits."
      await asEmployee(
        agent()
          .post(`/tenants/${tenantId}/credits/requests`)
          .send({ amountMinor: 1_000, reason: 'I would like more.' }),
      ).expect(403);
    });

    it('lets a Company Admin ask', async () => {
      const response = await asAdmin(
        agent()
          .post(`/tenants/${tenantId}/credits/requests`)
          .send({ amountMinor: 40_000, reason: 'Q4 tender season.' }),
      ).expect(201);
      assert.equal(response.body.state, 'Submitted');
      assert.equal(response.body.requestedMinor, 40_000);
    });

    it('keeps the platform decision route off the company plane', async () => {
      await asAdmin(agent().get('/platform/credits/requests')).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Finance decides
  // -------------------------------------------------------------------------

  describe('Finance decides', () => {
    it('approves, adds the credit and notifies the requester', async () => {
      const submitted = await submitRequest();
      const before = await companyWallet();

      const outcome = await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 40_000,
        reference: 'INV-2026-118',
        note: 'Approved against the Q4 commitment.',
      });

      assert.equal(outcome.request.state, 'Approved');
      assert.equal(outcome.request.approvedMinor, 40_000);
      assert.equal(outcome.request.reference, 'INV-2026-118');
      assert.notEqual(outcome.request.grantId, null);

      const after = await companyWallet();
      assert.equal(after.allowanceMinor, before.allowanceMinor + 40_000);

      const notifications = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, recipientUserId: adminUserId },
        }),
      );
      assert.ok(notifications.some((row) => /approved/i.test(row.title)));
    });

    it('approves for less than was asked — the prompt’s "Adjust Amount"', async () => {
      const submitted = await submitRequest(40_000);

      const outcome = await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 25_000,
        note: 'Half this quarter.',
      });

      assert.equal(outcome.request.approvedMinor, 25_000);
      assert.equal(outcome.request.requestedMinor, 40_000);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'credits.request_approved' },
        }),
      );
      // Recorded as adjusted, so nobody has to do arithmetic to find out.
      assert.match(JSON.stringify(events[0]?.metadata), /"adjusted":true/);
    });

    it('rejects with a reason and adds nothing', async () => {
      const submitted = await submitRequest();
      const before = await companyWallet();

      const outcome = await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: false,
        note: 'Outside the committed spend for this quarter.',
      });

      assert.equal(outcome.request.state, 'Rejected');
      const after = await companyWallet();
      assert.equal(after.allowanceMinor, before.allowanceMinor);
    });

    it('refuses a rejection with no reason', async () => {
      const submitted = await submitRequest();
      await assert.rejects(
        () =>
          credits().decideRequest({
            scope: scope(),
            operatorUserId: platformOwnerId,
            requestId: submitted.id,
            approve: false,
            note: '',
          }),
        /has to say why/,
      );
    });

    it('refuses to decide the same request twice', async () => {
      const submitted = await submitRequest();
      await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 1_000,
        note: 'Yes.',
      });

      await assert.rejects(
        () =>
          credits().decideRequest({
            scope: scope(),
            operatorUserId: platformOwnerId,
            requestId: submitted.id,
            approve: false,
            note: 'Changed my mind.',
          }),
        /already Approved|decision is final/i,
      );
    });

    it('refuses a reversal in the database too', async () => {
      const submitted = await submitRequest();
      await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 1_000,
        note: 'Yes.',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.creditRequest.update({
              where: { id: submitted.id },
              data: { approvedMinor: 999_999 },
            }),
          ),
        /cannot be rewritten/,
      );
    });

    it('does not make a future-dated grant spendable yet', async () => {
      const submitted = await submitRequest();
      const before = await companyWallet();

      await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 40_000,
        effectiveFrom: new Date(Date.now() + 7 * 86_400_000),
        note: 'Effective next week.',
      });

      const after = await companyWallet();
      // The company can see it coming and cannot spend it early.
      assert.equal(after.allowanceMinor, before.allowanceMinor);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Reallocation
  // -------------------------------------------------------------------------

  describe('reallocation does not create allowance', () => {
    const DEPARTMENT = '33333333-3333-4333-8333-333333333333';

    it('moves budget between levels, leaving the total unchanged', async () => {
      await cost().setAllowance({
        scope: scope(),
        actorUserId: adminUserId,
        budgetScope: 'Department',
        subjectId: DEPARTMENT,
        allowanceMinor: 0,
        reason: 'Create the department budget.',
      });

      const before = await companyWallet();

      await credits().reallocate({
        scope: scope(),
        actorUserId: adminUserId,
        from: { budgetScope: 'Company', subjectId: null },
        to: { budgetScope: 'Department', subjectId: DEPARTMENT },
        amountMinor: 20_000,
        reason: 'Exports needs more this quarter.',
      });

      const wallets = await cost().wallets(scope());
      const company = wallets.find((w) => w.scope === 'Company');
      const department = wallets.find((w) => w.scope === 'Department');

      assert.equal(company?.allowanceMinor, before.allowanceMinor - 20_000);
      assert.equal(department?.allowanceMinor, 20_000);
      // The sum is what it was: nothing was bought.
      assert.equal(
        (company?.allowanceMinor ?? 0) + (department?.allowanceMinor ?? 0),
        before.allowanceMinor,
      );
    });

    it('refuses to move more than is uncommitted', async () => {
      await assert.rejects(
        () =>
          credits().reallocate({
            scope: scope(),
            actorUserId: adminUserId,
            from: { budgetScope: 'Company', subjectId: null },
            to: { budgetScope: 'Department', subjectId: DEPARTMENT },
            amountMinor: 500_000,
            reason: 'Everything, please.',
          }),
        /create allowance out of nothing/,
      );
    });

    it('will not move budget that is already reserved', async () => {
      // Reserved budget is committed to a run in flight. Moving it would let the same money be
      // spent twice — once by the run and once by wherever it was moved to.
      const reservation = await cost().reserve(
        { scope: scope(), logicalProfile: 'AGENT_STANDARD', purpose: 'holding' },
        { estimateMinor: 90_000, currency: 'INR' },
      );
      assert.equal(reservation.reserved, true);

      await assert.rejects(
        () =>
          credits().reallocate({
            scope: scope(),
            actorUserId: adminUserId,
            from: { budgetScope: 'Company', subjectId: null },
            to: { budgetScope: 'Department', subjectId: DEPARTMENT },
            amountMinor: 50_000,
            reason: 'Move it anyway.',
          }),
        /create allowance out of nothing/,
      );
    });

    it('records both halves in the ledger', async () => {
      await credits().reallocate({
        scope: scope(),
        actorUserId: adminUserId,
        from: { budgetScope: 'Company', subjectId: null },
        to: { budgetScope: 'Department', subjectId: DEPARTMENT },
        amountMinor: 10_000,
        reason: 'Quarterly shift.',
      });

      const entries = (await cost().ledger({ scope: scope() })) as {
        kind: string;
        amountMinor: number;
      }[];
      const moves = entries.filter((entry) => entry.kind === 'Reallocation');
      assert.equal(moves.length, 2);
      // Equal and opposite: the statement shows a move rather than money appearing.
      assert.equal(moves[0]!.amountMinor + moves[1]!.amountMinor, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The commercial policy
  // -------------------------------------------------------------------------

  describe('the commercial policy', () => {
    it('starts at the documented defaults', async () => {
      const policy = await credits().policy(scope());
      assert.equal(policy.resetPolicy, DEFAULT_CREDIT_POLICY.resetPolicy);
      assert.equal(policy.carryForwardPolicy, 'Forfeit');
      assert.equal(policy.negativeBalancePolicy, 'BlockImmediately');
      assert.equal(policy.planChangePolicy, 'NextCycle');
      // The default that matters most: purchased credit does not expire unasked.
      assert.equal(policy.defaultTopUpExpiryDays, null);
    });

    it('is set on the platform plane, not by the company', async () => {
      // A company that could set its own carry-forward policy could grant itself credit it had
      // not bought — the same hole as self-approval in a different hat.
      await asAdmin(agent().post(`/tenants/${tenantId}/credits/policy`).send({})).expect(404);
    });

    it('refuses an incoherent policy', async () => {
      await assert.rejects(
        () =>
          credits().setPolicy({
            scope: scope(),
            actorUserId: platformOwnerId,
            reason: 'Trying it on.',
            policy: {
              ...DEFAULT_CREDIT_POLICY,
              carryForwardPolicy: 'CarryForwardCapped',
              carryForwardCapMinor: null,
            },
          }),
        /needs a cap/,
      );
    });

    it('audits a policy change', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Contract amendment 3.',
        policy: { ...DEFAULT_CREDIT_POLICY, carryForwardPolicy: 'CarryForward' },
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'credits.policy_changed' },
        }),
      );
      assert.equal(events.length, 1);
      assert.match(events[0]?.summary ?? '', /Contract amendment 3/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The edge cases
  // -------------------------------------------------------------------------

  describe('monthly reset and carry-forward', () => {
    it('does not reset before it is due', async () => {
      const outcome = await credits().applyPeriodReset({
        scope: scope(),
        actorUserId: platformOwnerId,
      });
      assert.equal(outcome.reset, false);
      assert.match(outcome.reason, /Not due until/);
    });

    it('forfeits unused allowance by default', async () => {
      // Spend a little, then reset a month later.
      const reservation = await cost().reserve(
        { scope: scope(), logicalProfile: 'AGENT_STANDARD', purpose: 'spend' },
        { estimateMinor: 10_000, currency: 'INR' },
      );
      if (!reservation.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: reservation.reservation.id,
        actualMinor: 10_000,
      });

      const outcome = await credits().applyPeriodReset({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: new Date(Date.now() + 40 * 86_400_000),
      });

      assert.equal(outcome.reset, true);
      assert.equal(outcome.carriedForwardMinor, 0);
      assert.equal(outcome.newAllowanceMinor, 100_000);

      // **The figure that matters, and the one an early version of the reset got wrong.**
      // `usedMinor` is cumulative because the ledger is immutable, so writing off the whole
      // previous allowance would have left last month's 10,000 still subtracted from this
      // month's budget — the company would start the new period able to spend only 90,000 of
      // the 100,000 it pays for. What lapses is the *unused* part, and nothing else.
      const wallet = await companyWallet();
      assert.equal(wallet.remainingMinor, 100_000);
      assert.equal(wallet.usedMinor, 10_000);
    });

    it('carries unused allowance forward when the policy says so', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Contract allows carry-forward.',
        policy: { ...DEFAULT_CREDIT_POLICY, carryForwardPolicy: 'CarryForward' },
      });

      const outcome = await credits().applyPeriodReset({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: new Date(Date.now() + 40 * 86_400_000),
      });

      assert.equal(outcome.reset, true);
      // Nothing was spent, so the whole allowance carries.
      assert.equal(outcome.carriedForwardMinor, 100_000);
      assert.equal(outcome.newAllowanceMinor, 200_000);

      const wallet = await companyWallet();
      assert.equal(wallet.remainingMinor, 200_000);
    });

    it('caps what it carries', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Capped at 20,000.',
        policy: {
          ...DEFAULT_CREDIT_POLICY,
          carryForwardPolicy: 'CarryForwardCapped',
          carryForwardCapMinor: 20_000,
        },
      });

      const outcome = await credits().applyPeriodReset({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: new Date(Date.now() + 40 * 86_400_000),
      });
      assert.equal(outcome.carriedForwardMinor, 20_000);
    });
  });

  describe('top-up expiry', () => {
    it('does not expire a top-up with no expiry', async () => {
      await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'TopUp',
        amountMinor: 40_000,
        effectiveFrom: new Date(),
        reason: 'Purchased.',
      });

      const outcome = await credits().expireGrants({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: new Date(Date.now() + 3650 * 86_400_000),
      });
      // Ten years later and still there, because nobody said it should expire.
      assert.equal(outcome.expired, 0);
    });

    it('expires a dated grant once, and takes the allowance back', async () => {
      const before = await companyWallet();
      await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'Promotional',
        amountMinor: 5_000,
        effectiveFrom: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'Launch promotion.',
      });

      const granted = await companyWallet();
      assert.equal(granted.allowanceMinor, before.allowanceMinor + 5_000);

      const later = new Date(Date.now() + 2 * 86_400_000);
      const first = await credits().expireGrants({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: later,
      });
      assert.equal(first.expired, 1);
      assert.equal(first.totalMinor, 5_000);

      const after = await companyWallet();
      assert.equal(after.allowanceMinor, before.allowanceMinor);

      // A second sweep must not charge the same expiry again.
      const second = await credits().expireGrants({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: later,
      });
      assert.equal(second.expired, 0);
    });
  });

  describe('payment failure after a top-up', () => {
    it('withdraws the credit and records why', async () => {
      const before = await companyWallet();
      const grant = await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'TopUp',
        amountMinor: 40_000,
        effectiveFrom: new Date(),
        reason: 'Purchased.',
        reference: 'INV-2026-118',
      });

      await credits().revokeGrant({
        scope: scope(),
        actorUserId: platformOwnerId,
        grantId: grant.id,
        reason: 'Invoice INV-2026-118 was not paid.',
      });

      const after = await companyWallet();
      assert.equal(after.allowanceMinor, before.allowanceMinor);

      const entries = (await cost().ledger({ scope: scope() })) as {
        kind: string;
        amountMinor: number;
      }[];
      // **A signed `Adjustment`, and deliberately not a `Refund`.** In this ledger a `Refund`
      // reduces what has been *used* — money coming back after a charge. Withdrawing an unpaid
      // top-up takes back allowance that was never spent, so recording it as a refund would
      // leave the allowance intact and write off real spend instead.
      const withdrawal = entries.find(
        (entry) => entry.kind === 'Adjustment' && entry.amountMinor === -40_000,
      );
      assert.ok(withdrawal, 'expected a negative Adjustment for the withdrawal');
      assert.ok(!entries.some((entry) => entry.kind === 'Refund'));
    });

    it('can leave the balance below what has already been spent', async () => {
      // The honest outcome: the company spent credit it turned out not to have paid for.
      const grant = await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'TopUp',
        amountMinor: 50_000,
        effectiveFrom: new Date(),
        reason: 'Purchased.',
      });

      const reservation = await cost().reserve(
        { scope: scope(), logicalProfile: 'AGENT_STANDARD', purpose: 'spend' },
        { estimateMinor: 120_000, currency: 'INR' },
      );
      if (!reservation.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: reservation.reservation.id,
        actualMinor: 120_000,
      });

      await credits().revokeGrant({
        scope: scope(),
        actorUserId: platformOwnerId,
        grantId: grant.id,
        reason: 'Payment failed.',
      });

      const after = await companyWallet();
      assert.ok(after.remainingMinor < 0, `remaining was ${after.remainingMinor}`);

      // And the negative-balance policy now blocks.
      const status = await credits().negativeBalanceStatus(scope());
      assert.equal(status.blocks, true);
    });

    it('refuses to withdraw the same grant twice', async () => {
      const grant = await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'TopUp',
        amountMinor: 1_000,
        effectiveFrom: new Date(),
        reason: 'Purchased.',
      });
      await credits().revokeGrant({
        scope: scope(),
        actorUserId: platformOwnerId,
        grantId: grant.id,
        reason: 'Payment failed.',
      });

      await assert.rejects(
        () =>
          credits().revokeGrant({
            scope: scope(),
            actorUserId: platformOwnerId,
            grantId: grant.id,
            reason: 'Again.',
          }),
        /already withdrawn/,
      );
    });
  });

  describe('negative balances', () => {
    it('tolerates an overdraft inside a configured grace', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Contract allows a small overdraft.',
        policy: {
          ...DEFAULT_CREDIT_POLICY,
          negativeBalancePolicy: 'AllowGrace',
          negativeBalanceGraceMinor: 10_000,
        },
      });

      const reservation = await cost().reserve(
        { scope: scope(), logicalProfile: 'AGENT_STANDARD', purpose: 'spend' },
        { estimateMinor: 90_000, currency: 'INR' },
      );
      if (!reservation.reserved) throw new Error('expected a reservation');
      await cost().settle({
        scope: scope(),
        reservationId: reservation.reservation.id,
        actualMinor: 105_000,
      });

      const status = await credits().negativeBalanceStatus(scope());
      assert.equal(status.blocks, false);
      assert.match(status.reason, /grace/);
    });
  });

  describe('plan change mid-cycle', () => {
    it('defers to the next cycle by default', async () => {
      const before = await companyWallet();
      const outcome = await credits().applyPlanChange({
        scope: scope(),
        actorUserId: platformOwnerId,
        newPlanAllowanceMinor: 200_000,
        reason: 'Upgraded to Enterprise.',
      });

      assert.equal(outcome.applied, false);
      const after = await companyWallet();
      assert.equal(after.allowanceMinor, before.allowanceMinor);
    });

    it('applies in full when the policy says so', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Immediate upgrades.',
        policy: { ...DEFAULT_CREDIT_POLICY, planChangePolicy: 'ImmediateFull' },
      });

      const outcome = await credits().applyPlanChange({
        scope: scope(),
        actorUserId: platformOwnerId,
        newPlanAllowanceMinor: 200_000,
        reason: 'Upgraded to Enterprise.',
      });

      assert.equal(outcome.applied, true);
      const after = await companyWallet();
      assert.equal(after.allowanceMinor, 200_000);
    });

    it('pro-rates when the policy says so', async () => {
      await credits().setPolicy({
        scope: scope(),
        actorUserId: platformOwnerId,
        reason: 'Pro-rated upgrades.',
        policy: { ...DEFAULT_CREDIT_POLICY, planChangePolicy: 'ProRate' },
      });

      const outcome = await credits().applyPlanChange({
        scope: scope(),
        actorUserId: platformOwnerId,
        newPlanAllowanceMinor: 200_000,
        reason: 'Upgraded mid-month.',
      });

      assert.equal(outcome.applied, true);
      // Somewhere between the two, and stated in words.
      assert.ok(outcome.allowanceMinor > 100_000 && outcome.allowanceMinor <= 200_000);
      assert.match(outcome.reason, /Pro-rated/);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Resuming after a top-up
  // -------------------------------------------------------------------------

  describe('resuming blocked runs', () => {
    /**
     * A run in a given state, seeded directly.
     *
     * Built the way the product builds one rather than the way a fixture would like to: an agent
     * starts in `DraftSetup`, gets a published version, and only then becomes `Active` with that
     * version in force — `active_engine_agent_has_a_current_version` refuses the shortcut, and
     * `agent_runs.engine_agent_version_id` is required because a run cites the exact
     * configuration that produced it. Going through the Agent Builder would mean an objective, an
     * assignment and a connection for a test that only cares which runs resume.
     */
    const seedRun = async (state: string) => {
      const suffix = Math.random().toString(36).slice(2, 8);

      return ctx.prisma.runAsPlatformOperation(async () => {
        const agentRow = await ctx.prisma.client.engineAgent.create({
          data: {
            tenantId,
            name: `Agent ${state} ${suffix}`,
            ownerUserId: adminUserId,
            status: 'DraftSetup',
            memoryMode: 'CurrentRunOnly',
          },
        });

        const versionRow = await ctx.prisma.client.engineAgentVersion.create({
          data: {
            tenantId,
            engineAgentId: agentRow.id,
            versionNumber: 1,
            status: 'Published',
            config: { seededBy: 'credits.e2e' },
            // `engine_agent_version_publication_is_attributed`: a published version names who
            // published it, in both directions.
            publishedAt: new Date(),
            publishedByUserId: adminUserId,
            createdByUserId: adminUserId,
          },
        });

        await ctx.prisma.client.engineAgent.update({
          where: { id: agentRow.id },
          data: {
            status: 'Active',
            currentVersionId: versionRow.id,
            // `engine_agent_activation_is_attributed`, the same rule as publication.
            activatedAt: new Date(),
            activatedByUserId: adminUserId,
          },
        });

        return ctx.prisma.client.agentRun.create({
          data: {
            tenantId,
            engineAgentId: agentRow.id,
            engineAgentVersionId: versionRow.id,
            state,
            // `blocked_run_says_why`: a blocked run carries the reason it stopped, so an
            // operations screen never shows a halted run with no explanation.
            failureReason: `Seeded in ${state} for the resume test.`,
            trigger: 'Manual',
            attempt: 1,
            correlationId: `corr-${Math.random().toString(36).slice(2, 10)}`,
            idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
          },
        });
      });
    };

    it('resumes a run blocked only by budget', async () => {
      const run = await seedRun('BlockedByBudget');

      const resumed = await credits().resumeRunsBlockedByBudget(scope(), platformOwnerId);
      assert.equal(resumed, 1);

      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
      );
      assert.equal(after.state, 'Queued');
      // Re-queued rather than run: every other check happens again when it is picked up.
      assert.equal(after.reservedAt, null);
    });

    it('leaves every other block alone', async () => {
      // Buying credits must not quietly clear a governance decision.
      const permission = await seedRun('BlockedByPermission');
      const connection = await seedRun('BlockedByConnection');

      const resumed = await credits().resumeRunsBlockedByBudget(scope(), platformOwnerId);
      assert.equal(resumed, 0);

      for (const run of [permission, connection]) {
        const after = await ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.agentRun.findUniqueOrThrow({ where: { id: run.id } }),
        );
        assert.notEqual(after.state, 'Queued');
      }
    });

    it('resumes as part of an approval', async () => {
      await seedRun('BlockedByBudget');
      const submitted = await submitRequest();

      const outcome = await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 40_000,
        note: 'Approved.',
      });

      assert.equal(outcome.resumedRuns, 1);
    });

    it('does not resume on a future-dated approval', async () => {
      // "after effective balance" — a grant that has not taken effect unblocks nothing.
      await seedRun('BlockedByBudget');
      const submitted = await submitRequest();

      const outcome = await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 40_000,
        effectiveFrom: new Date(Date.now() + 7 * 86_400_000),
        note: 'Effective next week.',
      });

      assert.equal(outcome.resumedRuns, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Everything still reconciles
  // -------------------------------------------------------------------------

  describe('the ledger still explains the balance', () => {
    it('reconciles after a top-up, a reallocation, an expiry and a revocation', async () => {
      // The property that matters across the whole prompt: no flow added here moves a balance
      // without an entry, so the Prompt 30 reconciliation still finds nothing.
      const submitted = await submitRequest();
      await credits().decideRequest({
        scope: scope(),
        operatorUserId: platformOwnerId,
        requestId: submitted.id,
        approve: true,
        approvedMinor: 40_000,
        note: 'Approved.',
      });

      await credits().reallocate({
        scope: scope(),
        actorUserId: adminUserId,
        from: { budgetScope: 'Company', subjectId: null },
        to: { budgetScope: 'Department', subjectId: '33333333-3333-4333-8333-333333333333' },
        amountMinor: 10_000,
        reason: 'Quarterly shift.',
      });

      const promo = await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'Promotional',
        amountMinor: 5_000,
        effectiveFrom: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        reason: 'Launch promotion.',
      });
      await credits().expireGrants({
        scope: scope(),
        actorUserId: platformOwnerId,
        now: new Date(Date.now() + 2 * 86_400_000),
      });

      const doomed = await credits().grant({
        scope: scope(),
        actorUserId: platformOwnerId,
        source: 'TopUp',
        amountMinor: 7_000,
        effectiveFrom: new Date(),
        reason: 'Purchased.',
      });
      await credits().revokeGrant({
        scope: scope(),
        actorUserId: platformOwnerId,
        grantId: doomed.id,
        reason: 'Payment failed.',
      });

      assert.notEqual(promo.id, doomed.id);

      const result = await cost().reconcile(scope());
      assert.deepEqual(result.findings, []);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The API
  // -------------------------------------------------------------------------

  describe('the API', () => {
    it('serves the credit vocabulary and says no payment is taken', async () => {
      const meta = await asAdmin(agent().get(`/tenants/${tenantId}/credits/meta`)).expect(200);
      assert.equal(meta.body.requestStates.length, 4);
      assert.match(meta.body.note, /does not take a payment/);
    });

    it('lets Finance list and decide over HTTP', async () => {
      const submitted = await submitRequest();

      const listed = await asPlatform(
        agent().get(`/platform/credits/requests?tenantId=${tenantId}`),
      ).expect(200);
      assert.equal(listed.body.length, 1);

      const decided = await asPlatform(
        agent()
          .post(`/platform/credits/requests/${submitted.id}/decide?tenantId=${tenantId}`)
          .send({ approve: true, approvedMinor: 40_000, note: 'Approved.' }),
      ).expect(201);
      assert.equal(decided.body.request.state, 'Approved');
    });

    it('refuses an unauthenticated request', async () => {
      await agent()
        .get(`/tenants/${tenantId}/credits/requests`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });
  });
});
