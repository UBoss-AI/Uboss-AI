import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  isObjectiveWorkAssignable,
  OBJECTIVE_STATUSES,
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
import { ObjectiveController } from '../src/objectives/objective.controller.js';
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
describe('objective review routing and strict versioning (e2e)', () => {
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
      controllers: [ObjectiveController],
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

  // -------------------------------------------------------------------------
  // 1. Hierarchy-aware Send To
  // -------------------------------------------------------------------------

  describe('Send To is hierarchy-aware', () => {
    it('accepts the author’s reporting manager', async () => {
      const created = await draft({ responsibleOwnerUserId: managerId });
      assert.equal(created.openDraft?.content.responsibleOwnerUserId, managerId);
    });

    it('accepts somebody in the author’s own team', async () => {
      // The direction is deliberately not constrained: the approved reference shows a Head
      // sending down to a specialist, while the prompt's wording suggests sending up.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.updateMany({
          where: { userId: strangerId },
          data: { reportingManagerUserId: authorId },
        }),
      );

      const created = await draft({ responsibleOwnerUserId: strangerId });
      assert.equal(created.openDraft?.content.responsibleOwnerUserId, strangerId);
    });

    it('refuses somebody in no reporting line with the author', async () => {
      await assert.rejects(
        draft({ responsibleOwnerUserId: strangerId }),
        /not in the same reporting line/,
      );
    });

    it('refuses somebody who is not an active member of the company', async () => {
      const outsider = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.createForPlatform({
          ubossUniqueId: 'UB-VRXX-0001',
          email: 'outsider@ver.example',
          displayName: 'Outsider',
        }),
      );

      await assert.rejects(
        draft({ responsibleOwnerUserId: outsider.id }),
        /not an active member of this company/,
      );
    });

    it('accepts the author as their own Responsible Owner', async () => {
      const created = await draft({ responsibleOwnerUserId: authorId });
      assert.equal(created.openDraft?.content.responsibleOwnerUserId, authorId);
    });

    it('permits routing when the hierarchy cannot be evaluated', async () => {
      // A considered exception: routing is data quality, not a security boundary — the recipient
      // still needs the permission and the scope. Refusing would make the builder unusable for a
      // company that has not finished filling in its hierarchy.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.deleteMany({ where: { userId: strangerId } }),
      );

      const created = await draft({ responsibleOwnerUserId: strangerId });
      assert.equal(created.openDraft?.content.responsibleOwnerUserId, strangerId);
    });
  });

  // -------------------------------------------------------------------------
  // 2. The reviewer's actions
  // -------------------------------------------------------------------------

  describe('the responsible manager’s actions', () => {
    it('confirms the execution team', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      const confirmed = await objectives().confirmExecutionTeam({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: created.id,
        executionTeam: 'Regulatory — Documentation (agreed)',
      });

      const version = confirmed.versions[0];
      assert.ok(version?.executionTeamConfirmedAt);
      assert.equal(version?.content.executionTeam, 'Regulatory — Documentation (agreed)');
      assert.equal(version?.reviewStage, 'Under review — execution team confirmed');
    });

    it('lets only the Responsible Owner confirm the team', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      await assert.rejects(
        objectives().confirmExecutionTeam({
          scope: scope(),
          actorUserId: approverId,
          objectiveId: created.id,
        }),
        /Only the Responsible Owner/,
      );
    });

    it('sends back with a reason and returns the version to Draft', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      const sent = await objectives().sendBack({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: created.id,
        reason: 'The target is not achievable in ten working days.',
      });

      const version = sent.versions[0];
      assert.equal(version?.status, 'Draft');
      assert.equal(version?.reviewStage, 'Sent back for changes');
      assert.equal(version?.sentBackReason, 'The target is not achievable in ten working days.');
      // Still V1: a send-back is not a new version, it is the same draft handed back.
      assert.equal(sent.versions.length, 1);
    });

    it('refuses a send-back with no reason', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      await assert.rejects(
        objectives().sendBack({
          scope: scope(),
          actorUserId: managerId,
          objectiveId: created.id,
          reason: '   ',
        }),
        /needs a reason/,
      );
    });

    it('lets the author edit and resubmit after a send-back', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      await objectives().sendBack({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: created.id,
        reason: 'Raise the target.',
      });

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
        content: form2({ targetCompletionTime: 20 }),
        steps: [step()],
      });
      // Still V1: the send-back returned the same draft, so editing it is not a new version.
      assert.equal(edited.versions.length, 1);
      assert.equal(edited.openDraft?.content.targetCompletionTime, 20);

      const resubmitted = await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      assert.equal(resubmitted.versions[0]?.status, 'UnderReview');
    });

    it('refuses to complete a review before the execution team is confirmed', async () => {
      // This is what makes Confirm Execution Team load-bearing rather than decorative.
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      await assert.rejects(
        objectives().completeReview({
          scope: scope(),
          actorUserId: managerId,
          objectiveId: created.id,
        }),
        /Confirm the execution team/,
      );
    });

    it('refuses to edit a version that is awaiting a decision, rather than opening a new draft', async () => {
      // The auto-V2 rule is about an objective that is *finished with*. Opening a draft here would
      // let an author route around the reviewer: edit the copy, publish it, and the review would
      // have decided nothing. This is the bug the Prompt 19 suite caught.
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      await assert.rejects(
        objectives().updateDraft({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: created.id,
          content: form2({ objectiveName: 'Changed under the reviewer' }),
          steps: [step()],
        }),
        /no editable draft/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Approve, then publish — two acts
  // -------------------------------------------------------------------------

  describe('approve and publish are separate acts', () => {
    it('approves without publishing, and says so', async () => {
      const view = await approved();
      const version = view.versions[0];

      assert.equal(version?.status, 'ReadyForApproval');
      assert.ok(version?.approvedAt);
      assert.equal(version?.approvedByUserId, approverId);
      assert.equal(version?.reviewStage, 'Approved — awaiting publish');
      // Not live.
      assert.equal(view.activeVersion, null);
      assert.equal(version?.publishedAt, null);
    });

    it('distinguishes awaiting approval from approved', async () => {
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
      const ready = await objectives().completeReview({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: created.id,
      });
      assert.equal(ready.versions[0]?.reviewStage, 'Awaiting approval');
    });

    it('refuses to publish a version that has not been approved', async () => {
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

      await assert.rejects(
        objectives().publish({
          scope: scope(),
          actorUserId: approverId,
          objectiveId: created.id,
        }),
        /has not been approved/,
      );
    });

    it('refuses to publish without an approval even through the database', async () => {
      const created = await draft();
      const versionId = created.openDraft?.id;
      assert.ok(versionId);

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveVersion.update({
            where: { id: versionId },
            data: { status: 'Active', publishedAt: new Date() },
          }),
        ),
        /live_objective_version_was_approved/,
      );
    });

    it('refuses to approve twice', async () => {
      const view = await approved();
      await assert.rejects(
        objectives().approve({
          scope: scope(),
          actorUserId: approverId,
          objectiveId: view.id,
        }),
        /already been approved/,
      );
    });

    it('publishes an approved version and makes it live', async () => {
      const view = await live();

      assert.equal(view.activeVersion?.versionNumber, 1);
      assert.equal(view.activeVersion?.status, 'Active');
      assert.ok(view.activeVersion?.publishedAt);
      assert.equal(view.openDraft, null);
    });

    it('refuses to approve one’s own objective', async () => {
      // The separation-of-duties engine, not a check written here.
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

      await assert.rejects(
        objectives().approve({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: created.id,
        }),
      );
    });

    it('clears an approval when the version is sent back', async () => {
      // An approval is a decision about specific content. Content that is about to change makes
      // it worthless, and leaving it would let the next publish go live on an approval nobody
      // gave for what it now says.
      const view = await approved();
      const sent = await objectives().sendBack({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: view.id,
        versionId: view.versions[0]?.id,
        reason: 'Reconsidered after approval.',
      });

      assert.equal(sent.versions[0]?.status, 'Draft');
      assert.equal(sent.versions[0]?.approvedAt, null);
      assert.equal(sent.versions[0]?.approvedByUserId, null);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Employees receive no actionable work during review
  // -------------------------------------------------------------------------

  describe('employees receive no actionable work during review', () => {
    it('marks only a live version assignable', async () => {
      for (const status of OBJECTIVE_STATUSES) {
        assert.equal(
          isObjectiveWorkAssignable(status),
          status === 'Active',
          `${status} assignability is wrong`,
        );
      }
    });

    it('reports a draft, a reviewed and an approved version as not assignable', async () => {
      const created = await draft();
      assert.equal(created.openDraft?.workAssignable, false);

      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      const underReview = await objectives().view({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      assert.equal(underReview.versions[0]?.workAssignable, false);

      const approvedView = await (async () => {
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
      })();
      // Approved is still not assignable: a plan awaiting publication is not work anybody owes.
      assert.equal(approvedView.versions[0]?.workAssignable, false);
    });

    it('reports a live version as assignable', async () => {
      const view = await live();
      assert.equal(view.activeVersion?.workAssignable, true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Strict versioning
  // -------------------------------------------------------------------------

  describe('strict versioning', () => {
    it('creates V2 as a draft copied from V1 when a live objective is edited', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'Revised plan' }),
        steps: [step({ whatExactWork: 'Collect evidence, revised' })],
      });

      assert.equal(edited.openDraft?.versionNumber, 2);
      assert.equal(edited.openDraft?.origin, 'Edit');
      assert.equal(edited.openDraft?.copiedFromVersionId, v1Id);
      assert.equal(edited.openDraft?.content.objectiveName, 'Revised plan');
    });

    it('keeps V1 live until V2 is approved and published', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;

      await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'Revised plan' }),
        steps: [step()],
      });

      // V2 exists as a draft and V1 is still the live version.
      const midway = await objectives().view({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
      });
      assert.equal(midway.activeVersion?.id, v1Id);
      assert.equal(midway.activeVersion?.versionNumber, 1);
      assert.equal(midway.openDraft?.versionNumber, 2);
    });

    it('supersedes V1 the moment V2 publishes', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;

      await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'Revised plan' }),
        steps: [step()],
      });
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
      });
      await objectives().confirmExecutionTeam({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: liveView.id,
      });
      await objectives().completeReview({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: liveView.id,
      });
      await objectives().approve({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: liveView.id,
      });
      const published = await objectives().publish({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: liveView.id,
      });

      assert.equal(published.activeVersion?.versionNumber, 2);
      const v1 = published.versions.find((version) => version.id === v1Id);
      assert.equal(v1?.status, 'Archived');
      // V1's content is untouched by any of it.
      assert.equal(v1?.content.objectiveName, 'GSPR checklist generation');
    });

    it('creates a version even for a minor edit that changes nothing', async () => {
      // The client's rule gives minor edits no exemption. A "nothing really changed" shortcut is
      // how a live plan gets rewritten under the people executing it.
      const liveView = await live();
      const identical = liveView.activeVersion;
      assert.ok(identical);

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: identical.content,
        steps: identical.steps.map(({ id: _id, ...rest }) => rest),
      });

      assert.equal(edited.openDraft?.versionNumber, 2);

      const compared = await objectives().compareVersions({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        fromVersionId: identical.id,
        toVersionId: edited.openDraft?.id ?? '',
      });
      // The version exists and the compare view says plainly that nothing changed.
      assert.equal(compared.diff.identical, true);
      assert.match(compared.diff.summary, /Nothing changed/);
    });

    it('refuses to open a second draft while one is open', async () => {
      const liveView = await live();
      await objectives().startNewDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
      });

      await assert.rejects(
        objectives().startNewDraft({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: liveView.id,
        }),
        /already has an open draft/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Rollback
  // -------------------------------------------------------------------------

  describe('rollback', () => {
    it('creates a new version based on an older one, and never reopens it', async () => {
      const liveView = await live();
      const v1 = liveView.activeVersion;
      assert.ok(v1);

      // V2 published, so V1 is archived.
      await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'V2 plan' }),
        steps: [step()],
      });
      for (const move of ['submit', 'confirm', 'complete', 'approve', 'publish'] as const) {
        if (move === 'submit') {
          await objectives().submitForReview({
            scope: scope(),
            actorUserId: authorId,
            objectiveId: liveView.id,
          });
        }
        if (move === 'confirm') {
          await objectives().confirmExecutionTeam({
            scope: scope(),
            actorUserId: managerId,
            objectiveId: liveView.id,
          });
        }
        if (move === 'complete') {
          await objectives().completeReview({
            scope: scope(),
            actorUserId: managerId,
            objectiveId: liveView.id,
          });
        }
        if (move === 'approve') {
          await objectives().approve({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: liveView.id,
          });
        }
        if (move === 'publish') {
          await objectives().publish({
            scope: scope(),
            actorUserId: approverId,
            objectiveId: liveView.id,
          });
        }
      }

      const rolled = await objectives().rollbackTo({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        versionId: v1.id,
        reason: 'V2 broke the evidence trail.',
      });

      // A forward-moving V3, copied from V1 — not a resurrection of V1.
      assert.equal(rolled.openDraft?.versionNumber, 3);
      assert.equal(rolled.openDraft?.origin, 'Rollback');
      assert.equal(rolled.openDraft?.copiedFromVersionId, v1.id);
      assert.equal(rolled.openDraft?.content.objectiveName, 'GSPR checklist generation');

      // V1 is still exactly what it was, and V2 is still the live version.
      const v1After = rolled.versions.find((version) => version.id === v1.id);
      assert.equal(v1After?.status, 'Archived');
      assert.equal(rolled.activeVersion?.versionNumber, 2);
    });

    it('refuses a rollback with no reason', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      await assert.rejects(
        objectives().rollbackTo({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: liveView.id,
          versionId: v1Id,
          reason: '  ',
        }),
        /needs a reason/,
      );
    });

    it('refuses a rollback to a version of another objective', async () => {
      const first = await live();
      const second = await draft({ objectiveName: 'A different objective' });
      const strayVersionId = second.openDraft?.id;
      assert.ok(strayVersionId);

      await assert.rejects(
        objectives().rollbackTo({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: first.id,
          versionId: strayVersionId,
          reason: 'Wrong objective.',
        }),
        /no such version/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. Version history
  // -------------------------------------------------------------------------

  describe('version history', () => {
    it('keeps every version with its exact id and its provenance', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;

      await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'V2 plan' }),
        steps: [step()],
      });

      const history = await objectives().history({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
      });

      assert.equal(history.entries.length, 2);
      const v2 = history.entries.find((entry) => entry.versionNumber === 2);
      const v1 = history.entries.find((entry) => entry.versionNumber === 1);

      assert.equal(v1?.versionId, v1Id);
      assert.equal(v1?.origin, 'Initial');
      assert.equal(v1?.copiedFromVersionId, null);
      assert.equal(v1?.live, true);

      assert.equal(v2?.origin, 'Edit');
      assert.equal(v2?.copiedFromVersionId, v1Id);
      assert.equal(v2?.copiedFromVersionNumber, 1);
      assert.equal(v2?.live, false);
    });

    it('records every review act against the version it happened to', async () => {
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
      await objectives().approve({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: created.id,
      });

      const history = await objectives().history({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      const entry = history.entries[0];

      assert.equal(entry?.submittedByUserId, authorId);
      assert.equal(entry?.executionTeamConfirmedByUserId, managerId);
      assert.equal(entry?.approvedByUserId, approverId);
      assert.equal(entry?.reviewStage, 'Approved — awaiting publish');
    });

    it('says that an edit never rewrites a version', async () => {
      const created = await draft();
      const history = await objectives().history({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });
      assert.match(history.note, /never rewrites a version/);
    });

    it('serves the history through the route', async () => {
      const created = await draft();
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${created.id}/versions`),
        authorUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.entries.length, 1);
      assert.equal(response.body.code, created.code);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Compare
  // -------------------------------------------------------------------------

  describe('compare', () => {
    it('reports the fields and steps that differ', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'Revised plan', targetCompletionTime: 20 }),
        steps: [step({ whatExactWork: 'Collect evidence, revised' })],
      });

      const compared = await objectives().compareVersions({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        fromVersionId: v1Id,
        toVersionId: edited.openDraft?.id ?? '',
      });

      assert.equal(compared.diff.identical, false);
      const changedKeys = compared.diff.fields.map((field) => field.key);
      assert.ok(changedKeys.includes('objectiveName'));
      assert.ok(changedKeys.includes('targetCompletionTime'));

      assert.equal(compared.diff.steps.length, 1);
      assert.equal(compared.diff.steps[0]?.kind, 'Changed');
      assert.ok(
        compared.diff.steps[0]?.cells.some((cell) => cell.key === 'whatExactWork'),
        'the changed cell should be named',
      );
    });

    it('reports an added and a removed step', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2(),
        steps: [step(), step({ position: 2, whatExactWork: 'A second step' })],
      });

      const forward = await objectives().compareVersions({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        fromVersionId: v1Id,
        toVersionId: edited.openDraft?.id ?? '',
      });
      assert.equal(forward.diff.steps[0]?.kind, 'Added');
      assert.equal(forward.diff.steps[0]?.position, 2);

      // The comparison is directional: reversing it turns the addition into a removal.
      const backward = await objectives().compareVersions({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        fromVersionId: edited.openDraft?.id ?? '',
        toVersionId: v1Id,
      });
      assert.equal(backward.diff.steps[0]?.kind, 'Removed');
    });

    it('names the versions it compared', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      const compared = await objectives().compareVersions({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        fromVersionId: v1Id,
        toVersionId: v1Id,
      });

      assert.equal(compared.from.versionNumber, 1);
      assert.equal(compared.to.versionNumber, 1);
      assert.equal(compared.diff.identical, true);
    });

    it('refuses to compare a version of another objective', async () => {
      const first = await live();
      const second = await draft({ objectiveName: 'Another' });
      const v1Id = first.activeVersion?.id;
      assert.ok(v1Id);

      await assert.rejects(
        objectives().compareVersions({
          scope: scope(),
          actorUserId: authorId,
          objectiveId: first.id,
          fromVersionId: v1Id,
          toVersionId: second.openDraft?.id ?? '',
        }),
        /no such version/i,
      );
    });

    it('serves the compare view through the route', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      const response = await as(
        agent()
          .get(`/tenants/${tenantId}/objectives/${liveView.id}/versions/compare`)
          .query({ from: v1Id, to: v1Id }),
        authorUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.diff.identical, true);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Authorization on the review routes
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses publishing to somebody without objective:Publish', async () => {
      // The stranger is a Head, which carries Publish — so this uses an Employee instead.
      const employee = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-VREM-0001',
          email: 'employee@ver.example',
          displayName: 'Plain Employee',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: user.id,
            roleKind: 'Employee',
            scopeKind: 'OwnWork',
            grantedByUserId: ownerId,
          },
        });
        return user;
      });

      const view = await approved();
      const response = await as(
        agent().post(`/tenants/${tenantId}/objectives/${view.id}/publish`).send({}),
        employee.ubossUniqueId,
      );
      assert.equal(response.status, 403);
    });

    it('refuses a send-back from somebody who is not the Responsible Owner, at the route', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${created.id}/review/send-back`)
          .send({ reason: 'I disagree.' }),
        approverUboss,
      );
      assert.equal(response.status, 403);
    });

    it('lets the Responsible Owner send back through the route', async () => {
      const created = await draft();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: created.id,
      });

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${created.id}/review/send-back`)
          .send({ reason: 'The target is not achievable.' }),
        managerUboss,
      );
      assert.equal(response.status, 201);
      assert.equal(response.body.versions[0].status, 'Draft');
    });

    it('refuses a rollback with no reason at the route', async () => {
      const liveView = await live();
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${liveView.id}/versions/rollback`)
          .send({ versionId: liveView.activeVersion?.id }),
        authorUboss,
      );
      assert.equal(response.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Audit
  // -------------------------------------------------------------------------

  describe('audit', () => {
    it('records every step with its exact version id', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceType: 'objective' },
          orderBy: { occurredAt: 'asc' },
        }),
      );

      const actions = events.map((event) => event.action);
      assert.ok(actions.includes('objective.created'));
      assert.ok(actions.includes('objective.submitted_for_review'));
      assert.ok(actions.includes('objective.execution_team_confirmed'));
      assert.ok(actions.includes('objective.review_completed'));
      assert.ok(actions.includes('objective.approved'));
      assert.ok(actions.includes('objective.published'));

      // The client requires historical records to keep exact version ids.
      const published = events.find((event) => event.action === 'objective.published');
      assert.equal((published?.metadata as Record<string, unknown>)['versionId'], v1Id);
    });

    it('records the supersession when a successor publishes', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;

      await objectives().updateDraft({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        content: form2({ objectiveName: 'V2' }),
        steps: [step()],
      });
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
      });
      await objectives().confirmExecutionTeam({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: liveView.id,
      });
      await objectives().completeReview({
        scope: scope(),
        actorUserId: managerId,
        objectiveId: liveView.id,
      });
      await objectives().approve({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: liveView.id,
      });
      await objectives().publish({
        scope: scope(),
        actorUserId: approverId,
        objectiveId: liveView.id,
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'objective.published' },
          orderBy: { occurredAt: 'desc' },
        }),
      );
      const metadata = events[0]?.metadata as Record<string, unknown>;
      assert.equal(metadata['supersededVersionId'], v1Id);
      assert.equal(metadata['supersededVersionNumber'], 1);
    });

    it('records a rollback with both version ids and the reason', async () => {
      const liveView = await live();
      const v1Id = liveView.activeVersion?.id;
      assert.ok(v1Id);

      await objectives().rollbackTo({
        scope: scope(),
        actorUserId: authorId,
        objectiveId: liveView.id,
        versionId: v1Id,
        reason: 'The evidence trail broke.',
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'objective.rolled_back' },
        }),
      );
      assert.ok(event);
      const metadata = event.metadata as Record<string, unknown>;
      assert.equal(metadata['copiedFromVersionId'], v1Id);
      assert.equal(metadata['origin'], 'Rollback');
      assert.equal(event.reason, 'The evidence trail broke.');
    });

    it('says on approval that it is not yet live', async () => {
      const view = await approved();
      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'objective.approved', resourceId: view.id },
        }),
      );
      assert.ok(event);
      assert.match(event.summary ?? '', /not yet live/i);
      assert.equal((event.metadata as Record<string, unknown>)['published'], false);
    });
  });
});
