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
import { ModelGateway } from '../src/model-gateway/model-gateway.js';
import { ClassifyingModelGateway } from './support/classifying-model-gateway.js';
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
import { OverdueTaskSweeper } from '../src/performance/overdue-task.sweeper.js';
import {
  BADGE_LADDER,
  BADGE_LEVEL_LABELS,
  PerformanceService,
} from '../src/performance/performance.service.js';
import { HumanTaskService } from '../src/tasks/human-task.service.js';
import { WorkReleaseService } from '../src/tasks/work-release.service.js';
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
  const sweeper = () => app.get(OverdueTaskSweeper);
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
        { provide: ModelGateway, useClass: ClassifyingModelGateway },
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
        // `HumanTaskService` scores a completion, so the module it is built in needs the
        // service that records it. In the running product `PerformanceModule` is global;
        // a test module assembles only what it names.
        PerformanceService,
        // The deadline sweep, so a missed deadline can be scored in this module's own tests.
        OverdueTaskSweeper,
        HumanTaskService,
        WorkReleaseService,
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

      // A live connection providing Read and Write, or the readiness check refuses every AI step
      // for want of a connection — which is correct behaviour, and would make every test here
      // about that one refusal.
      //
      // `mock-erp`, not `google-drive`: the readiness check now asks whether a usable connection's
      // *connector* supports the category, and `google-drive` is in no catalogue and has no
      // adapter. `connections.e2e.spec.ts` asserts the service refuses exactly that kind ("refuses
      // a connector kind nobody implements"), so this fixture — which writes straight to Prisma —
      // was standing up a connection the product itself would never accept. mock-erp is the
      // catalogue's Company-scope connector and supports Read and Write.
      const connection = await ctx.prisma.client.connection.create({
        data: {
          tenantId,
          scope: 'Company',
          connectorKind: 'mock-erp',
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
  /**
   * Three human steps and nothing else.
   *
   * `mixedSteps` is the right fixture for most of this suite — it carries an AI step and an
   * approval gate, which is what a real plan looks like. It is the wrong one for proving a
   * sequence: two of its three steps are not human, so a chain built from it has only two people
   * in it and cannot tell "the third waited for the second" from "the third was last".
   */
  const threeHumanSteps = (): Form2WorkflowStep[] => [
    step({
      position: 1,
      whoPersonName: 'Aman Singh',
      whatExactWork: 'Engine: prepare the source data',
      outputWhatIsProduced: 'Source extract',
    }),
    step({
      position: 2,
      whoPersonName: 'Ram Iyer',
      whatExactWork: 'Sub-Engine: reconcile the extract against the ledger',
      inputWhatIsUsed: 'Source extract',
      outputWhatIsProduced: 'Reconciliation sheet',
    }),
    step({
      position: 3,
      whoPersonName: 'Vikram Bose',
      whatExactWork: 'Executor: file the reconciliation and close the period',
      inputWhatIsUsed: 'Reconciliation sheet',
      outputWhatIsProduced: 'Filed reconciliation',
    }),
  ];

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
     *
     * **Who gets named matters now.** This used to name `otherWorker`, an Employee, who holds no
     * `approvals:Approve` — and naming an approver excludes everybody else, so every plan this
     * fixture built published a gate that **nobody** could ever decide. That was an invalid
     * workflow modelled as the normal case, and `assignment.service` now refuses it. The default is
     * the Approver, who can really decide; `nameIneligibleApprover` keeps the old shape for the one
     * test that asserts the refusal.
     */
    nameApprover = true,
    /** Name somebody who cannot approve, to assert the refusal rather than rely on it. */
    nameIneligibleApprover = false,
    /** The Form 2 grid to build from. The mixed one unless a test needs a different shape. */
    steps = mixedSteps(),
  }: {
    fillDods?: boolean;
    approve?: boolean;
    withSkill?: boolean;
    nameApprover?: boolean;
    nameIneligibleApprover?: boolean;
    steps?: Form2WorkflowStep[];
  } = {}): Promise<{ objectiveId: string; versionId: string; graph: WorkflowDraft }> => {
    if (withSkill) await publishSkill();

    /*
     * Tell the stub gateway what this fixture means by its steps.
     *
     * The analysis asks a model which part of each step needs a person, and the real one never
     * sees `whoEngine` — that the column no longer decides is the point of the change. A fixture
     * is the other way round: it *declares* the shape it wants to test against, and this suite
     * uses two of them. `mixedSteps` is one human step, one machine step and a gate;
     * `threeHumanSteps` is a chain of three people, and the shared default — position 2 is the
     * agent's — turned its middle link into AI work and left the chain two long.
     *
     * So the stub is driven by the steps this call was given. It reads as the grid deciding, and
     * it is not: it is the fixture stating its own intent in the one place that has it.
     */
    const gateway = app.get(ModelGateway) as ClassifyingModelGateway;
    gateway.classifyBy = (position, work) =>
      steps.find((candidate) => candidate.position === position)?.whoEngine === 'Human'
        ? { aiWork: null, humanWork: work }
        : { aiWork: work, humanWork: null };

    const created = await objectives().create({
      scope: scope(),
      actorUserId: managerUserId,
      content: form2(),
      steps,
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
          patch: {
            ownerUserId: nameIneligibleApprover ? otherWorkerUserId : objectiveApproverId,
          },
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
        /*
         * Assigned only when nothing has to happen first.
         *
         * The analysis now records the chain it drew as each step's dependencies, so a plan of
         * three sequential steps produces one task somebody can start and two that wait. Asserting
         * 'Assigned' for all of them was asserting that the order is not enforced.
         */
        assert.equal(
          row.status,
          row.dependsOnNodeIds.length === 0 ? 'Assigned' : 'Waiting',
          `${row.title} (waits on ${row.dependsOnNodeIds.join(', ') || 'nothing'})`,
        );
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
      assert.ok(rows.every((row) => row.recipientUserId === objectiveApproverId));
    });

    /*
     * The gate that could never be decided.
     *
     * An Employee holds `approvals:View` and not `Approve`, and a named approver excludes everybody
     * else — so this plan would publish an approval request that the named person is refused and
     * nobody else may touch. Refused at assignment, with a message naming the node, rather than
     * discovered by whoever eventually chases the work.
     */
    it('refuses a plan whose approval gate names somebody who cannot approve', async () => {
      const { objectiveId } = await readyToAssign({ nameIneligibleApprover: true });

      await assert.rejects(
        assignment().approveAndAssign({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId,
          acceptWarnings: true,
        }),
        (error: Error) => /cannot decide it/i.test(error.message),
      );

      // Nothing was written: the refusal is before the transaction, not a partial publish.
      const tasks = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.count({ where: { tenantId, objectiveId } }),
      );
      assert.equal(tasks, 0, 'work was assigned despite the refusal');
    });

    /*
     * Four eyes and one name are contradictory by construction: two distinct people cannot be
     * found in one, and naming somebody excludes everybody else.
     */
    it('refuses a four-eyes gate that also names a single approver', async () => {
      const { objectiveId, versionId } = await readyToAssign();

      const draft = await workflow().open({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      const gate = draft.graph.nodes.find((node) => node.kind === 'Approval');
      assert.ok(gate !== undefined, 'the analysis produced no approval gate to test');

      await workflow().editNode({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
        revision: draft.revision,
        nodeId: gate.id,
        patch: { dod: { ...gate.dod, approval: 'FourEyes' } },
      });

      await assert.rejects(
        assignment().approveAndAssign({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId,
          versionId,
          acceptWarnings: true,
        }),
        (error: Error) => /two distinct people cannot be found in one/i.test(error.message),
      );
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
        /*
         * Put the step in front of somebody, which is what this test is about.
         *
         * `status` is set for the same reason `assignedToUserId` is: the step needing approval is
         * the last one in the chain, so it legitimately starts Waiting on the ones before it. That
         * is the sequence's business and it has its own tests — this one asks what happens when a
         * step that needs approval is submitted, and it has to be startable to ask that.
         */
        return ctx.prisma.client.humanTask.update({
          where: { id: row.id },
          data: { assignedToUserId: workerUserId, approvalKind: 'Head', status: 'Assigned' },
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
  // -------------------------------------------------------------------------
  // 5. Engine -> Sub-Engine -> Executor
  // -------------------------------------------------------------------------

  /**
   * The sequence, proved rather than assumed.
   *
   * The client's rule is that the next stage must not become actionable before the required
   * previous stage is complete, and until this existed `dependsOnNodeIds` was written at publish
   * and never read again — so all three people in a chain got their work at the same moment.
   *
   * Three humans, three stages, one dependency each. Anything simpler would not distinguish "the
   * second step waited" from "the third step happened to be last".
   */
  describe('the Engine -> Sub-Engine -> Executor sequence', () => {
    /** Publish a three-person chain and return its tasks, in plan order. */
    const chain = async () => {
      // No AI step, so no Skill is needed and nothing else can park the plan.
      const ready = await readyToAssign({ withSkill: false, steps: threeHumanSteps() });

      // The three human steps the fixture's Form 2 produces, given owners and an order.
      let draft = await workflow().open({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId: ready.objectiveId,
      });

      const humans = draft.graph.nodes.filter((node) => node.kind === 'Human');
      assert.equal(humans.length, 3, 'the chain needs three people to be a chain');

      const owners = [workerUserId, otherWorkerUserId, ownerUserId];
      for (let index = 0; index < humans.length; index += 1) {
        const node = humans[index] as (typeof humans)[number];
        const previous = index === 0 ? [] : [(humans[index - 1] as (typeof humans)[number]).id];
        draft = await workflow().editNode({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId: ready.objectiveId,
          revision: draft.revision,
          nodeId: node.id,
          patch: {
            ownerUserId: owners[index % owners.length] as string,
            dod: { ...node.dod, dependencies: previous },
          },
        });
      }

      await assign(ready.objectiveId);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findMany({
          where: { tenantId, objectiveId: ready.objectiveId },
          select: {
            id: true,
            nodeId: true,
            title: true,
            status: true,
            assignedToUserId: true,
            dependsOnNodeIds: true,
          },
        }),
      );

      // Back into plan order: findMany's order is not the graph's.
      const ordered = humans.map((node) => {
        const row = rows.find((candidate) => candidate.nodeId === node.id);
        assert.ok(row !== undefined, `no task for node ${node.id}`);
        return row;
      });

      return { objectiveId: ready.objectiveId, nodes: humans, tasks: ordered };
    };

    const statusOf = async (taskId: string): Promise<string> => {
      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findFirstOrThrow({
          where: { tenantId, id: taskId },
          select: { status: true },
        }),
      );
      return row.status;
    };

    /** Take a task all the way to Completed, as the person it belongs to. */
    const finish = async (taskId: string, actorUserId: string) => {
      await tasks().start({ scope: scope(), actorUserId, taskId });
      await tasks().addEvidence({
        scope: scope(),
        actorUserId,
        taskId,
        description: 'The output, filed against this step.',
        reference: 'proof://dependency-sequence',
      });
      return tasks().submit({ scope: scope(), actorUserId, taskId });
    };

    it('pays the person who finished the work', async () => {
      /*
       * The gap this closes.
       *
       * The performance policy, its points and the badge ladder were all built, the screens read
       * them, and nothing ever wrote one. `recordEvent` was called from exactly two places — an
       * administrator typing a manual adjustment, and the rewards module — so finishing a task on
       * time changed nobody's score. Measured before this: **zero** performance events across
       * every company in the development database, after weeks of use.
       *
       * Completing work is what the score is *for*, so completion now writes it. A task with no
       * due date counts as on time: the company chose not to put a clock on it, and inventing a
       * deadline to penalise somebody against would be worse than not scoring at all.
       */
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      const before = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId } }),
      );

      await finish(first.id, first.assignedToUserId);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.findMany({
          where: { tenantId, sourceKind: 'human_task', sourceId: first.id },
        }),
      );

      assert.equal(events.length, 1, 'finishing a task should record exactly one outcome');
      const event = events[0];
      assert.equal(event?.kind, 'OnTimeAccepted');
      assert.equal(event?.subjectUserId, first.assignedToUserId, 'scored to whoever did it');
      assert.ok((event?.points ?? 0) > 0, 'an on-time completion is worth something');

      // Traceable, which is the whole reason `sourceKind`/`sourceId` are required.
      assert.equal(event?.sourceKind, 'human_task');
      assert.equal(event?.sourceId, first.id);

      const after = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId } }),
      );
      assert.equal(after, before + 1, 'exactly one event, not one per write in the path');
    });

    it('does not congratulate somebody for arriving at the bottom rung', async () => {
      /*
       * Seen on the running product, and the reason this test exists in this shape.
       *
       * An employee on **−15 points** — two missed deadlines — was sent *"You reached Starter.
       * Your performance score is −15 points, which earns the Starter badge."* Nothing was
       * earned. The lowest rung's threshold is zero, so the first event of any kind lands
       * somebody on it and fired the announcement.
       *
       * Congratulating a person for missing deadlines is worse than saying nothing: it is the
       * product telling them the outcome was fine. The badge is still recorded — the screen shows
       * it — and moving *down* to that rung later is a real change and is announced.
       */
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      await finish(first.id, first.assignedToUserId);

      const sent = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, recipientUserId: first.assignedToUserId, kind: 'Badge' },
        }),
      );
      assert.equal(sent.length, 0, 'a first badge at the entry rung was announced as an arrival');

      // It is still recorded, so the person's own screen is right.
      const held = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.badgeHistory.findFirst({
          where: { tenantId, subjectUserId: first.assignedToUserId, endedAt: null },
        }),
      );
      assert.ok(held, 'the badge was not recorded either');
    });

    it('names the rung the way the person sees it, when it does announce one', async () => {
      /*
       * Levels are **stored** `Bronze` … `Diamond` and **shown** `Starter` … `Legend` — the
       * client asked for the second vocabulary, and renaming the stored values would rewrite every
       * badge already earned. The announcement said `Bronze`, which is a rung the person cannot
       * find anywhere in the product.
       *
       * Asserted on the label map rather than by driving somebody up the ladder, which would take
       * a hundred completed tasks.
       */
      assert.equal(BADGE_LEVEL_LABELS.Bronze, 'Starter');
      assert.equal(BADGE_LEVEL_LABELS.Diamond, 'Legend');
      for (const level of BADGE_LADDER) {
        assert.ok(
          (BADGE_LEVEL_LABELS[level] ?? '').length > 0,
          `${level} has no name a person would recognise`,
        );
      }
    });

    it('charges a deadline that came and went with nobody doing the work', async () => {
      /*
       * `Missed` has been a scored outcome since the engine was written — the kind existed, the
       * policy carried −15 for it, and the badge ladder counted it. Nothing ever wrote one.
       *
       * So the only outcome the product could produce was a good one. A task finished late cost
       * something; a task never touched at all cost nothing, which made ignoring work the safest
       * thing an employee could do with it.
       */
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      // Two days past due, against a default window of one.
      const dueAt = new Date(Date.now() - 48 * 3_600_000);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({ where: { id: first.id }, data: { dueAt } }),
      );

      const swept = await sweeper().sweep();
      assert.ok(swept.recorded >= 1, 'the sweep scored nothing');

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.findMany({
          where: { tenantId, sourceKind: 'human_task', sourceId: first.id },
        }),
      );
      assert.equal(events.length, 1);
      const event = events[0];
      assert.equal(event?.kind, 'Missed');
      assert.equal(event?.subjectUserId, first.assignedToUserId, 'charged to whoever owed it');
      assert.ok((event?.points ?? 0) < 0, 'a missed deadline should cost something');

      /*
       * Dated when the window closed, not when the sweep noticed.
       *
       * A sweep runs on an interval and can be down for a day. Neither should move when somebody
       * missed their deadline, or an outage rewrites a performance record.
       */
      assert.equal(
        event?.occurredAt.getTime(),
        dueAt.getTime() + 24 * 3_600_000,
        'the event should be dated at the end of the grace window',
      );
    });

    it('sweeps twice and charges once', async () => {
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: first.id },
          data: { dueAt: new Date(Date.now() - 48 * 3_600_000) },
        }),
      );

      await sweeper().sweep();
      const second = await sweeper().sweep();

      const charged = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.count({
          where: { tenantId, sourceKind: 'human_task', sourceId: first.id, kind: 'Missed' },
        }),
      );
      assert.equal(charged, 1, 'a second sweep charged the same deadline again');
      assert.equal(second.recorded, 0, 'the second sweep claimed to have recorded something');
    });

    it('leaves a deadline alone until the window has closed', async () => {
      /*
       * A deadline passing is not yet a missed deadline. Somebody an hour late has been *late*,
       * which the completion path already scores. Where the line sits is the company's judgement
       * — a support rota and a quarterly filing do not mean the same thing by "overdue" — so this
       * asserts the policy is read rather than a constant applied.
       */
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: first.id },
          data: { dueAt: new Date(Date.now() - 3_600_000) },
        }),
      );

      await sweeper().sweep();

      const charged = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.count({
          where: { tenantId, sourceKind: 'human_task', sourceId: first.id },
        }),
      );
      assert.equal(charged, 0, 'an hour past due was charged as missed');
    });

    it('does not charge a missed deadline and a late one for the same slip', async () => {
      /*
       * Both statements would be true — they missed it, and they delivered late — but the company
       * set one penalty for one deadline. Charging both would quietly turn a stated −5 for
       * lateness into −20, which is a policy change nobody made. `BlockerNeutralised` is the
       * declared way to forgive the charge that was made.
       */
      const { tasks: chained } = await chain();
      const first = chained[0];
      assert.ok(first !== undefined);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: first.id },
          data: { dueAt: new Date(Date.now() - 48 * 3_600_000) },
        }),
      );
      await sweeper().sweep();

      await finish(first.id, first.assignedToUserId);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.findMany({
          where: { tenantId, sourceKind: 'human_task', sourceId: first.id },
        }),
      );
      assert.equal(events.length, 1, 'the same deadline was charged twice');
      assert.equal(events[0]?.kind, 'Missed');

      // And the work did finish — it is complete, it simply costs nothing further.
      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.humanTask.findFirst({ where: { id: first.id } }),
      );
      assert.equal(row?.status, 'Completed');
    });

    it('does not charge work that has not been handed out yet', async () => {
      /*
       * A `Waiting` step is waiting on something upstream. Nobody can miss a deadline for work
       * they have not been given, and charging it would score an employee for the plan's shape.
       */
      const { tasks: chained } = await chain();
      const waiting = chained[1];
      assert.ok(waiting !== undefined);
      assert.equal(waiting.status, 'Waiting');

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.update({
          where: { id: waiting.id },
          data: { dueAt: new Date(Date.now() - 96 * 3_600_000) },
        }),
      );

      await sweeper().sweep();

      const charged = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.performanceEvent.count({
          where: { tenantId, sourceKind: 'human_task', sourceId: waiting.id },
        }),
      );
      assert.equal(charged, 0, 'a step that had not started yet was charged as missed');
    });

    it('starts only the first step, and leaves the rest waiting', async () => {
      const { tasks: chained } = await chain();

      assert.equal(chained[0]?.status, 'Assigned');
      for (let index = 1; index < chained.length; index += 1) {
        assert.equal(
          chained[index]?.status,
          'Waiting',
          `step ${index + 1} should not be startable yet`,
        );
        // The dependency is recorded, which is what the release later reads.
        assert.deepEqual(chained[index]?.dependsOnNodeIds, [chained[index - 1]?.nodeId]);
      }
    });

    it('tells the first person and nobody else when the plan is assigned', async () => {
      /*
       * The client's rule, exactly: "only the first eligible person receives the current work
       * notification". The rest of the chain is told as it unlocks — which the test below this one
       * proves — and telling them now would be announcing work the product forbids them to start.
       */
      const { tasks: chained } = await chain();
      const [first, second, third] = chained;
      assert.ok(first !== undefined && second !== undefined);

      const told = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, kind: 'WorkReady' },
          select: { recipientUserId: true, resourceId: true, title: true },
        }),
      );

      const forThisPlan = told.filter((row) => chained.some((task) => task.id === row.resourceId));

      assert.equal(forThisPlan.length, 1, 'exactly one person was told');
      assert.equal(forThisPlan[0]?.resourceId, first.id);
      assert.equal(forThisPlan[0]?.recipientUserId, first.assignedToUserId);
      assert.match(String(forThisPlan[0]?.title), /New work assigned/);

      for (const later of [second, third]) {
        if (later === undefined) continue;
        assert.ok(
          !forThisPlan.some((row) => row.resourceId === later.id),
          `${later.title} was announced before its turn`,
        );
      }
    });

    it('refuses to start a step whose dependency has not finished', async () => {
      const { tasks: chained } = await chain();
      const second = chained[1];
      assert.ok(second !== undefined);

      /*
       * The negative test the whole feature rests on.
       *
       * Hiding the button would not be enough — this asks the server directly, as the person the
       * work genuinely belongs to, and requires a refusal. A permission error would not count:
       * this person *is* allowed to work their own task, and the reason it is refused has to be
       * the plan's order.
       */
      await assert.rejects(
        () =>
          tasks().start({
            scope: scope(),
            actorUserId: second.assignedToUserId,
            taskId: second.id,
          }),
        (error: Error) => {
          assert.match(error.message, /Waiting|cannot/i);
          return true;
        },
      );

      assert.equal(await statusOf(second.id), 'Waiting');
    });

    it('releases the next step, and only the next step, when one completes', async () => {
      const { tasks: chained } = await chain();
      const [first, second, third] = chained;
      assert.ok(first !== undefined && second !== undefined);

      await finish(first.id, first.assignedToUserId);

      assert.equal(await statusOf(first.id), 'Completed');
      assert.equal(await statusOf(second.id), 'Assigned');
      // The one after that is still waiting: a completion releases its own successor, not the tail.
      if (third !== undefined) assert.equal(await statusOf(third.id), 'Waiting');
    });

    it('notifies the person whose work just became startable', async () => {
      const { tasks: chained } = await chain();
      const [first, second] = chained;
      assert.ok(first !== undefined && second !== undefined);

      await finish(first.id, first.assignedToUserId);

      const raised = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, recipientUserId: second.assignedToUserId, kind: 'WorkReady' },
          select: { title: true, body: true, deepLink: true, resourceId: true },
        }),
      );

      assert.equal(raised.length, 1, 'exactly one WorkReady, raised once');
      assert.equal(raised[0]?.resourceId, second.id);
      assert.match(String(raised[0]?.title), new RegExp(second.title.slice(0, 12)));
      assert.equal(raised[0]?.deepLink, `/todo/${second.id}`);

      // And nothing was said to the person whose turn has not come.
      const third = chained[2];
      if (third !== undefined && third.assignedToUserId !== second.assignedToUserId) {
        const premature = await ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.notification.count({
            where: { tenantId, recipientUserId: third.assignedToUserId, kind: 'WorkReady' },
          }),
        );
        assert.equal(premature, 0, 'the third person was told nothing yet');
      }
    });

    it('walks the whole chain to the end', async () => {
      const { tasks: chained } = await chain();

      for (let index = 0; index < chained.length; index += 1) {
        const task = chained[index] as (typeof chained)[number];
        assert.equal(await statusOf(task.id), 'Assigned', `step ${index + 1} should be ready now`);
        await finish(task.id, task.assignedToUserId);
      }

      for (const task of chained) {
        const status = await statusOf(task.id);
        // A step whose Definition of Done required an approval parks at WaitingApproval instead,
        // which is the approval engine's business and not this sequence's.
        assert.ok(
          status === 'Completed' || status === 'WaitingApproval',
          `${task.title} ended at ${status}`,
        );
      }
    });

    it('tells the person what the wait is for, in words rather than node ids', async () => {
      const { tasks: chained } = await chain();
      const second = chained[1];
      assert.ok(second !== undefined);

      const list = await tasks().list({
        scope: scope(),
        actorUserId: second.assignedToUserId,
        filter: 'mine',
      });

      const view = list.tasks.find((task) => task.id === second.id);
      assert.ok(view !== undefined, 'the waiting task is shown, not hidden');
      assert.equal(view.status, 'Waiting');
      assert.deepEqual(view.waitingOn, [chained[0]?.title]);
      // Nothing it can do: the move list offers no way to start it.
      assert.ok(!view.nextStatuses.includes('InProgress'));
      // One, not two: the filter is `mine`, and the third stage belongs to somebody else.
      assert.equal(list.counts.waiting, 1);
      assert.equal(list.tasks.filter((task) => task.status === 'Waiting').length, 1);
    });
  });
});
