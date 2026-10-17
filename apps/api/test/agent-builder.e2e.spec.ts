import { ObjectiveReviewService } from '../src/objectives/objective-review.service.js';
import { ApprovalService } from '../src/approvals/approval.service.js';
import { PerformanceService } from '../src/performance/performance.service.js';
import { HumanTaskService } from '../src/tasks/human-task.service.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  AGENT_RUN_TYPES,
  FORM3_ACTION_COLUMNS,
  FORM3_JOB_LEVEL_FIELDS,
  MISSING_DATA_BEHAVIOURS,
  type Form2Objective,
  type Form2WorkflowStep,
  type SkillContent,
  type WorkflowDraft,
} from '@uboss/types';

import { AgentBuilderController } from '../src/agents/agent-builder.controller.js';
import { AgentBuilderService } from '../src/agents/agent-builder.service.js';
import { AgentSyncService } from '../src/agents/agent-sync.service.js';
import { JobMethodService } from '../src/agents/job-method.service.js';
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
import { ConnectorAdapters } from '../src/connections/connector-adapters.js';
import { McpConnectorAdapter } from '../src/connections/mcp-connector.adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
import { ModelGateway } from '../src/model-gateway/model-gateway.js';
import { ClassifyingModelGateway } from './support/classifying-model-gateway.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { AssignmentService } from '../src/objectives/assignment.service.js';
import { WorkReleaseService } from '../src/tasks/work-release.service.js';
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
  approveObjectiveReview,
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
 * Prompt 24 — Agent Builder and the reusable Engine Agent.
 *
 * What this suite is defending:
 *
 *   1. **The ZERO-QUESTION RULE.** The builder asks only what the objective, the workflow, policy
 *      and the approved connections cannot already answer — and when they answer everything, it
 *      asks nothing and offers Ready to Test / Activate.
 *   2. **The employee never re-enters the job method.** Form 3 stays a read for authorized users,
 *      composed from records that already exist.
 *   3. **One agent, then Runs.** Recurring work never mints a second Engine Agent for the same
 *      job, and a published configuration is immutable because Runs will cite it.
 *   4. **No credential ever leaves.** A connection is chosen by identity and judged by the
 *      connections module.
 *   5. **A mock is never presented as a real provider run.** Every stored test result says which
 *      it was, and the database refuses one that will not.
 */
