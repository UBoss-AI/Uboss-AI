import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  isObjectiveWorkAssignable,
  type Form2Objective,
  type Form2WorkflowStep,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';

import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { MockModelGateway, ModelGateway } from '../src/model-gateway/model-gateway.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { AssignmentService } from '../src/objectives/assignment.service.js';
import { ObjectiveClosureController } from '../src/objectives/objective-closure.controller.js';
import { ObjectiveClosureService } from '../src/objectives/objective-closure.service.js';
import { ObjectiveController } from '../src/objectives/objective.controller.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import { ObjectiveAnalysisService } from '../src/objectives/objective-analysis.service.js';
import { ObjectiveService } from '../src/objectives/objective.service.js';
import { WorkflowEditorService } from '../src/objectives/workflow-editor.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { NotificationRepository } from '../src/persistence/notification.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { SkillRouterService } from '../src/skills/skill-router.service.js';
import { SkillService } from '../src/skills/skill.service.js';
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
 * Prompt 20 — objective review routing and strict versioning.
 *
 * The client's rule, in full, is the thing this file exists to prove:
 *
 *   > V1 Draft → Review → Approved → Published → LIVE V1. Any later edit by any authorized user
 *   > automatically creates V2 Draft copied from V1. V1 remains live until V2 is
 *   > approved/published. Minor edits also create a new version. Rollback creates a new version
 *   > based on an older version. Historical records keep exact version IDs.
 *
 * Plus: Send To is hierarchy-aware, the responsible manager can review / edit / send back /
 * confirm the execution team, and **employees receive no actionable work during review**.
 */
