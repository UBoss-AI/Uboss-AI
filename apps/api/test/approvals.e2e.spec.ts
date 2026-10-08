import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ANALYSIS_SCHEMA_VERSION,
  APPROVAL_REQUEST_TYPES,
  APPROVAL_TYPE_MODULE,
  FOUR_EYES_APPROVAL_KIND,
  type RunState,
  type Form2Objective,
  type Form2WorkflowStep,
  type SkillContent,
  type WorkflowDraft,
} from '@uboss/types';

import { AgentBuilderController } from '../src/agents/agent-builder.controller.js';
import { AgentBuilderService } from '../src/agents/agent-builder.service.js';
import { EngineAgentController } from '../src/agents/engine-agent.controller.js';
import { AgentOperatorService } from '../src/agents/agent-operator.service.js';
import { EngineAgentService } from '../src/agents/engine-agent.service.js';
import { RunEngineService, RunFailure } from '../src/runs/run-engine.service.js';
import { RunProgressGateway } from '../src/runs/run-progress.gateway.js';
import { InlineRunQueue, RunQueue } from '../src/runs/run-queue.js';
import { RunSchedulerService } from '../src/runs/run-scheduler.service.js';
import { ApprovalController } from '../src/approvals/approval.controller.js';
import { ExecutorController } from '../src/executor/executor.controller.js';
import { ExecutorService } from '../src/executor/executor.service.js';
import { RunController } from '../src/runs/run.controller.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import { ApprovalService } from '../src/approvals/approval.service.js';
import { PerformanceService } from '../src/performance/performance.service.js';
import { HumanTaskService } from '../src/tasks/human-task.service.js';
import { WorkReleaseService } from '../src/tasks/work-release.service.js';
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
import { ConnectionService } from '../src/connections/connection.service.js';
import { ConnectorAdapter, MockConnectorAdapter } from '../src/connections/connector-adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
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
  grantBuilderAccess,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Prompt 28 — the Approval Engine, delegation and four-eyes controls.
 *
 * Built on the Prompt 23–27 fixture chain, because the approvals this engine decides are the real
 * ones: a workflow step gate created when a plan was assigned, an output approval raised when
 * somebody submitted work, an agent activation, an exception the Executor Agent could not act on
 * by itself.
 *
 * What this suite defends:
 *
 *   * **One table, one engine.** Every approval type flows through the same rows, the same queue
 *     and the same decide call. There is no per-module approval path to drift.
 *   * **Separation of duties is the authorization engine's, not a second implementation.** The
 *     mandatory platform `NoSelfApproval` control seeded at Prompt 7 is what refuses a
 *     self-approval, and a `FourEyes` gate declared by a workflow step reaches that same engine
 *     as an additional policy. Both are asserted here against real rows.
 *   * **The decision record is immutable.** A settled request cannot change its verdict, be
 *     reopened, or have its history edited — enforced by database triggers, so the tests prove
 *     the product and not merely the service.
 *   * **Delegation moves routing, never authority.** A delegate passes the same module check and
 *     the same SoD controls; being delegated to grants nothing.
 *   * **Nothing approves on a timer.** Escalation notifies a manager and the request keeps
 *     waiting for a person.
 */