describe('agent builder and engine agent activation (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let managerUserId: string;
  let _managerUboss: string;
  let workerUserId: string;
  let workerUboss: string;
  let otherWorkerUserId: string;
  let objectiveApproverId: string;
  let headUboss: string;
  let skillAdminId: string;
  let skillApproverId: string;
  let skillApproverUboss: string;
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
  const approvals = () => app.get(ApprovalService);
  const builder = () => app.get(AgentBuilderService);
  const skills = () => app.get(SkillService);
  const sync = () => app.get(AgentSyncService);

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
      controllers: [ObjectiveController, AgentBuilderController],
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
        MockConnectorAdapter,
        McpConnectorAdapter,
        ConnectorAdapters,
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
        ObjectiveReviewService,
        ApprovalService,
        PerformanceService,
        HumanTaskService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        WorkReleaseService,
        AgentBuilderService,
        JobMethodService,
        AgentSyncService,
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
    _managerUboss = people.manager.ubossUniqueId;
    workerUserId = people.worker.id;
    workerUboss = people.worker.ubossUniqueId;
    otherWorkerUserId = people.otherWorker.id;
    objectiveApproverId = people.head.id;
    headUboss = people.head.ubossUniqueId;
    skillAdminId = people.skillAdmin.id;
    skillApproverId = people.skillApprover.id;
    skillApproverUboss = people.skillApprover.ubossUniqueId;
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

      // The employee who owns the assigned AI work. `OwnWork` is the whole point: they complete
      // their own setup and activate, and nothing wider.
      //
      // **Since CR-03 (Prompt 40A) that needs an explicit grant.** A standard Employee is
      // operations-only — no Objective Optimization, no Agent Builder — so these two are "Power
      // Employees": the same template plus a `Custom` role carrying the builder permissions, which
      // is the client's own description of the case. `grantBuilderAccess` does it through the
      // mechanism that already existed, and keeps the scope at `OwnWork` so the capability is
      // widened without the reach being widened.
      //
      // A standard Employee being *refused* the same journey is asserted separately, below.
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

      /*
       * Builder access, granted by name rather than inherited from a role.
       *
       * Two rules put it here. CR-03 took it out of the Employee template, and the client's
       * 2026-09-25 rule took it out of Manager and Head as well: the model is that the Admin builds
       * Agents and everybody else operates them, with anything more granted explicitly. So these
       * personas are given it the way a real Admin would give it, through the mechanism the product
       * already ships — which also means these tests exercise that mechanism rather than assuming a
       * role default that no longer exists.
       *
       * The reach is granted with the capability and no wider: an employee over their own work, a
       * manager over their team, a head over their department.
       */
      for (const userId of [workerUserId, otherWorkerUserId]) {
        await grantBuilderAccess(ctx, {
          tenantId,
          userId,
          grantedByUserId: platformOwnerId,
        });
      }

      await grantBuilderAccess(ctx, {
        tenantId,
        userId: managerUserId,
        grantedByUserId: platformOwnerId,
        scopeKind: 'TeamSubtree',
        canPublish: true,
      });

      await grantBuilderAccess(ctx, {
        tenantId,
        userId: objectiveApproverId,
        grantedByUserId: platformOwnerId,
        scopeKind: 'Department',
        canPublish: true,
        departmentIds: [departmentId],
      });

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
  const assignedAiWork = async ({ withSkill = true } = {}) => {
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
    // CR-04: the review this submission raised has to be decided before the
    // analysis will run. See `approveObjectiveReview`.
    await approveObjectiveReview({
      context: ctx,
      tenantId,
      objectiveId: created.id,
      decide: (approverUserId, approvalId) =>
        approvals().decide({
          scope: scope(),
          actorUserId: approverUserId,
          approvalId,
          decision: 'Approve',
          note: 'Reviewed and approved for analysis.',
        }),
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

  // -------------------------------------------------------------------------
  // 1. The zero-question rule
  // -------------------------------------------------------------------------

  describe('the ZERO-QUESTION RULE', () => {
    it('prefills everything the objective, the workflow and policy already answer', async () => {
      const { assignmentId } = await assignedAiWork();
      const view = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });

      // The client's read-only row set: agent name, objective, AI work, owner, attached Skills.
      assert.ok(view.prefill.suggestedAgentName.trim() !== '');
      assert.ok(view.prefill.objectiveName.trim() !== '');
      assert.ok(view.prefill.assignedWork.trim() !== '');
      assert.ok(view.prefill.skillVersionIds.length > 0, 'the matched Skill was not carried over');
      // Derived by policy, so never asked.
      assert.equal(typeof view.prefill.approvalRequired, 'boolean');
      assert.ok(view.prefill.completionEvidence.trim() !== '');
      assert.equal(
        view.missing.some((entry) => entry.field === ('approvalRequired' as never)),
        false,
      );
    });

    it('asks only for the setup nobody has recorded, and says why for each', async () => {
      const { assignmentId } = await assignedAiWork();
      const view = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });

      assert.ok(view.missing.length > 0, 'a brand new builder asked nothing');
      for (const entry of view.missing) {
        assert.ok(entry.label.trim() !== '', `${entry.field} has no label`);
        assert.ok(entry.why.trim() !== '', `${entry.field} does not say why it is asked`);
      }
    });

    it('asks nothing once everything is answered, and offers Ready to Test', async () => {
      // The rule stated exactly: "show Ready to Test / Activate and ask nothing extra".
      const { assignmentId } = await assignedAiWork();
      const view = await answerEverything(assignmentId);

      assert.deepEqual(view.missing, []);
      assert.equal(view.readiness.readyToTest, true);
    });

    it('never asks a manual agent when it runs', async () => {
      const { assignmentId } = await assignedAiWork();
      const view = await answerEverything(assignmentId);

      assert.equal(view.setup.runType, 'Manual');
      assert.equal(
        view.missing.some((entry) => entry.field === 'triggerOrFrequency'),
        false,
      );
    });

    it('asks a scheduled agent when it runs, and clears the answer if the type changes back', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const scheduled = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: { runType: 'Scheduled' },
      });
      assert.deepEqual(
        scheduled.missing.map((entry) => entry.field),
        ['triggerOrFrequency'],
      );

      const timed = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: { triggerOrFrequency: 'Monday 10:30' },
      });
      assert.deepEqual(timed.missing, []);

      // Back to manual: the schedule stopped applying, so it is cleared rather than left to
      // linger as "Monday 10:30" on an agent a person starts by hand.
      const manual = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: { runType: 'Manual' },
      });
      assert.equal(manual.setup.triggerOrFrequency, null);
      assert.deepEqual(manual.missing, []);
    });

    it('patches one answer without blanking the others', async () => {
      const { assignmentId } = await assignedAiWork();
      const answered = await answerEverything(assignmentId);

      const patched = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: { outputDestination: 'The regulatory evidence folder' },
      });

      assert.equal(patched.setup.outputDestination, 'The regulatory evidence folder');
      assert.equal(patched.setup.runType, answered.setup.runType);
      assert.equal(patched.setup.whereWorkHappens, answered.setup.whereWorkHappens);
      assert.equal(patched.setup.missingDataBehaviour, answered.setup.missingDataBehaviour);
    });

    /**
     * The shape the **HTTP layer** actually delivers, which the test above does not.
     *
     * `@Type(() => AgentSetupPatchDto)` builds an instance of the DTO class, and an instance
     * carries every declared property as an own key — so the five nobody sent arrive as
     * `undefined`, not absent. The test above passes a plain object literal with one key, which
     * is the one shape no real request ever has, so it agreed with itself while the endpoint was
     * broken for every single-field save made from the screen.
     *
     * What it was: spreading those `undefined`s replaced the stored answers, and the vocabulary
     * check then refused the request naming a field nobody had touched —
     * `Unknown Missing/Wrong Data behaviour "undefined"`. Answering one question at a time, which
     * is the entire purpose of this endpoint, could not be done.
     */
    it('ignores the undefined keys a DTO instance carries for fields nobody sent', async () => {
      const { assignmentId } = await assignedAiWork();
      const answered = await answerEverything(assignmentId);

      const asTheDtoArrives = {
        runType: undefined,
        triggerOrFrequency: undefined,
        inputConnectionId: undefined,
        whereWorkHappens: undefined,
        outputDestination: 'The regulatory evidence folder',
        missingDataBehaviour: undefined,
      };

      const patched = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: asTheDtoArrives,
      });

      assert.equal(patched.setup.outputDestination, 'The regulatory evidence folder');
      assert.equal(patched.setup.runType, answered.setup.runType);
      assert.equal(patched.setup.whereWorkHappens, answered.setup.whereWorkHappens);
      assert.equal(patched.setup.missingDataBehaviour, answered.setup.missingDataBehaviour);
    });

    /**
     * The first answer on work where nothing has been answered yet.
     *
     * The same defect, at the point it was actually hit: a brand-new piece of work has no stored
     * setup at all, so every field starts null, and the first save carries one answer and five
     * `undefined`s. It came back as a 400 about a field the person had not reached yet.
     */
    it('accepts the very first answer, with every other field still unanswered', async () => {
      const { assignmentId } = await assignedAiWork();

      const first = await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: {
          runType: 'Scheduled',
          triggerOrFrequency: undefined,
          inputConnectionId: undefined,
          whereWorkHappens: undefined,
          outputDestination: undefined,
          missingDataBehaviour: undefined,
        },
      });

      assert.equal(first.setup.runType, 'Scheduled');
      assert.equal(first.setup.whereWorkHappens, null);
      assert.equal(first.setup.missingDataBehaviour, null);
    });

    it('refuses a run type or behaviour outside the client’s vocabulary', async () => {
      const { assignmentId } = await assignedAiWork();

      await assert.rejects(
        () =>
          builder().saveSetup({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            patch: { runType: 'Whenever' as never },
          }),
        /Run Type/,
      );
      await assert.rejects(
        () =>
          builder().saveSetup({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            patch: { missingDataBehaviour: 'Improvise' as never },
          }),
        /Missing\/Wrong Data/,
      );
    });

    it('serves a vocabulary the server itself validates against', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/agent-builder/meta`),
        workerUboss,
      ).expect(200);

      assert.deepEqual(
        response.body.runTypes.map((entry: { runType: string }) => entry.runType),
        [...AGENT_RUN_TYPES],
      );
      assert.deepEqual(
        response.body.missingDataBehaviours.map((entry: { behaviour: string }) => entry.behaviour),
        [...MISSING_DATA_BEHAVIOURS],
      );
      assert.equal(response.body.form3.actionColumns.length, FORM3_ACTION_COLUMNS.length);
      assert.equal(response.body.form3.jobLevelFields.length, FORM3_JOB_LEVEL_FIELDS.length);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Test
  // -------------------------------------------------------------------------

  /**
   * A sample long enough to be one.
   *
   * `agentTestProblems` refuses anything under ten characters, because an agent given one word
   * has not been tested. Written once here so a test that is about something else does not fail
   * for a reason it was not asking about.
   */
  const SAMPLE = 'Invoice INV-4471, vendor Meridian Supplies, 82,400 INR, dated 14 March.';

  describe('Test Agent', () => {
    it('refuses to test an agent whose setup is unfinished', async () => {
      // A test against incomplete setup is not testing what would actually run.
      const { assignmentId } = await assignedAiWork();
      await assert.rejects(
        () =>
          builder().test({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            sampleInput: SAMPLE,
          }),
        /unanswered setup/,
      );
    });

    it('records the result, and records that the model was a mock', async () => {
      // The rule this defends: never present a mock run as a real provider integration.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const tested = await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: SAMPLE,
      });

      assert.notEqual(tested.lastTest.at, null);
      assert.equal(tested.lastTest.passed, true);
      assert.equal(tested.lastTest.wasReal, false, 'a mock run claimed a real provider');
      assert.ok(String(tested.lastTest.summary).trim() !== '');
    });

    it('audits the test, saying in the event whether the model was real', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: SAMPLE,
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent.tested' },
          select: { metadata: true },
        }),
      );
      const metadata = events[0]?.metadata as Record<string, unknown> | undefined;
      assert.ok(metadata, 'the test was not audited');
      assert.equal(metadata['producedByRealModel'], false);
      assert.equal(metadata['modelWasMocked'], true);
    });

    it('refuses a test with nothing to work on', async () => {
      // The bug this pins: the route used to take no body at all, so "tested and passed" could
      // mean the agent had been handed its own configuration and nothing else. A pass like that
      // is evidence of wiring, and it was being read as evidence of work.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      await assert.rejects(
        () =>
          builder().test({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            sampleInput: '   ',
          }),
        /sample data/,
      );

      await assert.rejects(
        () =>
          builder().test({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            sampleInput: 'too short',
          }),
        /at least/,
      );
    });

    it('keeps what went in and what came back, not a sentence about them', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const tested = await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: SAMPLE,
        expectedOutcome: 'A vendor name and an amount, both matching the invoice.',
      });

      const run = tested.testHistory[0];
      assert.ok(run, 'the test was not recorded');
      assert.equal(run.status, 'Passed');
      assert.equal(run.sampleInput, SAMPLE);
      assert.equal(run.expectedOutcome, 'A vendor name and an amount, both matching the invoice.');
      assert.ok((run.output ?? '').trim() !== '', 'the output was not kept');
      assert.ok(run.durationMs >= 0);
      assert.equal(run.wasReal, false);
      // The mock gateway has to say so on the run itself, not only on the assignment: a run read
      // a week later must carry the conditions it was produced under.
      assert.ok(
        run.warnings.some((warning) => warning.includes('mock gateway')),
        'a mock run did not say it was mocked',
      );
      assert.deepEqual(run.errors, []);
    });

    it('keeps every attempt, so two can be compared', async () => {
      /*
       * The reason this matters: publishing is a decision made by comparing attempts — "the last
       * one dropped the tax line, this one keeps it". The builder used to overwrite four columns
       * on each test, so the attempt before was gone by the time you wanted to compare it.
       */
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: SAMPLE,
      });
      const second = await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: 'Invoice INV-9002, vendor Kestrel Traders, 12,000 INR, dated 2 April.',
      });

      assert.equal(second.testHistory.length, 2, 'the earlier attempt was overwritten');
      // Newest first, so the head is the run somebody just watched happen.
      assert.match(String(second.testHistory[0]?.sampleInput), /Kestrel/);
      assert.match(String(second.testHistory[1]?.sampleInput), /Meridian/);
    });

    it('keeps one company’s test runs out of another company', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().test({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        sampleInput: SAMPLE,
      });

      // Read under the other company's scope, which is what row-level security exists to stop.
      const leaked = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentBuilderTestRun.count({
          where: { tenantId: otherTenantId },
        }),
      );
      assert.equal(leaked, 0, 'a test run reached another company');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Activate
  // -------------------------------------------------------------------------

  describe('Activate Agent', () => {
    /**
     * Who may put an agent live, and who submits it instead — CR-04.
     *
     * Finishing a setup used to be the same act as publishing it, so whoever finished it
     * published it. The client's chain is the other one: *"employee fill karke submit karega,
     * uske baad uske head ko jayega, uske baad admin ke paas aayega."* So this call now ends in
     * one of two places, decided on `agents:Publish` — which the `Head` template holds and the
     * `Employee` template does not.
     *
     * `objectiveApproverId` is this file's Head, and is therefore the persona for every test
     * below that is about a *live* agent. `workerUserId` is the employee, and is the persona for
     * the submission tests. Neither was chosen for convenience: swapping them is exactly the bug
     * this split exists to catch.
     */
    it('puts the agent live for somebody who may publish agents', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const activated = await builder().activate({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });

      assert.ok(activated.engineAgent, 'no Engine Agent was created');
      assert.equal(activated.engineAgent.status, 'Active');
      assert.equal(activated.engineAgent.versionNumber, 1);
      assert.equal(activated.status, 'MappedToEngineAgent');

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findMany({
          where: { tenantId, engineAgentId: activated.engineAgent?.id ?? '' },
        }),
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.status, 'Published');
      assert.notEqual(stored[0]?.publishedAt, null);
    });

    it('sends it to a Head instead, when the person finishing it may not publish', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const submitted = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });

      // The agent exists and is configured. It is not running, and nothing points at a
      // configuration nobody approved.
      assert.ok(submitted.engineAgent, 'no Engine Agent was created');
      assert.equal(submitted.engineAgent.status, 'Ready');

      const agent = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.findFirstOrThrow({
          where: { tenantId, id: submitted.engineAgent?.id ?? '' },
        }),
      );
      assert.equal(agent.currentVersionId, null, 'an unapproved draft became the version in force');
      assert.equal(agent.activatedAt, null);

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findMany({
          where: { tenantId, engineAgentId: agent.id },
        }),
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.status, 'Draft');
      assert.equal(stored[0]?.publishedAt, null);
      // The column, not the config field beside it: this is what `activateVersion` reads before
      // it will accept an activation with no approval cited.
      assert.equal(stored[0]?.approvalRequired, true);

      const raised = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { tenantId, type: 'AgentActivation' },
        }),
      );
      assert.equal(raised.length, 1, 'no approval was raised');
      assert.equal(raised[0]?.status, 'Pending');
      assert.equal(raised[0]?.subjectId, stored[0]?.id);
      assert.equal(raised[0]?.requestedByUserId, workerUserId);
      // Addressed by role, so the person who built it does not choose who judges it.
      assert.equal(raised[0]?.approverRoleKind, 'Head');
    });

    it('lets a Head’s refusal be fixed and sent again, on the same version', async () => {
      /*
       * The trap this closes.
       *
       * Submitting names the agent on the assignment, and until this existed that single fact
       * refused both a second activation and any edit to the setup. So a Head saying "change the
       * output destination" left the employee holding work with no move: they could not change
       * it, and they could not send it again. The chain the client asked for only works if it
       * runs in both directions.
       */
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      const submitted = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const agentId = submitted.engineAgent?.id;
      assert.ok(agentId);

      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findFirstOrThrow({
          where: { tenantId, engineAgentId: agentId },
        }),
      );
      const first = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { tenantId, type: 'AgentActivation', subjectId: draft.id },
        }),
      );

      // While it is still with them, sending it again would ask the same person twice.
      await assert.rejects(
        () => builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId }),
        /waiting on a decision/,
      );

      await approvals().decide({
        scope: scope(),
        actorUserId: objectiveApproverId,
        approvalId: first.id,
        decision: 'SendBack',
        note: 'Send the output somewhere the team can read it.',
      });

      // Now it is theirs again — the edit the Head asked for is possible.
      await builder().saveSetup({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        patch: { outputDestination: 'The shared drive' },
      });

      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

      const versions = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findMany({
          where: { tenantId, engineAgentId: agentId },
        }),
      );
      // Still one version. It has never been in force, so correcting it is not a second one.
      assert.equal(versions.length, 1);
      assert.equal(versions[0]?.versionNumber, 1);
      assert.equal(
        (versions[0]?.config as { setup?: { outputDestination?: string } }).setup
          ?.outputDestination,
        'The shared drive',
        'the Head would be re-reading what they already refused',
      );

      const requests = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { tenantId, type: 'AgentActivation' },
          orderBy: { createdAt: 'asc' },
        }),
      );
      assert.equal(requests.length, 2, 'the second submission raised no request');
      assert.equal(requests[0]?.status, 'SentBack');
      assert.equal(requests[1]?.status, 'Pending');

      // And it is still not running.
      const agent = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.findFirstOrThrow({ where: { tenantId, id: agentId } }),
      );
      assert.equal(agent.currentVersionId, null);
    });

    it('refuses to send it again once somebody has approved it', async () => {
      // The decision belongs to an administrator at that point, and resending would throw away a
      // judgement a Head has already made.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      const submitted = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findFirstOrThrow({
          where: { tenantId, engineAgentId: submitted.engineAgent?.id ?? '' },
        }),
      );
      const request = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findFirstOrThrow({
          where: { tenantId, type: 'AgentActivation', subjectId: draft.id },
        }),
      );

      await approvals().decide({
        scope: scope(),
        actorUserId: objectiveApproverId,
        approvalId: request.id,
        decision: 'Approve',
        note: 'Looks right.',
      });

      await assert.rejects(
        () => builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId }),
        /waiting for an administrator/,
      );
    });

    it('records the submission as a submission, and not as an activation', async () => {
      // An audit trail that called both "activated" would say an agent went live on the day
      // somebody asked for permission to put it live.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceType: 'engine-agent' },
          select: { action: true, summary: true },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.action),
        ['agent.submitted_for_approval'],
      );
      assert.match(String(events[0]?.summary), /configured and not running/);
    });

    it('refuses to activate while a blocker stands', async () => {
      // Readiness is the condition the source document sets, and unfinished setup fails it.
      const { assignmentId } = await assignedAiWork();
      await assert.rejects(
        () => builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId }),
        /not ready to activate/,
      );
    });

    it('never even sees an AI step with no approved Skill, because assignment refuses first', async () => {
      // Recording what is actually true rather than forcing a path. The readiness check here does
      // carry a blocker for a Skill-less AI step, but it is unreachable in practice: Prompt 23's
      // Approve & Assign gate refuses to publish the plan at all, so no assignment is ever
      // created for such a step. Asserting the earlier refusal is the honest test; asserting the
      // later one would have needed a fabricated assignment that the product cannot produce.
      await assert.rejects(() => assignedAiWork({ withSkill: false }), /cannot be assigned yet/);
    });

    it('permits activation without a test, and records that it was untested', async () => {
      // The source document makes readiness the condition and does not include a passed test.
      // Inventing that gate would block work the client never said to block — so it is a warning
      // on the screen and a fact in the audit trail instead.
      const { assignmentId } = await assignedAiWork();
      const ready = await answerEverything(assignmentId);
      assert.ok(
        ready.readiness.findings.some(
          (finding) => finding.severity === 'Warning' && /not been tested/.test(finding.summary),
        ),
        'no warning was raised about activating untested',
      );
      assert.equal(ready.readiness.readyToActivate, true);

      const activated = await builder().activate({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });
      assert.ok(activated.engineAgent);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent.activated' },
          select: { metadata: true },
        }),
      );
      const metadata = events[0]?.metadata as Record<string, unknown> | undefined;
      assert.equal(metadata?.['testedBeforeActivation'], false);
    });

    it('never creates a second Engine Agent for the same work', async () => {
      /*
       * The locked lifecycle rule: recurring work creates Runs on the agent it already has.
       *
       * Put live by a Head, because that is the rule being tested. An agent still waiting on a
       * decision is a different case with a different answer — it is sent again rather than
       * duplicated, which the resubmission tests above cover.
       */
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: objectiveApproverId, assignmentId });

      await assert.rejects(
        () => builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId }),
        /never creates a second agent/,
      );

      const agents = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.count({ where: { tenantId } }),
      );
      assert.equal(agents, 1);
    });

    it('refuses a name another agent in the company already uses', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      const first = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        agentName: 'GSPR Drafter',
      });
      assert.equal(first.engineAgent?.name, 'GSPR Drafter');

      const second = await assignedAiWork({ withSkill: false });
      await answerEverything(second.assignmentId);
      await assert.rejects(
        () =>
          builder().activate({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId: second.assignmentId,
            agentName: 'GSPR Drafter',
          }),
        /already has an Engine Agent called/,
      );
    });

    it('freezes the published configuration, because Runs will cite it', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      // A Head, because the freeze is a property of a *published* version — a draft awaiting a
      // decision is still editable, and must be.
      const activated = await builder().activate({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });

      const version = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findFirstOrThrow({
          where: { tenantId, engineAgentId: activated.engineAgent?.id ?? '' },
        }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.engineAgentVersion.update({
              where: { id: version.id },
              data: { config: { tampered: true } },
            }),
          ),
        /published and cannot be changed/,
      );
    });

    it('refuses to change the setup once the agent is live', async () => {
      // Live, which is what the refusal is about. A submitted agent that no decision has reached
      // is still editable on purpose — a Head who sends it back is asking for an edit.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: objectiveApproverId, assignmentId });

      await assert.rejects(
        () =>
          builder().saveSetup({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            patch: { outputDestination: 'Somewhere else' },
          }),
        /already running on an Engine Agent/,
      );
    });

    it('audits the activation, and says recurring work will create Runs', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: objectiveApproverId, assignmentId });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent.activated' },
          select: { summary: true, resourceType: true },
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.resourceType, 'engine-agent');
      assert.match(String(events[0]?.summary), /Runs on this agent, never another agent/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Form 3
  // -------------------------------------------------------------------------

  describe('Form 3 — the canonical job method', () => {
    it('is a read composed from records that already exist', async () => {
      const { assignmentId } = await assignedAiWork();
      const view = await builder().form3({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });

      // Every job-level field the document names is present as a key, even when null: the shape
      // is the client's, not whatever happened to have a value.
      for (const field of FORM3_JOB_LEVEL_FIELDS) {
        assert.ok(field.key in view.jobLevel, `${field.label} is missing from Form 3`);
      }
      assert.ok(view.actions.length > 0, 'Form 3 has no action rows');
      // It says which records it came from, so it never reads as a document nobody wrote.
      assert.equal(view.composedFrom.aiWorkAssignmentId, assignmentId);
      assert.ok(view.composedFrom.objectiveVersionId);
      assert.ok(view.composedFrom.workflowDraftId);
    });

    it('says it is not a form to re-enter', async () => {
      const { assignmentId } = await assignedAiWork();
      const view = await builder().form3({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });
      assert.match(view.note, /form to fill in/i);
      assert.match(view.note, /re-enters it/i);
    });

    it('is not reachable by the employee who does the work', async () => {
      // "Advanced authorized view": the whole job method spans other people's steps, so it sits
      // with the authority over the job method rather than with whoever owns one step of it.
      const { assignmentId } = await assignedAiWork();
      await as(
        agent().get(`/tenants/${tenantId}/agent-builder/${assignmentId}/form3`),
        workerUboss,
      ).expect(403);
    });

    it('is reachable by a Head over the department', async () => {
      const { assignmentId } = await assignedAiWork();
      await as(
        agent().get(`/tenants/${tenantId}/agent-builder/${assignmentId}/form3`),
        headUboss,
      ).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Authorization, scope and isolation
  // -------------------------------------------------------------------------

  describe('who may do what', () => {
    it('refuses an unauthenticated request', async () => {
      const { assignmentId } = await assignedAiWork();
      await agent()
        .get(`/tenants/${tenantId}/agent-builder/${assignmentId}`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('lets the employee who owns the work complete setup and submit it', async () => {
      /*
       * The documented journey: "Employee completes Human work and only missing Agent setup ->
       * Test -> Activate." Over HTTP, because that is the path the screen actually uses.
       *
       * The last step ends at `Ready` rather than `Active` — CR-04. The employee does everything
       * they did before and is refused nothing; what changed is that finishing it asks their Head
       * instead of putting it in front of the company. That is the whole of the client's chain at
       * this end of it.
       */
      const { assignmentId } = await assignedAiWork();
      const view = await answerEverything(assignmentId);
      assert.deepEqual(view.missing, []);

      await as(
        agent()
          .post(`/tenants/${tenantId}/agent-builder/${assignmentId}/test`)
          .send({ sampleInput: SAMPLE }),
        workerUboss,
      ).expect(201);

      const submitted = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/${assignmentId}/activate`).send({}),
        workerUboss,
      ).expect(201);
      assert.equal(submitted.body.engineAgent.status, 'Ready');
    });

    it('does not let one employee touch another employee’s assigned work', async () => {
      // `OwnWork` is what makes the Employee grant safe. Without this the correction to the role
      // template would have handed every employee everybody else's agents.
      const { assignmentId } = await assignedAiWork();

      await assert.rejects(
        () => builder().view({ scope: scope(), actorUserId: otherWorkerUserId, assignmentId }),
        /no such assigned AI work/,
      );
      await assert.rejects(
        () =>
          builder().saveSetup({
            scope: scope(),
            actorUserId: otherWorkerUserId,
            assignmentId,
            patch: { runType: 'Manual' },
          }),
        /no such assigned AI work/,
      );
    });

    it('lists only the work a person may act on', async () => {
      const { assignmentId } = await assignedAiWork();

      const mine = await builder().list({ scope: scope(), actorUserId: workerUserId });
      assert.deepEqual(
        mine.assignments.map((entry) => entry.assignmentId),
        [assignmentId],
      );

      const theirs = await builder().list({ scope: scope(), actorUserId: otherWorkerUserId });
      assert.deepEqual(theirs.assignments, []);
    });

    it('lets a manager over the team see it', async () => {
      const { assignmentId } = await assignedAiWork();
      const seen = await builder().view({
        scope: scope(),
        actorUserId: managerUserId,
        assignmentId,
      });
      assert.equal(seen.assignmentId, assignmentId);
    });

    it('never lets another company reach it', async () => {
      const { assignmentId } = await assignedAiWork();

      const own = await as(
        agent().get(`/tenants/${otherTenantId}/agent-builder/${assignmentId}`),
        outsiderUboss,
        otherTenantId,
      );
      assert.equal(own.status, 404);

      const across = await as(
        agent().get(`/tenants/${tenantId}/agent-builder/${assignmentId}`),
        outsiderUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.prefill, undefined, 'a cross-tenant response carried the setup');
    });

    it('stores no Engine Agent outside its own tenant', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.findMany({ select: { tenantId: true } }),
      );
      assert.deepEqual(rows, [{ tenantId }]);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Secrets
  // -------------------------------------------------------------------------

  describe('credentials', () => {
    it('returns nothing that could be a credential', async () => {
      // "Do not expose raw API keys." Asserted against the serialised response rather than the
      // shape, because a leak would arrive as a field nobody declared.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const response = await as(
        agent().get(`/tenants/${tenantId}/agent-builder/${assignmentId}`),
        workerUboss,
      ).expect(200);

      const body = JSON.stringify(response.body).toLowerCase();
      for (const forbidden of ['secret', 'apikey', 'api_key', 'credential', 'password', 'token']) {
        assert.equal(body.includes(forbidden), false, `the response mentioned "${forbidden}"`);
      }
    });
  });

  // =========================================================================
  // Adding or replacing a Skill by hand.
  //
  // The objective analysis still matches Skills automatically; this is the builder's override.
  // Every control the automatic path goes through is re-applied on the manual one, and these are
  // the tests that say so: published only, entitled only, this company only, and refused once
  // the work is live. What a manual choice changes is WHICH approved Skill is used — never
  // whether approval, status, entitlement or tenancy applied.
  // =========================================================================
  describe('adding and replacing Skills by hand', () => {
    /** A second published company Skill, so there is something to swap TO. */
    const secondSkill = async () => {
      const content = {
        purpose: 'Check a drafted matrix against the index it came from.',
        category: 'Review' as const,
        whenToUse: 'After a GSPR matrix is drafted.',
        whenNotToUse: 'Never as the only check before release.',
        inputs: [{ name: 'Matrix', description: 'The drafted matrix.', required: true }],
        rules: [{ when: 'A requirement has no evidence', then: 'Flag it' }],
        steps: [{ order: 1, instruction: 'Compare each row against the index.' }],
        allowedToolCategories: ['Read'],
        outputSchema: '{"type":"object"}',
        validation: 'Every row is accounted for.',
        failureHandling: 'Stop and report the gap.',
        requiresApproval: true,
        autonomy: 'ProposeForApproval' as const,
        evidenceRequirement: 'The comparison table.',
      };
      const created = await skills().createCompanySkill({
        scope: scope(),
        actorUserId: skillAdminId,
        key: 'gspr-checker',
        name: 'GSPR matrix checker',
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
      return { skill: created, versionId };
    };

    it('replaces the matched Skill with one the builder chose, and pins that version', async () => {
      const { assignmentId } = await assignedAiWork();
      const before = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const matched = before.prefill.skillVersionIds;

      const { versionId } = await secondSkill();

      const after = await builder().setSkills({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        skillVersionIds: [versionId],
      });

      assert.deepEqual(
        after.prefill.skillVersionIds,
        [versionId],
        'the chosen version is what is attached',
      );
      assert.notDeepEqual(
        after.prefill.skillVersionIds,
        matched,
        'and it replaced what was matched',
      );

      // A version id, not a Skill id: that is what pinning means.
      const pinned = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.skillVersion.findFirstOrThrow({
          where: { id: versionId },
          select: { versionNumber: true, status: true },
        }),
      );
      assert.equal(pinned.status, 'Published');
      assert.equal(pinned.versionNumber, 1);
    });

    it('adds a Skill alongside the matched one rather than only replacing', async () => {
      const { assignmentId } = await assignedAiWork();
      const before = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const { versionId } = await secondSkill();

      const after = await builder().setSkills({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        skillVersionIds: [...before.prefill.skillVersionIds, versionId],
      });

      assert.equal(after.prefill.skillVersionIds.length, before.prefill.skillVersionIds.length + 1);
      assert.ok(after.prefill.skillVersionIds.includes(versionId));
    });

    it('refuses a draft version, because approval would otherwise be optional', async () => {
      const { assignmentId } = await assignedAiWork();

      const draft = await skills().createCompanySkill({
        scope: scope(),
        actorUserId: skillAdminId,
        key: 'not-approved-yet',
        name: 'Not approved yet',
        content: {
          purpose: 'A Skill nobody has approved.',
          category: 'Analysis' as const,
          whenToUse: 'Never, yet.',
          whenNotToUse: 'Anywhere.',
          inputs: [],
          rules: [],
          // A step, because the validator asks for one: "a capability with no procedure is a wish".
          steps: [{ order: 1, instruction: 'Do the check this Skill exists to do.' }],
          allowedToolCategories: [],
          outputSchema: '{}',
          validation: 'None.',
          failureHandling: 'Stop.',
          requiresApproval: true,
          autonomy: 'SuggestOnly' as const,
          evidenceRequirement: 'None.',
        },
        creationMode: 'Manual',
      });
      const draftVersionId = draft.openDraft?.id ?? draft.versions[0]?.id ?? '';

      await assert.rejects(
        () =>
          builder().setSkills({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            skillVersionIds: [draftVersionId],
          }),
        /not Published/i,
      );
    });

    it('refuses an Industry Pack the company is not entitled to', async () => {
      const { assignmentId } = await assignedAiWork();

      const pack = await skills().createPlatformSkill({
        actorUserId: platformOwnerId,
        layer: 'IndustryPack',
        industry: 'Aerospace',
        key: 'pack-aerospace-check',
        name: 'Aerospace check',
        content: {
          purpose: 'An Industry Pack Skill.',
          category: 'Review' as const,
          whenToUse: 'Aerospace work.',
          whenNotToUse: 'Anything else.',
          inputs: [],
          rules: [],
          // A step, because the validator asks for one: "a capability with no procedure is a wish".
          steps: [{ order: 1, instruction: 'Do the check this Skill exists to do.' }],
          allowedToolCategories: [],
          outputSchema: '{}',
          validation: 'Checked.',
          failureHandling: 'Stop.',
          requiresApproval: true,
          autonomy: 'SuggestOnly' as const,
          evidenceRequirement: 'The check.',
        },
      });
      for (const to of ['Review', 'Approved', 'Published'] as const) {
        await skills().transitionPlatformVersion({
          actorUserId: platformOwnerId,
          versionId: pack.versionId,
          to,
        });
      }

      await assert.rejects(
        () =>
          builder().setSkills({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            skillVersionIds: [pack.versionId],
          }),
        /not entitled/i,
      );

      // Entitle the company, and the same pick is permitted — so the refusal was the
      // entitlement and nothing else.
      await skills().setPackEntitlement({
        actorUserId: platformOwnerId,
        tenantId,
        industry: 'Aerospace',
        enabled: true,
        reason: 'Bought the aerospace pack.',
      });

      const after = await builder().setSkills({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        skillVersionIds: [pack.versionId],
      });
      assert.deepEqual(after.prefill.skillVersionIds, [pack.versionId]);
    });

    it('refuses a Skill version id from another company', async () => {
      const { assignmentId } = await assignedAiWork();

      // A real version id, belonging to a company this actor is not in. It must read as "no
      // such Skill" rather than "that is someone else's", which would confirm it exists.
      const theirs = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillVersion.findFirst({
          where: { tenantId: { not: null, notIn: [tenantId] } },
          select: { id: true },
        }),
      );

      if (theirs !== null) {
        await assert.rejects(
          () =>
            builder().setSkills({
              scope: scope(),
              actorUserId: workerUserId,
              assignmentId,
              skillVersionIds: [theirs.id],
            }),
          /No Skill version you can use/i,
        );
      }
    });

    it('refuses once the work is already running on an Engine Agent', async () => {
      // Running, not merely submitted: changing the Skills of an agent nobody has approved yet is
      // exactly what a Head's send-back asks for.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: objectiveApproverId, assignmentId });

      const { versionId } = await secondSkill();
      await assert.rejects(
        () =>
          builder().setSkills({
            scope: scope(),
            actorUserId: workerUserId,
            assignmentId,
            skillVersionIds: [versionId],
          }),
        /already running/i,
      );
    });

    it('records that the choice was a person’s, not the matcher’s', async () => {
      const { assignmentId } = await assignedAiWork();
      const { versionId } = await secondSkill();

      await builder().setSkills({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
        skillVersionIds: [versionId],
      });

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent-builder.skills_changed', resourceId: assignmentId },
        }),
      );
      assert.equal(events.length, 1);
      const metadata = events[0]?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['chosenManually'], true);
      assert.equal(metadata?.['to'], versionId);
    });
  });
  // -------------------------------------------------------------------------
  // One build, many executions
  // -------------------------------------------------------------------------

  /**
   * The client's rule that an Agent is built once and reused.
   *
   * "Do NOT ask Admin to build the same Skill/Agent every time the Objective runs." Before this,
   * every publish of an objective created its AI work `AwaitingAgentSetup`, so the second run of a
   * monthly objective asked for the whole setup again and produced a second agent doing the same
   * job. That is also how a company ends up with six agents nobody can tell apart.
   */
  describe('a published agent is reused rather than rebuilt', () => {
    /** Publish the objective again, unchanged, and return its AI work. */
    const republish = async (objectiveId: string) => {
      await objectives().startNewDraft({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      // CR-04: the review this submission raised has to be decided before the analysis
      // will run. See `approveObjectiveReview`.
      await approveObjectiveReview({
        context: ctx,
        tenantId,
        objectiveId,
        decide: (approverUserId, approvalId) =>
          approvals().decide({
            scope: scope(),
            actorUserId: approverUserId,
            approvalId,
            decision: 'Approve',
            note: 'Reviewed and approved for analysis.',
          }),
      });
      await objectives().confirmExecutionTeam({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });

      const run = await analysis().start({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      assert.equal(run.status, 'Completed', run.failureReason ?? 'no failure reason recorded');

      let draft = await workflow().open({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      for (const node of draft.graph.nodes) {
        draft = await workflow().editNode({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId,
          revision: draft.revision,
          nodeId: node.id,
          patch: {
            ...(node.kind === 'Approval' ? { ownerUserId: objectiveApproverId } : {}),
            dod: {
              criteria: 'The reviewer accepts the output.',
              failureCondition: 'A required item cannot be evidenced.',
              expectedOutput: node.dod.expectedOutput || 'A recorded outcome for this step.',
              evidence: node.dod.evidence || 'The output, filed against this step.',
            },
          },
        });
      }

      await objectives().completeReview({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      await objectives().approve({ scope: scope(), actorUserId: objectiveApproverId, objectiveId });
      return assignment().approveAndAssign({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
    };

    it('maps the next run to the agent already built for that step', async () => {
      const { objectiveId, assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      // Published, which this whole section is about: an agent still waiting on its Head is not
      // yet the agent a step runs, and a republish is right to ask for setup again.
      const agent = await builder().activate({
        scope: scope(),
        actorUserId: objectiveApproverId,
        assignmentId,
      });
      assert.ok(agent.engineAgent, 'the fixture did not produce an agent');

      const again = await republish(objectiveId);

      // Nothing to set up, and it says which agent it reused rather than only staying quiet.
      assert.deepEqual(again.nodesAwaitingAgentSetup, []);
      assert.equal(again.reusedAgents.length, 1);
      assert.equal(again.reusedAgents[0]?.agentName, agent.engineAgent?.name);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.aiWorkAssignment.findMany({
          where: { tenantId, objectiveId },
          orderBy: { createdAt: 'asc' },
          select: { status: true, engineAgentId: true },
        }),
      );
      assert.equal(rows.length, 2, 'the republish produced no second assignment');
      // The same agent, not a second one doing the same job.
      assert.equal(rows[1]?.status, 'MappedToEngineAgent');
      assert.equal(rows[1]?.engineAgentId, rows[0]?.engineAgentId);
    });

    it('asks again when the step is no longer the same work', async () => {
      /*
       * A node id survives a rewrite, so matching on it alone would hand a step an agent that was
       * configured for different words. The title is what the agent was built against.
       */
      const { objectiveId, assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: objectiveApproverId, assignmentId });

      await objectives().startNewDraft({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      // CR-04: the review this submission raised has to be decided before the analysis
      // will run. See `approveObjectiveReview`.
      await approveObjectiveReview({
        context: ctx,
        tenantId,
        objectiveId,
        decide: (approverUserId, approvalId) =>
          approvals().decide({
            scope: scope(),
            actorUserId: approverUserId,
            approvalId,
            decision: 'Approve',
            note: 'Reviewed and approved for analysis.',
          }),
      });
      await objectives().confirmExecutionTeam({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      const run = await analysis().start({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      assert.equal(run.status, 'Completed');

      let draft = await workflow().open({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      for (const node of draft.graph.nodes) {
        draft = await workflow().editNode({
          scope: scope(),
          actorUserId: managerUserId,
          objectiveId,
          revision: draft.revision,
          nodeId: node.id,
          patch: {
            ...(node.kind === 'Ai' ? { label: 'Something else entirely' } : {}),
            ...(node.kind === 'Approval' ? { ownerUserId: objectiveApproverId } : {}),
            dod: {
              criteria: 'The reviewer accepts the output.',
              failureCondition: 'A required item cannot be evidenced.',
              expectedOutput: node.dod.expectedOutput || 'A recorded outcome for this step.',
              evidence: node.dod.evidence || 'The output, filed against this step.',
            },
          },
        });
      }

      await objectives().completeReview({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });
      await objectives().approve({ scope: scope(), actorUserId: objectiveApproverId, objectiveId });
      const again = await assignment().approveAndAssign({
        scope: scope(),
        actorUserId: managerUserId,
        objectiveId,
      });

      assert.equal(again.reusedAgents.length, 0, 'rewritten work inherited an old agent');
      assert.equal(again.nodesAwaitingAgentSetup.length, 1, 'the rewritten step asks for setup');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Bringing in an agent built somewhere else — CR-05
  // -------------------------------------------------------------------------

  /**
   * Drag a file in, confirm what it says, and the agent exists.
   *
   * The client's words: *"kahin cloud me unke agent chal rahe hain… jo file milega agent ke liye,
   * bas yahan drag and drop kare, uske baad agent ban ke taiyar ho jaye."*
   *
   * What is worth testing is not the parser — that has its own tests in `@uboss/types` — but the
   * two promises this feature makes to a company: **reading a file creates nothing**, and an
   * imported agent is subject to every rule an agent typed in by hand is subject to. An import
   * that could skip the name clash, the Skill routing or the Head's approval would be a way of
   * putting an unreviewed agent into a company by uploading a file.
   */
  describe('syncing an agent from a file', () => {
    const ubossFile = [
      '---',
      'name: Imported invoice checker',
      'purpose: Check vendor invoices against the purchase order and flag mismatches',
      'trigger: Daily at 9am',
      'runs_in: SAP',
      'output_to: Finance shared drive',
      'if_data_missing: Stop',
      'tools: SAP, Email',
      '---',
      '',
      '## Steps',
      "1. Pull yesterday's invoices — read them from the SAP inbox",
      '2. Match each against its purchase order',
      '3. Flag every mismatch over 50,000',
      '',
    ].join('\n');

    const read = (content: string, filename = 'agent.md', uboss = workerUboss) =>
      as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync/read`).send({ filename, content }),
        uboss,
      );

    it('reads UBoss’s own format with no model call, and creates nothing', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.aiWorkAssignment.count({ where: { tenantId } }),
      );

      const response = await read(ubossFile).expect(201);

      assert.equal(response.body.usedModel, false, 'a file in our own format cost a model call');
      assert.equal(response.body.envelope.name, 'Imported invoice checker');
      assert.equal(response.body.envelope.runType, 'Scheduled');
      assert.equal(response.body.envelope.whereWorkHappens, 'SAP');
      assert.equal(response.body.envelope.steps.length, 3);

      // The promise that matters: reading is reading. Not a draft, not a placeholder, nothing.
      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.aiWorkAssignment.count({ where: { tenantId } }),
      );
      assert.equal(after, before, 'reading a file created something');
    });

    it('creates the agent, its setup and its steps from what was confirmed', async () => {
      const envelope = (await read(ubossFile).expect(201)).body.envelope;

      const created = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(envelope),
        workerUboss,
      ).expect(201);

      assert.equal(created.body.stepsSaved, 3);
      const assignmentId = created.body.assignmentId as string;

      const view = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });

      assert.equal(view.prefill.suggestedAgentName, 'Imported invoice checker');
      assert.equal(view.setup.runType, 'Scheduled');
      assert.equal(view.setup.triggerOrFrequency, 'Daily at 9am');
      assert.equal(view.setup.whereWorkHappens, 'SAP');
      assert.equal(view.setup.outputDestination, 'Finance shared drive');
      assert.equal(view.setup.missingDataBehaviour, 'Stop');

      /*
       * Nothing left to ask, so the agent is ready the moment it is dropped.
       *
       * This is the client's "agent ban ke taiyar ho jaye", and it holds only because the file
       * answered the five setup questions. A missing Skill does not block a custom agent — the
       * router matches one from the work when it runs — so with the setup complete there is no
       * blocker left.
       */
      assert.deepEqual(view.missing, [], 'the file answered everything and it still asks');
      assert.equal(view.readiness.readyToActivate, true);
    });

    it('puts the instruction in HOW, not inside the step', async () => {
      // A reviewer reading a list of actions should not have to read a paragraph in the action
      // column to find the action. This is where an imported prompt lands.
      const envelope = (await read(ubossFile).expect(201)).body.envelope;
      const created = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(envelope),
        workerUboss,
      ).expect(201);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodRow.findMany({
          where: {
            tenantId,
            jobMethod: { aiWorkAssignmentId: created.body.assignmentId as string },
          },
          orderBy: { step: 'asc' },
        }),
      );

      assert.equal(rows[0]?.whatExactWork, "Pull yesterday's invoices");
      assert.equal(rows[0]?.howExactMethod, 'read them from the SAP inbox');
      assert.equal(rows[0]?.toolSystemWorkplace, 'SAP');
    });

    it('obeys the Head’s approval like any other agent — CR-04', async () => {
      /*
       * The rule an import must never be a way around. The employee drops a file and finishes
       * the setup; the agent still stops at `Ready` and still goes to a Head.
       */
      const envelope = (await read(ubossFile).expect(201)).body.envelope;
      const created = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(envelope),
        workerUboss,
      ).expect(201);

      const submitted = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId: created.body.assignmentId as string,
      });

      assert.equal(submitted.engineAgent?.status, 'Ready', 'an imported agent went live by itself');

      const raised = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.approvalRequest.findMany({
          where: { tenantId, type: 'AgentActivation' },
        }),
      );
      assert.equal(raised.length, 1);
      assert.equal(raised[0]?.approverRoleKind, 'Head');
    });

    it('refuses the same file dropped twice', async () => {
      // The easy accident this feature introduces, and the same refusal `createStandalone` gives
      // — an import does not get its own copy of the rules.
      const envelope = (await read(ubossFile).expect(201)).body.envelope;
      await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(envelope),
        workerUboss,
      ).expect(201);

      const again = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(envelope),
        workerUboss,
      ).expect(409);
      assert.match(again.body.message as string, /already building an agent called/);
    });

    it('says which fields a thin file did not contain, and still creates on a name and a purpose', async () => {
      /*
       * A file that says almost nothing must not be refused: the fields it is missing are the
       * ones the builder screen already knows how to ask for. What it must do is *say* what was
       * missing, so a person can tell "the file was silent" from "it was read wrong".
       */
      const thin = ['---', 'name: Thin agent', 'purpose: Does one unspecified thing', '---'].join(
        '\n',
      );
      const response = await read(thin, 'thin.md').expect(201);

      assert.deepEqual(response.body.envelope.notFound, [
        'runType',
        'triggerOrFrequency',
        'whereWorkHappens',
        'outputDestination',
        'missingDataBehaviour',
        'steps',
        'tools',
      ]);

      const created = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/sync`).send(response.body.envelope),
        workerUboss,
      ).expect(201);
      assert.equal(created.body.stepsSaved, 0);

      // And the builder goes on asking for exactly what the file did not say.
      const view = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId: created.body.assignmentId as string,
      });
      assert.ok(
        view.missing.length > 0,
        'a file that said nothing produced an agent asking nothing',
      );
    });

    it('refuses an empty file', async () => {
      await read('   ', 'empty.md').expect(400);
    });

    /*
     * Through the service, not the route, and that is not a shortcut.
     *
     * `createNestApplication()` builds the app without `main.ts`, so these specs run on
     * body-parser's own 100 KB default rather than the limits table the product configures. A
     * request carrying a file of any realistic size is answered 413 by the harness before a
     * handler is reached — which says something about the harness and nothing about the feature.
     *
     * The routing table is asserted where it can be asserted honestly: `upload-body-limits.spec`
     * reads it out of `main.ts` and fails if this route is missing from it. What is left for here
     * is what the service itself promises about a dropped file, which is what these three check.
     */
    describe('the size of a dropped file', () => {
      it('refuses one too large to be an agent at all', async () => {
        await assert.rejects(
          () =>
            sync().read({
              scope: scope(),
              actorUserId: workerUserId,
              filename: 'dump.json',
              content: 'x'.repeat(3 * 1024 * 1024),
            }),
          /larger than 2 MB/,
        );
      });

      it('takes a real export, which is hundreds of kilobytes, not a page', async () => {
        /*
         * The ceiling used to be 64 KB on the reasoning that an agent definition is a page or
         * two. True of the definition, false of the file: an n8n export carries node positions
         * and connection maps around the prompt, a Custom GPT export carries its knowledge list.
         * The client dropped one of their own and was told their agent "looks like something
         * else".
         *
         * Padded as a comment so the file stays in UBoss's own format and this asserts the size
         * door rather than a model's reading.
         */
        const padded = `${ubossFile}\n<!-- ${'exported node data. '.repeat(20_000)} -->\n`;
        assert.ok(
          Buffer.byteLength(padded, 'utf8') > 300 * 1024,
          'the padding no longer makes a file big enough to prove anything',
        );

        const response = await sync().read({
          scope: scope(),
          actorUserId: workerUserId,
          filename: 'workflow.json',
          content: padded,
        });

        assert.equal(response.usedModel, false, 'a file in our own format cost a model call');
        assert.equal(response.envelope.name, 'Imported invoice checker');
        assert.equal(response.envelope.steps.length, 3);
      });

      it('says so when a long file was only read as far as the model budget', async () => {
        /*
         * The file is allowed to be 2 MB and the model still reads 64 KB of it, because the cost
         * of reading somebody else's export is charged to the company. The part that matters is
         * that this is *said*: a field left blank by a reading that stopped two thirds of the way
         * down looks exactly like a field the file never mentioned, and only one of those is the
         * person's to shrug at.
         */
        const long = `This agent does something.\n${'a line of exported configuration. '.repeat(
          4_000,
        )}`;
        assert.ok(Buffer.byteLength(long, 'utf8') > 64 * 1024);

        const response = await sync().read({
          scope: scope(),
          actorUserId: workerUserId,
          filename: 'crew.yaml',
          content: long,
        });

        assert.equal(response.usedModel, true, 'a file that is not ours was read without a model');
        assert.match(response.note, /only its first 64 KB were read/);
      });
    });

    it('needs agent-builder:Create to read a file at all', async () => {
      /*
       * `Create` rather than `View`, because reading spends the company's tokens on a file that
       * is not ours to read — and the only reason to read one is to make an agent, which needs
       * this grant anyway.
       */
      await read(ubossFile, 'agent.md', skillApproverUboss).expect(403);
    });

    it('never creates an agent from a file nobody confirmed', async () => {
      // There is no route that takes a file and makes an agent. The two steps are separate so a
      // person is always between the reading and the record.
      await as(
        agent()
          .post(`/tenants/${tenantId}/agent-builder/sync`)
          .send({ filename: 'agent.md', content: ubossFile }),
        workerUboss,
      ).expect(400);
    });
  });
});
