import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  AGENT_MEMORY_MODES,
  ENGINE_AGENT_ACTIONS,
  engineAgentActionsFor,
  type Form2Objective,
  type Form2WorkflowStep,
  type SkillContent,
  type WorkflowDraft,
} from '@uboss/types';

import { AgentBuilderController } from '../src/agents/agent-builder.controller.js';
import { AgentBuilderService } from '../src/agents/agent-builder.service.js';
import { EngineAgentController } from '../src/agents/engine-agent.controller.js';
import { EngineAgentService } from '../src/agents/engine-agent.service.js';
import { ApprovalService } from '../src/approvals/approval.service.js';
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
 * Prompt 25 — the Engine Agent registry and versioning.
 *
 * Built on the same fixture chain as Agent Builder, because the registry is about an agent that
 * activation produced: a company, a team, an approved Skill, a live connection, an analysed and
 * approved objective, assigned AI work, then Activate.
 *
 * What this suite defends:
 *
 *   1. **Agent -> Assignment/Job -> Run.** The registry owns the agent. It runs nothing, and
 *      `Run Now` has no route until the engine exists — a test asserts that boundary rather than
 *      letting a stub imply otherwise.
 *   2. **A published version is immutable**, enforced by a trigger, including its impact analysis
 *      and test result — those are what a reviewer relied on.
 *   3. **Approval before activation *where required*** means reach that widens or an agent
 *      several objectives depend on. Narrowing never needs permission.
 *   4. **Health and usage report absence, never a fabricated figure.**
 *   5. **Archiving is terminal**, and an archived agent stays readable.
 */
