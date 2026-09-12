import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  isHumanTaskOverdue,
  type Form2Objective,
  type Form2WorkflowStep,
  type SkillContent,
  type WorkflowDraft,
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
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
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
import { HumanTaskController } from '../src/tasks/human-task.controller.js';
import { HumanTaskService } from '../src/tasks/human-task.service.js';
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
 * Prompt 23 — Approve & Assign, and the Human To-do list.
 *
 * What this suite defends:
 *
 *   1. **Approve & Assign is one transaction.** Half a publish is worse than none: people
 *      assigned work for a version that never went live, or a live version whose approval gate
 *      nobody was asked to pass. A forced failure part-way must leave the company untouched.
 *   2. **All seven checks run, and every failure comes back at once.** A manager fixing one
 *      blocker at a time is being told the truth in instalments.
 *   3. **Assigning does not approve.** Approving is a separate act with its own permission, and
 *      the Manager who assigns usually does not hold it.
 *   4. **One queue for approvals**, not one per module. `approval_requests` is generic from the
 *      first prompt that needs it.
 *   5. **Evidence is required before a submission, not reported missing afterwards.**
 *   6. **Overdue is derived.** A task can be waiting on somebody else and late at once.
 */
describe('approve & assign and the human to-do list (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  /// A Head: holds objective Assign, Approve and Publish, and is the responsible owner.
  let ownerUserId: string;
  let ownerUboss: string;
  /// A Manager: holds objective Assign but NOT Approve — the client's assigning persona.
  let managerUserId: string;
  let managerUboss: string;
  /// An Employee: `todo` at OwnWork scope, no objective Assign.
  let workerUserId: string;
  let workerUboss: string;
  /// A second Employee, to prove one person cannot touch another's task.
  let otherWorkerUserId: string;
  let otherWorkerUboss: string;
  /// A separate approver: UBoss refuses to let anyone approve what they created (Prompt 8 SoD).
  let objectiveApproverId: string;
  let skillAdminId: string;
  let skillApproverId: string;
  let platformOwnerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const objectives = () => app.get(ObjectiveService);
  const analysis = () => app.get(ObjectiveAnalysisService);
  const workflow = () => app.get(WorkflowEditorService);
  const assignment = () => app.get(AssignmentService);
  const tasks = () => app.get(HumanTaskService);
  const skills = () => app.get(SkillService);

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
      controllers: [ObjectiveController, HumanTaskController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        { provide: ModelGateway, useClass: MockModelGateway },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        PlatformRepository,
        NotificationRepository,
        OutboxRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        NotificationService,
        SkillService,
        SkillRouterService,
        ObjectiveService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        HumanTaskService,
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
      slug: 'as-co',
      name: 'Assign Co',
      firstMember: { email: 'first@as.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@as.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        // The grid names the assignee by display name, which is how owners are matched.
        owner: await member('UB-ASOW-0001', 'Priya Nair'),
        manager: await member('UB-ASMG-0001', 'Ankush Verma'),
        worker: await member('UB-ASWK-0001', 'Pranav Kulkarni'),
        otherWorker: await member('UB-ASW2-0001', 'Divya Rao'),
        objectiveApprover: await member('UB-ASAP-0001', 'Rajesh Menon'),
        skillAdmin: await member('UB-ASSA-0001', 'Skill Admin'),
        skillApprover: await member('UB-ASSP-0001', 'Skill Approver'),
        platform: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-ASPL-0001',
          email: 'owner@as-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    ownerUserId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    managerUserId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    workerUserId = people.worker.id;
    workerUboss = people.worker.ubossUniqueId;
    otherWorkerUserId = people.otherWorker.id;
    otherWorkerUboss = people.otherWorker.ubossUniqueId;
    objectiveApproverId = people.objectiveApprover.id;
    skillAdminId = people.skillAdmin.id;
    skillApproverId = people.skillApprover.id;
    platformOwnerId = people.platform.id;

    const department = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', headUserId: ownerUserId },
      }),
    );
    departmentId = department.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: platformOwnerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      let sequence = 0;
      const employ = async (userId: string, reportingManagerUserId: string | null) => {
        sequence += 1;
        return ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId,
            userId,
            departmentId,
            employeeId: `EMP-${String(sequence).padStart(4, '0')}`,
            designation: 'Reg. Doc Specialist',
            joinedOn: new Date('2026-01-01'),
            ...(reportingManagerUserId === null ? {} : { reportingManagerUserId }),
          },
        });
      };
      await employ(ownerUserId, null);
      await employ(managerUserId, ownerUserId);
      await employ(workerUserId, managerUserId);
      await employ(people.otherWorker.id, managerUserId);
      await employ(objectiveApproverId, null);

      // A Head can approve and publish; a Manager can assign but not approve. That difference is
      // the whole reason Approve & Assign refuses an unapproved version.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: ownerUserId,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [departmentId],
          grantedByUserId: platformOwnerId,
        },
      });
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: managerUserId,
          roleKind: 'Manager',
          scopeKind: 'TeamSubtree',
          grantedByUserId: platformOwnerId,
        },
      });
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: objectiveApproverId,
          roleKind: 'Approver',
          scopeKind: 'MultipleDepartments',
          departmentIds: [departmentId],
          grantedByUserId: platformOwnerId,
        },
      });
      for (const userId of [workerUserId, people.otherWorker.id]) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind: 'Employee',
            scopeKind: 'OwnWork',
            grantedByUserId: platformOwnerId,
          },
        });
      }
      for (const [userId, roleKind] of [
        [skillAdminId, 'CompanyAdmin'],
        [skillApproverId, 'Approver'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind,
            scopeKind: 'WholeCompany',
            grantedByUserId: platformOwnerId,
          },
        });
      }

      // A live connection granting Read and Write, or the readiness check refuses every AI step
      // for want of a connection — which is correct behaviour, and would make every test here
      // about that one refusal.
      const connection = await ctx.prisma.client.connection.create({
        data: {
          tenantId,
          scope: 'Company',
          connectorKind: 'google-drive',
          label: 'Regulatory Drive',
          ownerUserId,
          environment: 'Test',
          allowedDepartmentIds: [departmentId],
          createdByUserId: platformOwnerId,
        },
      });
      for (const category of ['Read', 'Write'] as const) {
        await ctx.prisma.client.connectionToolGrant.create({
          data: {
            tenantId,
            connectionId: connection.id,
            agentId: crypto.randomUUID(),
            category,
            grantedByUserId: platformOwnerId,
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
    objectiveOwnerUserId: managerUserId,
    expectedFinalResult: 'A complete Annex I checklist at zero critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Ankush Verma',
    formDate: '2026-09-10',
    responsibleOwnerUserId: managerUserId,
    executionTeam: 'Regulatory',
    ...overrides,
  });

  const step = (overrides: Partial<Form2WorkflowStep> = {}): Form2WorkflowStep => ({
    position: 1,
    whoPersonName: 'Pranav Kulkarni',
    whoDesignation: 'Reg. Doc Specialist',
    whoEngine: 'Human',
    whenTrigger: 'Objective start',
    whenFrequency: 'Once',
    whatExactWork: 'Collect DHF and predicate evidence',
    inputWhatIsUsed: 'DHF workbook',
    inputReceivedFrom: 'R&D',
    whereWorkIsDone: 'UBoss',
    outputWhatIsProduced: 'Evidence index',
    outputSentTo: 'Reviewer',
    timeTaken: '2h',
    currentProblem: null,
    approval: 'NotRequired',
    ...overrides,
  });

  /** A human step, a machine step and an approval gate. */
  const mixedSteps = (): Form2WorkflowStep[] => [
    step({ position: 1 }),
    step({
      position: 2,
      whoEngine: 'Engine',
      whoPersonName: null,
      whatExactWork: 'Draft the GSPR matrix from the evidence index',
      outputWhatIsProduced: 'Draft checklist',
    }),
    step({
      position: 3,
      whoPersonName: 'Divya Rao',
      whatExactWork: 'Head review and sign-off',
      approval: 'Head',
      outputWhatIsProduced: 'Approved checklist',
    }),
  ];

  const publishSkill = async () => {
    const content: SkillContent = {
      purpose: 'Draft a GSPR matrix from an evidence index.',
      category: 'Drafting',
      whenToUse: 'When an evidence index exists and a GSPR checklist has to be drafted from it.',
      whenNotToUse: 'Never to decide whether evidence is sufficient — that is a human judgement.',
      inputs: [{ name: 'DHF workbook', description: 'The evidence index.', required: true }],
      rules: [{ when: 'A requirement has no evidence', then: 'Mark it as a gap.' }],
      steps: [
        { order: 1, instruction: 'Read the evidence index.' },
        { order: 2, instruction: 'Draft one checklist row per Annex I requirement.' },
      ],
      allowedToolCategories: ['Read', 'Write'],
      outputSchema: '{"type":"object","properties":{"rows":{"type":"array"}}}',
      validation: 'A person confirms the draft checklist before it is filed.',
      failureHandling: 'If the index cannot be read, escalate to the Skill owner.',
      requiresApproval: false,
      autonomy: 'ProposeForApproval',
      evidenceRequirement: 'Record the index revision and each requirement drafted.',
    };

    const created = await skills().createCompanySkill({
      scope: scope(),
      actorUserId: skillAdminId,
      key: 'gspr-drafter',
      name: 'GSPR matrix drafter',
      content,
      creationMode: 'Manual',
    });
    const versionId = created.openDraft?.id ?? created.versions[0]?.id ?? '';
    for (const to of ['Review', 'Approved', 'Published'] as const) {
      await skills().transition({
        scope: scope(),
        actorUserId: to === 'Approved' ? skillApproverId : skillAdminId,
        versionId,
        to,
        ...(to === 'Published' ? {} : { reason: 'Fixture.' }),
      });
    }
  };

  /**
   * The realistic journey to an assignable plan.
   *
   * Draft → submit → confirm team → analyse → fill in the Definitions of Done the analysis
   * honestly left blank → complete review → approve.
   */
  const readyToAssign = async ({
    fillDods = true,
    approve = true,
    withSkill = true,
    /**
     * Name a person on the approval gate.
     *
     * The analysis leaves an approval node's owner null on purpose — it knows the required role,
     * not who holds it, and resolving a role to people is the Approval Engine prompt's job. A
     * manager naming somebody in the editor is the other, equally real case, and it is the one
     * that has anybody to notify at this prompt.
     */
    nameApprover = true,
  } = {}): Promise<{ objectiveId: string; versionId: string; graph: WorkflowDraft }> => {
    if (withSkill) await publishSkill();

    const created = await objectives().create({
      scope: scope(),
      actorUserId: managerUserId,
      content: form2(),
      steps: mixedSteps(),
    });

    await objectives().submitForReview({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });
    await objectives().confirmExecutionTeam({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });

    const run = await analysis().start({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });
    assert.equal(run.status, 'Completed', run.failureReason ?? 'no failure reason recorded');

    let draft = await workflow().open({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });

    if (nameApprover) {
      const gate = draft.graph.nodes.find((node) => node.kind === 'Approval');
      if (gate !== undefined) {
        draft = await workflow().editNode({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId: created.id,
          revision: draft.revision,
          nodeId: gate.id,
          patch: { ownerUserId: otherWorkerUserId },
        });
      }
    }

    if (fillDods) {
      // The analysis leaves criteria and failure conditions blank on purpose — Form 2's grid does
      // not say — so a manager fills them. That is the journey, not a workaround.
      for (const node of draft.graph.nodes) {
        draft = await workflow().editNode({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId: created.id,
          revision: draft.revision,
          nodeId: node.id,
          patch: {
            dod: {
              criteria: 'The reviewer accepts the output against the Annex I list.',
              failureCondition: 'A required item cannot be evidenced.',
              ...(node.dod.expectedOutput.trim() === ''
                ? { expectedOutput: 'A recorded outcome for this step.' }
                : {}),
              ...(node.dod.evidence.trim() === ''
                ? { evidence: 'The output, filed against this step.' }
                : {}),
            },
          },
        });
      }
    }

    await objectives().completeReview({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });

    if (approve) {
      // A different person, because UBoss refuses to let anybody approve what they created.
      await objectives().approve({
        scope: scope(),
        actorUserId: objectiveApproverId,
        objectiveId: created.id,
      });
    }

    return {
      objectiveId: created.id,
      versionId: draft.objectiveVersionId,
      graph: draft.graph,
    };
  };

  const assign = (objectiveId: string, actorUserId = managerUserId) =>
    assignment().approveAndAssign({ scope: scope(), actorUserId, objectiveId });

  // -------------------------------------------------------------------------
  // 1. The gate
  // -------------------------------------------------------------------------

  describe('the seven checks', () => {
    it('refuses a version nobody has approved, and says approving is a separate act', async () => {
      // The Prompt 20 rule, defended from the assign side: a Manager holds Assign and not
      // Approve, so quietly approving on somebody's behalf would be a real privilege escalation.
      const { objectiveId } = await readyToAssign({ approve: false });

      await assert.rejects(
        () => assign(objectiveId),
        (error: Error) => {
          assert.match(error.message, /not been approved/);
          assert.match(error.message, /separate acts/);
          return true;
        },
      );
    });

    it('refuses an AI step with no approved Skill behind it', async () => {
      const { objectiveId } = await readyToAssign({ withSkill: false });

      await assert.rejects(
        () => assign(objectiveId),
        (error: Error) => {
          assert.match(error.message, /Skill/);
          return true;
        },
      );
    });

    it('refuses a plan with incomplete Definitions of Done', async () => {
      const { objectiveId } = await readyToAssign({ fillDods: false });

      await assert.rejects(
        () => assign(objectiveId),
        (error: Error) => {
          assert.match(error.message, /Definition of Done is incomplete/);
          return true;
        },
      );
    });

    it('reports every failing check at once, not one at a time', async () => {
      // The point of collecting: a manager who fixes one blocker, re-runs, and hits the next is
      // being told the truth in instalments.
      const { objectiveId } = await readyToAssign({
        fillDods: false,
        approve: false,
        withSkill: false,
      });

      await assert.rejects(
        () => assign(objectiveId),
        (error: Error) => {
          const lines = error.message.split('\n').filter((line) => line.startsWith('•'));
          assert.ok(lines.length >= 3, `only ${lines.length} refusals: ${error.message}`);
          // Each line names which of the client's checks failed.
          assert.ok(lines.some((line) => /Definition of Done/.test(line)));
          assert.ok(lines.some((line) => /Skill/.test(line)));
          assert.ok(lines.some((line) => /approved/.test(line)));
          return true;
        },
      );
    });

    it('refuses an actor without objective:Assign', async () => {
      const { objectiveId } = await readyToAssign();
      await assert.rejects(
        () => assign(objectiveId, workerUserId),
        /permission|not allowed|Forbidden/i,
      );
    });

    it('refuses over HTTP too, so a direct call is no way around the screen', async () => {
      const { objectiveId } = await readyToAssign();
      await as(
        agent().post(`/tenants/${tenantId}/objectives/${objectiveId}/assign`).send({}),
        workerUboss,
      ).expect(403);
    });

    it('assigns over HTTP for a Manager, which is the route the screen actually uses', async () => {
      // The service tests exercise the transaction; this one proves the wiring the button uses —
      // the controller, the guards, the DTO and the tenant header — actually reaches it.
      const { objectiveId } = await readyToAssign();
      const response = await as(
        agent().post(`/tenants/${tenantId}/objectives/${objectiveId}/assign`).send({}),
        managerUboss,
      );
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok((response.body.humanTaskIds as string[]).length > 0);
      assert.match(String(response.body.note), /Agent Builder/);
    });

    it('lets a department Head see the team’s assigned work that an employee cannot', async () => {
      // Three scopes, one list, decided by the same resource check: the Head's `Department` grant
      // reaches the whole department, the assignee's `OwnWork` reaches their own row, and the
      // other employee's reaches neither.
      const { objectiveId } = await readyToAssign();
      await assign(objectiveId);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findMany({
          where: { objectiveId },
          orderBy: { nodeId: 'asc' },
        }),
      );
      const task = rows[0];
      assert.ok(task, 'no task was created');
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: task.id },
          data: { assignedToUserId: workerUserId },
        }),
      );

      const asHead = await as(agent().get(`/tenants/${tenantId}/todo?filter=team`), ownerUboss);
      assert.equal(asHead.status, 200, JSON.stringify(asHead.body));
      assert.ok(
        (asHead.body.tasks as { id: string }[]).some((row) => row.id === task.id),
        'the department Head could not see their department’s assigned work',
      );

      const asStranger = await as(
        agent().get(`/tenants/${tenantId}/todo?filter=team`),
        otherWorkerUboss,
      ).expect(200);
      assert.equal(
        (asStranger.body.tasks as { id: string }[]).some((row) => row.id === task.id),
        false,
        'an OwnWork employee saw somebody else’s task through the team filter',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. What assigning produces
  // -------------------------------------------------------------------------

  describe('a successful Approve & Assign', () => {
    it('publishes the version and makes it live', async () => {
      const { objectiveId } = await readyToAssign();
      const result = await assign(objectiveId);

      const view = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId,
      });
      assert.equal(view.activeVersion?.id, result.objectiveVersionId);
      assert.equal(view.activeVersion?.status, 'Active');
    });

    it('creates one human task per human step, carrying everything the client listed', async () => {
      const { objectiveId, graph } = await readyToAssign();
      const result = await assign(objectiveId);

      const humanNodes = graph.nodes.filter((node) => node.kind === 'Human');
      assert.equal(result.humanTaskIds.length, humanNodes.length);
      assert.ok(humanNodes.length > 0, 'the fixture produced no human work');

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findMany({ where: { objectiveId } }),
      );
      for (const row of rows) {
        assert.ok(row.title.trim() !== '', 'a task with no title');
        assert.ok(row.assignedToUserId, 'a task assigned to nobody');
        assert.equal(row.assignedByUserId, managerUserId, 'Assigned By is the person who assigned');
        assert.ok(row.expectedOutput.trim() !== '', 'no expected output');
        assert.ok(row.evidenceRequirement.trim() !== '', 'no evidence requirement');
        assert.notEqual(row.dueAt, null, 'no due time, though the objective set a target');
        assert.equal(row.status, 'Assigned');
      }
    });

    it('creates one AI assignment per AI step, awaiting Agent Builder setup', async () => {
      // It never creates an Engine Agent: recurring work creates Runs, and the registry is a
      // later prompt. Claiming a mapping now would be a lie a constraint also refuses.
      const { objectiveId, graph } = await readyToAssign();
      const result = await assign(objectiveId);

      const aiNodes = graph.nodes.filter((node) => node.kind === 'Ai');
      assert.equal(result.aiAssignmentIds.length, aiNodes.length);
      assert.deepEqual(
        result.nodesAwaitingAgentSetup.sort(),
        aiNodes.map((node) => node.id).sort(),
      );

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.aiWorkAssignment.findMany({ where: { objectiveId } }),
      );
      for (const row of rows) {
        assert.equal(row.status, 'AwaitingAgentSetup');
        assert.equal(row.engineAgentId, null);
        const prefill = row.setupPrefill as Record<string, unknown>;
        // The next prompt's zero-question rule is only possible if publish records what it knew.
        assert.ok(String(prefill['suggestedAgentName']).trim() !== '');
        assert.ok(String(prefill['objectiveCode']).trim() !== '');
        assert.ok(Array.isArray(prefill['skillVersionIds']));
        assert.ok(
          (prefill['skillVersionIds'] as string[]).length > 0,
          'the matched Skill was lost',
        );
      }
    });

    it('puts approval gates in the one generic approvals queue', async () => {
      const { objectiveId, graph } = await readyToAssign();
      const result = await assign(objectiveId);

      const approvalNodes = graph.nodes.filter((node) => node.kind === 'Approval');
      assert.equal(result.approvalRequestIds.length, approvalNodes.length);
      assert.ok(approvalNodes.length > 0, 'the fixture produced no approval gate');

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({ where: { objectiveId } }),
      );
      for (const row of rows) {
        assert.equal(row.type, 'WorkflowStepApproval');
        assert.equal(row.status, 'Pending');
        assert.equal(row.decidedAt, null);
        assert.equal(row.objectiveVersionId, result.objectiveVersionId);
        assert.ok(row.workflowNodeId, 'the approval does not say which step it gates');
      }
    });

    it('registers what the Executor Agent should watch', async () => {
      // An expectation nobody recorded cannot be unmet: a task with no recorded due time can
      // never be reported overdue.
      const { objectiveId } = await readyToAssign();
      const result = await assign(objectiveId);

      assert.ok(result.executorExpectationIds.length > 0);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.executorExpectation.findMany({ where: { objectiveId } }),
      );
      const kinds = new Set(rows.map((row) => row.kind));
      assert.ok(kinds.has('HumanTaskOverdue'), 'nothing watches for late work');
      assert.ok(kinds.has('ApprovalPending'), 'nothing watches the approval gate');
      for (const row of rows) {
        assert.ok(row.detail.trim() !== '', 'an expectation that says nothing');
        assert.equal(row.satisfiedAt, null);
        if (row.kind === 'HumanTaskOverdue') assert.notEqual(row.dueAt, null);
      }
    });

    it('notifies the named approver that somebody is waiting on them', async () => {
      const { objectiveId } = await readyToAssign();
      const result = await assign(objectiveId);

      assert.ok(result.notificationsRaised > 0, 'no approver was told');

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({ where: { tenantId, kind: 'ApprovalWaiting' } }),
      );
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.recipientUserId === otherWorkerUserId));
    });

    it('records the required role when the gate names no person, and notifies nobody', async () => {
      // The other branch, and the honest one at this prompt: the analysis knows an approval is
      // required and which role must give it, not who holds that role. Resolving a role to people
      // belongs to the Approval Engine prompt, and guessing here would notify the wrong person
      // with real authority to act.
      const { objectiveId } = await readyToAssign({ nameApprover: false });
      const result = await assign(objectiveId);

      assert.equal(result.notificationsRaised, 0, 'somebody was notified from a role alone');

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({ where: { objectiveId } }),
      );
      assert.ok(rows.length > 0, 'the gate produced no approval request');
      for (const row of rows) {
        assert.equal(row.namedApproverUserId, null);
        assert.ok(row.approverRoleKind, 'the request records neither a person nor a role');
        assert.equal(row.status, 'Pending');
      }
    });

    it('freezes the plan', async () => {
      const { objectiveId } = await readyToAssign();
      const result = await assign(objectiveId);

      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.findUniqueOrThrow({
          where: { id: result.workflowDraftId },
        }),
      );
      assert.notEqual(draft.assignedAt, null);
      assert.equal(draft.assignedByUserId, managerUserId);
    });

    it('audits the publish with counts that match what it made', async () => {
      const { objectiveId } = await readyToAssign();
      const result = await assign(objectiveId);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: objectiveId, action: 'objective.approved_and_assigned' },
        }),
      );
      assert.equal(events.length, 1);
      const metadata = events[0]?.metadata as Record<string, unknown>;
      assert.equal(metadata['humanTaskCount'], result.humanTaskIds.length);
      assert.equal(metadata['approvalRequestCount'], result.approvalRequestIds.length);
      assert.equal(events[0]?.actorUserId, managerUserId);
    });

    it('refuses a second assignment of the same plan', async () => {
      const { objectiveId } = await readyToAssign();
      await assign(objectiveId);

      await assert.rejects(() => assign(objectiveId), /already been assigned/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Rollback safety
  // -------------------------------------------------------------------------

  describe('rollback safety', () => {
    it('leaves nothing behind when the transaction fails part-way', async () => {
      // A real partial failure, forced through the uniqueness rule: a task row already occupying
      // one node's slot makes the create fail after the version has been published and after
      // some rows have been written. Everything must roll back — a live version whose work was
      // never created is precisely the half-publish this design exists to prevent.
      const { objectiveId, versionId, graph } = await readyToAssign();
      const humanNode = graph.nodes.find((node) => node.kind === 'Human');
      assert.ok(humanNode, 'the fixture produced no human node');

      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.findFirstOrThrow({
          where: { objectiveVersionId: versionId },
        }),
      );

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.create({
          data: {
            tenantId,
            objectiveId,
            objectiveVersionId: versionId,
            workflowDraftId: draft.id,
            nodeId: humanNode.id,
            title: 'A task already occupying this slot',
            assignedToUserId: workerUserId,
            assignedByUserId: ownerUserId,
            dependsOnNodeIds: [],
            status: 'Assigned',
          },
        }),
      );

      await assert.rejects(() => assign(objectiveId));

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        version: await ctx.prisma.client.objectiveVersion.findUniqueOrThrow({
          where: { id: versionId },
        }),
        tasks: await ctx.prisma.client.humanTask.count({ where: { objectiveId } }),
        assignments: await ctx.prisma.client.aiWorkAssignment.count({ where: { objectiveId } }),
        approvals: await ctx.prisma.client.approvalRequest.count({ where: { objectiveId } }),
        expectations: await ctx.prisma.client.executorExpectation.count({ where: { objectiveId } }),
        draft: await ctx.prisma.client.objectiveWorkflowDraft.findUniqueOrThrow({
          where: { id: draft.id },
        }),
      }));

      assert.notEqual(after.version.status, 'Active', 'the version went live on a failed assign');
      assert.equal(after.version.publishedAt, null);
      assert.equal(after.tasks, 1, 'only the pre-planted row should remain');
      assert.equal(after.assignments, 0);
      assert.equal(after.approvals, 0);
      assert.equal(after.expectations, 0);
      assert.equal(after.draft.assignedAt, null, 'the plan was frozen by a failed assign');
    });
  });

  // -------------------------------------------------------------------------
  // 4. The Human To-do list
  // -------------------------------------------------------------------------

  describe('the human to-do list', () => {
    const firstTaskFor = async (objectiveId: string) => {
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findMany({
          where: { objectiveId },
          orderBy: { nodeId: 'asc' },
        }),
      );
      const row = rows[0];
      assert.ok(row, 'no task was created');
      return row;
    };

    /** Assigns, then re-points one task at the employee so they can work it. */
    const assignedTaskForWorker = async () => {
      const { objectiveId } = await readyToAssign();
      await assign(objectiveId);
      const row = await firstTaskFor(objectiveId);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: row.id },
          data: { assignedToUserId: workerUserId },
        }),
      );
      return { objectiveId, taskId: row.id };
    };

    it('shows an employee their own work and nobody else’s', async () => {
      const { taskId } = await assignedTaskForWorker();

      const mine = await tasks().list({ scope: scope(), actorUserId: workerUserId });
      assert.ok(mine.tasks.some((task) => task.id === taskId));

      const theirs = await as(agent().get(`/tenants/${tenantId}/todo`), otherWorkerUboss).expect(
        200,
      );
      assert.equal(
        (theirs.body.tasks as { id: string }[]).some((task) => task.id === taskId),
        false,
        'another employee could see somebody else’s task',
      );
    });

    it('refuses one employee acting on another’s task', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}),
        otherWorkerUboss,
      ).expect(403);
    });

    it('starts a task', async () => {
      const { taskId } = await assignedTaskForWorker();
      const response = await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}),
        workerUboss,
      ).expect(201);

      assert.equal(response.body.status, 'InProgress');
      assert.notEqual(response.body.startedAt, null);
    });

    it('will not block a task without a reason', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/block`).send({ reason: '   ' }),
        workerUboss,
      ).expect(400);
    });

    it('blocks a task with a reason, and clears it on resume', async () => {
      const { taskId } = await assignedTaskForWorker();
      const blocked = await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${taskId}/block`)
          .send({ reason: 'Waiting on the lab report' }),
        workerUboss,
      ).expect(201);
      assert.equal(blocked.body.status, 'Blocked');
      assert.equal(blocked.body.blockedReason, 'Waiting on the lab report');

      const resumed = await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}),
        workerUboss,
      ).expect(201);
      // A task cannot be in progress and blocked at once; a stale reason would misreport why
      // work stopped.
      assert.equal(resumed.body.status, 'InProgress');
      assert.equal(resumed.body.blockedReason, null);
    });

    it('refuses a submission with no evidence when the step required some', async () => {
      // Refused rather than accepted and flagged: the person is right there and can attach it.
      const { taskId } = await assignedTaskForWorker();
      await as(agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}), workerUboss);

      const response = await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/submit`).send({}),
        workerUboss,
      );
      assert.equal(response.status, 400);
      assert.match(String(response.body.message), /evidence/i);
    });

    it('accepts a submission once evidence is attached, and completes it', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}), workerUboss);
      await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${taskId}/evidence`)
          .send({ description: 'Evidence index v3', reference: 'DRIVE-991' }),
        workerUboss,
      ).expect(201);

      const submitted = await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/submit`).send({}),
        workerUboss,
      ).expect(201);

      // This step required no approval, so submitting completes it. Making somebody click twice
      // for a decision nobody has to make teaches people to ignore the button.
      assert.equal(submitted.body.status, 'Completed');
      assert.notEqual(submitted.body.completedAt, null);
      assert.equal(submitted.body.evidence.length, 1);
    });

    it('refuses evidence with no description', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/evidence`).send({ description: '  ' }),
        workerUboss,
      ).expect(400);
    });

    it('sends a step needing approval to the approvals queue rather than completing it', async () => {
      const { objectiveId } = await readyToAssign();
      await assign(objectiveId);

      const withApproval = await ctx.prisma.runAsPlatformOperation(async () => {
        const rows = await ctx.prisma.client.humanTask.findMany({ where: { objectiveId } });
        const row = rows.find((candidate) => candidate.approvalKind !== null) ?? rows[0];
        assert.ok(row);
        return ctx.prisma.client.humanTask.update({
          where: { id: row.id },
          data: { assignedToUserId: workerUserId, approvalKind: 'Head' },
        });
      });

      await as(
        agent().post(`/tenants/${tenantId}/todo/${withApproval.id}/start`).send({}),
        workerUboss,
      );
      await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${withApproval.id}/evidence`)
          .send({ description: 'Signed checklist' }),
        workerUboss,
      );

      const submitted = await as(
        agent().post(`/tenants/${tenantId}/todo/${withApproval.id}/submit`).send({}),
        workerUboss,
      ).expect(201);

      assert.equal(submitted.body.status, 'WaitingApproval');
      assert.equal(submitted.body.completedAt, null);

      // The same queue as every other approval — one table, not one per module.
      const raised = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { subjectType: 'HumanTask', subjectId: withApproval.id },
        }),
      );
      assert.equal(raised.length, 1);
      assert.equal(raised[0]?.type, 'OutputApproval');
      assert.equal(raised[0]?.status, 'Pending');
    });

    it('moves a task to Needs input when somebody asks for clarification', async () => {
      const { taskId } = await assignedTaskForWorker();
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${taskId}/notes`)
          .send({ kind: 'Clarification', body: 'Which Annex I revision applies?' }),
        workerUboss,
      ).expect(201);

      // A clarification is a question somebody is waiting on, which is what makes a task visibly
      // stalled rather than merely quiet.
      assert.equal(response.body.status, 'NeedsInput');
      assert.equal(response.body.notes.length, 1);
    });

    it('leaves the status alone for a plain comment', async () => {
      const { taskId } = await assignedTaskForWorker();
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${taskId}/notes`)
          .send({ kind: 'Comment', body: 'Starting on this now.' }),
        workerUboss,
      ).expect(201);

      assert.equal(response.body.status, 'Assigned');
      assert.equal(response.body.notes.length, 1);
    });

    it('refuses to submit a task that has already finished', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}), workerUboss);
      await as(
        agent()
          .post(`/tenants/${tenantId}/todo/${taskId}/evidence`)
          .send({ description: 'Evidence index v3' }),
        workerUboss,
      );
      await as(agent().post(`/tenants/${tenantId}/todo/${taskId}/submit`).send({}), workerUboss);

      const again = await as(
        agent().post(`/tenants/${tenantId}/todo/${taskId}/submit`).send({}),
        workerUboss,
      );
      assert.equal(again.status, 400);
    });

    it('derives Overdue rather than storing it', async () => {
      // The design decision, tested at the boundary: the stored status still says what the task
      // is actually waiting on, and the screen shows the fact that matters most.
      const { taskId } = await assignedTaskForWorker();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: taskId },
          data: {
            status: 'NeedsInput',
            startedAt: new Date(),
            dueAt: new Date(Date.now() - 60 * 60 * 1000),
          },
        }),
      );

      const view = await tasks().view({ scope: scope(), actorUserId: workerUserId, taskId });
      assert.equal(view.status, 'NeedsInput', 'the real state was overwritten');
      assert.equal(view.displayStatus, 'Overdue');
      assert.equal(view.overdue, true);
      assert.ok(isHumanTaskOverdue({ status: view.status, dueAt: view.dueAt }));
    });

    it('audits what somebody did to their task', async () => {
      const { taskId } = await assignedTaskForWorker();
      await as(agent().post(`/tenants/${tenantId}/todo/${taskId}/start`).send({}), workerUboss);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: taskId },
        }),
      );
      assert.ok(events.some((event) => event.action === 'todo.task_started'));
      assert.ok(events.every((event) => event.actorUserId === workerUserId));
    });

    it('serves a status vocabulary and says Overdue is not one of them', async () => {
      const response = await as(agent().get(`/tenants/${tenantId}/todo/meta`), workerUboss).expect(
        200,
      );
      const statuses = (response.body.statuses as { status: string }[]).map((row) => row.status);
      assert.ok(!statuses.includes('Overdue'));
      assert.match(String(response.body.note), /derived/i);
    });

    it('refuses an unauthenticated request', async () => {
      await agent().get(`/tenants/${tenantId}/todo`).set(WORKSPACE_HEADER, tenantId).expect(401);
    });
  });
});
