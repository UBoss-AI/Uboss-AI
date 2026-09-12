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
      controllers: [ObjectiveController, AgentBuilderController],
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

  describe('Test Agent', () => {
    it('refuses to test an agent whose setup is unfinished', async () => {
      // A test against incomplete setup is not testing what would actually run.
      const { assignmentId } = await assignedAiWork();
      await assert.rejects(
        () => builder().test({ scope: scope(), actorUserId: workerUserId, assignmentId }),
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
      });

      assert.notEqual(tested.lastTest.at, null);
      assert.equal(tested.lastTest.passed, true);
      assert.equal(tested.lastTest.wasReal, false, 'a mock run claimed a real provider');
      assert.ok(String(tested.lastTest.summary).trim() !== '');
    });

    it('audits the test, saying in the event whether the model was real', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().test({ scope: scope(), actorUserId: workerUserId, assignmentId });

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
  });

  // -------------------------------------------------------------------------
  // 3. Activate
  // -------------------------------------------------------------------------

  describe('Activate Agent', () => {
    it('creates the reusable Engine Agent with one published version', async () => {
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);

      const activated = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
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
        actorUserId: workerUserId,
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
      // The locked lifecycle rule: recurring work creates Runs on the agent it already has.
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

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
      const activated = await builder().activate({
        scope: scope(),
        actorUserId: workerUserId,
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
      const { assignmentId } = await assignedAiWork();
      await answerEverything(assignmentId);
      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

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
      await builder().activate({ scope: scope(), actorUserId: workerUserId, assignmentId });

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

    it('lets the employee who owns the work complete setup and activate it', async () => {
      // The documented journey: "Employee completes Human work and only missing Agent setup ->
      // Test -> Activate." Over HTTP, because that is the path the screen actually uses.
      const { assignmentId } = await assignedAiWork();
      const view = await answerEverything(assignmentId);
      assert.deepEqual(view.missing, []);

      await as(
        agent().post(`/tenants/${tenantId}/agent-builder/${assignmentId}/test`).send({}),
        workerUboss,
      ).expect(201);

      const activated = await as(
        agent().post(`/tenants/${tenantId}/agent-builder/${assignmentId}/activate`).send({}),
        workerUboss,
      ).expect(201);
      assert.equal(activated.body.engineAgent.status, 'Active');
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
});
