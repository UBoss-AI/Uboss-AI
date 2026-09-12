import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ALLOWED_AWARD_TRANSITIONS,
  REWARD_AWARD_STATUSES,
  settlementRouteFor,
  type Form2Objective,
  type Form2WorkflowStep,
  type ObjectiveRewardPanel,
  type RewardType,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { ObjectiveService } from '../src/objectives/objective.service.js';
import { PerformanceService } from '../src/performance/performance.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import {
  MockPayrollPayoutAdapter,
  PayoutAdapter,
  UnconfiguredPayoutAdapter,
} from '../src/rewards/payout-adapter.js';
import {
  ObjectiveRewardAwardController,
  SubjectRewardAwardController,
} from '../src/rewards/reward.controller.js';
import { RewardService } from '../src/rewards/reward.service.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
import {
  activateMembership,
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * A payout adapter a test can switch on and off.
 *
 * The product ships `UnconfiguredPayoutAdapter`, so "can this deployment pay anybody" has to be
 * controllable here — otherwise either the refusal path or the whole settlement lifecycle would be
 * untestable. `deliveredRealPayment` is **false** in every mode, because no mock may ever claim a
 * real payment happened.
 */
class SwitchablePayoutAdapter extends PayoutAdapter {
  readonly kind = 'mock-payroll';
  canSettle = false;
  nextReference = 'MOCK-0001';

  private readonly real = new MockPayrollPayoutAdapter(() => this.nextReference);

  async settle(payoutRequest: Parameters<PayoutAdapter['settle']>[0]) {
    if (!this.canSettle) {
      return new UnconfiguredPayoutAdapter().settle(payoutRequest);
    }
    return this.real.settle(payoutRequest);
  }
}

/**
 * Prompt 19A — objective extra work, bonus and reward controls.
 *
 * Four properties carry this prompt:
 *
 *   1. **Cash is never auto-paid.** Approving decides nothing about money. Settlement needs a
 *      connector, a second person, a positive amount and a cash award, and each is refused
 *      separately.
 *   2. **Approved points reach performance only through policy**, which is off by default. A
 *      refusal is an ending with a note, not an error.
 *   3. **The terms are snapshotted at assignment** and frozen, so nobody can raise the amount or
 *      soften the condition after the work was done.
 *   4. **Every step is attributed and every ending is final.**
 */
describe('reward rules and awards (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let payout: SwitchablePayoutAdapter;

  let tenantId: string;
  let otherTenantId: string;
  let departmentId: string;
  let otherDeptId: string;

  let headId: string;
  let headUboss: string;
  let approverId: string;
  let approverUboss: string;
  let financeId: string;
  let financeUboss: string;
  let policyAdminId: string;
  let workerId: string;
  let workerUboss: string;
  let ownerId: string;
  let otherMemberId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const rewards = () => app.get(RewardService);
  const objectives = () => app.get(ObjectiveService);
  const performance = () => app.get(PerformanceService);

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

    payout = new SwitchablePayoutAdapter();

    const moduleRef = await Test.createTestingModule({
      controllers: [ObjectiveRewardAwardController, SubjectRewardAwardController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        { provide: PayoutAdapter, useValue: payout },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        OrganizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        PerformanceService,
        ObjectiveService,
        RewardService,
        TenantContextService,
        Reflector,
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
    payout.canSettle = false;
    payout.nextReference = 'MOCK-0001';

    const provisioned = await ctx.provisioning.provision({
      slug: 'reward-co',
      name: 'Reward Co',
      firstMember: { email: 'first@reward.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-reward-co',
      name: 'Other Reward Co',
      firstMember: { email: 'first@other-reward.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;
    otherMemberId = other.user.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@reward.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        head: await member('UB-RWHD-0001', 'Reward Head'),
        // The named approver on the rule, and a *different* person from the one who settles.
        approver: await member('UB-RWAP-0001', 'Reward Approver'),
        finance: await member('UB-RWFN-0001', 'Reward Settler'),
        worker: await member('UB-RWWK-0001', 'Reward Worker'),
        // `performance:Administer` lives only on `CompanyAdmin` (Prompt 12B), so enabling the
        // reward-points policy needs one. A Head cannot, and that split is the right one: whether
        // a bonus can move somebody's score is company configuration, not a departmental call.
        policyAdmin: await member('UB-RWPA-0001', 'Policy Admin'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-RWOW-0001',
          email: 'owner@reward-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    headId = people.head.id;
    headUboss = people.head.ubossUniqueId;
    approverId = people.approver.id;
    approverUboss = people.approver.ubossUniqueId;
    financeId = people.finance.id;
    financeUboss = people.finance.ubossUniqueId;
    workerId = people.worker.id;
    policyAdminId = people.policyAdmin.id;
    workerUboss = people.worker.ubossUniqueId;
    ownerId = people.owner.id;

    const departments = await ctx.prisma.runAsPlatformOperation(async () => {
      const own = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', headUserId: headId },
      });
      const foreign = await ctx.prisma.client.department.create({
        data: { tenantId: other.tenant.id, name: 'Theirs', code: 'THR' },
      });
      return { own, foreign };
    });
    departmentId = departments.own.id;
    otherDeptId = departments.foreign.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      // `Head` caps at `MultipleDepartments`, so a single-department grant is the widest that
      // survives unnarrowed. Three Heads because the lifecycle deliberately needs three different
      // people: one to assign and find eligible, one to approve, one to settle.
      for (const userId of [headId, approverId, financeId]) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind: 'Head',
            scopeKind: 'Department',
            departmentIds: [departmentId],
            grantedByUserId: ownerId,
          },
        });
      }

      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: workerId,
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          grantedByUserId: ownerId,
        },
      });

      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: policyAdminId,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          grantedByUserId: ownerId,
        },
      });

      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: other.tenant.id,
          userId: otherMemberId,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [otherDeptId],
          grantedByUserId: ownerId,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const form2 = (): Form2Objective => ({
    objectiveName: 'GSPR checklist generation',
    departmentId,
    objectiveOwnerUserId: headId,
    expectedFinalResult: 'A complete Annex I checklist at zero critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Reward Head',
    formDate: '2026-09-10',
    responsibleOwnerUserId: headId,
    executionTeam: 'Regulatory',
  });

  const step = (): Form2WorkflowStep => ({
    position: 1,
    whoPersonName: 'Reward Worker',
    whoDesignation: 'Specialist',
    whoEngine: 'Human',
    whenTrigger: 'Objective start',
    whenFrequency: 'Once',
    whatExactWork: 'Collect evidence',
    inputWhatIsUsed: 'DHF',
    inputReceivedFrom: 'R&D',
    whereWorkIsDone: 'UBoss',
    outputWhatIsProduced: 'Index',
    outputSentTo: 'Reviewer',
    timeTaken: '2h',
    currentProblem: null,
    approval: 'NotRequired',
  });

  const panel = (overrides: Partial<ObjectiveRewardPanel> = {}): ObjectiveRewardPanel => ({
    applicable: true,
    rewardType: 'Cash',
    amountMinorUnits: 500_000,
    eligibilityCondition: 'Zero critical gaps, accepted by the Head',
    completionDeadline: '2026-10-15',
    evidence: 'Signed checklist',
    approverUserId: approverId,
    ...overrides,
  });

  /** An objective with a saved reward rule. */
  const objectiveWithRule = async (overrides: Partial<ObjectiveRewardPanel> = {}) => {
    const objective = await objectives().create({
      scope: scope(),
      actorUserId: headId,
      content: form2(),
      steps: [step()],
    });
    await objectives().saveReward({
      scope: scope(),
      actorUserId: headId,
      objectiveId: objective.id,
      panel: panel(overrides),
    });
    return objective;
  };

  /** Walk an award to `Approved`, using three different people as the lifecycle requires. */
  const approvedAward = async (overrides: Partial<ObjectiveRewardPanel> = {}) => {
    const objective = await objectiveWithRule(overrides);
    const assigned = await rewards().assign({
      scope: scope(),
      actorUserId: headId,
      objectiveId: objective.id,
      subjectUserId: workerId,
    });
    await rewards().markCompleted({
      scope: scope(),
      actorUserId: workerId,
      awardId: assigned.id,
    });
    await rewards().markEligible({ scope: scope(), actorUserId: headId, awardId: assigned.id });
    const approved = await rewards().approve({
      scope: scope(),
      actorUserId: approverId,
      awardId: assigned.id,
    });
    return { objective, award: approved };
  };

  // -------------------------------------------------------------------------
  // 1. The lifecycle
  // -------------------------------------------------------------------------

  describe('the lifecycle', () => {
    it('assigns an award straight to Assigned, snapshotting the rule’s terms', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      assert.equal(award.status, 'Assigned');
      assert.equal(award.rewardType, 'Cash');
      assert.equal(award.amountMinorUnits, 500_000);
      assert.equal(award.eligibilityCondition, 'Zero critical gaps, accepted by the Head');
      assert.equal(award.approverUserId, approverId);
      assert.equal(award.completionDeadline, '2026-10-15');
      assert.equal(award.assignedByUserId, headId);
      assert.equal(award.settlementRoute, 'Payout');
    });

    it('walks the client’s chain to Approved', async () => {
      const { award } = await approvedAward();
      assert.equal(award.status, 'Approved');
      assert.equal(award.decidedByUserId, approverId);
      assert.ok(award.decidedAt);
      // Approving is a decision, not a payment.
      assert.equal(award.payoutReference, null);
      assert.equal(award.payoutWasReal, false);
      assert.equal(award.settledAt, null);
    });

    it('reports the moves an award may make, from the shared table', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      assert.deepEqual(award.nextStatuses, [...ALLOWED_AWARD_TRANSITIONS.Assigned]);
    });

    it('refuses a move that skips a step', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      // Assigned -> Eligible skips the completion finding.
      await assert.rejects(
        rewards().markEligible({ scope: scope(), actorUserId: headId, awardId: award.id }),
        /cannot become/,
      );
    });

    it('refuses to assign under a rule that says no reward applies', async () => {
      const objective = await objectiveWithRule({
        applicable: false,
        rewardType: null,
        amountMinorUnits: null,
        eligibilityCondition: null,
        approverUserId: null,
      });

      await assert.rejects(
        rewards().assign({
          scope: scope(),
          actorUserId: headId,
          objectiveId: objective.id,
          subjectUserId: workerId,
        }),
        /no reward applies/,
      );
    });

    it('refuses to assign on an objective with no reward panel at all', async () => {
      const objective = await objectives().create({
        scope: scope(),
        actorUserId: headId,
        content: form2(),
        steps: [step()],
      });

      await assert.rejects(
        rewards().assign({
          scope: scope(),
          actorUserId: headId,
          objectiveId: objective.id,
          subjectUserId: workerId,
        }),
        /no Performance & Reward panel/,
      );
    });

    it('permits only one open award per person per rule', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().assign({
          scope: scope(),
          actorUserId: headId,
          objectiveId: objective.id,
          subjectUserId: workerId,
        }),
        /already has an open award/,
      );
    });

    it('lets a new award be assigned once the previous one is rejected', async () => {
      const objective = await objectiveWithRule();
      const first = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().reject({
        scope: scope(),
        actorUserId: approverId,
        awardId: first.id,
        reason: 'The condition was not met.',
      });

      const second = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      assert.equal(second.status, 'Assigned');
    });

    it('assigns two different people under one rule', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      const second = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: financeId,
      });
      assert.equal(second.status, 'Assigned');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Rejection
  // -------------------------------------------------------------------------

  describe('rejection', () => {
    it('rejects an assigned award, with a reason', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      const rejected = await rewards().reject({
        scope: scope(),
        actorUserId: approverId,
        awardId: award.id,
        reason: 'The work was not done.',
      });

      assert.equal(rejected.status, 'Rejected');
      assert.equal(rejected.decisionReason, 'The work was not done.');
      assert.equal(rejected.decidedByUserId, approverId);
      assert.equal(rejected.terminal, true);
    });

    it('refuses a rejection with no reason', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().reject({
          scope: scope(),
          actorUserId: approverId,
          awardId: award.id,
          reason: '   ',
        }),
        /needs a reason/,
      );
    });

    it('refuses to reopen a rejected award', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().reject({
        scope: scope(),
        actorUserId: approverId,
        awardId: award.id,
        reason: 'No.',
      });

      await assert.rejects(
        rewards().markCompleted({ scope: scope(), actorUserId: workerId, awardId: award.id }),
        /finished/,
      );
    });

    it('does not let an approved award be rejected', async () => {
      const { award } = await approvedAward();
      await assert.rejects(
        rewards().reject({
          scope: scope(),
          actorUserId: approverId,
          awardId: award.id,
          reason: 'Changed my mind.',
        }),
        /cannot become/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Do not auto-pay cash
  // -------------------------------------------------------------------------

  describe('cash is never auto-paid', () => {
    it('refuses to settle when no connector is configured', async () => {
      // This is the state the product ships in.
      const { award } = await approvedAward();
      assert.equal(payout.canSettle, false);

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /No approved payroll or payment connector/,
      );
    });

    it('says it will not record a payment it did not make', async () => {
      const { award } = await approvedAward();
      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /will not record a payment it did not make/,
      );
    });

    it('leaves the award Approved after a refused settlement', async () => {
      const { objective, award } = await approvedAward();
      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
      );

      const listed = await rewards().listForObjective({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
      });
      assert.equal(listed.awards[0]?.status, 'Approved');
      assert.equal(listed.awards[0]?.payoutReference, null);
    });

    it('refuses to settle an award that has not been approved', async () => {
      payout.canSettle = true;
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /Only an approved award/,
      );
    });

    it('refuses to let the approver settle their own approval', async () => {
      // Four eyes on the money. Enforced in the service and by a CHECK constraint.
      payout.canSettle = true;
      const { award } = await approvedAward();

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: approverId, awardId: award.id }),
        /cannot also pay it out/,
      );
    });

    it('settles through the connector when a second person does it', async () => {
      payout.canSettle = true;
      payout.nextReference = 'MOCK-PAY-9001';
      const { award } = await approvedAward();

      const settled = await rewards().settle({
        scope: scope(),
        actorUserId: financeId,
        awardId: award.id,
      });

      assert.equal(settled.status, 'Settled');
      assert.equal(settled.payoutReference, 'MOCK-PAY-9001');
      assert.equal(settled.settledByUserId, financeId);
      assert.ok(settled.settledAt);
      // The most important assertion in this file: a mock never claims a real payment.
      assert.equal(settled.payoutWasReal, false);
    });

    it('records in the audit trail that no real payment was made', async () => {
      payout.canSettle = true;
      const { award } = await approvedAward();
      await rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'reward.award_settled', resourceId: award.id },
        }),
      );
      assert.ok(event);
      assert.equal((event.metadata as Record<string, unknown>)['payoutWasReal'], false);
      assert.match(event.summary ?? '', /No real payment was made/i);
    });

    it('refuses to settle a non-cash award', async () => {
      payout.canSettle = true;
      const { award } = await approvedAward({
        rewardType: 'Points',
        amountMinorUnits: 250,
      });

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /not settled through payroll/,
      );
    });

    it('refuses to settle twice', async () => {
      payout.canSettle = true;
      const { award } = await approvedAward();
      await rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id });

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /Only an approved award/,
      );
    });

    it('leaves the award Approved when the connector itself fails', async () => {
      // A failed payout must not leave a half-settled award.
      payout.canSettle = true;
      payout.nextReference = 'fail:the provider rejected the account';
      const { objective, award } = await approvedAward();

      await assert.rejects(
        rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /provider rejected/,
      );

      const listed = await rewards().listForObjective({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
      });
      assert.equal(listed.awards[0]?.status, 'Approved');
    });

    it('refuses to change a settled award in the database', async () => {
      payout.canSettle = true;
      const { award } = await approvedAward();
      await rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id });

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.rewardAward.update({
            where: { id: award.id },
            data: { payoutReference: 'REWRITTEN' },
          }),
        ),
        /cannot be changed/,
      );
    });

    it('refuses the settle route when no connector is configured', async () => {
      // The same refusal through HTTP, because a screen calls the route rather than the service
      // and a 500 here would look like a bug rather than a policy.
      const { objective, award } = await approvedAward();
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/rewards/awards/${award.id}/settle`)
          .send({}),
        financeUboss,
      );
      assert.equal(response.status, 400);
      assert.match(response.body.message as string, /No approved payroll or payment connector/);
    });

    it('settles through the route once a connector is configured', async () => {
      payout.canSettle = true;
      payout.nextReference = 'MOCK-ROUTE-1';
      const { objective, award } = await approvedAward();

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/rewards/awards/${award.id}/settle`)
          .send({ currency: 'INR' }),
        financeUboss,
      );
      assert.equal(response.status, 201);
      assert.equal(response.body.status, 'Settled');
      assert.equal(response.body.payoutReference, 'MOCK-ROUTE-1');
      // Reported on the wire, so a screen cannot render "Settled" as a real payment.
      assert.equal(response.body.payoutWasReal, false);
    });

    it('says in its meta whether this deployment can pay anybody', async () => {
      const objective = await objectiveWithRule();
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/rewards/meta`),
        headUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.payoutConnector.canSettle, false);
      assert.equal(response.body.payoutConnector.deliversRealPayment, false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Points reach performance only through policy
  // -------------------------------------------------------------------------

  describe('points reach performance only through policy', () => {
    it('writes no performance event when policy has not enabled it', async () => {
      // The default. A company that has not decided has not agreed.
      const { award } = await approvedAward({ rewardType: 'Points', amountMinorUnits: 250 });

      const recorded = await rewards().record({
        scope: scope(),
        actorUserId: financeId,
        awardId: award.id,
      });

      assert.equal(recorded.status, 'Recorded');
      assert.equal(recorded.performanceEventId, null);
      assert.match(recorded.performanceNote ?? '', /only through policy/i);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId, subjectUserId: workerId } }),
      );
      assert.equal(events, 0);
    });

    it('writes a performance event once policy permits it', async () => {
      await performance().setPolicy({
        scope: scope(),
        actorUserId: policyAdminId,
        reason: 'Enable reward points reaching the score, as the client requires by policy.',
        changes: { rewardPointsReachPerformance: true },
      });

      const { award } = await approvedAward({ rewardType: 'Points', amountMinorUnits: 250 });
      const recorded = await rewards().record({
        scope: scope(),
        actorUserId: financeId,
        awardId: award.id,
      });

      assert.equal(recorded.status, 'Recorded');
      assert.ok(recorded.performanceEventId);
      assert.equal(recorded.performanceNote, null);

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.findUnique({
          where: { id: recorded.performanceEventId ?? '' },
        }),
      );
      assert.ok(event);
      assert.equal(event.subjectUserId, workerId);
      assert.equal(event.kind, 'ManualAdjustment');
      assert.equal(event.sourceKind, 'reward_award');
      assert.equal(event.sourceId, award.id);
      assert.equal(event.points, 250);
    });

    it('never writes a performance event for a cash award', async () => {
      // Being paid is not a performance outcome. Enforced by a CHECK as well as by the route.
      await performance().setPolicy({
        scope: scope(),
        actorUserId: policyAdminId,
        reason: 'Enabled, to prove cash still does not score.',
        changes: { rewardPointsReachPerformance: true },
      });
      payout.canSettle = true;

      const { award } = await approvedAward();
      const settled = await rewards().settle({
        scope: scope(),
        actorUserId: financeId,
        awardId: award.id,
      });

      assert.equal(settled.performanceEventId, null);
      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId, subjectUserId: workerId } }),
      );
      assert.equal(events, 0);
    });

    it('records a recognition award with no points and explains the absence', async () => {
      const { award } = await approvedAward({
        rewardType: 'Recognition',
        amountMinorUnits: null,
      });

      const recorded = await rewards().record({
        scope: scope(),
        actorUserId: financeId,
        awardId: award.id,
      });

      assert.equal(recorded.status, 'Recorded');
      assert.equal(recorded.performanceEventId, null);
      assert.match(recorded.performanceNote ?? '', /carries no points/i);
    });

    it('refuses to record a cash award', async () => {
      const { award } = await approvedAward();
      await assert.rejects(
        rewards().record({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /settled through payroll, not recorded/,
      );
    });

    it('refuses to record an award that has not been approved', async () => {
      const objective = await objectiveWithRule({ rewardType: 'Points', amountMinorUnits: 100 });
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().record({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /Only an approved award/,
      );
    });

    it('says in the audit trail whether policy permitted the points', async () => {
      const { award } = await approvedAward({ rewardType: 'Points', amountMinorUnits: 250 });
      await rewards().record({ scope: scope(), actorUserId: financeId, awardId: award.id });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'reward.award_recorded', resourceId: award.id },
        }),
      );
      assert.ok(event);
      const metadata = event.metadata as Record<string, unknown>;
      assert.equal(metadata['policyPermitsRewardPoints'], false);
      assert.equal(metadata['performanceEventId'], null);
      assert.equal(metadata['payoutWasReal'], false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. The terms are a promise
  // -------------------------------------------------------------------------

  describe('the promise cannot move after assignment', () => {
    it('keeps the award’s terms when the rule is edited afterwards', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      // The rule is raised after the fact. The award must still promise what it promised.
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        panel: panel({ amountMinorUnits: 5_000_000, eligibilityCondition: 'Anything at all' }),
      });

      const listed = await rewards().listForObjective({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
      });
      assert.equal(listed.awards[0]?.amountMinorUnits, 500_000);
      assert.equal(
        listed.awards[0]?.eligibilityCondition,
        'Zero critical gaps, accepted by the Head',
      );
      assert.equal(award.amountMinorUnits, 500_000);
    });

    it('refuses to raise an assigned award’s amount in the database', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.rewardAward.update({
            where: { id: award.id },
            data: { amountMinorUnits: 9_000_000 },
          }),
        ),
        /what it promises cannot change/,
      );
    });

    it('refuses to swap an assigned award’s approver or subject', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      for (const data of [{ approverUserId: headId }, { subjectUserId: financeId }]) {
        await assert.rejects(
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.rewardAward.update({ where: { id: award.id }, data }),
          ),
          /what it promises cannot change/,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 6. Who may do what
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    it('lets the subject report their own work complete', async () => {
      // An Employee with OwnWork scope. Reporting your own completion needs no wider permission.
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      const completed = await rewards().markCompleted({
        scope: scope(),
        actorUserId: workerId,
        awardId: award.id,
      });
      assert.equal(completed.status, 'Completed');
      assert.equal(completed.completedAt !== null, true);
    });

    it('does not let the subject declare their own work eligible', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().markCompleted({ scope: scope(), actorUserId: workerId, awardId: award.id });

      await assert.rejects(
        rewards().markEligible({ scope: scope(), actorUserId: workerId, awardId: award.id }),
        /cannot declare your own work eligible/,
      );
    });

    it('does not let the subject approve their own award', async () => {
      const objective = await objectiveWithRule({ approverUserId: workerId });
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().markCompleted({ scope: scope(), actorUserId: workerId, awardId: award.id });
      await rewards().markEligible({ scope: scope(), actorUserId: headId, awardId: award.id });

      // Even though the rule names them as the approver, they are the subject.
      await assert.rejects(
        rewards().approve({ scope: scope(), actorUserId: workerId, awardId: award.id }),
        /cannot approve your own reward/,
      );
    });

    it('lets only the approver named on the rule approve it', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().markCompleted({ scope: scope(), actorUserId: workerId, awardId: award.id });
      await rewards().markEligible({ scope: scope(), actorUserId: headId, awardId: award.id });

      // `financeId`, not `headId`: the Head *created* this objective, so the separation-of-duties
      // engine refuses them first with "you cannot approve something you created" — which is the
      // right refusal and a stronger one. To exercise the named-approver rule specifically the
      // actor has to be somebody who neither created it nor is named on it, and this Head is both
      // of those while still holding `objective:Approve`.
      await assert.rejects(
        rewards().approve({ scope: scope(), actorUserId: financeId, awardId: award.id }),
        /Only the approver named on this reward/,
      );

      const approved = await rewards().approve({
        scope: scope(),
        actorUserId: approverId,
        awardId: award.id,
      });
      assert.equal(approved.status, 'Approved');
    });

    it('refuses an Employee assigning a reward at the route', async () => {
      const objective = await objectiveWithRule();
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/rewards/awards`)
          .send({ subjectUserId: workerId }),
        workerUboss,
      );
      assert.equal(response.status, 403);
    });

    it('refuses an Employee approving at the route', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      const response = await as(
        agent()
          .post(
            `/tenants/${tenantId}/objectives/${objective.id}/rewards/awards/${award.id}/approve`,
          )
          .send({}),
        workerUboss,
      );
      assert.equal(response.status, 403);
    });

    it('lets the approver approve through the route', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      await rewards().markCompleted({ scope: scope(), actorUserId: workerId, awardId: award.id });
      await rewards().markEligible({ scope: scope(), actorUserId: headId, awardId: award.id });

      const response = await as(
        agent()
          .post(
            `/tenants/${tenantId}/objectives/${objective.id}/rewards/awards/${award.id}/approve`,
          )
          .send({}),
        approverUboss,
      );
      assert.equal(response.status, 201);
      assert.equal(response.body.status, 'Approved');
    });

    it('refuses a rejection with no reason at the route', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/rewards/awards/${award.id}/reject`)
          .send({}),
        approverUboss,
      );
      assert.equal(response.status, 400);
    });

    it('shows a person their own awards', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      const response = await as(
        agent().get(`/tenants/${tenantId}/reward-awards/${workerId}`),
        workerUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.awards.length, 1);
    });

    it('shows a department-scoped Head their own awards', async () => {
      // The gap this found: `listForSubject` used to apply the row-level scope check to everybody,
      // and a person's own award carries no department on the resource descriptor — so a
      // `Department`-scoped Head asking about their own bonus was refused as unevaluable. Being
      // told you may not see your own bonus is absurd, and a uniform check produced exactly that.
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: financeId,
      });

      const mine = await rewards().listForSubject({
        scope: scope(),
        actorUserId: financeId,
        subjectUserId: financeId,
      });
      assert.equal(mine.awards.length, 1);
    });

    it('does not show one employee another’s awards', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: financeId,
      });

      const response = await as(
        agent().get(`/tenants/${tenantId}/reward-awards/${financeId}`),
        workerUboss,
      );
      assert.equal(response.status, 403);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('refuses to touch another company’s award', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().markCompleted({
          scope: otherScope(),
          actorUserId: otherMemberId,
          awardId: award.id,
        }),
        /no such reward award/i,
      );
    });

    it('refuses to list another company’s awards', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      await assert.rejects(
        rewards().listForObjective({
          scope: otherScope(),
          actorUserId: otherMemberId,
          objectiveId: objective.id,
        }),
        /no such objective/i,
      );
    });

    it('returns nothing for a subject in another company', async () => {
      const objective = await objectiveWithRule();
      await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      const theirs = await rewards().listForSubject({
        scope: otherScope(),
        actorUserId: otherMemberId,
        subjectUserId: otherMemberId,
      });
      assert.deepEqual(theirs.awards, []);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The audit trail
  // -------------------------------------------------------------------------

  describe('audit', () => {
    it('records every step of the chain, attributed to whoever did it', async () => {
      payout.canSettle = true;
      const { award } = await approvedAward();
      await rewards().settle({ scope: scope(), actorUserId: financeId, awardId: award.id });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceType: 'reward_award' },
          orderBy: { occurredAt: 'asc' },
        }),
      );

      const actions = events.map((event) => event.action);
      assert.ok(actions.includes('reward.award_assigned'));
      assert.ok(actions.includes('reward.award_completed'));
      assert.ok(actions.includes('reward.award_eligible'));
      assert.ok(actions.includes('reward.award_approved'));
      assert.ok(actions.includes('reward.award_settled'));

      const byAction = new Map(events.map((event) => [event.action, event.actorUserId]));
      assert.equal(byAction.get('reward.award_completed'), workerId);
      assert.equal(byAction.get('reward.award_approved'), approverId);
      assert.equal(byAction.get('reward.award_settled'), financeId);
    });

    it('says on assignment that nothing is payable yet', async () => {
      const objective = await objectiveWithRule();
      const award = await rewards().assign({
        scope: scope(),
        actorUserId: headId,
        objectiveId: objective.id,
        subjectUserId: workerId,
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'reward.award_assigned', resourceId: award.id },
        }),
      );
      assert.ok(event);
      assert.match(event.summary ?? '', /Nothing is payable/i);
      assert.equal((event.metadata as Record<string, unknown>)['autoPaid'], false);
    });
  });

  // -------------------------------------------------------------------------
  // 9. The vocabulary the screen will render
  // -------------------------------------------------------------------------

  describe('meta', () => {
    it('serves every status with its transitions and tone', async () => {
      const objective = await objectiveWithRule();
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/rewards/meta`),
        headUboss,
      );

      const statuses = response.body.statuses as { status: string; next: string[] }[];
      assert.equal(statuses.length, REWARD_AWARD_STATUSES.length);
      for (const entry of statuses) {
        assert.deepEqual(
          entry.next,
          ALLOWED_AWARD_TRANSITIONS[entry.status as (typeof REWARD_AWARD_STATUSES)[number]],
        );
      }
    });

    it('states that approving is not a payment', async () => {
      const objective = await objectiveWithRule();
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/rewards/meta`),
        headUboss,
      );
      assert.match(response.body.note as string, /decision, not a payment/i);
      assert.match(response.body.note as string, /only if the company/i);
    });

    it('routes each reward type the way the shared helper does', async () => {
      for (const rewardType of ['Cash', 'Points', 'Recognition', 'Other'] as RewardType[]) {
        assert.ok(settlementRouteFor(rewardType));
      }
      assert.equal(settlementRouteFor('Cash'), 'Payout');
      assert.equal(settlementRouteFor('Points'), 'PerformancePoints');
    });
  });
});
