import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
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
import { RunSchedulerService, parseBusinessCron } from '../src/runs/run-scheduler.service.js';
import { RunController } from '../src/runs/run.controller.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
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
 * Prompt 26 — the run engine, its queue and its scheduler.
 *
 * Built on the Prompt 25 fixture chain, because a run only exists for an activated agent.
 *
 * What this suite defends:
 *
 *   1. **The durable row exists before the work.** A crashed worker leaves something findable,
 *      not work that silently never happened.
 *   2. **Queued -> Reserved -> Running.** The reservation is where budget is set aside, and the
 *      shortcut is refused by the transition table and by a database CHECK.
 *   3. **Idempotency is what makes a scheduler safe on two instances.** Two ticks noticing the
 *      same due moment produce one run; a person pressing the button twice gets two.
 *   4. **Retries are classified and bounded**, and the dead-letter path preserves context.
 *   5. **Live progress never replaces the record.** The event history is append-only and
 *      complete with nobody watching, and a broken listener cannot fail a run.
 *   6. **The scheduler works in the company’s timezone**, and never fires on a non-working day
 *      or a holiday.
 *
 * The queue here is `InlineRunQueue`, which genuinely performs the run rather than recording the
 * call. BullMQ is the shipping transport; what a broker adds is cross-process delivery and a
 * delayed retry surviving a restart, and neither is what these thirteen states are about.
 */
