import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { PerformanceController } from '../src/performance/performance.controller.js';
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
 * Prompt 12B — performance score and badge engine.
 *
 * Seven properties carry this prompt:
 *
 *   1. **The score is derived**, so it always equals the sum of its ledger — and a policy change
 *      re-derives the *level* without rewriting past *points*.
 *   2. **A positive event needs both halves**: completed in time **and** accepted. On-time work
 *      that was rejected does not score positively.
 *   3. **Event handling is idempotent** at the database, not by convention.
 *   4. **An approved blocker neutralises**, and may only neutralise something that cost points.
 *   5. **The ladder is Bronze → Diamond with configurable thresholds**, and every transition is
 *      kept as history with only one current level per person.
 *   6. **The history is company-specific and snapshotted on exit.**
 *   7. **The ledger is append-only** and tenant-isolated.
 */
describe('performance score and badges (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let departmentId: string;
  let adminId: string;
  let adminUboss: string;
  let managerId: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let peerId: string;
  let ownerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
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

    const moduleRef = await Test.createTestingModule({
      controllers: [PerformanceController],
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
        PlatformRepository,
        OrganizationRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
        PerformanceService,
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

    const provisioned = await ctx.provisioning.provision({
      slug: 'perf-co',
      name: 'Performance Co',
      firstMember: { email: 'first@perf.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-perf-co',
      name: 'Other Performance Co',
      firstMember: { email: 'first@other-perf.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@perf.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-PADM-0001', 'Performance Admin'),
        manager: await member('UB-PMGR-0001', 'Performance Manager'),
        employee: await member('UB-PEMP-0001', 'Performance Employee'),
        peer: await member('UB-PPER-0001', 'Performance Peer'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-POWN-0001',
          email: 'owner@perf-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    peerId = people.peer.id;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      const department = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Operations', code: 'OPS' },
      });
      departmentId = department.id;

      // Employment records, so a score is attached to an employment and the reporting line the
      // manager's `TeamSubtree` scope needs actually exists.
      await ctx.prisma.client.employmentRecord.create({
        data: { tenantId, userId: adminId, employeeId: 'P-001', designation: 'MD', departmentId },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: managerId,
          employeeId: 'P-002',
          designation: 'Head of Operations',
          departmentId,
          reportingManagerUserId: adminId,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: employeeId,
          employeeId: 'P-003',
          designation: 'Operations Executive',
          departmentId,
          reportingManagerUserId: managerId,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: peerId,
          employeeId: 'P-004',
          designation: 'Operations Executive',
          departmentId,
          reportingManagerUserId: adminId,
        },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [managerId, 'Manager', 'TeamSubtree'],
        [employeeId, 'Employee', 'OwnWork'],
        [peerId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** Record one event for the employee, from a named source. */
  const record = (
    kind: 'OnTimeAccepted' | 'LateCompletion' | 'Missed' | 'QualityRejected',
    sourceId: string,
    subject = employeeId,
  ) =>
    performance().recordEvent({
      scope: scope(),
      subjectUserId: subject,
      kind,
      sourceKind: 'todo',
      sourceId,
    });

  const scoreOf = async (subject = employeeId) =>
    (
      await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: subject,
      })
    ).score;

  // =========================================================================
  describe('the policy', () => {
    it('gives a company a baseline version 1 with the documented defaults', async () => {
      const policy = await performance().activePolicy(scope());

      assert.equal(policy.version, 1);
      assert.equal(policy.onTimeAcceptedPoints, 10);
      assert.equal(policy.lateCompletionPoints, -5);
      assert.equal(policy.missedPoints, -15);
      assert.equal(policy.qualityRejectedPoints, -10);
      assert.deepEqual(
        [
          policy.bronzeThreshold,
          policy.silverThreshold,
          policy.goldThreshold,
          policy.platinumThreshold,
          policy.diamondThreshold,
        ],
        [0, 100, 300, 600, 1000],
      );
      assert.equal(policy.blockersNeutraliseFully, true);
      assert.equal(policy.supersededAt, null);
    });

    it('supersedes rather than edits, so a past score keeps the rules that produced it', async () => {
      const first = await performance().activePolicy(scope());
      await record('OnTimeAccepted', 'T-1');

      const second = await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'Raising the on-time reward after the quarterly review.',
        changes: { onTimeAcceptedPoints: 25 },
      });

      assert.equal(second.version, 2);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performancePolicy.findMany({
          where: { tenantId },
          orderBy: { version: 'asc' },
        }),
      );
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0]?.supersededAt, null);
      assert.equal(rows[1]?.supersededAt, null);

      // The event scored under version 1 keeps its ten points. Rewriting it would restate
      // history the person cannot re-earn.
      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.findFirst({ where: { tenantId } }),
      );
      assert.equal(event?.points, 10);
      assert.equal(event?.policyVersion, 1);
      assert.equal(event?.policyId, first.id);

      // The next event scores under version 2.
      await record('OnTimeAccepted', 'T-2');
      assert.equal(await scoreOf(), 35);
    });

    it('refuses a policy change with no reason', async () => {
      await assert.rejects(
        () =>
          performance().setPolicy({
            scope: scope(),
            actorUserId: adminId,
            reason: '   ',
            changes: { goldThreshold: 250 },
          }),
        /needs a reason/i,
      );
    });

    it('lets the database refuse a second active version', async () => {
      const active = await performance().activePolicy(scope());

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.performancePolicy.create({
              data: {
                tenantId,
                version: active.version + 1,
                reason: 'A second active version, which must not be possible.',
              },
            }),
          ),
        /one_active_performance_policy_per_tenant/i,
      );
    });

    it('lets the database refuse thresholds that do not ascend', async () => {
      await assert.rejects(
        () =>
          performance().setPolicy({
            scope: scope(),
            actorUserId: adminId,
            reason: 'Gold below Silver, which would stop the ladder being a ladder.',
            changes: { silverThreshold: 400, goldThreshold: 300 },
          }),
        /badge_thresholds_ascend/i,
      );
    });

    it('lets the database refuse a policy that rewards a missed deadline', async () => {
      await assert.rejects(
        () =>
          performance().setPolicy({
            scope: scope(),
            actorUserId: adminId,
            reason: 'Positive points for missing work, which inverts the whole engine.',
            changes: { missedPoints: 15 },
          }),
        /performance_points_have_the_right_sign/i,
      );
    });

    it('needs performance:Administer, not merely View', async () => {
      await assert.rejects(
        () =>
          performance().setPolicy({
            scope: scope(),
            actorUserId: employeeId,
            reason: 'An employee raising their own reward.',
            changes: { onTimeAcceptedPoints: 500 },
          }),
        /forbidden|not permitted|denied/i,
      );
    });
  });

  // =========================================================================
  describe('scoring', () => {
    it('scores each outcome with its policy points and sums them', async () => {
      await record('OnTimeAccepted', 'T-1');
      await record('OnTimeAccepted', 'T-2');
      await record('LateCompletion', 'T-3');
      await record('Missed', 'T-4');

      // 10 + 10 - 5 - 15
      assert.equal(await scoreOf(), 0);
    });

    it('does not reward on-time work that was rejected', async () => {
      // Both halves of the client's rule: completed in the required time **and** accepted. A
      // rejected submission scoring positively is how a score stops meaning anything.
      const { event } = await record('QualityRejected', 'T-1');
      assert.equal(event.points, -10);
      assert.equal(await scoreOf(), -10);
    });

    it('reports the score as the sum of the events it shows', async () => {
      await record('OnTimeAccepted', 'T-1');
      await record('Missed', 'T-2');

      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });

      const sum = view.recentEvents.reduce((total, event) => total + event.points, 0);
      assert.equal(view.score, sum);
      assert.equal(view.policyVersion, 1);
    });

    it('reports on-time delivery as a percentage of completed work', async () => {
      await record('OnTimeAccepted', 'T-1');
      await record('OnTimeAccepted', 'T-2');
      await record('OnTimeAccepted', 'T-3');
      await record('LateCompletion', 'T-4');

      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      assert.equal(view.onTimePercent, 75);
    });

    it('reports no percentage rather than zero when nothing is completed', async () => {
      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      // Zero would read as "never delivered on time", which is a different claim from
      // "has not delivered anything yet".
      assert.equal(view.onTimePercent, null);
      assert.equal(view.score, 0);
    });

    it('links the event to the employment record, so a score is company-specific', async () => {
      const { event } = await record('OnTimeAccepted', 'T-1');
      const employment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.findFirst({ where: { tenantId, userId: employeeId } }),
      );
      assert.equal(event.employmentRecordId, employment?.id);
    });

    it('refuses an event that does not name its source', async () => {
      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'OnTimeAccepted',
            sourceKind: '  ',
            sourceId: '  ',
          }),
        /must name what produced it/i,
      );
    });
  });

  // =========================================================================
  describe('idempotency', () => {
    it('scores the same source once, however many times it is reported', async () => {
      const first = await record('OnTimeAccepted', 'T-1');
      assert.equal(first.alreadyRecorded, false);

      const again = await record('OnTimeAccepted', 'T-1');
      assert.equal(again.alreadyRecorded, true);
      assert.equal(again.event.id, first.event.id);

      assert.equal(await scoreOf(), 10);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId } }),
      );
      assert.equal(count, 1);
    });

    it('enforces it at the database, not only in the service', async () => {
      const { event } = await record('OnTimeAccepted', 'T-1');

      // The service's read-then-write is not atomic against a concurrent caller. The unique
      // index is what makes a duplicate impossible rather than merely unlikely.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.performanceEvent.create({
              data: {
                tenantId,
                subjectUserId: employeeId,
                kind: 'OnTimeAccepted',
                sourceKind: 'todo',
                sourceId: 'T-1',
                points: 10,
                policyId: event.policyId,
                policyVersion: 1,
              },
            }),
          ),
        /unique|duplicate/i,
      );
    });

    it('keeps a different outcome for the same source as its own event', async () => {
      // A task can be late *and* later rejected. Two facts, two rows — the key is per kind on
      // purpose, so recording one does not swallow the other.
      await record('LateCompletion', 'T-1');
      await record('QualityRejected', 'T-1');
      assert.equal(await scoreOf(), -15);
    });
  });

  // =========================================================================
  describe('approved blockers', () => {
    it('neutralises a negative event fully by default', async () => {
      const missed = await record('Missed', 'T-1');
      assert.equal(await scoreOf(), -15);

      await performance().recordEvent({
        scope: scope(),
        subjectUserId: employeeId,
        kind: 'BlockerNeutralised',
        sourceKind: 'exception',
        sourceId: 'X-1',
        neutralisesEventId: missed.event.id,
        reason: 'The upstream approval was outstanding for the whole window.',
        recordedByUserId: adminId,
      });

      assert.equal(await scoreOf(), 0);

      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      // The forgiven event is still visible and marked, because it happened.
      const missedRow = view.recentEvents.find((event) => event.kind === 'Missed');
      assert.equal(missedRow?.neutralised, true);
    });

    it('neutralises half when the policy says so', async () => {
      await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'A blocker mitigates a missed deadline but does not erase it.',
        changes: { blockersNeutraliseFully: false },
      });

      const missed = await record('Missed', 'T-1');
      await performance().recordEvent({
        scope: scope(),
        subjectUserId: employeeId,
        kind: 'BlockerNeutralised',
        sourceKind: 'exception',
        sourceId: 'X-1',
        neutralisesEventId: missed.event.id,
        reason: 'Partly outside their control.',
        recordedByUserId: adminId,
      });

      // -15 forgiven by +7, rounded towards zero so partial forgiveness is never a reward.
      assert.equal(await scoreOf(), -8);
    });

    it('refuses to neutralise something that did not cost anything', async () => {
      const good = await record('OnTimeAccepted', 'T-1');

      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'BlockerNeutralised',
            sourceKind: 'exception',
            sourceId: 'X-1',
            neutralisesEventId: good.event.id,
            reason: 'Trying to double a positive event.',
            recordedByUserId: adminId,
          }),
        /nothing to neutralise/i,
      );
    });

    it('refuses a neutralisation with no reason and one that names nothing', async () => {
      const missed = await record('Missed', 'T-1');

      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'BlockerNeutralised',
            sourceKind: 'exception',
            sourceId: 'X-1',
            neutralisesEventId: missed.event.id,
            reason: '   ',
            recordedByUserId: adminId,
          }),
        /needs a reason/i,
      );

      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'BlockerNeutralised',
            sourceKind: 'exception',
            sourceId: 'X-2',
            reason: 'Forgiving something unnamed.',
            recordedByUserId: adminId,
          }),
        /name the event it cancels/i,
      );
    });

    it('refuses a manual adjustment with no reason and one with no points', async () => {
      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'ManualAdjustment',
            sourceKind: 'manual',
            sourceId: 'M-1',
            points: 50,
            recordedByUserId: adminId,
          }),
        /needs a reason/i,
      );

      await assert.rejects(
        () =>
          performance().recordEvent({
            scope: scope(),
            subjectUserId: employeeId,
            kind: 'ManualAdjustment',
            sourceKind: 'manual',
            sourceId: 'M-2',
            reason: 'A correction with no amount.',
            recordedByUserId: adminId,
          }),
        /must state its points/i,
      );
    });

    it('lets the database refuse a discretionary event with no reason', async () => {
      const policy = await performance().activePolicy(scope());

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.performanceEvent.create({
              data: {
                tenantId,
                subjectUserId: employeeId,
                kind: 'ManualAdjustment',
                sourceKind: 'manual',
                sourceId: 'M-3',
                points: 100,
                policyId: policy.id,
                policyVersion: policy.version,
              },
            }),
          ),
        /discretionary_performance_event_has_a_reason/i,
      );
    });
  });

  // =========================================================================
  describe('the badge ladder', () => {
    /** Enough on-time work to reach `points`. */
    const earn = async (points: number, prefix: string) => {
      for (let index = 0; index < points / 10; index += 1) {
        await record('OnTimeAccepted', `${prefix}-${index}`);
      }
    };

    it('starts at Bronze and climbs through every configured threshold', async () => {
      const level = async () =>
        (
          await performance().viewFor({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
          })
        ).level;

      await earn(10, 'B');
      assert.equal(await level(), 'Bronze');

      await earn(100, 'S');
      assert.equal(await level(), 'Silver');

      await earn(200, 'G');
      assert.equal(await level(), 'Gold');

      await earn(300, 'P');
      assert.equal(await level(), 'Platinum');

      await earn(400, 'D');
      assert.equal(await level(), 'Diamond');
    });

    it('keeps every level as history, closing the previous period', async () => {
      await earn(110, 'S');

      const history = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.badgeHistory.findMany({
          where: { tenantId, subjectUserId: employeeId },
          orderBy: { startedAt: 'asc' },
        }),
      );

      assert.equal(history.length, 2);
      assert.equal(history[0]?.level, 'Bronze');
      assert.notEqual(history[0]?.endedAt, null);
      assert.equal(history[1]?.level, 'Silver');
      assert.equal(history[1]?.endedAt, null);
      // The score at the moment the level changed — 100, the tenth on-time delivery — not the
      // 110 they have now. That is the point of storing it: the transition is explicable
      // without re-deriving, and it says what earned the level rather than what came after.
      assert.equal(history[1]?.scoreAtChange, 100);
    });

    it('lets the database refuse a second current level', async () => {
      await earn(10, 'B');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.badgeHistory.create({
              data: { tenantId, subjectUserId: employeeId, level: 'Diamond', scoreAtChange: 9999 },
            }),
          ),
        /one_current_badge_per_person/i,
      );
    });

    it('re-derives the level after a threshold change without rewriting points', async () => {
      await earn(120, 'S');
      assert.equal(
        (
          await performance().viewFor({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
          })
        ).level,
        'Silver',
      );

      await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'Silver was too easy to reach; raising it after the first quarter.',
        changes: { silverThreshold: 200 },
      });

      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      // The level moves, because levels are a reading of the current policy. The points do not.
      assert.equal(view.level, 'Bronze');
      assert.equal(view.score, 120);
      assert.deepEqual(view.nextLevel, { level: 'Silver', pointsAway: 80 });
    });

    it('reports no next level at the top of the ladder', async () => {
      await performance().recordEvent({
        scope: scope(),
        subjectUserId: employeeId,
        kind: 'ManualAdjustment',
        sourceKind: 'manual',
        sourceId: 'M-1',
        points: 1200,
        reason: 'Opening balance carried over from the previous system.',
        recordedByUserId: adminId,
      });

      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      assert.equal(view.level, 'Diamond');
      assert.equal(view.nextLevel, null);
    });

    it('stays on the ladder below the lowest threshold rather than inventing a rung', async () => {
      await record('Missed', 'T-1');
      const view = await performance().viewFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });
      // Bronze with a negative score, shown honestly. A sixth level would change the client's
      // five.
      assert.equal(view.level, 'Bronze');
      assert.equal(view.score, -15);
    });
  });

  // =========================================================================
  describe('the exit snapshot', () => {
    it('freezes the record when employment ends', async () => {
      await record('OnTimeAccepted', 'T-1');
      await record('OnTimeAccepted', 'T-2');

      const snapshot = await ctx.prisma.runInTenantTransaction(scope(), () =>
        performance().snapshotOnExitWithinCurrentScope(scope(), employeeId),
      );
      assert.deepEqual(snapshot, { level: 'Bronze', score: 20 });

      const history = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.badgeHistory.findMany({
          where: { tenantId, subjectUserId: employeeId },
          orderBy: { startedAt: 'asc' },
        }),
      );

      const exit = history.at(-1);
      assert.equal(exit?.isExitSnapshot, true);
      assert.equal(exit?.scoreAtChange, 20);
      // Nothing is left open, so the history stops moving after the person leaves.
      assert.equal(
        history.every((row) => row.endedAt !== null),
        true,
      );
    });

    it('writes nothing for somebody who never scored', async () => {
      const snapshot = await ctx.prisma.runInTenantTransaction(scope(), () =>
        performance().snapshotOnExitWithinCurrentScope(scope(), peerId),
      );
      // A snapshot would imply a standing they never held.
      assert.equal(snapshot, null);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.badgeHistory.count({ where: { tenantId, subjectUserId: peerId } }),
      );
      assert.equal(count, 0);
    });

    it('preserves every event: the snapshot deletes nothing', async () => {
      await record('OnTimeAccepted', 'T-1');
      await record('Missed', 'T-2');

      await ctx.prisma.runInTenantTransaction(scope(), () =>
        performance().snapshotOnExitWithinCurrentScope(scope(), employeeId),
      );

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({
          where: { tenantId, subjectUserId: employeeId },
        }),
      );
      assert.equal(count, 2);
    });
  });

  // =========================================================================
  describe('the ledger is append-only', () => {
    it('refuses an update and a delete from the application role', async () => {
      await record('OnTimeAccepted', 'T-1');

      // The score is derived from these rows, so rewriting one silently restates somebody's
      // performance. A correction is a new ManualAdjustment with a reason.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE performance_events SET points = 999 WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `DELETE FROM performance_events WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('tenant isolation', () => {
    it('never lets one company see another’s performance', async () => {
      await record('OnTimeAccepted', 'T-1');

      const visible = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.performanceEvent.count({}),
      );
      assert.equal(visible, 0);
    });

    it('keeps each company’s policy to itself', async () => {
      await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'This company rewards on-time delivery more heavily.',
        changes: { onTimeAcceptedPoints: 50 },
      });

      const otherPolicy = await performance().activePolicy(otherScope());
      assert.equal(otherPolicy.onTimeAcceptedPoints, 10);
      assert.equal(otherPolicy.version, 1);
    });

    it('refuses to score somebody through another company’s workspace header', async () => {
      await agent()
        .get(`/tenants/${otherTenantId}/performance/${employeeId}`)
        .set('x-uboss-dev-actor', adminUboss)
        .set(WORKSPACE_HEADER, otherTenantId)
        .expect((response) => {
          assert.ok(
            response.status === 403 || response.status === 404,
            `expected a refusal, got ${response.status}`,
          );
        });
    });
  });

  // =========================================================================
  describe('the API surface', () => {
    it('lets somebody read their own performance', async () => {
      await record('OnTimeAccepted', 'T-1');

      const response = await as(
        agent().get(`/tenants/${tenantId}/performance/me`),
        employeeUboss,
      ).expect(200);

      assert.equal(response.body.score, 10);
      assert.equal(response.body.level, 'Bronze');
      assert.equal(response.body.subjectUserId, employeeId);
      assert.match(response.body.note, /sum of/i);
    });

    it('refuses an employee reading a colleague’s', async () => {
      await as(agent().get(`/tenants/${tenantId}/performance/${peerId}`), employeeUboss).expect(
        403,
      );
    });

    it('lets a manager read their own team and not somebody else’s', async () => {
      await record('OnTimeAccepted', 'T-1');

      const mine = await as(
        agent().get(`/tenants/${tenantId}/performance/${employeeId}`),
        managerUboss,
      ).expect(200);
      assert.equal(mine.body.score, 10);

      // The peer reports to the admin, not to this manager. `TeamSubtree` is the Prompt 7
      // answer; this engine does not invent a second rule.
      await as(agent().get(`/tenants/${tenantId}/performance/${peerId}`), managerUboss).expect(403);
    });

    it('lets an admin read anybody in the company', async () => {
      await record('Missed', 'T-1');
      const response = await as(
        agent().get(`/tenants/${tenantId}/performance/${employeeId}`),
        adminUboss,
      ).expect(200);
      assert.equal(response.body.score, -15);
    });

    it('shows the policy next to the score', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/performance/policy`),
        employeeUboss,
      ).expect(200);

      assert.equal(response.body.version, 1);
      assert.deepEqual(response.body.thresholds, {
        Bronze: 0,
        Silver: 100,
        Gold: 300,
        Platinum: 600,
        Diamond: 1000,
      });
    });

    it('refuses to let a derived outcome be typed in over HTTP', async () => {
      // A route accepting OnTimeAccepted would let anybody with the permission mint points for
      // work that never existed.
      await as(agent().post(`/tenants/${tenantId}/performance/events`), adminUboss)
        .send({
          subjectUserId: employeeId,
          kind: 'OnTimeAccepted',
          sourceKind: 'todo',
          sourceId: 'T-99',
          reason: 'Trying to award points by hand.',
        })
        .expect(400);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId } }),
      );
      assert.equal(count, 0);
    });

    it('records a manual adjustment over HTTP, and says when a replay changed nothing', async () => {
      const body = {
        subjectUserId: employeeId,
        kind: 'ManualAdjustment',
        sourceKind: 'manual',
        sourceId: 'M-1',
        points: 40,
        reason: 'Recognising work delivered outside the tracked system.',
      };

      const first = await as(agent().post(`/tenants/${tenantId}/performance/events`), adminUboss)
        .send(body)
        .expect(201);
      assert.equal(first.body.points, 40);
      assert.equal(first.body.alreadyRecorded, false);

      const again = await as(agent().post(`/tenants/${tenantId}/performance/events`), adminUboss)
        .send(body)
        .expect(201);
      assert.equal(again.body.alreadyRecorded, true);
      assert.equal(again.body.eventId, first.body.eventId);
      assert.match(again.body.note, /already been scored/i);

      assert.equal(await scoreOf(), 40);
    });

    it('refuses an employee recording an adjustment for themselves', async () => {
      await as(agent().post(`/tenants/${tenantId}/performance/events`), employeeUboss)
        .send({
          subjectUserId: employeeId,
          kind: 'ManualAdjustment',
          sourceKind: 'manual',
          sourceId: 'M-1',
          points: 500,
          reason: 'Awarding myself points.',
        })
        .expect(403);
    });

    it('refuses a policy write from somebody without Administer, over HTTP', async () => {
      await as(agent().put(`/tenants/${tenantId}/performance/policy`), managerUboss)
        .send({ reason: 'A manager raising the thresholds.', goldThreshold: 10 })
        .expect(403);
    });
  });

  // =========================================================================
  describe('audit', () => {
    it('records every event, badge change and policy version', async () => {
      await record('OnTimeAccepted', 'T-1');
      for (let index = 0; index < 11; index += 1) {
        await record('OnTimeAccepted', `S-${index}`);
      }
      await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'A change worth auditing.',
        changes: { goldThreshold: 250 },
      });

      const actions = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: { startsWith: 'performance.' } },
          select: { action: true },
        }),
      );

      const kinds = new Set(actions.map((row) => row.action));
      assert.ok(kinds.has('performance.event_recorded'));
      assert.ok(kinds.has('performance.badge_changed'));
      assert.ok(kinds.has('performance.policy_versioned'));
    });

    it('states in the audit metadata that a policy change rewrites no past score', async () => {
      await performance().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'Raising Gold after the review.',
        changes: { goldThreshold: 400 },
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'performance.policy_versioned' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['pastScoresRewritten'], false);
      assert.equal(metadata?.['fromVersion'], 1);
      assert.equal(metadata?.['toVersion'], 2);
      assert.equal(event?.actorUserId, adminId);
    });
  });
});
