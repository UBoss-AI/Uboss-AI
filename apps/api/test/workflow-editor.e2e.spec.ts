import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ANALYSIS_SCHEMA_VERSION,
  incompleteDodFields,
  nodeShapeFor,
  validateWorkflowDraft,
  WORKFLOW_EDGE_KINDS,
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
 * Prompt 22 — the manager-editable workflow and the Pre-Publish Summary.
 *
 * What this suite is really defending:
 *
 *   1. **The AI's proposal and the manager's plan are two separate records.** The client approved
 *      this explicitly: the completed analysis run stays immutable as the history of what the AI
 *      suggested, and the draft the manager edits lives beside it. A single mutable row would
 *      make "what did the AI actually propose?" unanswerable the moment anyone edited anything.
 *   2. **Concurrent edits are detected, never silently merged.** Two managers on one plan is an
 *      ordinary situation and last-write-wins is the wrong answer for a document that decides
 *      what people are told to do.
 *   3. **Conversion is restricted for a reason, not for tidiness.** Human → AI without an
 *      approved Skill would publish a step nothing can perform.
 *   4. **Nothing here publishes.** The Pre-Publish Summary is a readiness report. Approve &
 *      Assign is Prompt 23's transaction, and an assigned plan is frozen.
 *   5. **Hidden navigation is presentation only.** Every route is checked on the server, and no
 *      tenant can reach another's workflow.
 */