describe('engine agent registry and versioning (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let managerUserId: string;
  let managerUboss: string;
  let workerUserId: string;
  let _workerUboss: string;
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
  const registry = () => app.get(EngineAgentService);
  const approvals = () => app.get(ApprovalService);
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
      controllers: [ObjectiveController, AgentBuilderController, EngineAgentController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        // The real mock gateway: it is what ships, and its `producedByRealModel: false` is the
        // property several of these tests turn on.
        { provide: ModelGateway, useClass: MockModelGateway },
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
        EngineAgentService,
        // Prompt 28: activation approval is now a real record this service creates and
        // `activateVersion` verifies, so the registry cannot be tested without it.
        ApprovalService,
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
    managerUboss = people.manager.ubossUniqueId;
    workerUserId = people.worker.id;
    _workerUboss = people.worker.ubossUniqueId;
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

      // CR-03 (Prompt 40A): builder access is no longer part of the Employee default, so it is
      // granted explicitly here. See `grantBuilderAccess` for why this is the existing mechanism
      // rather than a new one.
      for (const userId of [workerUserId, otherWorkerUserId]) {
        await grantBuilderAccess(ctx, {
          tenantId,
          userId,
          grantedByUserId: platformOwnerId,
        });
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

      // Prompt 28: an agent activation approval is governed by `agents:Approve`, which only the
      // Approver role holds — the Manager and Head templates deliberately omit it, because the
      // client's locked Approve & Assign boundary keeps assigning work and approving a plan as
      // separate decisions.
      //
      // The WholeCompany assignment above is capped to MultipleDepartments by the Approver
      // template's own maxScope, and with no departments named that grant reaches nothing. So this
      // adds a department-scoped assignment alongside it: grants union, and the widest that
      // actually resolves wins.
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

  // -------------------------------------------------------------------------
  // 1. The registry
  // -------------------------------------------------------------------------

  describe('the registry', () => {
    it('shows every field the source document names', async () => {
      const { agentId, objectiveId } = await liveAgent();
      const view = await registry().view({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
      });

      // §17's visible items, one assertion each so a missing one names itself.
      assert.ok(view.name.trim() !== '', 'Agent Name');
      assert.ok(view.ownerUserId, 'Owner');
      assert.deepEqual(view.objectiveIds, [objectiveId], 'Objective(s)');
      assert.ok(view.currentVersion, 'Current Version');
      assert.ok(Array.isArray(view.skillVersionIds), 'Skills');
      assert.equal(view.status, 'Active', 'Status');
      assert.ok('scheduleOrTrigger' in view, 'Schedule / Trigger');
      assert.ok('health' in view, 'Health');
      assert.ok('usage' in view, 'Usage / Cost');
      assert.ok(Array.isArray(view.actions), 'Actions');
      // Plus the two the prompt adds beyond §17.
      assert.equal(view.memoryMode, 'CurrentRunOnly', 'memory mode');
      assert.ok('connectionId' in view, 'connections / tool grants');
    });

    it('reports no run data rather than a fabricated success rate', async () => {
      // A 0% success rate on an agent that has never run reads as failure. Runs arrive with the
      // next prompt; until then the honest answer is "no data".
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });

      assert.equal(view.health.hasRunData, false);
      assert.equal(view.health.successRate, null);
      assert.equal(view.health.lastRunAt, null);
      assert.equal(view.health.nextRunAt, null);
      assert.match(view.health.note, /never estimates/);
    });

    it('reports usage as absent rather than zero', async () => {
      // Zero would read as "this agent has cost nothing", which is a claim. Null is an absence.
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });

      assert.equal(view.usage.hasData, false);
      assert.equal(view.usage.promptTokens, null);
      assert.equal(view.usage.completionTokens, null);
    });

    it('offers only the actions the status permits', async () => {
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });

      assert.deepEqual(view.actions, engineAgentActionsFor('Active'));
      assert.ok(view.actions.includes('Pause'));
      assert.ok(!view.actions.includes('Resume'), 'an active agent was offered Resume');
    });

    it('lists the agent over HTTP and hides archived ones by default', async () => {
      const { agentId } = await liveAgent();

      const listed = await as(agent().get(`/tenants/${tenantId}/agents`), managerUboss).expect(200);
      assert.deepEqual(
        listed.body.agents.map((row: { id: string }) => row.id),
        [agentId],
      );

      await registry().archive({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        reason: 'Superseded.',
      });

      const afterArchive = await as(
        agent().get(`/tenants/${tenantId}/agents`),
        managerUboss,
      ).expect(200);
      assert.deepEqual(afterArchive.body.agents, []);

      const including = await as(
        agent().get(`/tenants/${tenantId}/agents?includeArchived=true`),
        managerUboss,
      ).expect(200);
      assert.equal(including.body.agents.length, 1);
    });

    it('serves a vocabulary carrying each memory mode’s technical rule', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/agents/meta`),
        managerUboss,
      ).expect(200);

      assert.deepEqual(
        response.body.memoryModes.map((entry: { mode: string }) => entry.mode),
        [...AGENT_MEMORY_MODES],
      );
      for (const entry of response.body.memoryModes) {
        assert.ok(String(entry.rule).trim() !== '', `${entry.mode} was served with no rule`);
      }
      assert.deepEqual(
        response.body.actions.map((entry: { action: string }) => entry.action),
        [...ENGINE_AGENT_ACTIONS],
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pause, resume, archive
  // -------------------------------------------------------------------------

  describe('operational actions', () => {
    it('pauses with a reason and resumes, clearing it', async () => {
      const { agentId } = await liveAgent();

      const paused = await registry().pause({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
        reason: 'Provider incident.',
      });
      assert.equal(paused.status, 'Paused');
      assert.equal(paused.pausedReason, 'Provider incident.');
      assert.ok(paused.actions.includes('Resume'));
      assert.ok(!paused.actions.includes('RunNow'), 'a paused agent could still be run by hand');

      const resumed = await registry().resume({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
      });
      assert.equal(resumed.status, 'Active');
      // Cleared, not kept: a reason left behind would describe a state it is no longer in.
      assert.equal(resumed.pausedReason, null);
    });

    it('refuses to pause without a reason', async () => {
      const { agentId } = await liveAgent();
      await assert.rejects(
        () =>
          registry().pause({
            scope: scope(),
            actorUserId: managerUserId,
            agentId,
            reason: '   ',
          }),
        /needs a reason/,
      );
    });

    it('archives, and then refuses every further move', async () => {
      // Terminal by design: reviving one resurrects an identity the company retired.
      const { agentId } = await liveAgent();
      const archived = await registry().archive({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        reason: 'Replaced by a new agent.',
      });
      assert.equal(archived.status, 'Archived');
      assert.notEqual(archived.archivedAt, null);
      assert.deepEqual(archived.actions, ['View', 'OpenRuns']);

      await assert.rejects(
        () => registry().resume({ scope: scope(), actorUserId: managerUserId, agentId }),
        /cannot become Active/,
      );
      await assert.rejects(
        () => registry().createNewVersion({ scope: scope(), actorUserId: headUserId, agentId }),
        /archived/,
      );
    });

    it('keeps an archived agent readable, which is why it is archived and not deleted', async () => {
      const { agentId } = await liveAgent();
      await registry().archive({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        reason: 'Done with it.',
      });

      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      assert.equal(view.status, 'Archived');
      assert.ok(view.currentVersion, 'the configuration that produced its runs is gone');
    });

    it('audits every move with where it came from and where it went', async () => {
      const { agentId } = await liveAgent();
      await registry().pause({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
        reason: 'Checking something.',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: agentId, action: 'agent.paused' },
          select: { summary: true, metadata: true, actorUserId: true },
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.actorUserId, managerUserId);
      const metadata = events[0]?.metadata as Record<string, unknown> | undefined;
      assert.equal(metadata?.['from'], 'Active');
      assert.equal(metadata?.['to'], 'Paused');
      assert.match(String(events[0]?.summary), /Checking something/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Versioning
  // -------------------------------------------------------------------------

  describe('versioning', () => {
    it('drafts a new version without touching the one in force', async () => {
      const { agentId } = await liveAgent();
      const before = await registry().view({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
      });

      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        setup: { outputDestination: 'A different folder' },
      });

      assert.equal(draft.status, 'Draft');
      assert.equal(draft.versionNumber, 2);
      assert.equal(draft.isCurrent, false);

      const after = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      assert.equal(after.currentVersion?.id, before.currentVersion?.id);
      assert.equal(after.currentVersion?.versionNumber, 1);
      assert.equal(after.openDraft?.versionNumber, 2);
    });

    it('reports what would change, and what relies on the agent', async () => {
      const { agentId, objectiveId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        setup: { outputDestination: 'Somewhere new' },
      });

      assert.ok(draft.impact, 'the draft carries no impact analysis');
      assert.ok(draft.impact.changedFields.includes('outputDestination'));
      assert.deepEqual(draft.impact.affectedObjectiveIds, [objectiveId]);
      assert.equal(draft.impact.widensReach, false);
    });

    it('needs no approval for a change that widens nothing', async () => {
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        setup: { outputDestination: 'Somewhere new' },
      });
      assert.equal(draft.approvalRequired, false);

      const activated = await registry().activateVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
      });
      assert.equal(activated.currentVersion?.versionNumber, 2);
      assert.equal(activated.openDraft, null);
    });

    it('needs approval when memory would start outliving the run', async () => {
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        memoryMode: 'AgentMemory',
      });

      assert.equal(draft.approvalRequired, true);
      assert.equal(draft.impact?.widensReach, true);
      assert.match(draft.impact?.reasons.join(' ') ?? '', /beyond the run/);

      await assert.rejects(
        () =>
          registry().activateVersion({
            scope: scope(),
            actorUserId: headUserId,
            agentId,
            versionId: draft.id,
          }),
        /needs an approval/,
      );
    });

    it('refuses to let the activator be their own approver', async () => {
      // Otherwise the requirement is decorative.
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        memoryMode: 'ApprovedLongTermMemory',
      });

      // Prompt 28: the Head asks the Manager, the Manager approves, and then the Head tries to
      // activate while claiming their *own* approval by citing a request the Manager decided.
      // The service reads the decision record rather than the caller's word for it.
      const asked = await registry().requestActivationApproval({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
        approverUserId: skillApproverId,
      });

      // The Head cannot address the approval to themselves in the first place.
      await assert.rejects(
        () =>
          registry().requestActivationApproval({
            scope: scope(),
            actorUserId: headUserId,
            agentId,
            versionId: draft.id,
            approverUserId: headUserId,
          }),
        /cannot address the approval to yourself/,
      );

      // Nor can the Head decide it. For this approval type the guarantee is structural rather
      // than a runtime check: raising an activation approval needs `agents:Publish` and deciding
      // one needs `agents:Approve`, and no built-in role template holds both — the Approve &
      // Assign boundary again. So the Head is stopped at routing, before separation of duties is
      // even consulted. (The NoSelfApproval control itself is exercised in approvals.e2e.spec.ts,
      // on a type where one role legitimately holds both.)
      await assert.rejects(
        () =>
          approvals().decide({
            scope: scope(),
            actorUserId: headUserId,
            approvalId: asked.approvalRequestId,
            decision: 'Approve',
            note: 'Waving my own through.',
          }),
        /names a different approver/i,
      );

      // And an undecided request does not authorise anything.
      await assert.rejects(
        () =>
          registry().activateVersion({
            scope: scope(),
            actorUserId: headUserId,
            agentId,
            versionId: draft.id,
            approvalRequestId: asked.approvalRequestId,
          }),
        /is Pending, not Approved/,
      );
    });

    it('activates a reach-widening version once somebody else approved it', async () => {
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        memoryMode: 'AgentMemory',
      });

      const asked = await registry().requestActivationApproval({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
        approverUserId: skillApproverId,
      });

      const decided = await approvals().decide({
        scope: scope(),
        actorUserId: skillApproverId,
        approvalId: asked.approvalRequestId,
        decision: 'Approve',
        note: 'Reviewed the impact analysis.',
      });
      assert.equal(decided.status, 'Approved');
      // The decision record exists and names the approver. This is what Prompt 25 asserted
      // through a parameter nobody checked.
      assert.equal(decided.history.length, 1);
      assert.equal(decided.history[0]?.actorUserId, skillApproverId);

      const activated = await registry().activateVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
        approvalRequestId: asked.approvalRequestId,
      });

      assert.equal(activated.currentVersion?.versionNumber, 2);
      // The agent's declared mode follows the version in force, so the registry and the
      // configuration cannot disagree about what it may remember.
      assert.equal(activated.memoryMode, 'AgentMemory');
    });

    it('needs no approval to narrow memory back again', async () => {
      // Requiring permission to reduce reach would discourage exactly the edits a company should
      // be free to make immediately.
      const { agentId } = await liveAgent();
      const widening = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        memoryMode: 'AgentMemory',
      });
      const wideningApproval = await registry().requestActivationApproval({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: widening.id,
        approverUserId: skillApproverId,
      });
      await approvals().decide({
        scope: scope(),
        actorUserId: skillApproverId,
        approvalId: wideningApproval.approvalRequestId,
        decision: 'Approve',
        note: 'Fine.',
      });
      await registry().activateVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: widening.id,
        approvalRequestId: wideningApproval.approvalRequestId,
      });

      const narrowing = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        memoryMode: 'CurrentRunOnly',
      });
      assert.equal(narrowing.approvalRequired, false);
      assert.equal(narrowing.impact?.widensReach, false);
    });

    it('permits only one open draft at a time', async () => {
      const { agentId } = await liveAgent();
      await registry().createNewVersion({ scope: scope(), actorUserId: headUserId, agentId });

      await assert.rejects(
        () => registry().createNewVersion({ scope: scope(), actorUserId: headUserId, agentId }),
        /already has an open draft/,
      );
    });

    it('keeps every published version readable as history', async () => {
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        setup: { outputDestination: 'v2 destination' },
      });
      await registry().activateVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
      });

      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      assert.equal(view.versions.length, 2);
      assert.deepEqual(
        view.versions.map((version) => version.versionNumber),
        [2, 1],
      );
      assert.ok(view.versions.every((version) => version.status === 'Published'));
    });

    it('tests a draft and records that the model was a mock', async () => {
      const { agentId } = await liveAgent();
      const draft = await registry().createNewVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
      });

      const tested = await registry().testVersion({
        scope: scope(),
        actorUserId: headUserId,
        agentId,
        versionId: draft.id,
      });

      assert.notEqual(tested.test.at, null);
      assert.equal(tested.test.passed, true);
      assert.equal(tested.test.wasReal, false, 'a mock run claimed a real provider');
    });

    it('refuses to test a version that is already published', async () => {
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      const live = view.currentVersion;
      assert.ok(live);

      await assert.rejects(
        () =>
          registry().testVersion({
            scope: scope(),
            actorUserId: headUserId,
            agentId,
            versionId: live.id,
          }),
        /already run/,
      );
    });

    it('cannot have a published version edited, even in the database', async () => {
      // The backstop behind the service. Runs cite this configuration, and the impact analysis and
      // test result are what a reviewer relied on.
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      const live = view.currentVersion;
      assert.ok(live);

      for (const data of [
        { config: { tampered: true } },
        { impact: { changedFields: ['nothing'] } },
        { testPassed: true },
      ]) {
        await assert.rejects(
          () =>
            ctx.prisma.runAsPlatformOperation(() =>
              ctx.prisma.client.engineAgentVersion.update({
                where: { id: live.id },
                data: data as never,
              }),
            ),
          /published and cannot be changed/,
        );
      }
    });

    it('refuses an unknown memory mode', async () => {
      const { agentId } = await liveAgent();
      await assert.rejects(
        () =>
          registry().createNewVersion({
            scope: scope(),
            actorUserId: headUserId,
            agentId,
            memoryMode: 'RemembersEverything' as never,
          }),
        /Unknown memory mode/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. Runs are the next prompt
  // -------------------------------------------------------------------------

  describe('runs', () => {
    it('reports Run now as available but serves no route for it', async () => {
      // Recording the boundary rather than stubbing it. An endpoint that accepted "run now" and
      // queued nothing would leave a caller unable to tell a silent no-op from a real start, so
      // the route does not exist until the engine does.
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      assert.ok(view.actions.includes('RunNow'));

      const response = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/run`).send({}),
        managerUboss,
      );
      assert.equal(response.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Authorization and isolation
  // -------------------------------------------------------------------------

  describe('who may do what', () => {
    it('refuses an unauthenticated request', async () => {
      const { agentId } = await liveAgent();
      await agent()
        .get(`/tenants/${tenantId}/agents/${agentId}`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('lets a Manager pause but not archive', async () => {
      // Pausing is operational; archiving retires an identity permanently, which is a Head
      // decision in the role templates.
      const { agentId } = await liveAgent();

      await as(
        agent()
          .post(`/tenants/${tenantId}/agents/${agentId}/pause`)
          .send({ reason: 'Operational.' }),
        managerUboss,
      ).expect(201);

      await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/archive`).send({}),
        managerUboss,
      ).expect(403);
    });

    it('does not let a Manager draft or activate a version', async () => {
      const { agentId } = await liveAgent();
      await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/versions`).send({}),
        managerUboss,
      ).expect(403);
    });

    it('lets a Head do the whole version flow over HTTP', async () => {
      const { agentId } = await liveAgent();

      const drafted = await as(
        agent()
          .post(`/tenants/${tenantId}/agents/${agentId}/versions`)
          .send({ setup: { outputDestination: 'Via HTTP' } }),
        headUboss,
      ).expect(201);
      const versionId = drafted.body.id;

      await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/versions/${versionId}/test`).send({}),
        headUboss,
      ).expect(201);

      const activated = await as(
        agent()
          .post(`/tenants/${tenantId}/agents/${agentId}/versions/${versionId}/activate`)
          .send({}),
        headUboss,
      ).expect(201);
      assert.equal(activated.body.currentVersion.versionNumber, 2);
    });

    it('never lets another company reach an agent', async () => {
      const { agentId } = await liveAgent();

      const own = await as(
        agent().get(`/tenants/${otherTenantId}/agents/${agentId}`),
        outsiderUboss,
        otherTenantId,
      );
      assert.equal(own.status, 404);

      const across = await as(
        agent().get(`/tenants/${tenantId}/agents/${agentId}`),
        outsiderUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.name, undefined, 'a cross-tenant response carried the agent');
    });

    it('stores no agent or version outside its own tenant', async () => {
      const { agentId } = await liveAgent();
      await registry().createNewVersion({ scope: scope(), actorUserId: headUserId, agentId });

      const agents = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.findMany({ select: { tenantId: true } }),
      );
      const versions = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentVersion.findMany({ select: { tenantId: true } }),
      );
      assert.deepEqual(agents, [{ tenantId }]);
      assert.ok(versions.every((row) => row.tenantId === tenantId));
    });
  });
});