describe('approval engine, delegation and four-eyes (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let managerUserId: string;
  let workerUserId: string;
  let otherWorkerUserId: string;
  let objectiveApproverId: string;
  /// The same person, named for what they do in these tests.
  let headUserId: string;
  let headUboss: string;
  let skillAdminId: string;
  let skillApproverId: string;
  let platformOwnerId: string;
  let outsiderUboss: string;
  let otherTenantId: string;
  let connectionId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const objectives = () => app.get(ObjectiveService);
  const analysis = () => app.get(ObjectiveAnalysisService);
  const workflow = () => app.get(WorkflowEditorService);
  const assignment = () => app.get(AssignmentService);
  const builder = () => app.get(AgentBuilderService);
  const engine = () => app.get(RunEngineService);
  const executor = () => app.get(ExecutorService);
  const approvals = () => app.get(ApprovalService);
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
      controllers: [
        ApprovalController,
        ObjectiveController,
        AgentBuilderController,
        EngineAgentController,
        RunController,
        ExecutorController,
      ],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        // The real mock gateway: it is what ships, and its `producedByRealModel: false` is the
        // property several of these tests turn on.
        { provide: ModelGateway, useClass: ClassifyingModelGateway },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        { provide: SecretsVault, useClass: LocalSealedSecretsVault },
        { provide: ConnectorAdapter, useClass: MockConnectorAdapter },
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
        ConnectionService,
        SkillService,
        SkillRouterService,
        ObjectiveService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        AgentBuilderService,
        // Prompt 40A (CR-03): the run route consults an operator share before deciding a
        // person cannot reach an agent, so this is now part of its graph.
        AgentOperatorService,
        EngineAgentService,
        { provide: RunQueue, useClass: InlineRunQueue },
        RunProgressGateway,
        RunEngineService,
        RunSchedulerService,
        ExecutorService,
        // Prompt 28: the Executor now raises a real approval row for RequestApproval, rather
        // than reporting that it asked for a decision nobody could see.
        ApprovalService,
        // `HumanTaskService` scores a completion, so the module it is built in needs the
        // service that records it. In the running product `PerformanceModule` is global;
        // a test module assembles only what it names.
        PerformanceService,
        HumanTaskService,
        WorkReleaseService,
        CompanySettingsService,
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
      slug: 'ab-co',
      name: 'Agent Builder Co',
      firstMember: { email: 'first@ab.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'ab-other',
      name: 'Other Co',
      firstMember: { email: 'first@abother.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string, tenant = provisioned.tenant.id) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@ab.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: tenant, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        manager: await member('UB-ABMG-0001', 'Priya Nair'),
        // The grid names this person, so the analysis assigns the AI step's owner to them.
        worker: await member('UB-ABWK-0001', 'Pranav Kulkarni'),
        otherWorker: await member('UB-ABOW-0001', 'Meera Iyer'),
        head: await member('UB-ABHD-0001', 'Department Head'),
        skillAdmin: await member('UB-ABSA-0001', 'Skill Admin'),
        skillApprover: await member('UB-ABSP-0001', 'Skill Approver'),
        outsider: await member('UB-ABOT-0001', 'Outsider', other.tenant.id),
        platform: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-ABPL-0001',
          email: 'owner@ab-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    managerUserId = people.manager.id;
    workerUserId = people.worker.id;
    otherWorkerUserId = people.otherWorker.id;
    objectiveApproverId = people.head.id;
    headUserId = people.head.id;
    headUboss = people.head.ubossUniqueId;
    skillAdminId = people.skillAdmin.id;
    skillApproverId = people.skillApprover.id;
    outsiderUboss = people.outsider.ubossUniqueId;
    platformOwnerId = people.platform.id;

    const department = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', headUserId: managerUserId },
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
      await employ(managerUserId, null);
      await employ(workerUserId, managerUserId);
      await employ(otherWorkerUserId, managerUserId);
      await employ(objectiveApproverId, null);

      // A Manager over the team, so the plan can be built and assigned.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: managerUserId,
          roleKind: 'Manager',
          scopeKind: 'TeamSubtree',
          grantedByUserId: platformOwnerId,
        },
      });

      // The employee who owns the assigned AI work. `OwnWork` is the whole point: the source
      // document has them complete their own setup and activate, and nothing wider.
      for (const userId of [workerUserId, otherWorkerUserId]) {
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

      // CR-03 (Prompt 40A): these two complete their own agent setup in this suite's fixtures,
      // which a standard Employee can no longer do. Granted explicitly, through the mechanism
      // that already existed — see `grantBuilderAccess`.
      for (const userId of [workerUserId, otherWorkerUserId]) {
        await grantBuilderAccess(ctx, { tenantId, userId, grantedByUserId: platformOwnerId });
      }

      // A Head, for the approve step and for the Form 3 read.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: objectiveApproverId,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [departmentId],
          grantedByUserId: platformOwnerId,
        },
      });

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

      // A HighRiskAction is governed by `approvals:Approve`, which the Approver role holds — but
      // the WholeCompany assignment above is capped to MultipleDepartments by that role's own
      // maxScope, and with no departments named it resolves to nothing. Grants of the same kind
      // union their department lists, so this one makes the Approver's reach actually resolve.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: skillApproverId,
          roleKind: 'Approver',
          scopeKind: 'MultipleDepartments',
          departmentIds: [departmentId],
          grantedByUserId: platformOwnerId,
        },
      });

      const connection = await ctx.prisma.client.connection.create({
        data: {
          tenantId,
          scope: 'Company',
          // A real connector kind from the catalogue, not an invented string. 'mock-erp' is a
          // Company connector that genuinely declares Read and Write, so the capability check
          // is exercised rather than sidestepped.
          connectorKind: 'mock-erp',
          label: 'Regulatory ERP',
          ownerUserId: managerUserId,
          environment: 'Test',
          allowedDepartmentIds: [departmentId],
          createdByUserId: platformOwnerId,
        },
      });
      connectionId = connection.id;
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

      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: other.tenant.id,
          userId: people.outsider.id,
          roleKind: 'Head',
          scopeKind: 'WholeCompany',
          grantedByUserId: platformOwnerId,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, tenant = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, tenant) as T;

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
    preparedBy: 'Priya Nair',
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

  const mixedSteps = (): Form2WorkflowStep[] => [
    step({ position: 1 }),
    step({
      position: 2,
      whoEngine: 'Engine',
      whoPersonName: 'Pranav Kulkarni',
      whatExactWork: 'Draft the GSPR matrix from the evidence index',
      outputWhatIsProduced: 'Draft checklist',
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
    return created;
  };

  /** Draft → submit → confirm → analyse → fill DoDs → review → approve → assign. */
  const assignedAiWork = async ({
    withSkill = true,
    steps = mixedSteps(),
  }: { withSkill?: boolean; steps?: Form2WorkflowStep[] } = {}) => {
    if (withSkill) await publishSkill();

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

    await objectives().completeReview({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });
    await objectives().approve({
      scope: scope(),
      actorUserId: objectiveApproverId,
      objectiveId: created.id,
    });
    await assignment().approveAndAssign({
      scope: scope(),
      actorUserId: managerUserId,
      objectiveId: created.id,
    });

    const assignments = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.aiWorkAssignment.findMany({ where: { objectiveId: created.id } }),
    );
    const first = assignments[0];
    assert.ok(first, 'the fixture produced no assigned AI work');

    return { objectiveId: created.id, assignmentId: first.id, graph: draft.graph as WorkflowDraft };
  };

  /** Answer every remaining question, whichever ones the server says are outstanding. */
  const answerEverything = async (assignmentId: string, actorUserId = workerUserId) => {
    let view = await builder().view({ scope: scope(), actorUserId, assignmentId });

    for (let guard = 0; guard < 10 && view.missing.length > 0; guard += 1) {
      const next = view.missing[0];
      if (next === undefined) break;

      const patch: Record<string, unknown> = {};
      if (next.field === 'runType') patch['runType'] = 'Manual';
      else if (next.field === 'missingDataBehaviour') patch['missingDataBehaviour'] = 'Stop';
      else if (next.field === 'inputConnectionId') patch['inputConnectionId'] = connectionId;
      else patch[next.field] = 'UBoss';

      view = await builder().saveSetup({ scope: scope(), actorUserId, assignmentId, patch });
    }

    return view;
  };

  /** An activated agent: the state the registry is about. */
  const liveAgent = async () => {
    const { assignmentId, objectiveId } = await assignedAiWork();
    await answerEverything(assignmentId);
    const activated = await builder().activate({
      scope: scope(),
      actorUserId: workerUserId,
      assignmentId,
    });
    const agentId = activated.engineAgent?.id;
    assert.ok(agentId, 'activation produced no agent');
    return { agentId, assignmentId, objectiveId };
  };

  /** A run parked in a specific blocked state. */
  const blockedRun = async (state: RunState, detail: string) => {
    const { agentId } = await liveAgent();
    engine().setExecutor(async () => {
      throw new RunFailure(detail, 'NeedsIntervention', state);
    });
    const outcome = await engine().start({
      scope: scope(),
      engineAgentId: agentId,
      trigger: 'Manual',
    });
    engine().setExecutor(null);
    assert.equal(outcome.run.state, state);
    return { agentId, runId: outcome.run.id };
  };
  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** A generic high-risk request, raised by the Head and addressed to the Head role. */
  const highRiskAddressedToHeads = async (overrides: Record<string, unknown> = {}) =>
    approvals().raise({
      scope: scope(),
      type: 'HighRiskAction',
      title: 'Release the regulatory filing early',
      detail: 'Needs a decision before Friday.',
      subjectType: 'Objective',
      requestedByUserId: headUserId,
      approverRoleKind: 'Head',
      ...overrides,
    });

  // -------------------------------------------------------------------------
  // 1. One table, every domain
  // -------------------------------------------------------------------------

  describe('one engine across every domain', () => {
    it('raises every approval type through the same table', async () => {
      // The client's constraint: no separate approval table per module. If any type needed its
      // own path, this loop would not compile, let alone pass.
      for (const type of APPROVAL_REQUEST_TYPES) {
        const raised = await approvals().raise({
          scope: scope(),
          type,
          title: `A ${type} request`,
          detail: '',
          subjectType: 'Probe',
          requestedByUserId: managerUserId,
          approverRoleKind: 'Head',
          // A change request carries the kind of change it is about, the way a workflow step
          // approval carries its node. The table is shared; the columns that mean something
          // for one type and nothing for another are how it stays one table.
          ...(type === 'ChangeRequest' ? ({ changeKind: 'Other' } as const) : {}),
        });
        assert.equal(raised.type, type);
        assert.equal(raised.status, 'Pending');
        // Which permission governs it is published rather than implied.
        assert.equal(raised.module, APPROVAL_TYPE_MODULE[type]);
      }
    });

    it('governs an agent activation by agents and a workflow publish by objective', async () => {
      // Otherwise a single approvals:Approve grant would let whoever signs off a budget also
      // publish a workflow — far wider than the role templates intend.
      assert.equal(APPROVAL_TYPE_MODULE.AgentActivation, 'agents');
      assert.equal(APPROVAL_TYPE_MODULE.WorkflowPublish, 'objective');
    });

    it('refuses a request addressed to nobody', async () => {
      await assert.rejects(
        () =>
          approvals().raise({
            scope: scope(),
            type: 'HighRiskAction',
            title: 'Nobody asked',
            detail: '',
            subjectType: 'Probe',
            requestedByUserId: managerUserId,
          }),
        /must name an approver, a role, or a four-eyes gate/,
      );
    });

    it('shows the whole queue through one screen, aged', async () => {
      await highRiskAddressedToHeads();
      await highRiskAddressedToHeads({
        title: 'Overdue one',
        dueAt: new Date(Date.now() - 48 * 3_600_000),
      });

      const queue = await approvals().list({ scope: scope(), actorUserId: headUserId });
      assert.equal(queue.requests.length, 2);
      assert.equal(queue.counts.Pending, 2);
      assert.equal(queue.counts.Overdue, 1);

      const overdue = queue.requests.find((r) => r.title === 'Overdue one');
      assert.equal(overdue?.bucket, 'Overdue');
      assert.equal(overdue?.bucketTone, 'danger');
    });

    it('never calls a request with no due date overdue', async () => {
      // It can be old; it cannot be late against a deadline nobody set.
      const raised = await highRiskAddressedToHeads();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.update({
          where: { id: raised.id },
          data: { createdAt: new Date(Date.now() - 400 * 3_600_000) },
        }),
      );

      const queue = await approvals().list({ scope: scope(), actorUserId: headUserId });
      assert.equal(queue.requests[0]?.bucket, 'Aging');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Separation of duties
  // -------------------------------------------------------------------------

  describe('separation of duties', () => {
    it('refuses a self-approval through the authorization engine, not a local rule', async () => {
      // The Head raised it and the Head role is what it is addressed to, so routing lets them
      // through and permission lets them through. The only thing left is the mandatory
      // platform-wide NoSelfApproval control seeded at Prompt 7 — and it is what refuses.
      const raised = await highRiskAddressedToHeads();

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Mine, and fine.',
          }),
        /cannot approve something you created/i,
      );
    });

    it('refuses the creator from rejecting their own request too', async () => {
      // Rejecting is as much an exercise of the decision right as approving: somebody who may
      // not approve their own work may not dispose of it by rejecting it either.
      const raised = await highRiskAddressedToHeads();

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Reject',
            note: 'Withdrawing it this way.',
          }),
        /cannot approve something you created/i,
      );
    });

    it('records a blocked self-approval as a security event', async () => {
      const raised = await highRiskAddressedToHeads();
      await assert.rejects(() =>
        approvals().decide({
          scope: scope(),
          actorUserId: headUserId,
          approvalId: raised.id,
          decision: 'Approve',
          note: 'Trying it on.',
        }),
      );

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findMany({
          where: { tenantId, action: 'security.separation_of_duties_blocked' },
        }),
      );
      // An attempt to self-approve is exactly the pattern an audit wants to see, whether it was
      // a mistake or not.
      assert.equal(events.length, 1);
    });

    it('lets a different authorized person decide it', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Checked the filing dates.',
      });

      assert.equal(decided.status, 'Approved');
      assert.equal(decided.decidedByUserId, headUserId);
      assert.equal(decided.history.length, 1);
    });

    it('lets somebody comment on their own request', async () => {
      // Commenting is participating in the discussion, not approving your own work. Refusing it
      // would suppress exactly the questions that make an approval queue useful.
      const raised = await highRiskAddressedToHeads();

      const commented = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Comment',
        note: 'Adding the filing reference for whoever picks this up.',
      });

      assert.equal(commented.status, 'Pending');
      assert.equal(commented.history.length, 1);
      assert.equal(commented.history[0]?.decision, 'Comment');
    });

    it('applies a four-eyes gate a workflow step asked for, with no policy configured', async () => {
      // STEP_APPROVAL_KINDS offers FourEyes, and the value lands in approver_role_kind. It is not
      // a role: read as one it would address the request to a role nobody holds and deadlock the
      // gate. It travels to checkSeparationOfDuties as an additional policy instead.
      const configured = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.separationOfDutiesPolicy.findMany({
          where: { tenantId, rule: 'FourEyes' },
        }),
      );
      assert.equal(configured.length, 0, 'no company FourEyes policy is configured');

      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'A gate the plan marked four-eyes',
        detail: '',
        subjectType: 'ObjectiveWorkflowNode',
        requestedByUserId: managerUserId,
        approverRoleKind: FOUR_EYES_APPROVAL_KIND,
      });

      // Addressed to any authorized approver — the control is on how many distinct people act.
      const view = await approvals().view({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
      });
      const approve = view.available.find((a) => a.decision === 'Approve');

      // ADR-296: the Head holds approvals:Approve and did not raise it, so they are a valid
      // *first* eye. Being first is no longer a refusal — that was the bug. What must still hold
      // is that one person cannot carry the gate, which is asserted below on the request itself.
      assert.equal(approve?.allowed, true, 'a qualified person may give the first approval');

      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First pair of eyes.',
      });

      const afterOne = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { id: raised.id },
          select: { status: true },
        }),
      );
      assert.equal(afterOne.status, 'Pending', 'one approval does not satisfy four eyes');
    });

    it('satisfies four eyes once a second person has acted', async () => {
      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'A gate the plan marked four-eyes',
        detail: '',
        subjectType: 'ObjectiveWorkflowNode',
        requestedByUserId: managerUserId,
        approverRoleKind: FOUR_EYES_APPROVAL_KIND,
      });

      // The Approver acts first. Recorded as a real decision row, which is what the engine reads
      // as `priorActorUserIds`.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalDecisionRecord.create({
          data: {
            tenantId,
            approvalRequestId: raised.id,
            decision: 'Approve',
            actorUserId: skillApproverId,
            note: 'First pair of eyes.',
          },
        }),
      );

      const view = await approvals().view({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
      });
      const approve = view.available.find((a) => a.decision === 'Approve');
      assert.equal(approve?.allowed, true);

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Second pair of eyes.',
      });
      assert.equal(decided.status, 'Approved');
    });

    it('refuses a second decision from the same person on a four-eyes gate', async () => {
      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'A gate the plan marked four-eyes',
        detail: '',
        subjectType: 'ObjectiveWorkflowNode',
        requestedByUserId: managerUserId,
        approverRoleKind: FOUR_EYES_APPROVAL_KIND,
      });

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalDecisionRecord.create({
          data: {
            tenantId,
            approvalRequestId: raised.id,
            decision: 'Approve',
            actorUserId: headUserId,
            note: 'Me, once.',
          },
        }),
      );

      // Two decisions from one person are not two pairs of eyes.
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Me, again.',
          }),
        /second person|four.eyes/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. The immutable decision record
  // -------------------------------------------------------------------------

  describe('the decision record is immutable', () => {
    const settled = async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Approved.',
      });
      return raised.id;
    };

    it('refuses a second decision on a settled request', async () => {
      const id = await settled();
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: skillApproverId,
            approvalId: id,
            decision: 'Reject',
            note: 'Changed my mind.',
          }),
        /already Approved/,
      );
    });

    it('refuses a verdict change in the database, not only in the service', async () => {
      // The service could be bypassed by a later prompt. The trigger cannot.
      const id = await settled();
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.approvalRequest.update({
              where: { id },
              data: { status: 'Rejected' },
            }),
          ),
        /A decision is final/,
      );
    });

    it('refuses reopening a settled request to Pending', async () => {
      const id = await settled();
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.approvalRequest.update({
              where: { id },
              data: { status: 'Pending', decidedByUserId: null, decidedAt: null },
            }),
          ),
        /A decision is final/,
      );
    });

    it('refuses rewriting who decided or why', async () => {
      const id = await settled();
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.approvalRequest.update({
              where: { id },
              data: { decisionNote: 'A tidier reason.' },
            }),
          ),
        /cannot be rewritten/,
      );
    });

    it('refuses editing or deleting a decision row', async () => {
      const id = await settled();
      const history = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalDecisionRecord.findMany({
          where: { tenantId, approvalRequestId: id },
        }),
      );
      assert.equal(history.length, 1);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.approvalDecisionRecord.update({
              where: { id: history[0]!.id },
              data: { note: 'Something else entirely.' },
            }),
          ),
        /immutable/,
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.approvalDecisionRecord.delete({ where: { id: history[0]!.id } }),
          ),
        /immutable/,
      );
    });

    it('requires a reason for a refusal', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Reject',
            note: '   ',
          }),
        /has to say why/,
      );
    });

    it('keeps sent back distinct from rejected, and resubmits as a new row', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      const sentBack = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'SendBack',
        note: 'Add the filing dates and resubmit.',
      });
      assert.equal(sentBack.status, 'SentBack');

      // The corrected work is a new request pointing back, because the old one's verdict stands.
      const resubmitted = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Release the regulatory filing early (v2)',
        detail: 'Filing dates added.',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        approverRoleKind: 'Head',
        supersedesId: raised.id,
      });
      assert.equal(resubmitted.status, 'Pending');

      const original = await approvals().view({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
      });
      assert.equal(original.supersededById, resubmitted.id);
      assert.equal(original.status, 'SentBack');
    });

    it('refuses to resubmit against anything but a sent-back request', async () => {
      const id = await settled();
      await assert.rejects(
        () =>
          approvals().raise({
            scope: scope(),
            type: 'HighRiskAction',
            title: 'Sneaking a second go',
            detail: '',
            subjectType: 'Objective',
            requestedByUserId: managerUserId,
            approverRoleKind: 'Head',
            supersedesId: id,
          }),
        /Only a sent-back request can be resubmitted/,
      );
    });

    it('refuses two resubmissions of the same request', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'SendBack',
        note: 'Try again.',
      });

      const again = {
        scope: scope(),
        type: 'HighRiskAction' as const,
        title: 'v2',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        approverRoleKind: 'Head',
        supersedesId: raised.id,
      };
      await approvals().raise(again);
      // Two live requests both claiming to replace one sent-back item would give the same work
      // two independent verdicts.
      await assert.rejects(() => approvals().raise({ ...again, title: 'v2 again' }));
    });
  });

  // -------------------------------------------------------------------------
  // 4. Named approver and routing
  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('lets only the named approver decide', async () => {
      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Named to the Approver',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'I will take this one.',
          }),
        /names a different approver/,
      );

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: skillApproverId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Mine to decide.',
      });
      assert.equal(decided.status, 'Approved');
    });

    it('refuses a role-addressed request from somebody without the role', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: workerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Helping out.',
          }),
        /addressed to a Head|does not include/i,
      );
    });

    it('tells a screen exactly what it may do, matching what the server will allow', async () => {
      // A greyed-out button and a refused POST must never disagree, so `available` runs the real
      // checks rather than approximating them.
      const raised = await highRiskAddressedToHeads();
      const view = await approvals().view({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
      });

      const approve = view.available.find((a) => a.decision === 'Approve');
      assert.equal(approve?.allowed, false);
      assert.match(approve?.reason ?? '', /cannot approve something you created/i);

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'x',
          }),
        new RegExp(approve!.reason.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Out-of-office delegation
  // -------------------------------------------------------------------------

  describe('out-of-office delegation', () => {
    const window = () => ({
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 7 * 86_400_000),
    });

    it('lets a delegate decide a request named to the person who delegated', async () => {
      await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: headUserId,
        types: [],
        ...window(),
        reason: 'On leave until next Friday.',
      });

      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Named to the Approver, decided by their deputy',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Covering while they are away.',
      });

      assert.equal(decided.status, 'Approved');
      assert.equal(decided.decidedByUserId, headUserId);
      // Who actually decided and who they stood in for are different facts, and an audit that
      // cannot tell them apart cannot answer the only question anybody asks.
      assert.equal(decided.decidedOnBehalfOfUserId, skillApproverId);
      assert.equal(decided.history[0]?.onBehalfOfUserId, skillApproverId);
    });

    it('grants the delegate no authority they did not already have', async () => {
      // The whole point: delegation moves routing, never authority. The worker holds no Approve
      // anywhere, and being delegated to changes nothing.
      await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: workerUserId,
        types: [],
        ...window(),
        reason: 'Out of office.',
      });

      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Named to the Approver',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: workerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'I was delegated to.',
          }),
        /does not include "Approve"|role does not include/i,
      );
    });

    it('does not let a delegation launder a self-approval', async () => {
      // The requester delegating to themselves, or receiving a delegation, still faces the
      // mandatory NoSelfApproval control — it keys on who created the thing.
      await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: headUserId,
        types: [],
        ...window(),
        reason: 'Away.',
      });

      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Raised by the deputy, named to the person on leave',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: headUserId,
        namedApproverUserId: skillApproverId,
      });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Standing in for myself.',
          }),
        /cannot approve something you created/i,
      );
    });

    it('honours a type-scoped delegation and ignores it for other types', async () => {
      await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: headUserId,
        types: ['BudgetOverride'],
        ...window(),
        reason: 'Budget cover only.',
      });

      const budget = await approvals().raise({
        scope: scope(),
        type: 'BudgetOverride',
        title: 'Budget override',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });
      const other = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Not covered',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: budget.id,
        decision: 'Approve',
        note: 'Covered by the delegation.',
      });
      assert.equal(decided.status, 'Approved');

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: other.id,
            decision: 'Approve',
            note: 'Not covered.',
          }),
        /names a different approver/,
      );
    });

    it('stops the moment it is revoked, not at its end date', async () => {
      const delegation = await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: headUserId,
        types: [],
        ...window(),
        reason: 'Away.',
      });

      await approvals().revokeDelegation({
        scope: scope(),
        actorUserId: skillApproverId,
        delegationId: delegation.id,
      });

      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'After the revocation',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: skillApproverId,
      });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Still covering?',
          }),
        /names a different approver/,
      );
    });

    it('refuses a delegation that covers no time, or runs past a quarter', async () => {
      await assert.rejects(
        () =>
          approvals().delegate({
            scope: scope(),
            actorUserId: headUserId,
            fromUserId: headUserId,
            toUserId: skillApproverId,
            types: [],
            startsAt: new Date(Date.now() + 86_400_000),
            endsAt: new Date(Date.now()),
            reason: 'Backwards.',
          }),
        /end after it starts/,
      );

      await assert.rejects(
        () =>
          approvals().delegate({
            scope: scope(),
            actorUserId: headUserId,
            fromUserId: headUserId,
            toUserId: skillApproverId,
            types: [],
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 200 * 86_400_000),
            reason: 'Indefinitely.',
          }),
        /reassignment of authority/,
      );
    });

    it('refuses arranging for somebody else to delegate to you', async () => {
      // A self-service promotion dressed as cover.
      await assert.rejects(
        () =>
          approvals().delegate({
            scope: scope(),
            actorUserId: skillAdminId,
            fromUserId: headUserId,
            toUserId: skillAdminId,
            types: [],
            ...window(),
            reason: 'Helping myself.',
          }),
        /cannot arrange for somebody else to delegate their approvals to you/,
      );
    });

    it('does not let a delegate silently hand the cover back', async () => {
      const delegation = await approvals().delegate({
        scope: scope(),
        actorUserId: skillApproverId,
        fromUserId: skillApproverId,
        toUserId: workerUserId,
        types: [],
        ...window(),
        reason: 'Away.',
      });

      // Dropping cover somebody is relying on is how a queue stops being watched without
      // anybody noticing. The delegate has no ManageAccess, so they cannot.
      await assert.rejects(
        () =>
          approvals().revokeDelegation({
            scope: scope(),
            actorUserId: workerUserId,
            delegationId: delegation.id,
          }),
        /ManageAccess|does not include/i,
      );
    });

    it('lists delegations in both directions', async () => {
      await approvals().delegate({
        scope: scope(),
        actorUserId: headUserId,
        fromUserId: headUserId,
        toUserId: skillApproverId,
        types: [],
        ...window(),
        reason: 'Away.',
      });

      const mine = await approvals().listDelegations({
        scope: scope(),
        actorUserId: headUserId,
      });
      assert.equal(mine.length, 1);
      assert.equal(mine[0]?.active, true);

      const theirs = await approvals().listDelegations({
        scope: scope(),
        actorUserId: skillApproverId,
      });
      assert.equal(theirs.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Escalation — which never decides
  // -------------------------------------------------------------------------

  describe('escalation', () => {
    it('escalates an overdue request to the approver reporting manager', async () => {
      // Prompt 27's escalation routed back to the existing owner, which is a loop rather than an
      // escalation. This walks one step up the reporting hierarchy.
      const raised = await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Overdue and waiting',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: workerUserId,
        dueAt: new Date(Date.now() - 3_600_000),
      });

      const outcome = await approvals().escalateAged({ scope: scope() });
      assert.equal(outcome.escalated, 1);

      const view = await approvals().view({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
      });
      // The worker reports to the manager, so that is where it went.
      assert.equal(view.escalatedToUserId, managerUserId);
      assert.notEqual(view.escalatedAt, null);
      // And it is still waiting for a person. This is the whole point.
      assert.equal(view.status, 'Pending');
      assert.equal(view.decidedByUserId, null);
    });

    it('never decides anything, however overdue', async () => {
      await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Very overdue',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: workerUserId,
        dueAt: new Date(Date.now() - 400 * 3_600_000),
      });

      await approvals().escalateAged({ scope: scope() });
      await approvals().escalateAged({ scope: scope() });

      const settledRows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { tenantId, status: { not: 'Pending' } },
        }),
      );
      assert.equal(settledRows.length, 0, 'nothing was decided by the passage of time');
    });

    it('does not escalate on age alone', async () => {
      // Escalating everything old trains people to ignore escalations.
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.update({
          where: { id: raised.id },
          data: { createdAt: new Date(Date.now() - 400 * 3_600_000) },
        }),
      );

      const outcome = await approvals().escalateAged({ scope: scope() });
      assert.equal(outcome.escalated, 0);
      assert.match(outcome.skipped[0]?.reason ?? '', /not overdue/);
    });

    it('escalates once, not on every sweep', async () => {
      await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Overdue',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: managerUserId,
        namedApproverUserId: workerUserId,
        dueAt: new Date(Date.now() - 3_600_000),
      });

      assert.equal((await approvals().escalateAged({ scope: scope() })).escalated, 1);
      assert.equal((await approvals().escalateAged({ scope: scope() })).escalated, 0);
    });

    it('escalates to nobody rather than inventing a recipient', async () => {
      // The manager is at the top of the tree. Escalating to a made-up recipient would be worse
      // than saying there is nowhere to go.
      await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Nowhere up',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: workerUserId,
        namedApproverUserId: managerUserId,
        dueAt: new Date(Date.now() - 3_600_000),
      });

      const outcome = await approvals().escalateAged({ scope: scope() });
      assert.equal(outcome.escalated, 0);
      assert.match(outcome.skipped[0]?.reason ?? '', /Nobody to escalate to/);
    });

    it('notifies the manager it escalated to', async () => {
      await approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Overdue and waiting',
        detail: '',
        subjectType: 'Objective',
        requestedByUserId: headUserId,
        namedApproverUserId: workerUserId,
        dueAt: new Date(Date.now() - 3_600_000),
      });
      await approvals().escalateAged({ scope: scope() });

      const notifications = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, recipientUserId: managerUserId, kind: 'Overdue' },
        }),
      );
      assert.equal(notifications.length, 1);
      // It says what actually happened: nobody has decided.
      assert.match(notifications[0]?.body ?? '', /has not been approved/);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Integration with the other modules
  // -------------------------------------------------------------------------

  describe('integration', () => {
    it('gives the Executor RequestApproval a real row somebody can see', async () => {
      // Prompt 27 left this as a state change with nothing behind it: the Executor could report
      // that it had asked for a decision nobody would ever find in a queue.
      // A budget block, because `resolutionsFor` offers RequestApproval only for an
      // ApprovalPending or BudgetOrTokenLimit exception — the two kinds where a person's
      // decision is the thing actually missing. A repeated failure is not one of them.
      const { runId } = await blockedRun('BlockedByBudget', 'The department budget is exhausted.');
      await executor().sweep({ scope: scope() });

      const open = await executor().list({ scope: scope(), actorUserId: headUserId });
      const exception = open.exceptions.find((e) => e.sourceId === runId);
      assert.notEqual(exception, undefined);

      await executor().act({
        scope: scope(),
        exceptionId: exception!.id,
        action: 'RequestApproval',
        actorUserId: headUserId,
        note: 'Needs a decision before we retry.',
      });

      const queue = await approvals().list({
        scope: scope(),
        actorUserId: headUserId,
        type: 'HighRiskAction',
      });
      const raised = queue.requests.find((r) => r.subjectId === exception!.id);
      assert.notEqual(raised, undefined, 'the Executor raised a visible approval request');
      assert.equal(raised?.status, 'Pending');
      assert.equal(raised?.subjectType, 'ExecutorException');
    });

    it('does not let the Executor decide the approval it raised', async () => {
      // The locked rule: the Executor escalates rather than proceeding. There is no endpoint
      // through which an automated actor decides anything, and the request it raises is
      // addressed to a person.
      // A budget block, because `resolutionsFor` offers RequestApproval only for an
      // ApprovalPending or BudgetOrTokenLimit exception — the two kinds where a person's
      // decision is the thing actually missing. A repeated failure is not one of them.
      const { runId } = await blockedRun('BlockedByBudget', 'The department budget is exhausted.');
      await executor().sweep({ scope: scope() });
      const open = await executor().list({ scope: scope(), actorUserId: headUserId });
      const exception = open.exceptions.find((e) => e.sourceId === runId);

      await executor().act({
        scope: scope(),
        exceptionId: exception!.id,
        action: 'RequestApproval',
        actorUserId: headUserId,
        note: 'Please decide.',
      });

      const queue = await approvals().list({
        scope: scope(),
        actorUserId: headUserId,
        type: 'HighRiskAction',
      });
      const raised = queue.requests.find((r) => r.subjectId === exception!.id)!;

      // The Head raised it, so the Head cannot decide it. Somebody else must.
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'Proceeding.',
          }),
        /cannot approve something you created|names a different approver/i,
      );
    });

    it('puts a workflow step gate in the same queue, decided by the same engine', async () => {
      // Prompt 23 creates the row when the plan is assigned; Prompt 28 decides it. One table, and
      // this test is what proves the two prompts agree about it.
      await assignedAiWork({
        steps: [
          step({ position: 1, approval: 'Manager' }),
          step({
            position: 2,
            whoEngine: 'Engine',
            whoPersonName: 'Pranav Kulkarni',
            whatExactWork: 'Draft the GSPR matrix from the evidence index',
            outputWhatIsProduced: 'Draft checklist',
          }),
        ],
      });

      const queue = await approvals().list({ scope: scope(), actorUserId: headUserId });
      const gate = queue.requests.find((r) => r.type === 'WorkflowStepApproval');
      assert.notEqual(gate, undefined, 'the assigned plan produced an approval gate');

      // Governed by `approvals`, not `todo`. Nothing in ROLE_TEMPLATES grants `todo:Approve`, so
      // mapping it there would have made every workflow gate in the product undecidable.
      assert.equal(gate?.module, 'approvals');
    });

    // ADR-293: the Manager role now holds `approvals:Approve`, because Form 2 offers `Manager` as
    // an approval authority and a request routed there was previously undecidable by anybody. The
    // separation that mattered is unchanged — it never lived in the absence of the grant. This
    // test keeps the scenario it always had (a manager signing off the plan they authored) and now
    // asserts the rule that actually refuses it.
    it('still refuses a Manager deciding a gate on the plan they authored themselves', async () => {
      await assignedAiWork({
        steps: [
          step({ position: 1, approval: 'Manager' }),
          step({
            position: 2,
            whoEngine: 'Engine',
            whoPersonName: 'Pranav Kulkarni',
            whatExactWork: 'Draft the GSPR matrix from the evidence index',
            outputWhatIsProduced: 'Draft checklist',
          }),
        ],
      });

      const queue = await approvals().list({ scope: scope(), actorUserId: headUserId });
      const gate = queue.requests.find((r) => r.type === 'WorkflowStepApproval');
      if (gate === undefined) throw new Error('expected an approval gate');

      // `assignedAiWork` creates, reviews and assigns everything as the manager, so they are the
      // requester. NoSelfApproval keys on exactly that and refuses — the grant changes nothing
      // about it.
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: managerUserId,
            approvalId: gate.id,
            decision: 'Approve',
            note: 'Signing off my own team plan.',
          }),
        /something you created|a different person|names a different approver|addressed to a/i,
      );
    });

    // -----------------------------------------------------------------------
    // ADR-293 — what the Manager grant does and does not reach.
    //
    // Six checks, one per limit the decision named. Each one is written so that it would fail if
    // the limit were dropped, not merely pass while the limit happens to hold.
    // -----------------------------------------------------------------------
    describe('the Manager approval grant (ADR-293)', () => {
      /** A Manager-addressed request raised by somebody else, so self-approval is not in play. */
      const addressedToManagers = async (overrides: Record<string, unknown> = {}) =>
        approvals().raise({
          scope: scope(),
          type: 'OutputApproval',
          title: 'Weekly pack ready for the manager to sign off',
          detail: 'Submitted by the team member who did the work.',
          subjectType: 'HumanTask',
          requestedByUserId: workerUserId,
          approverRoleKind: 'Manager',
          ...overrides,
        });

      it('lets a Manager approve in-scope work a subordinate submitted', async () => {
        const raised = await addressedToManagers();

        const decided = await approvals().decide({
          scope: scope(),
          actorUserId: managerUserId,
          approvalId: raised.id,
          decision: 'Approve',
          note: 'Checked against the weekly template; the exception list is complete.',
        });

        assert.equal(decided.status, 'Approved');
      });

      it('still refuses a Manager approving a request they raised themselves', async () => {
        const raised = await addressedToManagers({ requestedByUserId: managerUserId });

        await assert.rejects(
          () =>
            approvals().decide({
              scope: scope(),
              actorUserId: managerUserId,
              approvalId: raised.id,
              decision: 'Approve',
              note: 'Approving my own submission.',
            }),
          /something you created|a different person/i,
        );
      });

      it('does not let a Manager approve work outside their TeamSubtree', async () => {
        // The scope is evaluated against the request's owner. The fixture employs the manager as
        // the root with two reports under them; the Head is not in that subtree at all. So a
        // Manager-addressed request whose owner is the Head is in this company, addressed to this
        // role, and still out of reach — which is the whole point of TeamSubtree.
        const outside = await addressedToManagers({
          requestedByUserId: headUserId,
          title: 'Work belonging to somebody outside the manager’s team',
        });

        await assert.rejects(
          () =>
            approvals().decide({
              scope: scope(),
              actorUserId: managerUserId,
              approvalId: outside.id,
              decision: 'Approve',
              note: 'Reaching outside my own team.',
            }),
          /scope|outside|not in your|covers/i,
        );
      });

      it('does not let a Manager decide a request addressed to another role', async () => {
        // Head-addressed. The grant is not a master key: routing still decides who may answer.
        const raised = await highRiskAddressedToHeads();

        await assert.rejects(
          () =>
            approvals().decide({
              scope: scope(),
              actorUserId: managerUserId,
              approvalId: raised.id,
              decision: 'Approve',
              note: 'Taking this one as well.',
            }),
          /addressed to a|names a different approver|does not include/i,
        );
      });

      it('does not let a Manager decide a request in another company', async () => {
        const raised = await addressedToManagers();

        // The other tenant's scope, with this company's manager as the actor. Row-level security
        // confines the read before authorization is consulted, so the request is simply not there.
        await assert.rejects(
          () =>
            approvals().decide({
              scope: tenantScopeForPlatformOperation(otherTenantId),
              actorUserId: managerUserId,
              approvalId: raised.id,
              decision: 'Approve',
              note: 'Reaching across a tenant boundary.',
            }),
          /not found|no such|no role in this company|outside/i,
        );
      });

      it('does not let one Manager settle a four-eyes gate on their own', async () => {
        // Still true, for a better reason: the Manager may now be an eye, but one eye is not the
        // gate. Two distinct people are required, and ADR-296 proves the full sequence.
        const raised = await addressedToManagers({
          type: 'HighRiskAction',
          title: 'A four-eyes action',
          approverRoleKind: 'FourEyes',
        });

        await approvals().decide({
          scope: scope(),
          actorUserId: managerUserId,
          approvalId: raised.id,
          decision: 'Approve',
          note: 'One pair of eyes.',
        });

        const state = await ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.approvalRequest.findFirstOrThrow({
            where: { id: raised.id },
            select: { status: true },
          }),
        );
        assert.equal(state.status, 'Pending', 'one Manager approval does not settle four eyes');
      });

      it('still refuses an Employee, who holds no Approve at all', async () => {
        const raised = await addressedToManagers();

        await assert.rejects(
          () =>
            approvals().decide({
              scope: scope(),
              actorUserId: workerUserId,
              approvalId: raised.id,
              decision: 'Approve',
              note: 'Approving my own work as an employee.',
            }),
          /does not include "Approve"|addressed to a|something you created|a different person/i,
        );
      });

      it('leaves Head and Approver able to decide exactly what they always could', async () => {
        const headRequest = await highRiskAddressedToHeads({ requestedByUserId: workerUserId });
        const decided = await approvals().decide({
          scope: scope(),
          actorUserId: headUserId,
          approvalId: headRequest.id,
          decision: 'Approve',
          note: 'Head decision, unchanged by the Manager grant.',
        });
        assert.equal(decided.status, 'Approved');
      });
    });
  });

  // -------------------------------------------------------------------------
  // 8. Tenant isolation and the HTTP surface
  // -------------------------------------------------------------------------

  describe('tenant isolation and the API', () => {
    it('refuses an unauthenticated request', async () => {
      await agent()
        .get(`/tenants/${tenantId}/approvals`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('never lets somebody from another company read the queue', async () => {
      await highRiskAddressedToHeads();

      const across = await as(
        agent().get(`/tenants/${tenantId}/approvals`),
        outsiderUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.requests, undefined);
    });

    it('stores no approval outside its own tenant', async () => {
      await highRiskAddressedToHeads();
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({ where: { tenantId: otherTenantId } }),
      );
      assert.equal(rows.length, 0);
    });

    it('serves the queue and its vocabulary over HTTP', async () => {
      await highRiskAddressedToHeads({ requestedByUserId: managerUserId });

      const meta = await as(agent().get(`/tenants/${tenantId}/approvals/meta`), headUboss).expect(
        200,
      );
      assert.equal(meta.body.types.length, APPROVAL_REQUEST_TYPES.length);
      assert.equal(meta.body.decisions.length, 4);
      assert.match(meta.body.note, /Nothing approves on a timer/);

      const listed = await as(agent().get(`/tenants/${tenantId}/approvals`), headUboss).expect(200);
      assert.equal(listed.body.requests.length, 1);
    });

    it('decides over HTTP and records the history', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });

      const decided = await as(
        agent()
          .post(`/tenants/${tenantId}/approvals/${raised.id}/decide`)
          .send({ decision: 'Approve', note: 'Fine by me.' }),
        headUboss,
      ).expect(201);

      assert.equal(decided.body.status, 'Approved');
      assert.equal(decided.body.history.length, 1);
    });

    it('refuses an unknown decision', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await as(
        agent()
          .post(`/tenants/${tenantId}/approvals/${raised.id}/decide`)
          .send({ decision: 'Rubberstamp', note: 'x' }),
        headUboss,
      ).expect(400);
    });

    it('writes an audit event for every decision', async () => {
      const raised = await highRiskAddressedToHeads({ requestedByUserId: managerUserId });
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Approved.',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceType: 'approval-request' },
          orderBy: { occurredAt: 'asc' },
        }),
      );
      const actions = events.map((e) => e.action);
      assert.ok(actions.includes('approvals.requested'));
      assert.ok(actions.includes('approvals.approve'));
    });
  });

  // ===========================================================================
  // ADR-294 — the human task approval loop.
  //
  // Submitting a task that needs approval parks it at WaitingApproval and raises an OutputApproval
  // against it. Nothing used to read that back, so an approved task never finished. These tests
  // drive the real services end to end: the task is submitted through HumanTaskService and decided
  // through ApprovalService. The only Prisma writes are fixtures standing a task up in the first
  // place — never a status nudged to make an assertion pass.
  // ===========================================================================
  describe('the human task approval loop (ADR-294)', () => {
    /** A task that has reached WaitingApproval the way a person reaches it. */
    const taskAwaitingApproval = async ({
      approvalKind = 'Manager',
      assignee = workerUserId,
    }: { approvalKind?: string; assignee?: string } = {}) => {
      const created = await objectives().create({
        scope: scope(),
        actorUserId: managerUserId,
        content: form2(),
        steps: mixedSteps(),
      });
      const version = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveVersion.findFirstOrThrow({
          where: { objectiveId: created.id },
          select: { id: true },
        }),
      );

      // A task points at the workflow draft it came from, so the draft has to exist first. The
      // graph is the minimum the schema accepts: these tests are about the approval loop, not
      // about what the analysis produces.
      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.create({
          data: {
            tenantId,
            objectiveId: created.id,
            objectiveVersionId: version.id,
            graph: { nodes: [{ id: 'step-1', kind: 'Human' }], edges: [] },
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
          },
          select: { id: true },
        }),
      );

      const task = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.create({
          data: {
            tenantId,
            objectiveId: created.id,
            objectiveVersionId: version.id,
            workflowDraftId: draft.id,
            nodeId: 'step-1',
            title: 'Validate the weekly submissions',
            assignedToUserId: assignee,
            assignedByUserId: managerUserId,
            expectedOutput: 'A validated submission list.',
            evidenceRequirement: 'The submission log.',
            approvalKind,
            status: 'InProgress',
            startedAt: new Date(),
          },
          select: { id: true },
        }),
      );

      // Through the real service from here: evidence, then submit.
      await tasks().addEvidence({
        scope: scope(),
        actorUserId: assignee,
        taskId: task.id,
        description: 'All branches submitted.',
        reference: 'branch-ops/week-38',
      });
      const submitted = await tasks().submit({
        scope: scope(),
        actorUserId: assignee,
        taskId: task.id,
      });
      assert.equal(submitted.status, 'WaitingApproval');

      const request = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { subjectType: 'HumanTask', subjectId: task.id },
          select: { id: true, status: true },
        }),
      );
      return { taskId: task.id, approvalId: request.id, objectiveId: created.id };
    };

    const statusOf = async (taskId: string) =>
      ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.findFirstOrThrow({
          where: { id: taskId },
          select: { status: true, completedAt: true, submittedAt: true },
        }),
      );

    it('completes the task when its single required approval is approved', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();
      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Approve',
        note: 'Checked against the weekly template.',
      });

      const after = await statusOf(taskId);
      assert.equal(after.status, 'Completed');
      assert.ok(after.completedAt, 'a completed task records when it completed');
      assert.ok(after.submittedAt, 'and keeps when it was submitted');
    });

    it('charges the submitter when their submission is sent back', async () => {
      /*
       * `QualityRejected` sat in every company's policy at −10 with nothing able to produce it,
       * so work that had to be redone twice scored the same as work accepted first time.
       *
       * Nothing here moves the task. ADR-295's rule holds — the product defines no task
       * transition for a rejection and inventing one during an integration is how a lifecycle
       * acquires semantics nobody approved. What is recorded is the score the policy already
       * described.
       */
      const { taskId, approvalId } = await taskAwaitingApproval();

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Reject',
        note: 'The reconciliation is missing two branches.',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.findMany({
          where: { tenantId, sourceKind: 'approval_request', sourceId: approvalId },
        }),
      );

      assert.equal(events.length, 1, 'a rejected submission scored nothing');
      assert.equal(events[0]?.kind, 'QualityRejected');
      assert.equal(
        events[0]?.subjectUserId,
        workerUserId,
        'the rejection should cost the person who submitted, not the one who read it',
      );
      assert.ok((events[0]?.points ?? 0) < 0, 'a rejection should cost something');

      // The task itself is exactly where it was.
      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');
    });

    it('charges each rejection once, however often reconciliation runs', async () => {
      /*
       * Keyed on the approval rather than the task, so a resubmission that is sent back again is
       * a second outcome and re-reading the same rejection is not.
       */
      const { taskId, approvalId } = await taskAwaitingApproval();

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Reject',
        note: 'Two branches short.',
      });

      await tasks().reconcileApprovalOutcome({
        scope: scope(),
        taskId,
        actorUserId: managerUserId,
      });

      const charged = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({
          where: { tenantId, sourceKind: 'approval_request', sourceId: approvalId },
        }),
      );
      assert.equal(charged, 1, 'the same rejection was charged twice');
    });

    it('keeps the evidence, the approver and the decision on the completed task', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Approve',
        note: 'Signed off with the exception noted.',
      });

      const evidence = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTaskEvidence.findMany({ where: { taskId } }),
      );
      assert.equal(evidence.length, 1, 'evidence survives completion');

      const request = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({ where: { id: approvalId } }),
      );
      assert.equal(request.status, 'Approved');
      assert.equal(request.decidedByUserId, managerUserId, 'the approver is on the record');
      assert.ok(request.decidedAt, 'and when they decided');
      assert.match(request.decisionNote ?? '', /exception/);

      // The completion is in the trail, linked to the task and naming the approvals that satisfied
      // it, so "why did this finish" is answerable without inference.
      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: taskId, action: 'todo.task_completed' },
        }),
      );
      assert.equal(events.length, 1);
      assert.match(JSON.stringify(events[0]?.metadata ?? {}), /approvalRequestIds/);
    });

    it('does not duplicate side effects when reconciled again', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Approve',
        note: 'First and only decision.',
      });
      const first = await statusOf(taskId);

      // A retry, a redelivered decision, a sweep: the same call again must change nothing.
      const again = await tasks().reconcileApprovalOutcome({
        scope: scope(),
        taskId,
        actorUserId: managerUserId,
      });
      assert.equal(again.changed, false, 'the second pass is a no-op');

      const second = await statusOf(taskId);
      assert.equal(second.status, 'Completed');
      assert.deepEqual(second.completedAt, first.completedAt, 'completion time is not moved');

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: taskId, action: 'todo.task_completed' },
        }),
      );
      assert.equal(events.length, 1, 'and the trail records it once');
    });

    it('does not let the requester approve their own task through the loop', async () => {
      // Assigned to the manager, so the manager is the one who submitted it and raised the request.
      const { taskId, approvalId } = await taskAwaitingApproval({ assignee: managerUserId });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: managerUserId,
            approvalId,
            decision: 'Approve',
            note: 'Approving my own work.',
          }),
        /something you created|a different person/i,
      );

      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');
    });

    it('cannot be completed by a decision from another company', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();

      await assert.rejects(
        () =>
          approvals().decide({
            scope: tenantScopeForPlatformOperation(otherTenantId),
            actorUserId: managerUserId,
            approvalId,
            decision: 'Approve',
            note: 'From the wrong company.',
          }),
        /not found|no such|no role in this company|outside/i,
      );

      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');
    });

    it('is untouched by an approval for a different resource', async () => {
      const { taskId } = await taskAwaitingApproval();
      const unrelated = await highRiskAddressedToHeads({ requestedByUserId: workerUserId });

      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: unrelated.id,
        decision: 'Approve',
        note: 'Nothing to do with that task.',
      });

      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');
    });

    it('does not let the assignee reach Completed by re-submitting', async () => {
      const { taskId } = await taskAwaitingApproval();

      // Re-submitting is permitted by the lifecycle and does not throw, so the property worth
      // asserting is the one the requirement is about: it does not finish the task. The assignee
      // cannot reach Completed from the task side at all — that edge does not exist, and approval
      // remains outstanding afterwards.
      await tasks().submit({ scope: scope(), actorUserId: workerUserId, taskId });

      const after = await statusOf(taskId);
      assert.notEqual(after.status, 'Completed', 'submitting again is not a way to finish');
      assert.equal(after.status, 'WaitingApproval');
      assert.equal(after.completedAt, null);

      const stillPending = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.count({
          where: { subjectType: 'HumanTask', subjectId: taskId, status: 'Pending' },
        }),
      );
      assert.ok(stillPending > 0, 'an approval is still outstanding');
    });

    /*
     * Reopening withdraws the approval the submission raised — the approved F3 decision.
     *
     * The lifecycle lets a person pull work back out of WaitingApproval, and the request that
     * submission raised used to stay Pending in the approver's queue with nothing on it to say
     * the work had been withdrawn. Proven against the running product: an approver signed off a
     * submission that had been pulled back three minutes earlier, and a resubmission then left
     * two identical requests governing one task, each of which had to be approved before it
     * could ever finish. Every reopen added another.
     */
    it('withdraws the pending approval when the work is pulled back', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();

      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });

      assert.equal((await statusOf(taskId)).status, 'InProgress', 'the work is back in progress');

      const request = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { id: approvalId },
          select: { status: true, decidedByUserId: true, decidedAt: true, decisionNote: true },
        }),
      );

      assert.equal(request.status, 'Cancelled', 'the request no longer waits on withdrawn work');
      // Kept, not deleted: the trail has to answer "what happened to the thing in my queue".
      assert.equal(request.decidedByUserId, workerUserId, 'attributed to whoever pulled it back');
      assert.ok(request.decidedAt, 'and to when');
      assert.match(request.decisionNote ?? '', /withdrawn, not decided/i);

      const trail = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'todo.approvals_withdrawn', resourceId: taskId },
        }),
      );
      assert.equal(trail.length, 1, 'the withdrawal is on the record');
    });

    it('refuses a decision on a withdrawn request', async () => {
      const { taskId, approvalId } = await taskAwaitingApproval();
      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });

      // The approver's queue still shows it until they reload; deciding it must not work.
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: managerUserId,
            approvalId,
            decision: 'Approve',
            note: 'Approving something that was withdrawn.',
          }),
        (error: Error) => /already|cancelled|not pending/i.test(error.message),
      );

      assert.equal((await statusOf(taskId)).status, 'InProgress', 'and the task is unaffected');
    });

    it('raises a fresh approval for the revised work, and finishes on that one alone', async () => {
      const { taskId, approvalId: original } = await taskAwaitingApproval();

      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });
      await tasks().addEvidence({
        scope: scope(),
        actorUserId: workerUserId,
        taskId,
        description: 'Corrected: the two missing branches are now included.',
        reference: 'branch-ops/week-38-v2',
      });
      const resubmitted = await tasks().submit({
        scope: scope(),
        actorUserId: workerUserId,
        taskId,
      });
      assert.equal(resubmitted.status, 'WaitingApproval');

      const requests = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { subjectType: 'HumanTask', subjectId: taskId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true },
        }),
      );
      assert.equal(requests.length, 2, 'the withdrawn one is kept, not replaced in place');
      assert.equal(requests[0]?.id, original);
      assert.equal(requests[0]?.status, 'Cancelled');
      assert.equal(requests[1]?.status, 'Pending', 'and the revised work has its own');

      // One decision, on the new request only, finishes the task. Before this, the withdrawn one
      // counted against it and the task could never complete.
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: requests[1]?.id ?? '',
        decision: 'Approve',
        note: 'The corrected list matches the template.',
      });

      const after = await statusOf(taskId);
      assert.equal(after.status, 'Completed', 'the revised work finished on its own approval');
      assert.ok(after.completedAt);
    });

    it('is not blocked by a rejection from a submission that was withdrawn', async () => {
      /*
       * A settled record is never modified, so a rejection survives a reopen — and every
       * governing request has to be Approved before a task finishes. Without scoping the set to
       * the current submission, that old rejection would block the task for ever: the exact
       * "stuck task" this decision exists to prevent, arriving by the one door the withdrawal
       * cannot close.
       */
      const { taskId, approvalId } = await taskAwaitingApproval();

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId,
        decision: 'Reject',
        note: 'Two branches are missing from the list.',
      });
      assert.equal((await statusOf(taskId)).status, 'WaitingApproval', 'a rejection parks it');

      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });
      await tasks().addEvidence({
        scope: scope(),
        actorUserId: workerUserId,
        taskId,
        description: 'Both missing branches added.',
        reference: 'branch-ops/week-38-v3',
      });
      await tasks().submit({ scope: scope(), actorUserId: workerUserId, taskId });

      const fresh = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { subjectType: 'HumanTask', subjectId: taskId, status: 'Pending' },
          select: { id: true },
        }),
      );

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: fresh.id,
        decision: 'Approve',
        note: 'The corrected list is complete.',
      });

      assert.equal(
        (await statusOf(taskId)).status,
        'Completed',
        'an old rejection must not block the submission that replaced it',
      );

      // And it is still there to read.
      const rejected = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { id: approvalId },
          select: { status: true, decisionNote: true },
        }),
      );
      assert.equal(rejected.status, 'Rejected', 'a settled decision is never rewritten');
      assert.match(rejected.decisionNote ?? '', /missing/i);
    });

    it('withdraws only on a reopen, not on every Start', async () => {
      /*
       * Resuming from Blocked is the other way a task reaches In progress, and it has no
       * submission behind it. Proving the withdrawal is confined to the WaitingApproval edge
       * rather than firing on every Start — which would be a sweep over an approval queue run by
       * a routine button.
       *
       * (In progress cannot be started again at all — that edge does not exist — so Blocked is
       * how this case is reached.)
       */
      const { taskId } = await taskAwaitingApproval();

      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });
      const afterReopen = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.count({
          where: { tenantId, action: 'todo.approvals_withdrawn', resourceId: taskId },
        }),
      );
      assert.equal(afterReopen, 1, 'the reopen withdrew once');

      await tasks().block({
        scope: scope(),
        actorUserId: workerUserId,
        taskId,
        reason: 'Waiting on the branch file.',
      });
      await tasks().start({ scope: scope(), actorUserId: workerUserId, taskId });

      const afterResume = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.count({
          where: { tenantId, action: 'todo.approvals_withdrawn', resourceId: taskId },
        }),
      );
      assert.equal(afterResume, 1, 'resuming from Blocked withdraws nothing');
    });

    it('is not completed by reconciliation alone while the approval is still pending', async () => {
      // The Executor may observe and reconcile; it must never stand in for the approver. Calling
      // the reconciliation directly, with the request still Pending, must change nothing.
      const { taskId } = await taskAwaitingApproval();

      const outcome = await tasks().reconcileApprovalOutcome({
        scope: scope(),
        taskId,
        actorUserId: headUserId,
      });

      assert.equal(outcome.changed, false);
      assert.equal((await statusOf(taskId)).status, 'WaitingApproval');
    });
  });

  // ===========================================================================
  // ADR-296 — four eyes means two distinct human approvals on the same request.
  //
  // The rule used to refuse anybody not preceded by another actor, while every decision that would
  // have made someone a prior actor also settled the request — so the first eye was always refused
  // and there was never a second. Permission to be an eye and satisfaction of the requirement are
  // now separate questions: the SoD gate decides who may contribute one, and the settlement counts
  // them.
  // ===========================================================================
  describe('four eyes, two distinct people (ADR-296)', () => {
    /** A four-eyes request raised by somebody who is not going to decide it. */
    const fourEyesRequest = async (overrides: Record<string, unknown> = {}) =>
      approvals().raise({
        scope: scope(),
        type: 'HighRiskAction',
        title: 'Release the regulatory filing early',
        detail: 'Two people have to agree.',
        subjectType: 'Objective',
        requestedByUserId: workerUserId,
        approverRoleKind: 'FourEyes',
        ...overrides,
      });

    const stateOf = async (approvalId: string) =>
      ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { id: approvalId },
          select: { status: true, decidedByUserId: true, decidedAt: true },
        }),
      );

    const eyesOn = async (approvalId: string) =>
      ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalDecisionRecord.findMany({
          where: { approvalRequestId: approvalId },
          orderBy: { occurredAt: 'asc' },
          select: { decision: true, actorUserId: true, note: true, occurredAt: true },
        }),
      );

    it('leaves the request Pending after the first valid approval', async () => {
      const raised = await fourEyesRequest();

      const after = await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First pair of eyes.',
      });

      assert.equal((await stateOf(raised.id)).status, 'Pending', 'one approval does not settle it');
      assert.equal(after.approvalsGiven, 1);
      assert.equal(after.approvalsRequired, 2);
    });

    it('approves on the second distinct approval', async () => {
      const raised = await fourEyesRequest();

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First pair of eyes.',
      });
      const second = await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Second pair of eyes.',
      });

      const state = await stateOf(raised.id);
      assert.equal(state.status, 'Approved');
      assert.ok(state.decidedAt, 'the settlement is timestamped');
      assert.equal(second.approvalsGiven, 2);
      assert.equal(second.approvalsRequired, 2);
    });

    it('does not let the same person be both eyes', async () => {
      const raised = await fourEyesRequest();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First.',
      });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: managerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'And again.',
          }),
        /already acted|second decision has to come from somebody else/i,
      );

      assert.equal((await stateOf(raised.id)).status, 'Pending');
    });

    it('is idempotent when the first approver retries', async () => {
      const raised = await fourEyesRequest();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First.',
      });
      const before = await eyesOn(raised.id);

      await approvals()
        .decide({
          scope: scope(),
          actorUserId: managerUserId,
          approvalId: raised.id,
          decision: 'Approve',
          note: 'Retry.',
        })
        .catch(() => null);

      const after = await eyesOn(raised.id);
      assert.equal(after.length, before.length, 'a retry adds no second eye');
      assert.equal((await stateOf(raised.id)).status, 'Pending');
    });

    it('does not count a comment as an eye', async () => {
      const raised = await fourEyesRequest();

      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Comment',
        note: 'Looks reasonable to me.',
      });
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'One genuine approval.',
      });

      assert.equal(
        (await stateOf(raised.id)).status,
        'Pending',
        'a comment plus one approval is one eye, not two',
      );
    });

    it('does not let the creator be an eye', async () => {
      const raised = await fourEyesRequest({ requestedByUserId: managerUserId });

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: managerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'My own request.',
          }),
        /something you created|a different person/i,
      );
    });

    it('does not let an Employee without authority be an eye', async () => {
      const raised = await fourEyesRequest();

      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: otherWorkerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'I would like to approve this.',
          }),
        /does not include "Approve"|addressed to a|outside what your role covers/i,
      );

      assert.equal((await stateOf(raised.id)).status, 'Pending');
    });

    it('does not let an actor from another company be an eye', async () => {
      const raised = await fourEyesRequest();

      await assert.rejects(
        () =>
          approvals().decide({
            scope: tenantScopeForPlatformOperation(otherTenantId),
            actorUserId: managerUserId,
            approvalId: raised.id,
            decision: 'Approve',
            note: 'From the wrong company.',
          }),
        /not found|no such|no role in this company|outside/i,
      );

      assert.equal((await stateOf(raised.id)).status, 'Pending');
    });

    it('keeps both decisions, neither overwriting the other', async () => {
      const raised = await fourEyesRequest();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First pair of eyes.',
      });
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'Second pair of eyes.',
      });

      const records = (await eyesOn(raised.id)).filter((row) => row.decision === 'Approve');
      assert.equal(records.length, 2, 'both eyes are on the record');
      assert.deepEqual(
        records.map((row) => row.actorUserId),
        [managerUserId, headUserId],
        'in the order they were given, with the first approver intact',
      );
      assert.match(records[0]?.note ?? '', /First pair/);
      assert.match(records[1]?.note ?? '', /Second pair/);
      for (const row of records) assert.ok(row.occurredAt, 'each eye is timestamped');
    });

    it('records the first eye in the trail without calling it final', async () => {
      const raised = await fourEyesRequest();
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: raised.id,
        decision: 'Approve',
        note: 'First.',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: raised.id, action: 'approvals.approve' },
        }),
      );
      assert.equal(events.length, 1);
      assert.match(events[0]?.summary ?? '', /1 of 2 approvals/);
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-296 meeting ADR-294: a four-eyes gate on a human task.
  // ---------------------------------------------------------------------------
  describe('four eyes on a human task (ADR-296 + ADR-294)', () => {
    it('does not complete the task after the first eye, and does after the second', async () => {
      const created = await objectives().create({
        scope: scope(),
        actorUserId: managerUserId,
        content: form2(),
        steps: mixedSteps(),
      });
      const version = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveVersion.findFirstOrThrow({
          where: { objectiveId: created.id },
          select: { id: true },
        }),
      );
      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.create({
          data: {
            tenantId,
            objectiveId: created.id,
            objectiveVersionId: version.id,
            graph: { nodes: [{ id: 'step-1', kind: 'Human' }], edges: [] },
            schemaVersion: ANALYSIS_SCHEMA_VERSION,
          },
          select: { id: true },
        }),
      );
      const task = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.humanTask.create({
          data: {
            tenantId,
            objectiveId: created.id,
            objectiveVersionId: version.id,
            workflowDraftId: draft.id,
            nodeId: 'step-1',
            title: 'Work needing two signatures',
            assignedToUserId: workerUserId,
            assignedByUserId: managerUserId,
            expectedOutput: 'A signed-off result.',
            evidenceRequirement: 'The working papers.',
            approvalKind: 'FourEyes',
            status: 'InProgress',
            startedAt: new Date(),
          },
          select: { id: true },
        }),
      );

      await tasks().addEvidence({
        scope: scope(),
        actorUserId: workerUserId,
        taskId: task.id,
        description: 'Working papers attached.',
        reference: 'wp/2026-38',
      });
      await tasks().submit({ scope: scope(), actorUserId: workerUserId, taskId: task.id });

      const request = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { subjectType: 'HumanTask', subjectId: task.id },
          select: { id: true },
        }),
      );

      const taskStatus = async () =>
        (
          await ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.humanTask.findFirstOrThrow({
              where: { id: task.id },
              select: { status: true },
            }),
          )
        ).status;

      // Eye one: the request stays open, and ADR-294 reconciliation must not run.
      await approvals().decide({
        scope: scope(),
        actorUserId: managerUserId,
        approvalId: request.id,
        decision: 'Approve',
        note: 'First pair of eyes.',
      });
      assert.equal(await taskStatus(), 'WaitingApproval', 'one eye does not finish the work');

      // Eye two: the gate closes and the task follows.
      await approvals().decide({
        scope: scope(),
        actorUserId: headUserId,
        approvalId: request.id,
        decision: 'Approve',
        note: 'Second pair of eyes.',
      });
      assert.equal(await taskStatus(), 'Completed');
    });
  });
  // -------------------------------------------------------------------------
  // Change requests
  // -------------------------------------------------------------------------

  /**
   * Somebody asks for a change.
   *
   * The rule under test is the client's: "Do not give the employee direct configuration power
   * simply because they requested a change." Filing one must change nothing — it must produce a
   * Pending request addressed to somebody with the authority, and nothing else.
   */
  describe('asking for a change', () => {
    it('creates a pending request addressed to the Admin, and changes nothing else', async () => {
      const raised = await approvals().requestChange({
        scope: scope(),
        actorUserId: workerUserId,
        kind: 'Access',
        reason: 'I cannot open the Field Operations workshop and I work there.',
      });

      assert.equal(raised.type, 'ChangeRequest');
      assert.equal(raised.status, 'Pending');

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { tenantId, id: raised.id },
          select: {
            changeKind: true,
            approverRoleKind: true,
            namedApproverUserId: true,
            requestedByUserId: true,
            detail: true,
            decidedAt: true,
          },
        }),
      );

      assert.equal(row.changeKind, 'Access');
      // Addressed to the authority rather than to whichever Admin is at their desk today.
      assert.equal(row.approverRoleKind, 'CompanyAdmin');
      assert.equal(row.namedApproverUserId, null);
      assert.equal(row.requestedByUserId, workerUserId);
      assert.match(row.detail, /Field Operations workshop/);
      // Nothing has been decided, which is the whole point: asking is not doing.
      assert.equal(row.decidedAt, null);
    });

    it('keeps the conversation it was raised from, so the Admin can read the thread', async () => {
      const conversation = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.chatConversation.create({
          data: {
            tenantId,
            kind: 'Group',
            title: 'Field Operations',
            createdByUserId: workerUserId,
          },
        }),
      );

      const raised = await approvals().requestChange({
        scope: scope(),
        actorUserId: workerUserId,
        kind: 'WorkReassignment',
        reason: 'Please move the Tuesday reconciliation to somebody else while I am away.',
        conversationId: conversation.id,
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { tenantId, id: raised.id },
          select: { subjectType: true, subjectId: true },
        }),
      );
      assert.equal(row.subjectType, 'ChatConversation');
      assert.equal(row.subjectId, conversation.id);
    });

    it('says so when it was not raised from a conversation', async () => {
      // Rather than claiming one it does not have.
      const raised = await approvals().requestChange({
        scope: scope(),
        actorUserId: workerUserId,
        kind: 'Other',
        reason: 'The Monday rota has me in two places at once.',
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { tenantId, id: raised.id },
          select: { subjectType: true, subjectId: true },
        }),
      );
      assert.equal(row.subjectType, 'ChangeRequest');
      assert.equal(row.subjectId, null);
    });

    it('refuses a reason nobody could act on', async () => {
      await assert.rejects(
        () =>
          approvals().requestChange({
            scope: scope(),
            actorUserId: workerUserId,
            kind: 'Hierarchy',
            reason: 'fix',
          }),
        (error: Error) => {
          assert.match(error.message, /Say what needs changing/i);
          return true;
        },
      );
    });

    it('refuses a kind nobody asked about', async () => {
      await assert.rejects(
        () =>
          approvals().requestChange({
            scope: scope(),
            actorUserId: workerUserId,
            kind: 'Salary' as never,
            reason: 'A perfectly good and sufficiently long reason.',
          }),
        (error: Error) => {
          assert.match(error.message, /not a kind of change/i);
          return true;
        },
      );
    });

    it('refuses a change kind on any other type, at the database', async () => {
      /*
       * The column means something for one type and nothing for the others, and the database says
       * so rather than trusting every future caller to remember.
       */
      await assert.rejects(() =>
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.approvalRequest.create({
            data: {
              tenantId,
              type: 'ObjectiveReview',
              status: 'Pending',
              title: 'Not a change request',
              subjectType: 'Objective',
              requestedByUserId: workerUserId,
              approverRoleKind: 'CompanyAdmin',
              changeKind: 'Access',
            },
          }),
        ),
      );
    });
  });
});
