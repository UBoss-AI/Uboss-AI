import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  EXCEPTION_KINDS,
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
import { ExecutorController } from '../src/executor/executor.controller.js';
import { ExecutorService } from '../src/executor/executor.service.js';
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
 * Prompt 27 — the Executor Agent and the Exception Center.
 *
 * Built on the run-engine fixture chain, because the conditions the Executor exists to notice
 * are real ones: a dead-lettered run, a run blocked on a budget or a permission, a run waiting
 * on a person.
 *
 * What this suite defends, above everything else:
 *
 *   **The Executor never decides.** It detects, routes, escalates, retries a transient fault and
 *   pauses a misbehaving agent. It cannot resolve or dismiss anything, it cannot act at all on an
 *   exception raised because a control refused the work, and it never passes a high-risk action
 *   that is waiting on a person. Three independent layers enforce that — the vocabulary, the
 *   service, and a database CHECK — and there is a test for each.
 *
 * Also defended: one condition holds one open exception however often the sweep runs; the
 * resolution history says whether a person or the machine did each thing, and is append-only;
 * and an acknowledged exception still escalates, because acknowledging is not fixing.
 */
describe('executor agent and exception center (e2e)', () => {
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
  let _headUserId: string;
  let _headUboss: string;
  let skillAdminId: string;
  let skillApproverId: string;
  let platformOwnerId: string;
  let outsiderUboss: string;
  let _otherTenantId: string;
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
        ExecutorController,
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
        { provide: RunQueue, useClass: InlineRunQueue },
        RunProgressGateway,
        RunEngineService,
        RunSchedulerService,
        ExecutorService,
        // Prompt 28: the Executor now raises a real approval row for RequestApproval, rather
        // than reporting that it asked for a decision nobody could see.
        ApprovalService,
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
    _otherTenantId = other.tenant.id;

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
      // **Since CR-03 (Prompt 40A) that needs an explicit grant.** A standard Employee is
      // operations-only, so these two are "Power Employees": the same template plus a `Custom`
      // role carrying the builder permissions. This suite's fixtures drive Agent Builder as the
      // worker in order to produce a live agent to sweep, so the grant is what keeps that
      // possible — and `grantBuilderAccess` keeps the scope at `OwnWork`, so the capability is
      // widened without the reach being widened.
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

  /** A dead-lettered run: the condition the sweep is meant to notice. */
  const deadLetteredRun = async () => {
    const { agentId } = await liveAgent();
    engine().setExecutor(async () => {
      throw new RunFailure('Always fails.', 'Retryable');
    });
    const outcome = await engine().start({
      scope: scope(),
      engineAgentId: agentId,
      trigger: 'Manual',
    });
    engine().setExecutor(null);
    assert.notEqual(outcome.run.deadLetteredAt, null);
    return { agentId, runId: outcome.run.id };
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

  /**
   * A run left `Queued`, aged by hand — Prompt 40.
   *
   * Planted rather than produced, because producing one would mean holding the queue for half an
   * hour. The row is what the sweep reads, so a row with an old `created_at` is the same input a
   * genuinely starved run presents.
   */
  const queuedRunAgedBy = async (minutes: number) => {
    const { agentId } = await liveAgent();
    const queuedAt = new Date(Date.now() - minutes * 60_000);

    return ctx.prisma.runAsPlatformOperation(async () => {
      const agentRow = await ctx.prisma.client.engineAgent.findUniqueOrThrow({
        where: { id: agentId },
        select: { currentVersionId: true },
      });
      const suffix = Math.random().toString(36).slice(2, 10);
      const run = await ctx.prisma.client.agentRun.create({
        data: {
          tenantId,
          engineAgentId: agentId,
          engineAgentVersionId: agentRow.currentVersionId!,
          state: 'Queued',
          trigger: 'Scheduled',
          // Required by `scheduled_run_knows_its_moment`: a scheduled occurrence must record the
          // moment it was due, or the schedule cannot be reconstructed from the row. A scheduled
          // run is also the realistic starvation case — nobody is watching it.
          scheduledFor: queuedAt,
          attempt: 1,
          idempotencyKey: `starved-${suffix}`,
          correlationId: `corr-${suffix}`,
          createdAt: queuedAt,
          progressMessage:
            'Your company already has the maximum number of agent runs in progress.',
        },
      });
      return { agentId, runId: run.id };
    });
  };

  // -------------------------------------------------------------------------
  // 1. Detection
  // -------------------------------------------------------------------------

  describe('the sweep', () => {
    it('raises a Repeated Failure for a dead-lettered run', async () => {
      // Closing the boundary Prompt 26 deliberately left open: the run engine preserves the
      // context and the Executor is what turns it into somebody's problem.
      const { runId } = await deadLetteredRun();
      const swept = await executor().sweep({ scope: scope() });

      assert.equal(swept.byKind['RepeatedFailure'], 1, JSON.stringify(swept.byKind));

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);
      assert.equal(raised.kind, 'RepeatedFailure');
      assert.equal(raised.severity, 'High');
      assert.equal(raised.attempts, 3, 'the attempt count did not carry from the run');
    });

    // Four tests rather than one loop: a Skill key and an agent name are both unique per company,
    // so four agents in one company collide on both. A fresh company per test — which the
    // beforeEach already gives — is simpler than working around either.
    //
    // The reason these are four separate exception kinds and not one with a reason code is that
    // four different people resolve them.

    it('maps a budget block to Budget / token limit, whose owner holds the budget', async () => {
      const { runId } = await blockedRun('BlockedByBudget', 'The department budget is exhausted.');
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised, 'nothing was raised');
      assert.equal(raised.kind, 'BudgetOrTokenLimit');
      assert.equal(raised.severity, 'High');
      assert.match(raised.defaultOwner, /budget approver/);
    });

    it('maps a connection block to Credential / connection expired', async () => {
      const { runId } = await blockedRun(
        'BlockedByConnection',
        'The credential for this connection has expired.',
      );
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised, 'nothing was raised');
      assert.equal(raised.kind, 'CredentialOrConnectionExpired');
      assert.match(raised.defaultOwner, /Connection owner/);
    });

    it('maps a permission block to Permission denied, which is High', async () => {
      // High because it means the agent attempted something it should not have been able to.
      const { runId } = await blockedRun(
        'BlockedByPermission',
        'The agent has no tool permission on this connection.',
      );
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised, 'nothing was raised');
      assert.equal(raised.kind, 'PermissionDenied');
      assert.equal(raised.severity, 'High');
    });

    it('raises an Agent run overdue for a run that has stopped being fairly queued', async () => {
      // Prompt 40. Round-robin ordering and a per-company ceiling mean a busy company waits behind
      // other companies rather than ahead of them — correct, and completely invisible to the
      // person who asked for the work. Half an hour is past any legitimate round-robin wait, so at
      // that point the run is being starved rather than queued, and it becomes somebody's problem.
      const { runId } = await queuedRunAgedBy(45);
      const swept = await executor().sweep({ scope: scope() });

      assert.equal(swept.byKind['AgentRunOverdue'], 1, JSON.stringify(swept.byKind));

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised, 'nothing was raised');
      assert.equal(raised.kind, 'AgentRunOverdue');
      // Medium, not High: the work is queued, not lost, and the usual cause is a ceiling set lower
      // than the company's appetite — a capacity conversation rather than an incident.
      assert.equal(raised.severity, 'Medium');
      assert.match(raised.detail, /queued for 4[45] minutes/);
      // The deferral reason carries through, because it is the actual answer to "why".
      assert.match(raised.detail, /maximum number of agent runs/i);
    });

    it('raises nothing for a run that is merely waiting its turn', async () => {
      // The threshold is what makes the exception above worth having. An exception for ordinary
      // queueing would train everybody to ignore the list, which is the failure mode every alert
      // and exception in this product is designed against.
      await queuedRunAgedBy(5);
      const swept = await executor().sweep({ scope: scope() });

      assert.equal(swept.byKind['AgentRunOverdue'], undefined, JSON.stringify(swept.byKind));
    });

    it('maps a provider block to Provider / tool unavailable, the one kind that self-clears', async () => {
      const { runId } = await blockedRun('BlockedByProvider', 'The provider is unavailable.');
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised, 'nothing was raised');
      assert.equal(raised.kind, 'ProviderOrToolUnavailable');
      // Medium however dramatic an outage sounds, precisely because it clears itself.
      assert.equal(raised.severity, 'Medium');
    });

    it('raises Needs Human Input for a run waiting on a person', async () => {
      const { runId } = await blockedRun('WaitingForHumanInput', 'Somebody has to confirm this.');
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.equal(raised?.kind, 'NeedsHumanInput');
      assert.equal(raised?.severity, 'Low');
    });

    it('raises one exception per condition however often it sweeps', async () => {
      // Without this an overdue condition would raise a fresh exception every pass, and the
      // Exception Center would fill with copies of the thing nobody has fixed.
      await deadLetteredRun();
      const first = await executor().sweep({ scope: scope() });
      const second = await executor().sweep({ scope: scope() });
      const third = await executor().sweep({ scope: scope() });

      assert.equal(first.raised, 1);
      assert.equal(second.raised, 0);
      assert.equal(third.raised, 0);

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      assert.equal(listed.exceptions.length, 1);
    });

    it('lets the same condition raise again once the first is closed', async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const first = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(first);

      await executor().act({
        scope: scope(),
        exceptionId: first.id,
        action: 'Resolve',
        actorUserId: skillAdminId,
        note: 'Reran it by hand and it worked.',
      });

      // A recurrence after a resolution is a genuinely new event.
      const again = await executor().sweep({ scope: scope() });
      assert.equal(again.raised, 1);
    });

    it('records the evidence a resolver needs, not a stack trace', async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      const evidence = raised?.evidence as Record<string, unknown> | null;
      assert.ok(evidence);
      assert.equal(evidence['attempts'], 3);
      assert.ok(String(evidence['correlationId']).length > 0, 'no correlation id to trace with');
    });

    it('attributes the raise to the Executor in the resolution history', async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.equal(raised?.history.length, 1);
      assert.equal(raised?.history[0]?.byExecutor, true);
      assert.equal(raised?.history[0]?.actorUserId, null);
    });
  });

  // -------------------------------------------------------------------------
  // 2. THE LOCKED RULE
  // -------------------------------------------------------------------------

  describe('the Executor never decides', () => {
    it('refuses to resolve an exception itself', async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Resolve',
            // Null means the Executor is acting, not a person.
            actorUserId: null,
            note: 'I have decided this is fine.',
          }),
        /judgement|oversight/,
      );
    });

    it('refuses to dismiss an exception itself', async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Dismiss',
            actorUserId: null,
            note: 'Not important.',
          }),
        /judgement|oversight/,
      );
    });

    it('refuses even to retry work a control has refused', async () => {
      const { runId } = await blockedRun('BlockedByPermission', 'The agent lacks a permission.');
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Retry',
            actorUserId: null,
            note: 'Trying again.',
          }),
        /refused/,
      );
    });

    it('does let the Executor escalate, which is what it is for', async () => {
      const { runId } = await blockedRun('WaitingForHumanInput', 'Waiting on somebody.');
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      const escalated = await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Escalate',
        actorUserId: null,
        toUserId: managerUserId,
        note: 'Nobody has picked this up.',
      });

      assert.equal(escalated.state, 'Escalated');
      assert.equal(escalated.escalatedToUserId, managerUserId);
      assert.equal(escalated.history.at(-1)?.byExecutor, true);
    });

    it('cannot be closed by the Executor even directly in the database', async () => {
      // The third of three layers. A future caller that bypassed the service still could not do
      // this, which is the point of putting the rule in the schema too.
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.executorExceptionEvent.create({
              data: {
                tenantId,
                exceptionId: raised.id,
                action: 'Resolve',
                state: 'Resolved',
                byExecutor: true,
                note: 'Closing this myself.',
              },
            }),
          ),
        /executor_never_closes_an_exception|violates check/,
      );
    });

    it('records whether a person or the Executor did each thing', async () => {
      // "Nobody" and "the machine" are different answers and a report must never conflate them.
      const { runId } = await blockedRun('WaitingForHumanInput', 'Waiting.');
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Acknowledge',
        actorUserId: managerUserId,
        note: 'Looking at it.',
      });

      const after = await executor().view({
        scope: scope(),
        actorUserId: managerUserId,
        exceptionId: raised.id,
      });
      assert.equal(after.history[0]?.byExecutor, true, 'the raise was not the Executor');
      assert.equal(after.history[1]?.byExecutor, false, 'the acknowledgement was not a person');
      assert.equal(after.history[1]?.actorUserId, managerUserId);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Validation order
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('stops at a failed deterministic check without calling a model', async () => {
      const outcome = await executor().validate({
        scope: scope(),
        subject: 'A checklist with no evidence attached.',
        deterministic: { passed: false, detail: 'No evidence was filed.' },
        useAiEvaluator: true,
        humanApprovalRequired: false,
        humanApprovalGiven: false,
      });

      assert.equal(outcome.verdict, 'Failed');
      assert.equal(outcome.stages.length, 1, 'the AI evaluator ran anyway');
      assert.match(outcome.summary, /not consulted/);
    });

    it('records that the evaluator was a mock', async () => {
      const outcome = await executor().validate({
        scope: scope(),
        subject: 'A drafted checklist.',
        deterministic: { passed: true, detail: 'Every rule held.' },
        useAiEvaluator: true,
        humanApprovalRequired: false,
        humanApprovalGiven: false,
      });

      const ai = outcome.stages.find((stage) => stage.stage === 'AiEvaluator');
      assert.ok(ai, 'the AI stage did not run');
      assert.equal(ai.producedByRealModel, false, 'a mock evaluator claimed a real provider');
    });

    it('defers a high-risk action rather than passing it', async () => {
      // The locked rule inside the pipeline.
      const outcome = await executor().validate({
        scope: scope(),
        subject: 'A payment instruction.',
        deterministic: { passed: true, detail: 'Every rule held.' },
        useAiEvaluator: true,
        humanApprovalRequired: true,
        humanApprovalGiven: false,
      });

      assert.equal(outcome.verdict, 'Deferred');
      assert.equal(outcome.exceptionKind, 'ApprovalPending');
    });

    it('passes it once a person has approved', async () => {
      const outcome = await executor().validate({
        scope: scope(),
        subject: 'A payment instruction.',
        deterministic: { passed: true, detail: 'Every rule held.' },
        useAiEvaluator: false,
        humanApprovalRequired: true,
        humanApprovalGiven: true,
      });
      assert.equal(outcome.verdict, 'Passed');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Escalation and self-healing
  // -------------------------------------------------------------------------

  describe('escalation', () => {
    it('escalates an exception that has aged past its window', async () => {
      const { runId } = await blockedRun('WaitingForHumanInput', 'Waiting on somebody.');
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);

      // Give it an owner so escalating has a destination, and backdate it past the window.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.executorException.update({
          where: { id: raised.id },
          data: {
            ownerUserId: workerUserId,
            openedAt: new Date(Date.now() - 100 * 3_600_000),
          },
        }),
      );

      const swept = await executor().sweep({ scope: scope() });
      assert.ok(swept.escalated >= 1, JSON.stringify(swept));

      const after = await executor().view({
        scope: scope(),
        actorUserId: managerUserId,
        exceptionId: raised.id,
      });
      assert.equal(after.state, 'Escalated');
      assert.equal(after.escalatedToUserId, workerUserId);
    });

    it('does not escalate into the void when nobody owns it', async () => {
      // An escalation with no destination is not a route. It stays open and overdue, which the
      // queue shows.
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);
      assert.equal(raised.ownerUserId, null);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.executorException.update({
          where: { id: raised.id },
          data: { openedAt: new Date(Date.now() - 100 * 3_600_000) },
        }),
      );

      const swept = await executor().sweep({ scope: scope() });
      assert.equal(swept.escalated, 0);

      const after = await executor().view({
        scope: scope(),
        actorUserId: managerUserId,
        exceptionId: raised.id,
      });
      assert.equal(after.state, 'Open');
      // But it reports itself overdue, so it is not invisible.
      assert.equal(after.escalation.due, true);
    });

    it('acknowledges a provider outage that has passed, but does not close it', async () => {
      // A provider returning is not the same as the work getting done, so closing it is still a
      // person's call.
      const { runId } = await blockedRun('BlockedByProvider', 'The provider is unavailable.');
      await executor().sweep({ scope: scope() });

      // The run recovers.
      await engine().resume({ scope: scope(), runId, note: 'The provider came back.' });

      const swept = await executor().sweep({ scope: scope() });
      assert.equal(swept.cleared, 1);

      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.equal(raised?.state, 'Acknowledged');
      assert.notEqual(raised?.state, 'Resolved');
      assert.match(String(raised?.history.at(-1)?.note), /not the same as the work getting done/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Resolution by a person
  // -------------------------------------------------------------------------

  describe('resolution', () => {
    const anException = async () => {
      const { runId } = await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions.find((entry) => entry.sourceId === runId);
      assert.ok(raised);
      return raised;
    };

    it('lets a person resolve it, with a reason on the record', async () => {
      const raised = await anException();
      const resolved = await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Resolve',
        actorUserId: skillAdminId,
        note: 'The upstream file was fixed and the work reran.',
      });

      assert.equal(resolved.state, 'Resolved');
      assert.notEqual(resolved.closedAt, null);
      assert.equal(resolved.closeReason, 'The upstream file was fixed and the work reran.');
      assert.deepEqual(resolved.availableActions, []);
    });

    it('refuses to reopen a closed exception', async () => {
      const raised = await anException();
      await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Resolve',
        actorUserId: skillAdminId,
        note: 'Done.',
      });

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Acknowledge',
            actorUserId: managerUserId,
            note: 'Actually, hold on.',
          }),
        /rewrite a resolution/,
      );
    });

    it('reassigns to somebody else, and needs to know who', async () => {
      const raised = await anException();

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Reassign',
            actorUserId: managerUserId,
            note: 'Somebody else should do this.',
          }),
        /needs somebody to hand this to/,
      );

      const reassigned = await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Reassign',
        actorUserId: managerUserId,
        toUserId: workerUserId,
        note: 'This is yours.',
      });
      assert.equal(reassigned.ownerUserId, workerUserId);
    });

    it('does not treat a retry as progress', async () => {
      // Otherwise an exception would look handled because somebody pressed retry.
      const raised = await anException();
      const retried = await executor().act({
        scope: scope(),
        exceptionId: raised.id,
        action: 'Retry',
        actorUserId: managerUserId,
        note: 'Trying again.',
      });

      assert.notEqual(retried.state, 'Resolved');
      assert.equal(retried.closedAt, null);
    });

    it('cannot have its resolution history rewritten', async () => {
      const raised = await anException();
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.executorExceptionEvent.updateMany({
              where: { exceptionId: raised.id },
              data: { note: 'rewritten' },
            }),
          ),
        /append-only/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. The Exception Center over HTTP
  // -------------------------------------------------------------------------

  describe('the Exception Center', () => {
    it('publishes the boundary rather than merely respecting it', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/executor/meta`),
        managerUboss,
      ).expect(200);

      assert.equal(response.body.kinds.length, EXCEPTION_KINDS.length);
      for (const entry of response.body.kinds) {
        assert.ok(String(entry.defaultOwner).trim() !== '', `${entry.kind} has no default owner`);
      }
      assert.deepEqual(
        response.body.validationOrder.map((entry: { stage: string }) => entry.stage),
        ['Deterministic', 'AiEvaluator', 'HumanApproval'],
      );

      // A screen can show which actions the Executor may take alone.
      const byAction = new Map<string, boolean>(
        response.body.actions.map((entry: { action: string; executorMayTakeItAlone: boolean }) => [
          entry.action,
          entry.executorMayTakeItAlone,
        ]),
      );
      assert.equal(byAction.get('Escalate'), true);
      assert.equal(byAction.get('Resolve'), false);
      assert.equal(byAction.get('Dismiss'), false);
    });

    it('filters by kind, severity and agent', async () => {
      await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const byKind = await as(
        agent().get(`/tenants/${tenantId}/executor/exceptions?kind=RepeatedFailure`),
        managerUboss,
      ).expect(200);
      assert.equal(byKind.body.exceptions.length, 1);

      const wrongKind = await as(
        agent().get(`/tenants/${tenantId}/executor/exceptions?kind=MissingEvidence`),
        managerUboss,
      ).expect(200);
      assert.equal(wrongKind.body.exceptions.length, 0);
    });

    it('acts over HTTP as the authenticated person, never as the Executor', async () => {
      // There is deliberately no way to act as the Executor through a route.
      await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions[0];
      assert.ok(raised);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/executor/exceptions/${raised.id}/act`)
          .send({ action: 'Acknowledge', note: 'Mine now.' }),
        managerUboss,
      ).expect(201);

      assert.equal(response.body.state, 'Acknowledged');
      assert.equal(response.body.history.at(-1).byExecutor, false);
      assert.equal(response.body.history.at(-1).actorUserId, managerUserId);
    });

    it('needs Administer to close, not merely Comment', async () => {
      // Closing an exception is deciding it is dealt with, which is a stronger act than
      // annotating one.
      await deadLetteredRun();
      await executor().sweep({ scope: scope() });
      const listed = await executor().list({ scope: scope(), actorUserId: managerUserId });
      const raised = listed.exceptions[0];
      assert.ok(raised);

      await assert.rejects(
        () =>
          executor().act({
            scope: scope(),
            exceptionId: raised.id,
            action: 'Resolve',
            actorUserId: managerUserId,
            note: 'Closing it.',
          }),
        /Administer|not permitted|forbidden/i,
      );
    });

    it('refuses an unauthenticated request', async () => {
      await agent()
        .get(`/tenants/${tenantId}/executor/exceptions`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('never lets another company read an exception', async () => {
      await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const across = await as(
        agent().get(`/tenants/${tenantId}/executor/exceptions`),
        outsiderUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.exceptions, undefined);
    });

    it('stores no exception outside its own tenant', async () => {
      await deadLetteredRun();
      await executor().sweep({ scope: scope() });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.executorException.findMany({ select: { tenantId: true } }),
      );
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.tenantId === tenantId));
    });
  });
});