describe('objective closure, outcome review and archive (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;

  /** Owns the objective and drafts it. Reports to the manager. */
  let authorId: string;
  let authorUboss: string;
  /** The Responsible Owner the form is sent to — the author's reporting manager. */
  let managerId: string;
  let managerUboss: string;
  /** Approves. Holds `objective:Approve` and `objective:Publish`, and did not create anything. */
  let approverId: string;
  let approverUboss: string;
  /** In the company, in no reporting line with the author. */
  let strangerId: string;
  /** Holds `Employee` at `OwnWork`: the person the permission refusals are about. */
  let employeeId: string;
  let employeeUboss: string;
  let ownerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const objectives = () => app.get(ObjectiveService);

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
      controllers: [ObjectiveController, ObjectiveClosureController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        ObjectiveService,
        ObjectiveClosureService,
        CompanySettingsService,
        // Prompt 21 gave `ObjectiveController` an analysis service and a Model Gateway.
        // The real `MockModelGateway` is used rather than a stub — it is what ships.
        SkillService,
        SkillRouterService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        NotificationService,
        NotificationRepository,
        OutboxRepository,
        { provide: ModelGateway, useClass: MockModelGateway },
        TenantContextService,
        Reflector,
        // The real resolver, not a stub: this suite's whole subject is hierarchy-aware routing
        // and `TeamSubtree` scope, and a stub would prove neither.
        { provide: HIERARCHY_RESOLVER, useExisting: OrganizationRepository },
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
      slug: 'ver-co',
      name: 'Versioning Co',
      firstMember: { email: 'first@ver.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@ver.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        author: await member('UB-VRAU-0001', 'Objective Author'),
        manager: await member('UB-VRMG-0001', 'Responsible Manager'),
        approver: await member('UB-VRAP-0001', 'Objective Approver'),
        stranger: await member('UB-VRST-0001', 'Unrelated Person'),
        employee: await member('UB-VREM-0001', 'Objective Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-VROW-0001',
          email: 'owner@ver-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    authorId = people.author.id;
    authorUboss = people.author.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    approverId = people.approver.id;
    approverUboss = people.approver.ubossUniqueId;
    strangerId = people.stranger.id;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    ownerId = people.owner.id;

    const department = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', headUserId: managerId },
      }),
    );
    departmentId = department.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      // Employment records, because the Send To check is hierarchy-aware and needs a real tree.
      // The author reports to the manager; the approver and the stranger report to nobody, which
      // is what makes the stranger genuinely outside the author's reporting line.
      // A counter, not a slice of the id: uuid v7 is timestamp-prefixed, so ids created in the
      // same millisecond share their first characters and a sliced employee id collides.
      let employeeSequence = 0;
      const employ = async (userId: string, reportingManagerUserId: string | null) => {
        employeeSequence += 1;
        return ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId,
            userId,
            departmentId,
            employeeId: `EMP-${String(employeeSequence).padStart(4, '0')}`,
            designation: 'Specialist',
            joinedOn: new Date('2026-01-01'),
            ...(reportingManagerUserId === null ? {} : { reportingManagerUserId }),
          },
        });
      };

      await employ(managerId, null);
      await employ(authorId, managerId);
      await employ(approverId, null);
      await employ(strangerId, null);
      await employ(employeeId, null);

      // An Employee, so the refusal tests have somebody who genuinely lacks `objective:Publish`
      // and `objective:Approve`. Everybody else in this fixture is a Head, which is what the
      // versioning suite needed and what made the first cut of the refusal tests vacuous.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: employeeId,
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          grantedByUserId: ownerId,
        },
      });

      for (const [userId, roleKind] of [
        [authorId, 'Head'],
        [managerId, 'Head'],
        [approverId, 'Head'],
        [strangerId, 'Head'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind,
            scopeKind: 'Department',
            departmentIds: [departmentId],
            grantedByUserId: ownerId,
          },
        });
      }
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, tenantId) as T;

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const form2 = (overrides: Partial<Form2Objective> = {}): Form2Objective => ({
    objectiveName: 'GSPR checklist generation',
    departmentId,
    objectiveOwnerUserId: authorId,
    expectedFinalResult: 'A complete Annex I checklist at zero critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Objective Author',
    formDate: '2026-09-10',
    responsibleOwnerUserId: managerId,
    executionTeam: 'Regulatory — Documentation',
    ...overrides,
  });

  const step = (overrides: Partial<Form2WorkflowStep> = {}): Form2WorkflowStep => ({
    position: 1,
    whoPersonName: 'Objective Author',
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
    ...overrides,
  });

  const draft = async (overrides: Partial<Form2Objective> = {}) =>
    objectives().create({
      scope: scope(),
      actorUserId: authorId,
      content: form2(overrides),
      steps: [step()],
    });

  /** Draft → submitted → team confirmed → review complete → approved. */
  const approved = async () => {
    const created = await draft();
    await objectives().submitForReview({
      scope: scope(),
      actorUserId: authorId,
      objectiveId: created.id,
    });
    await objectives().confirmExecutionTeam({
      scope: scope(),
      actorUserId: managerId,
      objectiveId: created.id,
    });
    await objectives().completeReview({
      scope: scope(),
      actorUserId: managerId,
      objectiveId: created.id,
    });
    return objectives().approve({
      scope: scope(),
      actorUserId: approverId,
      objectiveId: created.id,
    });
  };

  /** …and published, so V1 is LIVE. */
  const live = async () => {
    const view = await approved();
    return objectives().publish({
      scope: scope(),
      actorUserId: approverId,
      objectiveId: view.id,
    });
  };

  const closure = () => app.get(ObjectiveClosureService);

  /**
   * A live objective, completed, with nothing outstanding.
   *
   * `complete` is the real route rather than a status write, so every constraint the completion
   * path has to satisfy is exercised on the way in.
   */
  const completed = async () => {
    const view = await live();
    await closure().complete({
      scope: scope(),
      actorUserId: approverId,
      objectiveId: view.id,
    });
    return view;
  };

  /** …and reviewed, so it is sitting in Outcome Review awaiting sign-off or closure. */
  const reviewed = async (verdict: 'Met' | 'PartiallyMet' = 'Met') => {
    const view = await completed();
    // A review is refused until the work has actually finished, so the fixture has to produce a
    // completion date the way the product does: a finished run against this objective.
    await seedFinishedRun(view.id);
    await closure().review({
      scope: scope(),
      actorUserId: approverId,
      objectiveId: view.id,
      verdict,
      actualResult: 'Every supplier contract was reviewed and signed by the quarter end.',
      ...(verdict === 'Met'
        ? {}
        : {
            explanation:
              'Two of the eleven contracts were still with legal when the quarter closed, so ' +
              'the renewal dates for those two slipped into the next period.',
          }),
    });
    return view;
  };

  /**
   * The problems from a thrown Nest exception.
   *
   * `new ConflictException(string[])` and `new BadRequestException(string[])` both leave
   * `error.message` as the bare class name — the list is on `response.message`, which is what a
   * client receives. Asserting on `error.message` would pass for any conflict at all.
   */
  const problemsFrom = (error: unknown): string[] => {
    const response = (error as { response?: { message?: unknown } }).response;
    const message = response?.message;
    if (Array.isArray(message)) return message.map((entry) => String(entry));
    return [String(message ?? (error as Error).message)];
  };

  const versionStatus = async (objectiveId: string) => {
    const rows = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.objectiveVersion.findMany({
        where: { tenantId, objectiveId },
        orderBy: [{ versionNumber: 'desc' }],
        select: { status: true, versionNumber: true },
      }),
    );
    return rows[0]?.status ?? null;
  };

  // -------------------------------------------------------------------------
  // 1. Controlled pause and resume
  // -------------------------------------------------------------------------

  describe('controlled pause and resume', () => {
    it('pauses a live objective and records why', async () => {
      const view = await live();

      const paused = await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'WaitingOnBudget',
        reason: 'The quarter’s AI budget ran out.',
      });

      assert.equal(paused.reasonKind, 'WaitingOnBudget');
      assert.equal(paused.resumedAt, null);
      assert.equal(await versionStatus(view.id), 'Paused');
    });

    it('stops assigning work while paused', async () => {
      // The whole point of a controlled pause: no new task, no scheduled run.
      const view = await live();
      await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'Deprioritised',
        reason: 'Other work came first.',
      });

      assert.equal(isObjectiveWorkAssignable((await versionStatus(view.id)) as never), false);
    });

    it('refuses a second pause', async () => {
      const view = await live();
      await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'Deprioritised',
        reason: 'Other work came first.',
      });

      // Refused by the transition table — `Paused -> Paused` is not an edge — before the
      // service's own "already paused" check is reached. The table is the better refusal: it is
      // the one place every move is governed.
      await assert.rejects(
        () =>
          closure().pause({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
            reasonKind: 'WaitingOnBudget',
            reason: 'And the budget ran out.',
          }),
        /is Paused cannot be paused|already paused/,
      );
    });

    it('refuses a pause with no reason', async () => {
      const view = await live();
      await assert.rejects(
        () =>
          closure().pause({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
            reasonKind: 'Other',
            reason: '  ',
          }),
        /Say why/,
      );
    });

    it('resumes, and records how long it was stopped', async () => {
      const view = await live();
      await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'WaitingOnSomebody',
        reason: 'Waiting on the supplier.',
      });

      const resumed = await closure().resume({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        note: 'The supplier came back.',
      });

      assert.notEqual(resumed.resumedAt, null);
      assert.equal(resumed.resumeNote, 'The supplier came back.');
      assert.equal(resumed.daysStopped, 0);
      assert.equal(await versionStatus(view.id), 'Active');
    });

    it('keeps every pause, not just the current one', async () => {
      // Two nullable columns on the objective would hold only the latest, and "how much of this
      // quarter did the work spend stopped" is the question a delivery review asks.
      const view = await live();
      for (const reason of ['Deprioritised', 'WaitingOnBudget'] as const) {
        await closure().pause({
          scope: scope(),
          actorUserId: approverId,
          objectiveId: view.id,
          reasonKind: reason,
          reason: `Paused because of ${reason}.`,
        });
        await closure().resume({
          scope: scope(),
          actorUserId: approverId,
          objectiveId: view.id,
        });
      }

      const history = await closure().pauses({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });
      assert.equal(history.length, 2);
      assert.ok(history.every((entry) => entry.resumedAt !== null));
    });

    it('refuses to resume something that is not paused', async () => {
      const view = await live();
      await assert.rejects(
        () =>
          closure().resume({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
          }),
        /no Paused version|not.*paused/i,
      );
    });

    it('refuses a pause from somebody without the grant', async () => {
      // An `Employee` holds no `objective:Publish`: stopping a company's work is not an
      // individual contributor's call.
      const view = await live();
      await assert.rejects(
        () =>
          closure().pause({
            scope: scope(),
            actorUserId: employeeId,
            objectiveId: view.id,
            reasonKind: 'Other',
            reason: 'Because I said so.',
          }),
        /permission|not permitted|access|does not include/i,
      );
    });

    it('refuses to edit a paused version’s Form 2, at the database', async () => {
      // **The defect adding these states created.** The immutability trigger listed
      // ('Active','Completed','Archived') and returned early for anything else, so a paused
      // version would have been freely editable — a way round the versioning rule.
      const view = await live();
      await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'BeingRethought',
        reason: 'We want to change the plan.',
      });

      const version = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.objectiveVersion.findFirstOrThrow({
          where: { tenantId, objectiveId: view.id, status: 'Paused' },
        }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.objectiveVersion.update({
              where: { id: version.id },
              data: { expectedFinalResult: 'Something else entirely.' },
            }),
          ),
        /cannot be.*changed|never rewrites/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Completion
  // -------------------------------------------------------------------------

  describe('completion', () => {
    it('completes a live objective', async () => {
      const view = await live();
      const result = await closure().complete({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });

      assert.equal(result.status, 'Completed');
      assert.equal(await versionStatus(view.id), 'Completed');
    });

    it('refuses to complete a paused objective', async () => {
      // Otherwise somebody closes work whose remaining part was never restarted.
      const view = await live();
      await closure().pause({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        reasonKind: 'Deprioritised',
        reason: 'Other work came first.',
      });

      await assert.rejects(
        () =>
          closure().complete({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
          }),
        /resumed first/,
      );
    });

    it('reports what is outstanding when it completes', async () => {
      const view = await live();
      const result = await closure().complete({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });

      // No runs and no tasks, so there is no completion date and the review is not ready.
      assert.equal(result.readiness.ready, false);
      assert.ok(result.readiness.blocking.some((problem) => /no completion date/.test(problem)));
    });
  });

  // -------------------------------------------------------------------------
  // 3. The Outcome Review
  // -------------------------------------------------------------------------

  describe('the outcome review', () => {
    it('refuses a review while the work is not ready', async () => {
      const view = await completed();
      await assert.rejects(
        () =>
          closure().review({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
            verdict: 'Met',
            actualResult: 'Everything was done.',
          }),
        (error: unknown) => {
          assert.ok(
            problemsFrom(error).some((problem) => /completion date|not finished/i.test(problem)),
            `unexpected problems: ${problemsFrom(error).join(' | ')}`,
          );
          return true;
        },
      );
    });

    it('records the review once the work has finished', async () => {
      const view = await completed();
      await seedFinishedRun(view.id);

      const review = await closure().review({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        verdict: 'Met',
        actualResult: 'Every supplier contract was reviewed and signed.',
      });

      assert.equal(review.verdict, 'Met');
      assert.equal(review.closedAt, null);
      assert.equal(await versionStatus(view.id), 'OutcomeReview');
    });

    it('compares what §27.1 asks it to compare', async () => {
      const view = await completed();
      await seedFinishedRun(view.id);

      const review = await closure().review({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        verdict: 'Met',
        actualResult: 'Every supplier contract was reviewed and signed.',
      });

      const comparison = review.comparison;
      assert.ok(comparison.expectedFinalResult.length > 0);
      assert.equal(typeof comparison.aiCostMinor, 'number');
      assert.equal(typeof comparison.humanTasksTotal, 'number');
      assert.equal(typeof comparison.exceptionsUnresolved, 'number');
      assert.equal(comparison.agentRunsTotal, 1);
    });

    it('snapshots the comparison rather than reading it live', async () => {
      // A review read live would change after it was signed: a late settlement would silently
      // alter what somebody put their name to.
      const view = await completed();
      await seedFinishedRun(view.id);

      const review = await closure().review({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
        verdict: 'Met',
        actualResult: 'Every supplier contract was reviewed and signed.',
      });
      const runsAtReview = review.comparison.agentRunsTotal;

      await seedFinishedRun(view.id);

      const reread = await closure().reviewOf({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });
      assert.ok(reread);
      assert.equal(reread.comparison.agentRunsTotal, runsAtReview);
    });

    it('insists on an explanation for anything but a clean Met', async () => {
      const view = await completed();
      await seedFinishedRun(view.id);

      await assert.rejects(
        () =>
          closure().review({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
            verdict: 'PartiallyMet',
            actualResult: 'Most of it was done.',
            explanation: 'ran out of time',
          }),
        (error: unknown) => {
          const response = (error as { response?: { message?: unknown } }).response;
          const problems = Array.isArray(response?.message)
            ? response.message.map(String)
            : [String(response?.message ?? (error as Error).message)];
          assert.ok(problems.some((problem) => /characters of explanation/.test(problem)));
          return true;
        },
      );
    });

    it('insists on an actual result', async () => {
      const view = await completed();
      await seedFinishedRun(view.id);

      await assert.rejects(
        () =>
          closure().review({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
            verdict: 'Met',
            actualResult: 'done',
          }),
        (error: unknown) => {
          const response = (error as { response?: { message?: unknown } }).response;
          const problems = Array.isArray(response?.message)
            ? response.message.map(String)
            : [String(response?.message ?? (error as Error).message)];
          assert.ok(problems.some((problem) => /recorded nowhere else/.test(problem)));
          return true;
        },
      );
    });

    it('refuses a second review of the same version, at the database', async () => {
      const view = await reviewed();

      const version = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.objectiveVersion.findFirstOrThrow({
          where: { tenantId, objectiveId: view.id, status: 'OutcomeReview' },
        }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.objectiveOutcomeReview.create({
              data: {
                tenantId,
                objectiveId: view.id,
                objectiveVersionId: version.id,
                verdict: 'NotMet',
                actualResult: 'On reflection nothing was achieved at all.',
                explanation:
                  'A second opinion that contradicts the first, which is why one version gets ' +
                  'exactly one review.',
                slaOutcome: 'Unknown',
                comparison: {} as never,
                signOffPolicy: 'Never',
                reviewedByUserId: approverId,
              },
            }),
          ),
        /duplicate key|objective_outcome_reviews_tenant_id_objective_version_id_key/,
      );
    });

    it('refuses a review from somebody who may only publish', async () => {
      // Reviewing is `objective:Approve`, deliberately not `Publish`: the person who declared
      // the work finished should not be the only one who can grade it.
      const view = await completed();
      await seedFinishedRun(view.id);

      await assert.rejects(
        () =>
          closure().review({
            scope: scope(),
            actorUserId: employeeId,
            objectiveId: view.id,
            verdict: 'Met',
            actualResult: 'Every supplier contract was reviewed and signed.',
          }),
        /permission|not permitted|access|does not include/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Sign-off and closure
  // -------------------------------------------------------------------------

  describe('sign-off and closure', () => {
    it('defaults to asking the owner to sign', async () => {
      const meta = await closure().meta({ scope: scope(), actorUserId: approverId });
      assert.equal(meta['signOffPolicy'], 'OwnerSignOff');
    });

    it('refuses a closure by somebody other than the owner without a signature', async () => {
      // The case the default prevents: a review written by somebody else, closing the owner's
      // objective, with the owner never told.
      const view = await reviewed();

      await assert.rejects(
        () =>
          closure().close({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
          }),
        /owner to sign off/,
      );
    });

    it('lets the owner sign, and then anybody with Publish may close', async () => {
      const view = await reviewed();

      const signed = await closure().signOff({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: view.id,
      });
      assert.equal(signed.signedOffByUserId, authorId);

      const closed = await closure().close({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });
      assert.notEqual(closed.closedAt, null);
      assert.equal(await versionStatus(view.id), 'Closed');
    });

    it('refuses a signature from anybody but the owner', async () => {
      const view = await reviewed();
      await assert.rejects(
        () =>
          closure().signOff({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
          }),
        /Only the objective’s owner/,
      );
    });

    it('refuses a second signature', async () => {
      const view = await reviewed();
      await closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id });
      await assert.rejects(
        () => closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id }),
        /already been signed off/,
      );
    });

    it('refuses a second closure', async () => {
      const view = await reviewed();
      await closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id });
      await closure().close({ scope: scope(), actorUserId: approverId, objectiveId: view.id });

      await assert.rejects(
        () => closure().close({ scope: scope(), actorUserId: approverId, objectiveId: view.id }),
        /not under outcome review|already closed/i,
      );
    });

    it('records which policy the closure was judged under', async () => {
      // A closure judged under this quarter's rule stays judged under it when the company
      // changes the rule later.
      const view = await reviewed();
      const review = await closure().reviewOf({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });
      assert.ok(review);
      assert.equal(review.signOffPolicy, 'OwnerSignOff');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Archive, and the versioning rule
  // -------------------------------------------------------------------------

  describe('archive and reopening', () => {
    it('archives a closed objective', async () => {
      const view = await reviewed();
      await closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id });
      await closure().close({ scope: scope(), actorUserId: approverId, objectiveId: view.id });

      const archived = await closure().archive({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });
      assert.equal(archived.status, 'Archived');
      assert.equal(await versionStatus(view.id), 'Archived');
    });

    it('archives a completed objective without a review, and records that it did', async () => {
      // A company that wants no review of a finished objective should not be forced through one,
      // and a report asking "how did this turn out" should be able to tell.
      const view = await completed();
      await closure().archive({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: view.id,
      });

      const event = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'objective.archived' },
          orderBy: { occurredAt: 'desc' },
        }),
      );
      assert.ok(event);
      assert.equal((event.metadata as Record<string, unknown>)['reviewed'], false);
    });

    it('offers no route from a closed objective back to live', async () => {
      // Reopening is a new Draft version under the versioning rule — never a resurrection of the
      // version people executed.
      const view = await reviewed();
      await closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id });
      await closure().close({ scope: scope(), actorUserId: approverId, objectiveId: view.id });

      await assert.rejects(
        () =>
          closure().resume({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: view.id,
          }),
        /no Paused version|not.*paused/i,
      );
    });

    it('reopens as a new draft, leaving the closed version exactly as it was', async () => {
      const view = await reviewed();
      await closure().signOff({ scope: scope(), actorUserId: authorId, objectiveId: view.id });
      await closure().close({ scope: scope(), actorUserId: approverId, objectiveId: view.id });

      await objectives().startNewDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: view.id,
      });

      const versions = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.objectiveVersion.findMany({
          where: { tenantId, objectiveId: view.id },
          orderBy: [{ versionNumber: 'asc' }],
          select: { versionNumber: true, status: true },
        }),
      );

      assert.equal(versions.length, 2);
      // V1 is still Closed — the review and the closure stand.
      assert.equal(versions[0]?.status, 'Closed');
      assert.equal(versions[1]?.status, 'Draft');
    });
  });

  // -------------------------------------------------------------------------
  // 6. The routes, not only the service
  // -------------------------------------------------------------------------

  describe('the route guards', () => {
    it('lets a Head pause over the route', async () => {
      // The check that would have caught `objective:Pause`: a grant nobody holds is a 403 here
      // however correct the service looks.
      const view = await live();

      await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${view.id}/closure/pause`)
          .send({ reasonKind: 'WaitingOnBudget', reason: 'The quarter’s budget ran out.' }),
        approverUboss,
      ).expect(201);
    });

    it('refuses an Employee at the pause route', async () => {
      const view = await live();

      await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${view.id}/closure/pause`)
          .send({ reasonKind: 'Deprioritised', reason: 'Because I said so.' }),
        employeeUboss,
      ).expect(403);
    });

    it('refuses an Employee at the review route', async () => {
      const view = await live();

      await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${view.id}/closure/review`)
          .send({ verdict: 'Met', actualResult: 'Everything was done properly.' }),
        employeeUboss,
      ).expect(403);
    });

    it('serves the closure meta to anybody who may see the objective', async () => {
      const view = await live();

      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${view.id}/closure/meta`),
        managerUboss,
      ).expect(200);

      assert.equal(response.body.signOffPolicy, 'OwnerSignOff');
      assert.ok(String(response.body.pauseEffect).includes('stops new work'));
    });

    it('refuses a verdict that is not one of the four', async () => {
      const view = await live();

      await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${view.id}/closure/review`)
          .send({ verdict: 'Brilliant', actualResult: 'Everything was done properly.' }),
        authorUboss,
      ).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('does not show another company’s outcome review', async () => {
      const view = await reviewed();

      const other = await ctx.provisioning.provision({
        slug: 'other-closure-co',
        name: 'Other Closure Co',
        firstMember: { email: 'first@other-closure.example', displayName: 'Other First' },
      });
      await activateTenant(ctx, other.tenant.id);

      const reviews = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(other.tenant.id),
        () =>
          ctx.prisma.client.objectiveOutcomeReview.findMany({
            where: { tenantId: other.tenant.id },
          }),
      );

      assert.equal(reviews.length, 0);
      assert.ok(view.id.length > 0);
    });
  });

  /**
   * A finished agent run against this objective, so the comparison has a completion date.
   *
   * Seeded directly because the run engine is not this suite's subject: what matters here is that
   * the review reads the run's finish, not how the run got there.
   */
  async function seedFinishedRun(objectiveId: string): Promise<void> {
    await ctx.prisma.runAsPlatformOperation(async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const agentRow = await ctx.prisma.client.engineAgent.create({
        data: {
          tenantId,
          name: `Closure agent ${suffix}`,
          ownerUserId: ownerId,
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
          config: {},
          publishedAt: new Date(),
          publishedByUserId: ownerId,
          createdByUserId: ownerId,
        },
      });

      await ctx.prisma.client.engineAgent.update({
        where: { id: agentRow.id },
        data: {
          status: 'Active',
          currentVersionId: versionRow.id,
          activatedAt: new Date(),
          activatedByUserId: ownerId,
        },
      });

      await ctx.prisma.client.agentRun.create({
        data: {
          tenantId,
          engineAgentId: agentRow.id,
          engineAgentVersionId: versionRow.id,
          objectiveId,
          state: 'Completed',
          trigger: 'Manual',
          attempt: 1,
          correlationId: `corr-${suffix}`,
          idempotencyKey: `idem-${suffix}`,
          reservedAt: new Date(),
          startedAt: new Date(),
          finishedAt: new Date(),
          producedByRealModel: false,
          output: { text: 'Done.' } as never,
        },
      });
    });
  }
});