describe('run engine, queue and scheduler (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let managerUserId: string;
  let managerUboss: string;
  let workerUserId: string;
  let workerUboss: string;
  let otherWorkerUserId: string;
  let otherWorkerUboss: string;
  let objectiveApproverId: string;
  /// The same person, named for what they do in these tests.
  let _headUserId: string;
  let _headUboss: string;
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
  const engine = () => app.get(RunEngineService);
  const scheduler = () => app.get(RunSchedulerService);
  const progress = () => app.get(RunProgressGateway);
  const settings = () => app.get(CompanySettingsService);
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
        ObjectiveController,
        AgentBuilderController,
        EngineAgentController,
        RunController,
      ],
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
        // Prompt 40A (CR-03): the run route consults an operator share before deciding a
        // person cannot reach an agent, so this is now part of its graph.
        AgentOperatorService,
        EngineAgentService,
        ApprovalService,
        { provide: RunQueue, useClass: InlineRunQueue },
        RunProgressGateway,
        RunEngineService,
        RunSchedulerService,
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
    managerUboss = people.manager.ubossUniqueId;
    workerUserId = people.worker.id;
    workerUboss = people.worker.ubossUniqueId;
    otherWorkerUserId = people.otherWorker.id;
    otherWorkerUboss = people.otherWorker.ubossUniqueId;
    objectiveApproverId = people.head.id;
    _headUserId = people.head.id;
    _headUboss = people.head.ubossUniqueId;
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

      // The employee who owns the assigned AI work. `OwnWork` is the whole point: they complete
      // their own setup and activate, and nothing wider.
      //
      // **Since CR-03 (Prompt 40A) that needs an explicit grant.** This suite drives Agent Builder
      // as the worker to produce a live agent to run, so the grant is what keeps that possible.
      // `grantBuilderAccess` keeps the scope at `OwnWork`: the capability widens, the reach does
      // not.
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
  // 1. A durable row before the work
  // -------------------------------------------------------------------------

  describe('starting a run', () => {
    it('writes the row before the work, and walks Queued → Reserved → Running → Completed', async () => {
      const { agentId } = await liveAgent();
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
        startedByUserId: workerUserId,
      });

      assert.equal(outcome.created, true);
      assert.equal(outcome.run.state, 'Completed');

      // The whole sequence is on the row's own event history, in order. This is what makes a
      // WebSocket a convenience: the story survives without anyone watching.
      assert.deepEqual(
        outcome.run.events.map((event) => event.state),
        ['Queued', 'Reserved', 'Running', 'Completed'],
      );
    });

    it('cites the immutable version that produced it', async () => {
      const { agentId } = await liveAgent();
      const view = await registry().view({ scope: scope(), actorUserId: managerUserId, agentId });
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      assert.equal(outcome.run.engineAgentVersionId, view.currentVersion?.id);
    });

    it('records that the mock model did the work', async () => {
      // Never presented as a real provider result, on the thing that actually did the work.
      const { agentId } = await liveAgent();
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      assert.equal(outcome.run.producedByRealModel, false);
      assert.match(String(outcome.run.progressMessage), /mock model, not a live provider/);
    });

    it('threads a correlation id through the run and its events', async () => {
      const { agentId } = await liveAgent();
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
        correlationId: 'corr-fixed-1',
      });
      assert.equal(outcome.run.correlationId, 'corr-fixed-1');
    });

    it('refuses to run an agent that is not active', async () => {
      // Pausing an agent that could still be triggered would not be a pause.
      const { agentId } = await liveAgent();
      await registry().pause({
        scope: scope(),
        actorUserId: managerUserId,
        agentId,
        reason: 'Provider incident.',
      });

      await assert.rejects(
        () => engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' }),
        /Only an active agent runs/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('makes two callers meaning one occurrence into one run', async () => {
      // What lets a scheduler run on two instances without a lock.
      const { agentId } = await liveAgent();
      const occurrence = '2026-03-02T10:30:00.000Z';

      const first = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Scheduled',
        occurrence,
        scheduledFor: new Date(occurrence),
      });
      const second = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Scheduled',
        occurrence,
        scheduledFor: new Date(occurrence),
      });

      assert.equal(first.created, true);
      assert.equal(second.created, false);
      assert.equal(second.run.id, first.run.id);
      assert.match(second.reason, /idempotency key matched/);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.count({ where: { tenantId, engineAgentId: agentId } }),
      );
      assert.equal(count, 1);
    });

    it('lets a person start the same agent twice on purpose', async () => {
      // Pressing the button twice means somebody wants it twice; deduplicating that would
      // silently ignore an instruction.
      const { agentId } = await liveAgent();
      const first = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      const second = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      assert.equal(first.created, true);
      assert.equal(second.created, true);
      assert.notEqual(second.run.id, first.run.id);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Overlap
  // -------------------------------------------------------------------------

  describe('overlap policy', () => {
    /** Park a run mid-flight so a second start has something to overlap with. */
    const parkRunning = async (agentId: string) => {
      engine().setExecutor(async () => {
        throw new RunFailure('Waiting on a person.', 'NeedsIntervention', 'WaitingForHumanInput');
      });
      const parked = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);
      assert.equal(parked.run.state, 'WaitingForHumanInput');
      return parked.run.id;
    };

    it('skips a new run while one is unfinished, by default', async () => {
      const { agentId } = await liveAgent();
      await parkRunning(agentId);

      await assert.rejects(
        () => engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' }),
        /skips overlaps/,
      );
    });

    it('leaves no row at all for a skipped occurrence', async () => {
      // Decided before the row is written, so a skip does not leave a run that immediately
      // cancels itself and clutters the history.
      const { agentId } = await liveAgent();
      await parkRunning(agentId);

      await assert.rejects(() =>
        engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' }),
      );

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.count({ where: { tenantId, engineAgentId: agentId } }),
      );
      assert.equal(count, 1);
    });

    it('allows concurrency when the agent is configured for it', async () => {
      const { agentId } = await liveAgent();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.update({
          where: { id: agentId },
          data: { overlapPolicy: 'Allow' },
        }),
      );
      await parkRunning(agentId);

      const second = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      assert.equal(second.created, true);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Retries and the dead-letter path
  // -------------------------------------------------------------------------

  describe('retries', () => {
    it('retries a retryable failure and increments the attempt', async () => {
      const { agentId } = await liveAgent();
      let attempts = 0;
      engine().setExecutor(async () => {
        attempts += 1;
        if (attempts === 1) throw new RunFailure('A blip.', 'Retryable');
        return { output: { ok: true }, producedByRealModel: false };
      });

      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      assert.equal(attempts, 2);
      assert.equal(outcome.run.state, 'Completed');
      assert.equal(outcome.run.attempt, 2);
      assert.ok(
        outcome.run.events.some((event) => event.state === 'Retrying'),
        'the retry is not on the record',
      );
    });

    it('does not retry a terminal failure, and says why', async () => {
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure('The input can never parse.', 'Terminal');
      });

      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      assert.equal(outcome.run.state, 'Failed');
      assert.equal(outcome.run.attempt, 1, 'a terminal failure was retried');
      assert.match(String(outcome.run.failureReason), /will not succeed/);
    });

    it('spends its bounded attempts then dead-letters, preserving the context', async () => {
      // The architecture's requirement: the dead-letter path preserves context rather than
      // dropping the work.
      const { agentId } = await liveAgent();
      let attempts = 0;
      engine().setExecutor(async () => {
        attempts += 1;
        throw new RunFailure(`Attempt ${attempts} failed.`, 'Retryable');
      });

      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      assert.equal(attempts, 3, 'the attempt ceiling was not honoured');
      assert.equal(outcome.run.state, 'Failed');
      assert.notEqual(outcome.run.deadLetteredAt, null);
      assert.match(String(outcome.run.failureReason), /attempts are used/);
      // The context: every attempt is on the record, not just the last.
      assert.equal(outcome.run.events.filter((event) => event.state === 'Retrying').length, 2);
    });

    it('audits the dead-lettering', async () => {
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure('Always fails.', 'Retryable');
      });
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });
      engine().setExecutor(null);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent.run_dead_lettered' },
          select: { summary: true },
        }),
      );
      assert.equal(events.length, 1);
      assert.match(String(events[0]?.summary), /context is preserved/);
    });

    it('treats an unclassified throw as retryable', async () => {
      // A bug that always throws burns its bounded attempts and then dead-letters, which is
      // visible. Treating it as terminal would turn a transient fault into a permanent failure on
      // the first blip.
      const { agentId } = await liveAgent();
      let attempts = 0;
      engine().setExecutor(async () => {
        attempts += 1;
        throw new Error('Something unexpected.');
      });

      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });
      engine().setExecutor(null);
      assert.equal(attempts, 3);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Blocked states
  // -------------------------------------------------------------------------

  describe('blocked runs', () => {
    it('moves to the specific blocked state, and does not retry it', async () => {
      // The four are separate states because four different people resolve them.
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure(
          'The budget for this department is exhausted.',
          'NeedsIntervention',
          'BlockedByBudget',
        );
      });

      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      assert.equal(outcome.run.state, 'BlockedByBudget');
      assert.equal(outcome.run.attempt, 1);
      assert.match(String(outcome.run.failureReason), /budget/);
      assert.equal(outcome.run.finishedAt, null, 'a blocked run is not finished');
    });

    it('re-queues a blocked run once the cause is resolved', async () => {
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure('No live connection.', 'NeedsIntervention', 'BlockedByConnection');
      });
      const blocked = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);
      assert.equal(blocked.run.state, 'BlockedByConnection');

      const resumed = await engine().resume({
        scope: scope(),
        runId: blocked.run.id,
        note: 'The connection was reauthorized.',
      });
      assert.equal(
        (app.get(RunQueue) as InlineRunQueue).lastFailure?.message ?? null,
        null,
        (app.get(RunQueue) as InlineRunQueue).lastFailure?.stack ?? 'the handler threw',
      );
      // It ran to completion once re-queued, because resuming a blocked run puts it back through
      // the reservation rather than straight into Running.
      assert.equal(
        resumed.state,
        'Completed',
        `states seen: ${resumed.events.map((e) => e.state).join(' -> ')}; msg=${resumed.progressMessage}`,
      );
      assert.ok(resumed.events.some((event) => event.state === 'Reserved'));
    });
  });

  // -------------------------------------------------------------------------
  // 6. Cancellation
  // -------------------------------------------------------------------------

  describe('cancellation', () => {
    it('cancels a waiting run, which is the case that must not be un-cancellable', async () => {
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure('Waiting on a person.', 'NeedsIntervention', 'WaitingForHumanInput');
      });
      const parked = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      const cancelled = await engine().cancel({
        scope: scope(),
        runId: parked.run.id,
        actorUserId: managerUserId,
        reason: 'The person who owned this has left.',
      });

      assert.equal(cancelled.state, 'Cancelled');
      assert.notEqual(cancelled.cancelledAt, null);
      assert.notEqual(cancelled.finishedAt, null);
      assert.match(String(cancelled.failureReason), /has left/);
    });

    it('refuses to cancel a finished run, because that would rewrite history', async () => {
      const { agentId } = await liveAgent();
      const done = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      assert.equal(done.run.state, 'Completed');

      await assert.rejects(
        () =>
          engine().cancel({
            scope: scope(),
            runId: done.run.id,
            actorUserId: managerUserId,
            reason: 'Changed my mind.',
          }),
        /already finished/,
      );
    });

    it('audits the cancellation with the state it came from', async () => {
      const { agentId } = await liveAgent();
      engine().setExecutor(async () => {
        throw new RunFailure('Parked.', 'NeedsIntervention', 'WaitingForApproval');
      });
      const parked = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      engine().setExecutor(null);

      await engine().cancel({
        scope: scope(),
        runId: parked.run.id,
        actorUserId: managerUserId,
        reason: 'No longer needed.',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'agent.run_cancelled' },
          select: { metadata: true },
        }),
      );
      const metadata = events[0]?.metadata as Record<string, unknown> | undefined;
      assert.equal(metadata?.['from'], 'WaitingForApproval');
    });
  });

  // -------------------------------------------------------------------------
  // 7. Live progress is a convenience, never the record
  // -------------------------------------------------------------------------

  describe('live progress', () => {
    it('publishes every state change to the company’s listeners', async () => {
      const { agentId } = await liveAgent();
      const seen: string[] = [];
      const unsubscribe = progress().subscribe(tenantId, (event) => seen.push(event.state));

      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });
      unsubscribe();

      assert.deepEqual(seen, ['Queued', 'Reserved', 'Running', 'Completed']);
    });

    it('never delivers one company’s progress to another’s listener', async () => {
      const { agentId } = await liveAgent();
      const otherCompanySaw: string[] = [];
      const unsubscribe = progress().subscribe(otherTenantId, (event) =>
        otherCompanySaw.push(event.state),
      );

      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });
      unsubscribe();

      assert.deepEqual(otherCompanySaw, []);
    });

    it('does not fail the run when a listener throws', async () => {
      // The run's state is already committed. Losing the animation is acceptable; losing the work
      // is not.
      const { agentId } = await liveAgent();
      const unsubscribe = progress().subscribe(tenantId, () => {
        throw new Error('This listener is broken.');
      });

      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });
      unsubscribe();

      assert.equal(outcome.run.state, 'Completed');
    });

    it('leaves the durable history complete even with nobody listening', async () => {
      const { agentId } = await liveAgent();
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRunEvent.findMany({
          where: { tenantId, runId: outcome.run.id },
          orderBy: { occurredAt: 'asc' },
        }),
      );
      assert.deepEqual(
        stored.map((event) => event.state),
        ['Queued', 'Reserved', 'Running', 'Completed'],
      );
    });

    it('cannot have its history rewritten', async () => {
      const { agentId } = await liveAgent();
      const outcome = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.agentRunEvent.updateMany({
              where: { runId: outcome.run.id },
              data: { message: 'rewritten' },
            }),
          ),
        /append-only/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. The scheduler
  // -------------------------------------------------------------------------

  describe('the scheduler', () => {
    /** Give the agent a machine-readable schedule: 10:30 every day the company works. */
    const schedule = async (agentId: string, cron = '30 10 * * *') =>
      ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.update({
          where: { id: agentId },
          data: { scheduleCron: cron, nextRunAt: null },
        }),
      );

    it('parses only the business subset, and refuses the rest with a reason', () => {
      assert.equal(parseBusinessCron('30 10 * * *').ok, true);
      assert.equal(parseBusinessCron('0,30 9,17 * * Monday,Friday').ok, true);

      // Day-of-month would bypass the working-day and holiday rules this scheduler exists to
      // enforce, so it is refused rather than approximated.
      const dom = parseBusinessCron('0 9 13 * *');
      assert.equal(dom.ok, false);
      if (!dom.ok) assert.match(dom.reason, /day-of-month/);

      const wrongFields = parseBusinessCron('0 9 *');
      assert.equal(wrongFields.ok, false);
      if (!wrongFields.ok) assert.match(wrongFields.reason, /five fields/);
    });

    it('starts a run at the scheduled minute on a working day', async () => {
      const { agentId } = await liveAgent();
      await schedule(agentId);

      // 2026-03-02 is a Monday. 05:00Z is 10:30 in Asia/Kolkata, the default business timezone.
      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T05:00:00Z'),
      });

      const forAgent = outcome.outcomes.find((entry) => entry.engineAgentId === agentId);
      assert.equal(forAgent?.started, 1, forAgent?.reason);
    });

    it('does not fire on a non-working day', async () => {
      const { agentId } = await liveAgent();
      await schedule(agentId);

      // 2026-03-07 is a Saturday, which the default working week excludes.
      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-07T05:00:00Z'),
      });
      assert.equal(outcome.outcomes.find((entry) => entry.engineAgentId === agentId)?.started, 0);
    });

    it('does not fire on a company holiday', async () => {
      const { agentId } = await liveAgent();
      await schedule(agentId);
      await settings().update({
        scope: scope(),
        actorUserId: skillAdminId,
        values: { 'general.holidays': '2026-03-02' },
        reason: 'A company holiday for the test.',
      });

      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T05:00:00Z'),
      });
      assert.equal(outcome.outcomes.find((entry) => entry.engineAgentId === agentId)?.started, 0);
    });

    it('is idempotent: two ticks on the same minute start one run', async () => {
      // What makes it safe on two instances, with no lock.
      const { agentId } = await liveAgent();
      await schedule(agentId);
      const now = new Date('2026-03-02T05:00:00Z');

      await scheduler().tick({ scope: scope(), now });
      await scheduler().tick({ scope: scope(), now });

      const runs = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.count({
          where: { tenantId, engineAgentId: agentId, trigger: 'Scheduled' },
        }),
      );
      assert.equal(runs, 1);
    });

    it('reports an unreadable schedule instead of silently never firing', async () => {
      // The worst outcome would be a company believing an agent is scheduled when it is not.
      const { agentId } = await liveAgent();
      await schedule(agentId, 'every monday at ten');

      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T05:00:00Z'),
      });
      const forAgent = outcome.outcomes.find((entry) => entry.engineAgentId === agentId);
      assert.equal(forAgent?.started, 0);
      assert.match(String(forAgent?.reason), /could not be read/);
    });

    it('ignores an agent with no machine-readable schedule', async () => {
      // Prompt 24 records the trigger as free text, which cannot drive a scheduler. Such an agent
      // is not ticked at all rather than guessed at.
      const { agentId } = await liveAgent();
      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T05:00:00Z'),
      });
      assert.equal(
        outcome.outcomes.find((entry) => entry.engineAgentId === agentId),
        undefined,
      );
    });

    it('records the next occurrence so the registry can show it', async () => {
      const { agentId } = await liveAgent();
      await schedule(agentId);
      await scheduler().tick({ scope: scope(), now: new Date('2026-03-02T05:00:00Z') });

      const agent = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.findUniqueOrThrow({ where: { id: agentId } }),
      );
      assert.notEqual(agent.nextRunAt, null);
    });

    it('skips missed occurrences by default', async () => {
      // Catching up after an outage can flood a provider and spend a budget in minutes.
      const { agentId } = await liveAgent();
      await schedule(agentId);

      // Checkpoint two working days back, so several occurrences are already late.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.update({
          where: { id: agentId },
          data: { nextRunAt: new Date('2026-02-26T05:00:00Z') },
        }),
      );

      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T06:00:00Z'),
      });
      const forAgent = outcome.outcomes.find((entry) => entry.engineAgentId === agentId);
      assert.equal(forAgent?.started, 0, forAgent?.reason);
      assert.ok((forAgent?.skipped ?? 0) > 0);
    });

    it('catches up once when configured to', async () => {
      const { agentId } = await liveAgent();
      await schedule(agentId);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgent.update({
          where: { id: agentId },
          data: { nextRunAt: new Date('2026-02-26T05:00:00Z'), missedRunPolicy: 'RunOnce' },
        }),
      );

      const outcome = await scheduler().tick({
        scope: scope(),
        now: new Date('2026-03-02T06:00:00Z'),
      });
      assert.equal(outcome.outcomes.find((entry) => entry.engineAgentId === agentId)?.started, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 9. The routes ADR-122 deferred
  // -------------------------------------------------------------------------

  describe('run routes', () => {
    it('runs now over HTTP, which is what Prompt 25 deliberately had no route for', async () => {
      const { agentId } = await liveAgent();
      const response = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        workerUboss,
      ).expect(201);

      assert.equal(response.body.created, true);
      assert.equal(response.body.run.state, 'Completed');
    });

    it('opens the runs list over HTTP', async () => {
      const { agentId } = await liveAgent();
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });

      const response = await as(
        agent().get(`/tenants/${tenantId}/agents/${agentId}/runs`),
        managerUboss,
      ).expect(200);
      assert.equal(response.body.runs.length, 1);
    });

    it('says which transport is carrying the work, rather than leaving it to be guessed', async () => {
      const { agentId } = await liveAgent();
      const response = await as(
        agent().get(`/tenants/${tenantId}/agents/${agentId}/runs/meta`),
        managerUboss,
      ).expect(200);

      assert.equal(typeof response.body.transport.isDurableTransport, 'boolean');
      assert.equal(Object.keys(response.body.blockOwners).length, 4);
      assert.equal(response.body.states.length, 13);
    });

    it('refuses an unauthenticated request', async () => {
      const { agentId } = await liveAgent();
      await agent()
        .get(`/tenants/${tenantId}/agents/${agentId}/runs`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('never lets another company read a run', async () => {
      const { agentId } = await liveAgent();
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });

      const across = await as(
        agent().get(`/tenants/${tenantId}/agents/${agentId}/runs`),
        outsiderUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.runs, undefined);
    });

    it('stores no run outside its own tenant', async () => {
      const { agentId } = await liveAgent();
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.findMany({ select: { tenantId: true } }),
      );
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.tenantId === tenantId));
    });
  });

  /**
   * Prompt 40A (CR-03) §5 — the person an agent was built *for*.
   *
   * ## Why this block exists
   *
   * `AgentOperatorService.assertMayRun` was written at Prompt 40A and **called by nothing**. The
   * operator screen asked `mayRun`, was told yes, and enabled Run — and the run route then decided
   * visibility from ownership and refused, because a manager-built agent is owned by the manager
   * and the employee is capped at `OwnWork`. Every test covering the share asked the *service*, so
   * nothing failed.
   *
   * These tests go over HTTP for that reason: they are about the route, and only the route could
   * have shown the gap.
   */
  describe('an operator running an agent built for them', () => {
    const operators = () => app.get(AgentOperatorService);

    /** Share `agentId` with the other worker, as the manager who may assign work. */
    const shareWithOtherWorker = (agentId: string) =>
      operators().share({
        scope: scope(),
        actorUserId: managerUserId,
        engineAgentId: agentId,
        operatorUserId: otherWorkerUserId,
      });

    it('refuses somebody the agent was never shared with', async () => {
      const { agentId } = await liveAgent();

      const response = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        otherWorkerUboss,
      );

      assert.ok(
        response.status === 403 || response.status === 404,
        `an unshared run answered ${response.status}`,
      );
    });

    it('lets the operator run it once it is shared', async () => {
      const { agentId } = await liveAgent();
      await shareWithOtherWorker(agentId);

      const response = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        otherWorkerUboss,
      ).expect(201);

      assert.equal(response.body.created, true);
    });

    it('agrees with the screen: what mayRun promised is what the route does', async () => {
      const { agentId } = await liveAgent();
      await shareWithOtherWorker(agentId);

      // The exact question the operator's screen asks to decide whether Run is enabled.
      const decision = await operators().mayRun({
        scope: scope(),
        actorUserId: otherWorkerUserId,
        engineAgentId: agentId,
      });
      assert.equal(decision.allowed, true);

      // And the route agrees. These two disagreeing is the defect this block was written for.
      await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        otherWorkerUboss,
      ).expect(201);
    });

    it('lets the operator read the runs of their own agent', async () => {
      const { agentId } = await liveAgent();
      await shareWithOtherWorker(agentId);
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });

      const response = await as(
        agent().get(`/tenants/${tenantId}/agents/${agentId}/runs`),
        otherWorkerUboss,
      ).expect(200);

      assert.equal(response.body.runs.length, 1);
    });

    it('stops the run the moment the share is withdrawn', async () => {
      const { agentId } = await liveAgent();
      await shareWithOtherWorker(agentId);
      await operators().revokeShare({
        scope: scope(),
        actorUserId: managerUserId,
        engineAgentId: agentId,
        operatorUserId: otherWorkerUserId,
      });

      const response = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        otherWorkerUboss,
      );

      assert.ok(
        response.status === 403 || response.status === 404,
        `a withdrawn share answered ${response.status}`,
      );
    });

    it('does not let a share confer the authority to cancel somebody’s work', async () => {
      const { agentId } = await liveAgent();
      await shareWithOtherWorker(agentId);
      const run = await engine().start({
        scope: scope(),
        engineAgentId: agentId,
        trigger: 'Manual',
      });

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/agents/${agentId}/runs/${run.run.id}/cancel`)
          .send({ reason: 'Changed my mind.' }),
        otherWorkerUboss,
      );

      // Being handed a job to do is not being handed the authority to stop work in flight.
      assert.ok(
        response.status === 403 || response.status === 404,
        `an operator cancel answered ${response.status}`,
      );
    });

    it('leaves the owner path exactly as it was', async () => {
      const { agentId } = await liveAgent();

      // No share anywhere. The worker owns this agent and runs it the way they always did.
      await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        workerUboss,
      ).expect(201);
    });
  });

  // =========================================================================
  describe('the complete company journey — Prompt 42', () => {
    /**
     * One test, the whole arc, asserting the **hand-offs**.
     *
     * Every stage below already has a suite of its own that checks it deeply, and this does not
     * repeat any of that. What no per-stage suite can check is that the artefact one stage produces
     * is the artefact the next stage consumes — that the same objective id reaches the assignment,
     * the same assignment reaches the agent, the same agent reaches the run, and the person who
     * ends up operating it is the person it was built for.
     *
     * Those seams are where an integration breaks without any single suite failing, which is why
     * Prompt 42 asks for this test by name.
     */
    it('runs Objective → AI work → Agent → activation → the employee operating it', async () => {
      // ---- 1. an objective, analysed into a workflow, with AI work assigned ----
      const { assignmentId, objectiveId } = await assignedAiWork();

      assert.ok(objectiveId, 'no objective came out of the analysis');
      assert.ok(assignmentId, 'no AI work assignment came out of the workflow');

      const assignment = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.aiWorkAssignment.findFirst({ where: { id: assignmentId } }),
      );
      assert.ok(assignment);
      // The first seam: the assignment names the objective it came from, not a copy of it.
      assert.equal(assignment.objectiveId, objectiveId);

      // ---- 2. the builder answers only what the objective could not ----
      await answerEverything(assignmentId);
      const ready = await builder().view({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      assert.equal(ready.missing.length, 0, 'the builder still wants something after answering all');
      assert.equal(ready.readiness.readyToActivate, true);

      // ---- 3. activation produces a reusable Engine Agent ----
      const activated = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const agentId = activated.engineAgent?.id;
      assert.ok(agentId, 'activation produced no agent');

      // The second seam: the assignment now names its agent, and the constraint
      // `mapped_assignment_names_its_agent` is what makes that not merely a convention.
      const mapped = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.aiWorkAssignment.findFirst({ where: { id: assignmentId } }),
      );
      assert.equal(mapped?.engineAgentId, agentId);

      // ---- 4. a colleague who was given the work can operate it ----
      await app.get(AgentOperatorService).share({
        scope: scope(),
        actorUserId: managerUserId,
        engineAgentId: agentId,
        operatorUserId: otherWorkerUserId,
      });

      const mine = await app.get(AgentOperatorService).myAgents({
        scope: scope(),
        actorUserId: otherWorkerUserId,
      });
      const theirs = mine.find((entry) => entry.agentId === agentId);
      assert.ok(theirs, 'the agent did not appear on the operator’s screen');

      // The third seam, and the one CR-03 exists for: the objective's name and the assigned work
      // reach the operator's screen, resolved from the chain rather than copied onto the share.
      assert.ok(theirs.linkedObjectiveName, 'the operator screen lost the objective');
      assert.ok(theirs.assignedWorkTitle, 'the operator screen lost the assigned work');

      /*
       * Deliberately *not* asserted here: that the operator holds no builder access.
       *
       * It is true of a standard Employee and it is the point of CR-03, but it is not true of
       * this fixture — every persona in this suite was granted `agent-builder` when the CR-03
       * narrowing broke the 62 tests that drive Agent Builder as an employee. Asserting it here
       * would either fail or, worse, be "fixed" by weakening the fixture.
       *
       * It belongs to `cr03-access-and-job-method.e2e.spec.ts`, which builds a clean standard
       * Employee for exactly that question and asserts it there.
       */

      // ---- 5. and running it over HTTP actually works ----
      const started = await as(
        agent().post(`/tenants/${tenantId}/agents/${agentId}/runs`).send({}),
        otherWorkerUboss,
      ).expect(201);
      assert.equal(started.body.created, true);

      const runId = started.body.run?.id;
      assert.ok(runId, 'the run has no id');

      // ---- 6. the run is attributed all the way back up the chain ----
      const run = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.agentRun.findFirst({ where: { id: runId } }),
      );
      assert.ok(run);
      assert.equal(run.engineAgentId, agentId);
      // The fourth seam: a run knows which objective it served, so cost and reporting can roll up
      // without walking the assignment — which may be null.
      assert.equal(run.objectiveId, objectiveId);

      // ---- 7. nothing in the arc was produced by a real model, and it says so ----
      assert.equal(
        run.producedByRealModel,
        false,
        'a mock run must never be recorded as a real provider result',
      );

      // ---- 8. the whole arc left an audit trail ----
      const audited = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId },
          select: { action: true, resourceType: true },
        }),
      );
      const actions = audited.map((row) => row.action);

      // Not an exhaustive list — each stage's own suite pins its own events. What matters here is
      // that the arc is continuous: an objective, an agent and a run all left a record in one
      // company's trail, so an auditor can follow the work from intent to execution.
      assert.ok(
        actions.some((action) => action.startsWith('objective.')),
        'the objective stage left no audit event',
      );
      assert.ok(
        actions.some((action) => action.startsWith('agent.')),
        'the agent stage left no audit event',
      );
      assert.ok(audited.every((row) => row.resourceType !== ''), 'an audit row named no resource');
    });

    it('keeps the whole journey inside one company', async () => {
      /*
       * The same arc, asked the only question that matters across a tenant boundary: did any of it
       * land anywhere else? Checked at the database under the *other* company's RLS context, because
       * a route returning nothing could be a permission refusal while an empty result here is the
       * isolation itself.
       */
      const { assignmentId, objectiveId } = await assignedAiWork();
      await answerEverything(assignmentId);
      const activated = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
        assignmentId,
      });
      const agentId = activated.engineAgent?.id;
      assert.ok(agentId);
      await engine().start({ scope: scope(), engineAgentId: agentId, trigger: 'Manual' });

      const otherScope = tenantScopeForPlatformOperation(otherTenantId);
      const counts = await ctx.prisma.runInTenantTransaction(otherScope, async () => ({
        objectives: await ctx.prisma.client.objective.count({ where: { id: objectiveId } }),
        assignments: await ctx.prisma.client.aiWorkAssignment.count({ where: { id: assignmentId } }),
        agents: await ctx.prisma.client.engineAgent.count({ where: { id: agentId } }),
        runs: await ctx.prisma.client.agentRun.count({ where: { engineAgentId: agentId } }),
      }));

      assert.deepEqual(counts, { objectives: 0, assignments: 0, agents: 0, runs: 0 });
    });
  });
});
