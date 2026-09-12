import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_STAGES,
  nodeShapeFor,
  validateWorkflowDraft,
  type Form2Objective,
  type Form2WorkflowStep,
  type SkillContent,
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
import {
  MockModelGateway,
  ModelGateway,
  type ModelRequest,
  type ModelResponse,
} from '../src/model-gateway/model-gateway.js';
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
 * A gateway a test can steer.
 *
 * `producedByRealModel` is settable **only** so the "nothing claims a real model falsely"
 * constraint and the reporting around it can be exercised. It defaults to false, which is what
 * every shipping adapter returns, and no test leaves it true.
 */
class SteerableModelGateway extends ModelGateway {
  readonly capability = 'mock-reasoning-v1';
  usesRealModel = false;
  pretendReal = false;
  /** Set to make the next call throw, so the failure path is testable without a network. */
  failNextWith: string | null = null;
  /** Runs before each call — the seam a cancellation test uses to cancel mid-flight. */
  onCall: ((purpose: string) => Promise<void>) | null = null;
  calls: string[] = [];

  private readonly inner = new MockModelGateway();

  async complete(modelRequest: ModelRequest): Promise<ModelResponse> {
    this.calls.push(modelRequest.purpose);

    if (this.onCall) {
      await this.onCall(modelRequest.purpose);
    }
    if (this.failNextWith !== null) {
      const message = this.failNextWith;
      this.failNextWith = null;
      throw new Error(message);
    }

    const response = await this.inner.complete(modelRequest);
    return { ...response, producedByRealModel: this.pretendReal };
  }
}

/**
 * Prompt 21 — objective AI analysis and the right-side progress experience.
 *
 * Four properties carry this prompt:
 *
 *   1. **The output is always a Draft.** Analysis moves the version to pre-approval states only,
 *      and nothing it produces is assignable or live.
 *   2. **Every model call goes through the Model Gateway**, provider names never leave it, and
 *      `producedByRealModel` travels with the result so mock output cannot read as judgement.
 *   3. **The draft satisfies its own versioned schema** or it is not stored, and a draft from an
 *      unreadable version is refused rather than guessed at.
 *   4. **Progress is durable and cancellation is real** — the run is rows, and a cancellation
 *      from elsewhere stops the pipeline at the next stage boundary.
 */