describe('workflow graph editor and pre-publish readiness (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let ownerUserId: string;
  let ownerUboss: string;
  let workerId: string;
  let workerUboss: string;
  /// A CompanyAdmin: objective View/Comment/Export, deliberately no EditDraft (Prompt 7).
  let viewerUboss: string;
  let skillAdminId: string;
  let skillApproverId: string;
  let platformOwnerId: string;
  /// A second company, to prove no workflow crosses a tenant boundary.
  let otherTenantId: string;
  let otherUboss: string;

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

    const moduleRef = await Test.createTestingModule({
      controllers: [ObjectiveController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        // The real mock gateway: it is what ships, and the analysis only has to complete here.
        { provide: ModelGateway, useClass: MockModelGateway },
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

    const provisioned = await ctx.provisioning.provision({
      slug: 'wf-co',
      name: 'Workflow Co',
      firstMember: { email: 'first@wf.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'wf-other',
      name: 'Other Co',
      firstMember: { email: 'first@other.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string, tenant = provisioned.tenant.id) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@wf.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: tenant, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        // The grid names this person by display name, which is how owners are matched.
        owner: await member('UB-WFOW-0001', 'Priya Nair'),
        worker: await member('UB-WFWK-0001', 'Pranav Kulkarni'),
        viewer: await member('UB-WFVW-0001', 'Company Admin'),
        skillAdmin: await member('UB-WFSA-0001', 'Skill Admin'),
        skillApprover: await member('UB-WFSP-0001', 'Skill Approver'),
        outsider: await member('UB-WFOT-0001', 'Outsider', other.tenant.id),
        platform: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-WFPL-0001',
          email: 'owner@wf-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    ownerUserId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    workerId = people.worker.id;
    workerUboss = people.worker.ubossUniqueId;
    viewerUboss = people.viewer.ubossUniqueId;
    skillAdminId = people.skillAdmin.id;
    skillApproverId = people.skillApprover.id;
    otherUboss = people.outsider.ubossUniqueId;
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

      // CompanyAdmin: objective View/Comment/Export and no EditDraft. That is the Prompt 7
      // decision, and it makes this actor the natural "can look, cannot edit" case.
      for (const [userId, roleKind] of [
        [people.viewer.id, 'CompanyAdmin'],
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

  /** A human step, a machine step and an approval gate — every node kind the analysis emits. */
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

  /** A published Skill, so the machine step has something approved behind it. */
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

  /** An objective with a completed analysis behind it: the state the editor opens onto. */
  const analysedObjective = async ({ withSkill = true } = {}) => {
    if (withSkill) await publishSkill();

    const objective = await objectives().create({
      scope: scope(),
      actorUserId: ownerUserId,
      content: form2(),
      steps: mixedSteps(),
    });

    const run = await analysis().start({
      scope: scope(),
      actorUserId: ownerUserId,
      objectiveId: objective.id,
    });
    assert.equal(run.status, 'Completed', run.failureReason ?? 'no failure reason recorded');

    return { objective, run };
  };

  interface DraftView {
    id: string;
    revision: number;
    graph: WorkflowDraft;
    schemaVersion: number;
    seededFromRunId: string | null;
    assignedAt: string | null;
    editable: boolean;
  }

  const open = async (objectiveId: string, uboss = ownerUboss): Promise<DraftView> => {
    const response = await as(
      agent().post(`/tenants/${tenantId}/objectives/${objectiveId}/workflow`).send({}),
      uboss,
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body as DraftView;
  };

  const humanNodeOf = (graph: WorkflowDraft) =>
    graph.nodes.find((node) => node.kind === 'Human') ?? assert.fail('no human node');
  const aiNodeOf = (graph: WorkflowDraft) =>
    graph.nodes.find((node) => node.kind === 'Ai') ?? assert.fail('no AI node');
  const goalOf = (graph: WorkflowDraft) =>
    graph.nodes.find((node) => node.kind === 'Goal') ?? assert.fail('no goal node');

  // -------------------------------------------------------------------------
  // 1. Opening the draft — the two-record decision
  // -------------------------------------------------------------------------

  describe('opening the editable draft', () => {
    it('seeds it from the completed analysis, at the current schema version', async () => {
      const { objective, run } = await analysedObjective();
      const draft = await open(objective.id);

      assert.equal(draft.schemaVersion, ANALYSIS_SCHEMA_VERSION);
      assert.equal(draft.seededFromRunId, run.id);
      assert.equal(draft.revision, 1);
      assert.equal(draft.editable, true);
      assert.equal(draft.assignedAt, null);
      assert.deepEqual(validateWorkflowDraft(draft.graph), []);
      assert.ok(draft.graph.nodes.length >= 3, 'the seeded plan has no steps');
    });

    it('refuses to open a version that has never been analysed', async () => {
      // Not a silent empty canvas: an empty editor would look like the analysis produced nothing.
      const objective = await objectives().create({
        scope: scope(),
        actorUserId: ownerUserId,
        content: form2(),
        steps: mixedSteps(),
      });

      const response = await as(
        agent().post(`/tenants/${tenantId}/objectives/${objective.id}/workflow`).send({}),
        ownerUboss,
      );
      assert.equal(response.status, 409);
      assert.match(String(response.body.message), /Analyze/i);
    });

    it('is idempotent: opening twice returns the same draft, not a second one', async () => {
      const { objective } = await analysedObjective();
      const first = await open(objective.id);
      const second = await open(objective.id);

      assert.equal(second.id, first.id);
      assert.equal(second.revision, first.revision);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.count({ where: { objectiveId: objective.id } }),
      );
      assert.equal(count, 1);
    });

    it('leaves the analysis run completely untouched', async () => {
      // The client's approved design decision, and the reason this table exists at all. The run
      // is the history of what the AI proposed; if editing the plan rewrote it, nobody could ever
      // answer "what did the AI actually suggest?" after the first edit.
      const { objective, run } = await analysedObjective();
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveAnalysisRun.findUniqueOrThrow({ where: { id: run.id } }),
      );

      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);
      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({ revision: draft.revision, label: 'Completely rewritten by the manager' }),
        ownerUboss,
      ).expect(200);

      const afterEdit = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveAnalysisRun.findUniqueOrThrow({ where: { id: run.id } }),
      );

      assert.deepEqual(afterEdit.draft, before.draft, 'the manager’s edit rewrote the AI proposal');
      assert.equal(afterEdit.status, before.status);
      assert.equal(afterEdit.version, before.version);
    });

    it('does not discard a manager’s edits when the objective is analysed again', async () => {
      // Re-analysing is a legitimate act. It must not silently throw away work.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({ revision: draft.revision, label: 'Manager wording' }),
        ownerUboss,
      ).expect(200);

      const second = await analysis().start({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(second.status, 'Completed', second.failureReason ?? '');

      const reopened = await open(objective.id);
      assert.equal(
        reopened.graph.nodes.find((candidate) => candidate.id === node.id)?.label,
        'Manager wording',
      );
    });

    it('serves an editor vocabulary the server itself validates against', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/workflow/meta`),
        ownerUboss,
      ).expect(200);

      assert.equal(response.body.schemaVersion, ANALYSIS_SCHEMA_VERSION);
      assert.deepEqual(
        response.body.edgeKinds.map((entry: { kind: string }) => entry.kind),
        [...WORKFLOW_EDGE_KINDS],
      );
      assert.equal(response.body.dodFields.length, 7);
      // The locked UI rule, served rather than assumed by the renderer.
      const shapes = new Map<string, string>(
        response.body.nodeKinds.map((entry: { kind: string; shape: string }) => [
          entry.kind,
          entry.shape,
        ]),
      );
      assert.equal(shapes.get('Human'), 'rectangle');
      assert.equal(shapes.get('Ai'), 'diamond');
      assert.notEqual(shapes.get('Goal'), shapes.get('Human'));
    });
  });

  // -------------------------------------------------------------------------
  // 2. Concurrency
  // -------------------------------------------------------------------------

  describe('concurrent edits', () => {
    it('refuses a stale revision and names both numbers', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);
      const url = `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`;

      await as(agent().put(url).send({ revision: 1, label: 'First manager' }), ownerUboss).expect(
        200,
      );

      // The second manager still holds revision 1.
      const stale = await as(
        agent().put(url).send({ revision: 1, label: 'Second manager' }),
        workerUboss,
      );
      assert.equal(stale.status, 409);
      assert.match(String(stale.body.message), /revision 1/);
      assert.match(String(stale.body.message), /2/);

      // And the first manager's wording survived.
      const after = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/workflow`),
        ownerUboss,
      ).expect(200);
      assert.equal(
        (after.body.graph as WorkflowDraft).nodes.find((candidate) => candidate.id === node.id)
          ?.label,
        'First manager',
      );
    });

    it('increments the revision on every successful edit', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);
      const url = `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`;

      let revision = draft.revision;
      for (const label of ['One', 'Two', 'Three']) {
        const response = await as(agent().put(url).send({ revision, label }), ownerUboss).expect(
          200,
        );
        assert.equal(response.body.revision, revision + 1);
        revision = response.body.revision;
      }
    });

    it('cannot have its revision rewound, even in the database', async () => {
      // The backstop behind the service check. A rewound revision would make a stale edit look
      // current, which is exactly the failure the token exists to prevent.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      await as(
        agent()
          .put(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${humanNodeOf(draft.graph).id}`,
          )
          .send({ revision: draft.revision, label: 'Edited' }),
        ownerUboss,
      ).expect(200);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.objectiveWorkflowDraft.update({
              where: { id: draft.id },
              data: { revision: 1 },
            }),
          ),
        /revision/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Editing a node
  // -------------------------------------------------------------------------

  describe('editing a node', () => {
    it('changes the title', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);

      const response = await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({ revision: draft.revision, label: 'Collect DHF and predicate evidence' }),
        ownerUboss,
      ).expect(200);

      assert.equal(
        (response.body.graph as WorkflowDraft).nodes.find((candidate) => candidate.id === node.id)
          ?.label,
        'Collect DHF and predicate evidence',
      );
    });

    it('refuses a blank title', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({ revision: draft.revision, label: '   ' }),
        ownerUboss,
      ).expect(400);
    });

    it('changes the assignee', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);

      const response = await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({ revision: draft.revision, ownerUserId: workerId }),
        ownerUboss,
      ).expect(200);

      assert.equal(
        (response.body.graph as WorkflowDraft).nodes.find((candidate) => candidate.id === node.id)
          ?.ownerUserId,
        workerId,
      );
    });

    it('patches one part of a Definition of Done and leaves the rest alone', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);
      const before = node.dod;

      const response = await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}`)
          .send({
            revision: draft.revision,
            dod: { criteria: 'Every Annex I requirement has a named evidence document.' },
          }),
        ownerUboss,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));

      const after = (response.body.graph as WorkflowDraft).nodes.find(
        (candidate) => candidate.id === node.id,
      );
      assert.equal(after?.dod.criteria, 'Every Annex I requirement has a named evidence document.');
      assert.equal(after?.dod.expectedOutput, before.expectedOutput);
      assert.equal(after?.dod.evidence, before.evidence);
      assert.equal(after?.dod.failureCondition, before.failureCondition);
      assert.equal(after?.dod.approval, before.approval);
      // The two that a naive spread silently emptied: a validated DTO carries every declared
      // field as an own property, set to undefined when the request omitted it.
      assert.deepEqual(after?.dod.dependencies, before.dependencies);
      assert.deepEqual(after?.dod.tools, before.tools);
    });

    it('answers 404 for a node that is not in the workflow', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/not-a-node`)
          .send({ revision: draft.revision, label: 'Nowhere' }),
        ownerUboss,
      ).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Human ↔ AI conversion
  // -------------------------------------------------------------------------

  describe('Human ↔ AI conversion', () => {
    it('converts AI work back to Human, and clears the Skill', async () => {
      // Leaving the Skill attached would suggest an agent is still involved in a human step.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = aiNodeOf(draft.graph);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}/convert`)
          .send({ revision: draft.revision, to: 'Human' }),
        ownerUboss,
      ).expect(201);

      const after = (response.body.graph as WorkflowDraft).nodes.find(
        (candidate) => candidate.id === node.id,
      );
      assert.equal(after?.kind, 'Human');
      assert.equal(after?.shape, nodeShapeFor('Human'));
      assert.equal(after?.skillVersionId, null);
      assert.equal(after?.skillName, null);
    });

    it('refuses Human → AI when no approved Skill stands behind the step', async () => {
      // The conversion would otherwise publish a step nothing can perform.
      const { objective } = await analysedObjective({ withSkill: false });
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}/convert`)
          .send({ revision: draft.revision, to: 'Ai' }),
        ownerUboss,
      );
      assert.equal(response.status, 400);
      assert.match(String(response.body.message), /Skill/);
    });

    it('refuses to convert the Goal', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      await as(
        agent()
          .post(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${goalOf(draft.graph).id}/convert`,
          )
          .send({ revision: draft.revision, to: 'Human' }),
        ownerUboss,
      ).expect(400);
    });

    it('keeps the shape and the kind in step, which is the locked UI rule', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = aiNodeOf(draft.graph);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}/convert`)
          .send({ revision: draft.revision, to: 'Human' }),
        ownerUboss,
      ).expect(201);

      for (const candidate of (response.body.graph as WorkflowDraft).nodes) {
        assert.equal(
          candidate.shape,
          nodeShapeFor(candidate.kind),
          `${candidate.id} is a ${candidate.kind} drawn as a ${candidate.shape}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 5. Adding and deleting nodes
  // -------------------------------------------------------------------------

  describe('adding and deleting nodes', () => {
    it('adds a node with a blank Definition of Done for the manager to fill', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes`)
          .send({ revision: draft.revision, kind: 'Human', label: 'Second review pass' }),
        ownerUboss,
      ).expect(201);

      const graph = response.body.graph as WorkflowDraft;
      const added = graph.nodes.find((node) => node.label === 'Second review pass');
      assert.ok(added, 'the node was not added');
      // Blank, not plausibly filled in. The Pre-Publish Summary must be able to say so.
      assert.ok(incompleteDodFields(added.dod).length > 0);
    });

    it('wires a sequential edge when asked to insert after a node', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const after = humanNodeOf(draft.graph);

      const response = await as(
        agent().post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes`).send({
          revision: draft.revision,
          kind: 'Human',
          label: 'Follow-up',
          afterNodeId: after.id,
        }),
        ownerUboss,
      ).expect(201);

      const graph = response.body.graph as WorkflowDraft;
      const added = graph.nodes.find((node) => node.label === 'Follow-up');
      assert.ok(
        graph.edges.some(
          (edge) =>
            edge.fromNodeId === after.id &&
            edge.toNodeId === added?.id &&
            edge.kind === 'Sequential',
        ),
        'no sequential edge was wired',
      );
    });

    it('refuses a second Goal', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes`)
          .send({ revision: draft.revision, kind: 'Goal', label: 'Another goal' }),
        ownerUboss,
      );
      assert.equal(response.status, 400);
      assert.match(String(response.body.message), /Goal/);
    });

    it('refuses to delete the Goal', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      await as(
        agent().delete(
          `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/` +
            `${goalOf(draft.graph).id}?revision=${draft.revision}`,
        ),
        ownerUboss,
      ).expect(400);
    });

    it('deletes a node and the edges that touched it', async () => {
      // Leaving an edge behind would name a node that no longer exists, and the whole-graph
      // validation would then refuse every later edit for a reason the manager never caused.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const node = humanNodeOf(draft.graph);
      assert.ok(
        draft.graph.edges.some((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id),
        'the fixture node has no edges, so this test would prove nothing',
      );

      const response = await as(
        agent().delete(
          `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${node.id}` +
            `?revision=${draft.revision}`,
        ),
        ownerUboss,
      ).expect(200);

      const graph = response.body.graph as WorkflowDraft;
      assert.equal(
        graph.nodes.find((candidate) => candidate.id === node.id),
        undefined,
      );
      assert.equal(
        graph.edges.filter((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id)
          .length,
        0,
      );
      assert.deepEqual(validateWorkflowDraft(graph), []);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Reordering, reconnecting and dependencies
  // -------------------------------------------------------------------------

  describe('reconnecting the graph', () => {
    it('replaces the edge list, including a failure branch and a parallel path', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const goal = goalOf(draft.graph);
      const human = humanNodeOf(draft.graph);
      const ai = aiNodeOf(draft.graph);

      const response = await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/edges`)
          .send({
            revision: draft.revision,
            edges: [
              { fromNodeId: goal.id, toNodeId: human.id, kind: 'Sequential' },
              { fromNodeId: human.id, toNodeId: ai.id, kind: 'Parallel' },
              { fromNodeId: ai.id, toNodeId: human.id, kind: 'Failure' },
            ],
          }),
        ownerUboss,
      ).expect(200);

      const graph = response.body.graph as WorkflowDraft;
      assert.equal(graph.edges.length, 3);
      assert.deepEqual(graph.edges.map((edge) => edge.kind).sort(), [
        'Failure',
        'Parallel',
        'Sequential',
      ]);
    });

    it('refuses an IF/ELSE edge that does not say which outcome it is', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const goal = goalOf(draft.graph);
      const human = humanNodeOf(draft.graph);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/edges`)
          .send({
            revision: draft.revision,
            edges: [{ fromNodeId: goal.id, toNodeId: human.id, kind: 'Condition' }],
          }),
        ownerUboss,
      ).expect(400);
    });

    it('accepts an IF/ELSE edge that states its condition', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const goal = goalOf(draft.graph);
      const human = humanNodeOf(draft.graph);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/edges`)
          .send({
            revision: draft.revision,
            edges: [
              {
                fromNodeId: goal.id,
                toNodeId: human.id,
                kind: 'Condition',
                condition: 'A critical gap was found',
              },
            ],
          }),
        ownerUboss,
      ).expect(200);
    });

    it('refuses an edge naming a node that is not in the workflow', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      await as(
        agent()
          .put(`/tenants/${tenantId}/objectives/${objective.id}/workflow/edges`)
          .send({
            revision: draft.revision,
            edges: [{ fromNodeId: goalOf(draft.graph).id, toNodeId: 'ghost', kind: 'Sequential' }],
          }),
        ownerUboss,
      ).expect(400);
    });

    it('sets dependencies, and refuses one that names nothing real', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const human = humanNodeOf(draft.graph);
      const ai = aiNodeOf(draft.graph);
      const url = `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${ai.id}/dependencies`;

      const ok = await as(
        agent()
          .put(url)
          .send({ revision: draft.revision, dependsOn: [human.id] }),
        ownerUboss,
      ).expect(200);
      assert.deepEqual(
        (ok.body.graph as WorkflowDraft).nodes.find((candidate) => candidate.id === ai.id)?.dod
          .dependencies,
        [human.id],
      );

      await as(
        agent()
          .put(url)
          .send({ revision: ok.body.revision, dependsOn: ['ghost'] }),
        ownerUboss,
      ).expect(400);
    });

    it('refuses a node that depends on itself', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const ai = aiNodeOf(draft.graph);

      await as(
        agent()
          .put(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${ai.id}/dependencies`,
          )
          .send({ revision: draft.revision, dependsOn: [ai.id] }),
        ownerUboss,
      ).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 7. The Pre-Publish Summary
  // -------------------------------------------------------------------------

  describe('the Pre-Publish Summary', () => {
    const summaryFor = async (objectiveId: string, uboss = ownerUboss) => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objectiveId}/workflow/pre-publish`),
        uboss,
      ).expect(200);
      return response.body;
    };

    it('reports every item the client asked for', async () => {
      const { objective } = await analysedObjective();
      await open(objective.id);
      const summary = await summaryFor(objective.id);

      // The client's list, in one assertion each so a missing item names itself.
      assert.ok(Array.isArray(summary.affectedUserIds), 'affected employees');
      assert.equal(typeof summary.humanNodeCount, 'number', 'human count');
      assert.equal(typeof summary.aiNodeCount, 'number', 'AI count');
      assert.ok(Array.isArray(summary.nodesNeedingNewSkill), 'new agents');
      assert.ok(Array.isArray(summary.nodesReusingSkill), 'reusable agents');
      assert.ok(Array.isArray(summary.skillVersionIds), 'skills');
      assert.ok(Array.isArray(summary.missingConnections), 'missing connections');
      assert.ok(Array.isArray(summary.highRiskNodes), 'high-risk actions');
      assert.equal(typeof summary.approvalGateCount, 'number', 'approval gates');
      assert.equal(typeof summary.estimatedUsage.minTokens, 'number', 'estimated cost');
      assert.ok(Array.isArray(summary.workloadConflicts), 'workload conflicts');
      assert.ok(Array.isArray(summary.incompleteNodes), 'incomplete fields');
    });

    it('counts human and AI work separately, and names the people affected', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const summary = await summaryFor(objective.id);

      assert.equal(
        summary.humanNodeCount,
        draft.graph.nodes.filter((node) => node.kind === 'Human').length,
      );
      assert.equal(
        summary.aiNodeCount,
        draft.graph.nodes.filter((node) => node.kind === 'Ai').length,
      );
      for (const userId of summary.affectedUserIds) {
        assert.ok(
          draft.graph.nodes.some((node) => node.ownerUserId === userId),
          'a person is reported as affected who owns nothing',
        );
      }
    });

    it('estimates cost as a range that says where it came from', async () => {
      // Never a single confident figure: the estimate is derived, not measured, and a single
      // number reads as a quote.
      const { objective } = await analysedObjective();
      await open(objective.id);
      const summary = await summaryFor(objective.id);

      assert.ok(summary.estimatedUsage.maxTokens >= summary.estimatedUsage.minTokens);
      assert.ok(String(summary.estimatedUsage.basis).trim() !== '');
    });

    it('reports a node with an unfilled Definition of Done as incomplete', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      const added = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes`)
          .send({ revision: draft.revision, kind: 'Human', label: 'Unspecified step' }),
        ownerUboss,
      ).expect(201);

      const newNodeId = (added.body.graph as WorkflowDraft).nodes.find(
        (node) => node.label === 'Unspecified step',
      )?.id;

      const summary = await summaryFor(objective.id);
      const entry = summary.incompleteNodes.find(
        (candidate: { nodeId: string }) => candidate.nodeId === newNodeId,
      );
      assert.ok(entry, 'the blank node was not reported as incomplete');
      assert.ok(entry.missing.length > 0);
      assert.equal(summary.readyToAssign, false);
    });

    it('separates an AI step reusing an approved Skill from one that needs a new agent', async () => {
      const withSkill = await analysedObjective();
      await open(withSkill.objective.id);
      const reusing = await summaryFor(withSkill.objective.id);
      assert.ok(
        reusing.nodesReusingSkill.length > 0,
        'the matched Skill was not reported as reusable',
      );

      // A blocker, not a warning: the step cannot run until a Skill is authored and approved.
      assert.ok(
        reusing.findings.every(
          (finding: { severity: string; summary: string }) =>
            !/no approved, published Skill/.test(finding.summary),
        ),
        'a matched step was still reported as needing a new Skill',
      );
    });

    it('blocks assignment while an AI step has no approved Skill behind it', async () => {
      const { objective } = await analysedObjective({ withSkill: false });
      await open(objective.id);
      const summary = await summaryFor(objective.id);

      assert.ok(summary.nodesNeedingNewSkill.length > 0);
      assert.equal(summary.readyToAssign, false);
      assert.ok(
        summary.findings.some((finding: { severity: string }) => finding.severity === 'Blocker'),
        'no blocker was raised',
      );
    });

    it('publishes nothing', async () => {
      // The prompt is explicit: the next prompt handles the publish transaction. Reading a
      // readiness report must not move the objective a single step.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      const before = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });

      await summaryFor(objective.id);

      const after = await objectives().view({
        scope: scope(),
        actorUserId: ownerUserId,
        objectiveId: objective.id,
      });
      assert.equal(after.openDraft?.status, before.openDraft?.status);
      assert.equal(after.activeVersion?.id, before.activeVersion?.id);
      assert.equal(after.versions.length, before.versions.length);

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.findUniqueOrThrow({ where: { id: draft.id } }),
      );
      assert.equal(stored.assignedAt, null);
      assert.equal(stored.revision, draft.revision);
    });
  });

  // -------------------------------------------------------------------------
  // 8. An assigned plan is frozen
  // -------------------------------------------------------------------------

  describe('an assigned workflow', () => {
    /** Prompt 23 owns Approve & Assign; this sets the flag the freeze depends on. */
    const markAssigned = (draftId: string) =>
      ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.update({
          where: { id: draftId },
          data: { assignedAt: new Date(), assignedByUserId: ownerUserId },
        }),
      );

    it('is read-only, and says why', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      await markAssigned(draft.id);

      const response = await as(
        agent()
          .put(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${humanNodeOf(draft.graph).id}`,
          )
          .send({ revision: draft.revision, label: 'Changed after assignment' }),
        ownerUboss,
      );
      assert.equal(response.status, 409);
      assert.match(String(response.body.message), /assigned/i);
    });

    it('reports itself as not editable', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      await markAssigned(draft.id);

      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/workflow`),
        ownerUboss,
      ).expect(200);
      assert.equal(response.body.editable, false);
      assert.notEqual(response.body.assignedAt, null);
    });

    it('cannot have its graph rewritten even in the database', async () => {
      // The backstop: a future caller that forgets the service check still cannot rewrite work
      // people are already doing.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      await markAssigned(draft.id);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.objectiveWorkflowDraft.update({
              where: { id: draft.id },
              data: { graph: { nodes: [{ id: 'x' }], edges: [] } },
            }),
          ),
        /assigned/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 9. Authorization and tenant isolation
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses an unauthenticated request', async () => {
      const { objective } = await analysedObjective();
      await agent()
        .get(`/tenants/${tenantId}/objectives/${objective.id}/workflow`)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(401);
    });

    it('lets a CompanyAdmin read the plan but not edit it', async () => {
      // Hidden navigation is presentation only; the route itself is what protects the data.
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/workflow`),
        viewerUboss,
      ).expect(200);

      await as(
        agent()
          .put(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${humanNodeOf(draft.graph).id}`,
          )
          .send({ revision: draft.revision, label: 'Not permitted' }),
        viewerUboss,
      ).expect(403);
    });

    it('refuses a CompanyAdmin opening the editable draft', async () => {
      // Opening seeds a row, so it is an edit, not a read.
      const { objective } = await analysedObjective();
      await as(
        agent().post(`/tenants/${tenantId}/objectives/${objective.id}/workflow`).send({}),
        viewerUboss,
      ).expect(403);
    });

    it('never lets another company reach the workflow', async () => {
      const { objective } = await analysedObjective();
      await open(objective.id);

      // Asking in their own workspace: the objective does not exist there.
      const own = await as(
        agent().get(`/tenants/${otherTenantId}/objectives/${objective.id}/workflow`),
        otherUboss,
        otherTenantId,
      );
      assert.equal(own.status, 404);

      // Asking against the owning tenant's URL: refused before any row is read.
      const across = await as(
        agent().get(`/tenants/${tenantId}/objectives/${objective.id}/workflow`),
        otherUboss,
        tenantId,
      );
      assert.ok(
        across.status === 403 || across.status === 404,
        `cross-tenant read answered ${across.status}`,
      );
      assert.equal(across.body.graph, undefined, 'a cross-tenant response carried a workflow');
    });

    it('stores no workflow draft outside its own tenant', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveWorkflowDraft.findMany({ select: { id: true, tenantId: true } }),
      );
      assert.deepEqual(rows, [{ id: draft.id, tenantId }]);
    });
  });

  // -------------------------------------------------------------------------
  // 10. The audit trail
  // -------------------------------------------------------------------------

  describe('the audit trail', () => {
    it('records opening the draft and each edit, and says the analysis was not changed', async () => {
      const { objective } = await analysedObjective();
      const draft = await open(objective.id);
      await as(
        agent()
          .put(
            `/tenants/${tenantId}/objectives/${objective.id}/workflow/nodes/${humanNodeOf(draft.graph).id}`,
          )
          .send({ revision: draft.revision, label: 'Edited for the record' }),
        ownerUboss,
      ).expect(200);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: objective.id },
          orderBy: { occurredAt: 'asc' },
          select: { action: true, summary: true, actorUserId: true },
        }),
      );

      const opened = events.find((event) => event.action === 'objective.workflow_draft_opened');
      assert.ok(opened, 'opening the draft was not audited');
      assert.equal(opened.actorUserId, ownerUserId);
      assert.match(String(opened.summary), /analysis run is unchanged/i);

      assert.ok(
        events.some((event) => event.action === 'objective.workflow_node_edited'),
        'the edit was not audited',
      );
    });
  });
});