describe('objective AI analysis (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let gateway: SteerableModelGateway;

  let tenantId: string;
  let departmentId: string;
  let ownerUserId: string;
  let ownerUboss: string;
  let workerId: string;
  /// Skills have their own separation: only CompanyAdmin may author, only Approver may approve.
  let skillAdminId: string;
  let skillApproverId: string;
  let platformOwnerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const objectives = () => app.get(ObjectiveService);
  const analysis = () => app.get(ObjectiveAnalysisService);
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

    gateway = new SteerableModelGateway();

    const moduleRef = await Test.createTestingModule({
      controllers: [ObjectiveController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        { provide: ModelGateway, useValue: gateway },
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
        SkillService,
        SkillRouterService,
        ObjectiveService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        NotificationService,
        NotificationRepository,
        OutboxRepository,
        TenantContextService,
        Reflector,
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
    gateway.calls = [];
    gateway.pretendReal = false;
    gateway.usesRealModel = false;
    gateway.failNextWith = null;
    gateway.onCall = null;

    const provisioned = await ctx.provisioning.provision({
      slug: 'ana-co',
      name: 'Analysis Co',
      firstMember: { email: 'first@ana.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@ana.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        // The grid names this person by display name, which is how owners are matched.
        owner: await member('UB-ANOW-0001', 'Priya Nair'),
        worker: await member('UB-ANWK-0001', 'Pranav Kulkarni'),
        skillAdmin: await member('UB-ANSA-0001', 'Skill Admin'),
        skillApprover: await member('UB-ANSP-0001', 'Skill Approver'),
        platform: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-ANPL-0001',
          email: 'owner@ana-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    ownerUserId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    workerId = people.worker.id;
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

      // The worker reports to the owner, so `reportingSubtreeUserIds` finds them and the
      // owner-assignment stage has somebody to match.
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
      await employ(workerId, ownerUserId);

      for (const userId of [ownerUserId, workerId]) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind: 'Head',
            scopeKind: 'Department',
            departmentIds: [departmentId],
            grantedByUserId: platformOwnerId,
          },
        });
      }

      // Skills keep their own separation of duties: `settings:Administer` authors and only
      // `settings:Approve` approves. Neither lives on `Head`, so the Skill fixture needs its
      // own two actors rather than reusing the objective owner.
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
    objectiveOwnerUserId: ownerUserId,
    expectedFinalResult: 'A complete Annex I checklist at zero critical gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Priya Nair',
    formDate: '2026-09-10',
    responsibleOwnerUserId: ownerUserId,
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

  /** A human step, a machine step and an approval gate — enough to exercise every node kind. */
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
      whoPersonName: 'Priya Nair',
      whatExactWork: 'Head review and sign-off',
      approval: 'Head',
      outputWhatIsProduced: 'Approved checklist',
    }),
  ];

  const draftObjective = async (steps: Form2WorkflowStep[] = mixedSteps()) =>
    objectives().create({
      scope: scope(),
      actorUserId: ownerUserId,
      content: form2(),
      steps,
    });

  /** A published Skill the router can match to the machine step. */
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
        // Approving is the Approver's act; the rest is the admin's.
        actorUserId: to === 'Approved' ? skillApproverId : skillAdminId,
        versionId,
        to,
        ...(to === 'Published' ? {} : { reason: 'Fixture.' }),
      });
    }
    return created;
  };

  // -------------------------------------------------------------------------
  // 1. The pipeline and its output
  // -------------------------------------------------------------------------

  describe('the pipeline', () => {
    it('runs all seven stages and completes', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      // The reason is in the message: a status assertion that hides why it failed costs a
      // whole debugging cycle.
      assert.equal(run.status, 'Completed', run.failureReason ?? 'no failure reason recorded');
      assert.equal(run.stagesCompleted, ANALYSIS_STAGES.length);
      assert.equal(run.stage, 'BuildingWorkflow');
      assert.equal(run.stages.length, 7);
      assert.ok(run.stages.every((entry) => entry.state === 'done'));
    });

    it('calls the Model Gateway once per stage', async () => {
      // Not decorative: the seam is on the path of every stage, so a real provider changes the
      // analysis everywhere at once rather than in whichever stage somebody remembered to wire.
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(gateway.calls.length, ANALYSIS_STAGES.length);
    });

    it('produces a draft that satisfies its own schema', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      assert.ok(run.draft);
      assert.equal(run.draft.schemaVersion, ANALYSIS_SCHEMA_VERSION);
      assert.deepEqual(validateWorkflowDraft(run.draft), []);
    });

    it('draws a Human node as a rectangle and an AI node as a diamond', async () => {
      // The client's locked rule, on the produced data rather than in a component's CSS.
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      for (const node of run.draft.nodes) {
        assert.equal(node.shape, nodeShapeFor(node.kind), `${node.kind} has the wrong shape`);
      }

      const human = run.draft.nodes.find((node) => node.kind === 'Human');
      const ai = run.draft.nodes.find((node) => node.kind === 'Ai');
      assert.equal(human?.shape, 'rectangle');
      assert.equal(ai?.shape, 'diamond');
    });

    it('produces exactly one Goal, visually distinct', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const goals = run.draft.nodes.filter((node) => node.kind === 'Goal');
      assert.equal(goals.length, 1);
      assert.equal(run.draft.goalNodeId, goals[0]?.id);
      assert.equal(goals[0]?.shape, 'goal');
    });

    it('derives every node from a Form 2 row, and says which', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      // The Goal is the only node with no source row: it is what the plan is for, not a step.
      for (const node of run.draft.nodes) {
        if (node.kind === 'Goal') {
          assert.equal(node.fromStepPosition, null);
        } else {
          assert.ok(
            node.fromStepPosition !== null,
            `${node.id} should name the grid row it came from`,
          );
        }
      }
    });

    it('gives every node the client-s seven-part Definition of Done', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      for (const node of run.draft.nodes) {
        // Schema version 2: the structure is always present. Its parts may be blank where the
        // grid did not say — the Pre-Publish Summary counts those rather than the analysis
        // inventing content.
        assert.ok(node.dod, `${node.id} has no Definition of Done`);
        assert.ok(Array.isArray(node.dod.dependencies), `${node.id} has no dependency list`);
        assert.ok(Array.isArray(node.dod.tools), `${node.id} has no tool list`);
        assert.equal(typeof node.dod.expectedOutput, 'string');
        assert.equal(typeof node.dod.criteria, 'string');
        assert.equal(typeof node.dod.evidence, 'string');
        assert.equal(typeof node.dod.failureCondition, 'string');
      }
    });

    it('makes an approval gate for a step that needs approval', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const gate = run.draft.nodes.find((node) => node.kind === 'Approval');
      assert.ok(gate, 'the Head-approval step should produce a gate');
      assert.equal(gate.approvalKind, 'Head');
      assert.equal(gate.fromStepPosition, 3);
    });

    it('builds edges from the grid order, starting at the Goal', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const first = run.draft.edges[0];
      assert.equal(first?.fromNodeId, 'goal');
      assert.equal(first?.toNodeId, 'step-1');
    });

    it('estimates AI usage as a range that says what it came from', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      assert.ok(run.draft.usage.maxTokens >= run.draft.usage.minTokens);
      assert.equal(run.draft.usage.aiNodeCount, 1);
      assert.ok(run.draft.usage.basis.length > 0);
      // Ran against a mock, and the basis says so rather than reading as a quote.
      assert.match(run.draft.usage.basis, /mock model/i);
    });

    it('assigns a human owner by the name the grid holds', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const collected = run.draft.nodes.find((node) => node.fromStepPosition === 1);
      assert.equal(collected?.ownerUserId, workerId);
    });

    it('records a gap rather than guessing when the named person is unknown', async () => {
      const objective = await draftObjective([
        step({ position: 1, whoPersonName: 'Somebody Not Employed Here' }),
      ]);
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const node = run.draft.nodes.find((candidate) => candidate.fromStepPosition === 1);
      assert.equal(node?.ownerUserId, null);
      assert.ok(
        run.draft.gaps.some((gap) => gap.includes('Somebody Not Employed Here')),
        'the unmatched name should be recorded as a gap',
      );
    });

    it('records a gap when a step names nobody', async () => {
      const objective = await draftObjective([step({ position: 1, whoPersonName: null })]);
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft?.gaps.some((gap) => gap.includes('names nobody')));
    });
  });

  // -------------------------------------------------------------------------
  // 2. Skill matching
  // -------------------------------------------------------------------------

  describe('matching approved Skills', () => {
    it('records a gap and a high risk when no approved Skill matches', async () => {
      // The honest outcome, not a failure: a Skill has to be authored and approved first.
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const ai = run.draft.nodes.find((node) => node.kind === 'Ai');
      assert.equal(ai?.skillVersionId, null);
      assert.ok(run.draft.gaps.some((gap) => gap.includes('No approved Skill matches')));
      assert.ok(
        run.draft.risks.some(
          (risk) => risk.severity === 'High' && risk.summary.includes('no approved Skill'),
        ),
      );
    });

    it('attaches a published Skill version when one applies', async () => {
      await publishSkill();

      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.ok(run.draft);

      const ai = run.draft.nodes.find((node) => node.kind === 'Ai');
      assert.ok(ai?.skillVersionId, 'the AI node should carry a Skill version');
      assert.equal(ai.skillName, 'GSPR matrix drafter');
    });

    it('raises no Skill Candidate, because an analysis is exploratory', async () => {
      // Raising a governance item on every exploratory run would bury the ones a person filed.
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const candidates = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillCandidate.count({ where: { tenantId } }),
      );
      assert.equal(candidates, 0);
    });

    it('flags an Executor step as a checking step, never a doing step', async () => {
      const objective = await draftObjective([
        step({ position: 1 }),
        step({
          position: 2,
          whoEngine: 'Executor',
          whoPersonName: null,
          whatExactWork: 'Validate the checklist against the evidence',
        }),
      ]);
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      assert.ok(
        run.draft?.risks.some((risk) => risk.summary.includes('Executor step')),
        'an Executor step should carry the note that it monitors rather than does',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. The output is always a draft
  // -------------------------------------------------------------------------

  describe('the output is always a draft', () => {
    it('moves the version to WorkflowDraft, never to Active', async () => {
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const after = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(after.versions[0]?.status, 'WorkflowDraft');
      assert.equal(after.activeVersion, null);
    });

    it('leaves the analysed work unassignable', async () => {
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const after = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(after.versions[0]?.workAssignable, false);
    });

    it('never approves anything', async () => {
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const after = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(after.versions[0]?.approvedAt, null);
    });

    it('has no column that could record an approval on a run', async () => {
      // Enforced by absence: approval belongs to the objective version, not to an analysis.
      const columns = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.$queryRawUnsafe<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'objective_analysis_runs'
               AND column_name ~ 'approv|publish'`,
        ),
      );
      assert.deepEqual(columns, []);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The Model Gateway
  // -------------------------------------------------------------------------

  describe('the Model Gateway', () => {
    it('records that no real model produced the draft', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      assert.equal(run.producedByRealModel, false);
      assert.equal(run.modelCapability, 'mock-reasoning-v1');
      assert.ok(run.promptTokens > 0);
    });

    it('reports an opaque capability and never a provider name', async () => {
      const objective = await draftObjective();
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/analysis/meta`),
        ownerUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.model.usesRealModel, false);
      assert.equal(response.body.model.capability, 'mock-reasoning-v1');
      void objective;
    });

    it('says in the audit trail that no real model was used', async () => {
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'objective.analysis_completed' },
        }),
      );
      assert.ok(event);
      assert.equal((event.metadata as Record<string, unknown>)['producedByRealModel'], false);
      assert.match(event.summary ?? '', /It is a draft/i);
    });

    it('serves the node shapes so a renderer cannot disagree with the locked rule', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/analysis/meta`),
        ownerUboss,
      );
      assert.equal(response.body.nodeShapes.Human, 'rectangle');
      assert.equal(response.body.nodeShapes.Ai, 'diamond');
      assert.match(response.body.note as string, /always a \*\*draft\*\*/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Failure and cancellation
  // -------------------------------------------------------------------------

  describe('failure and cancellation', () => {
    it('records a failure in words a person can act on', async () => {
      gateway.failNextWith = 'The model gateway is unreachable.';
      const objective = await draftObjective();

      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      assert.equal(run.status, 'Failed');
      assert.equal(run.failureReason, 'The model gateway is unreachable.');
      assert.equal(run.draft, null);
    });

    it('stops at the next stage boundary when cancelled mid-flight', async () => {
      const objective = await draftObjective();
      let runIdSeen: string | null = null;

      // Cancel from "elsewhere" the moment the third stage's model call happens. The pipeline
      // checks its own status between stages, so it should stop rather than finish.
      gateway.onCall = async (purpose) => {
        if (purpose === 'objective.analysis.human-work' && runIdSeen === null) {
          const latest = await analysis().latestFor({
            scope: scope(),
            actorUserId: ownerUserId,
            objectiveId: objective.id,
          });
          runIdSeen = latest?.id ?? null;
          if (runIdSeen !== null) {
            await analysis().cancel({
              scope: scope(),
              actorUserId: ownerUserId,
              runId: runIdSeen,
            });
          }
        }
      };

      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      assert.equal(run.status, 'Cancelled');
      assert.equal(run.draft, null);
      assert.equal(run.cancelledByUserId, ownerUserId);
      // It stopped part-way rather than running to the end.
      assert.ok(run.stagesCompleted < ANALYSIS_STAGES.length);
    });

    it('refuses to cancel a finished run', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      await assert.rejects(
        analysis().cancel({ scope: scope(), actorUserId: ownerUserId, runId: run.id }),
        /can no longer be cancelled/,
      );
    });

    it('refuses a second analysis of the same version while one is running', async () => {
      // Two would race to write the draft and the screen would show whichever answered last.
      const objective = await draftObjective();
      gateway.onCall = async (purpose) => {
        if (purpose !== 'objective.analysis.understand') return;
        await assert.rejects(
          analysis().start({
            scope: scope(),
            actorUserId: ownerUserId,
            objectiveId: objective.id,
          }),
          /already running/,
        );
      };

      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(run.status, 'Completed');
    });

    it('allows a fresh analysis once the previous one has finished', async () => {
      const objective = await draftObjective();
      await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const second = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(second.status, 'Completed');
    });

    it('refuses to analyse a version with no workflow steps', async () => {
      const objective = await objectives().create({
        scope: scope(),
        actorUserId: ownerUserId,
        content: form2(),
        steps: [],
      });

      await assert.rejects(
        analysis().start({
          scope: scope(),
          actorUserId: ownerUserId,
          objectiveId: objective.id,
        }),
        /no workflow steps/,
      );
    });

    it('refuses to change a finished run in the database', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveAnalysisRun.update({
            where: { id: run.id },
            data: { producedByRealModel: true },
          }),
        ),
        /cannot be changed/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Durable progress and schema versioning
  // -------------------------------------------------------------------------

  describe('durable progress', () => {
    it('reports the latest run for a reopened screen', async () => {
      const objective = await draftObjective();
      const started = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const latest = await analysis().latestFor({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(latest?.id, started.id);
      assert.equal(latest?.status, 'Completed');
    });

    it('reports no run for an objective that has never been analysed', async () => {
      const objective = await draftObjective();
      const latest = await analysis().latestFor({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(latest, null);
    });

    it('refuses a stored draft written with an unreadable schema version', async () => {
      // The whole point of stamping a version: a later reader refuses knowingly rather than
      // mis-interpreting a shape it does not understand.
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      // Written directly, because the service would never produce one — and the freeze trigger
      // refuses an update, so this is a fresh row standing in for a draft from a future build.
      const futureRunId = await ctx.prisma.runAsPlatformOperation(async () => {
        const created = await ctx.prisma.client.objectiveAnalysisRun.create({
          data: {
            tenantId,
            objectiveId: objective.id,
            objectiveVersionId: run.objectiveVersionId,
            status: 'Completed',
            stage: 'BuildingWorkflow',
            stagesCompleted: 7,
            startedAt: new Date(),
            completedAt: new Date(),
            schemaVersion: 99,
            draft: { schemaVersion: 99, somethingNew: true },
          },
        });
        return created.id;
      });

      const view = await analysis().view({
        scope: scope(),
        actorUserId: ownerUserId,
        runId: futureRunId,
      });

      assert.equal(view.draft, null);
      assert.equal(view.schemaVersion, 99);
      assert.match(view.unreadableReason ?? '', /does not read/);
    });

    it('serves a run through the route', async () => {
      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/analysis/${run.id}`),
        ownerUboss,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'Completed');
      assert.equal(response.body.producedByRealModel, false);
      assert.equal(response.body.stages.length, 7);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Authorization and isolation
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses analysis to somebody without objective:EditDraft', async () => {
      const stranger = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-ANST-0001',
          email: 'stranger@ana.example',
          displayName: 'Auditor Only',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: user.id,
            roleKind: 'Auditor',
            scopeKind: 'WholeCompany',
            grantedByUserId: platformOwnerId,
          },
        });
        return user;
      });

      const objective = await draftObjective();
      const response = await as(
        agent().post(`/tenants/${tenantId}/objectives/${objective.id}/analysis`).send({}),
        stranger.ubossUniqueId,
      );
      assert.equal(response.status, 403);
    });

    it('refuses to read another company’s run', async () => {
      const other = await ctx.provisioning.provision({
        slug: 'other-ana-co',
        name: 'Other Analysis Co',
        firstMember: { email: 'first@other-ana.example', displayName: 'Other First' },
      });
      await activateTenant(ctx, other.tenant.id);
      await activateMembership(ctx, other.user.id, other.tenant.id);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId: other.tenant.id,
            userId: other.user.id,
            roleKind: 'CompanyAdmin',
            scopeKind: 'WholeCompany',
            grantedByUserId: platformOwnerId,
          },
        }),
      );

      const objective = await draftObjective();
      const run = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      await assert.rejects(
        analysis().view({
          scope: tenantScopeForPlatformOperation(other.tenant.id),
          actorUserId: other.user.id,
          runId: run.id,
        }),
        /no such analysis run/i,
      );
    });
  });
});
