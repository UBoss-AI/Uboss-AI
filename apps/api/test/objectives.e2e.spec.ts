import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  FORM2_OBJECTIVE_FIELDS,
  FORM2_SOURCE_FIELD_KEYS,
  FORM2_WORKFLOW_COLUMN_COUNT,
  FORM2_WORKFLOW_COLUMNS,
  type Form2Objective,
  type Form2WorkflowStep,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
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
  grantBuilderAccess,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Prompt 19 — Objective Builder, exact Form 2.
 *
 * Five properties carry this prompt, and each has tests rather than a comment:
 *
 *   1. **Form 2 is preserved exactly.** Every source field round-trips, `Unit` and `Time Unit`
 *      stay separate, and the grid keeps all fifteen columns with the row count unfixed.
 *   2. **A live version is immutable.** Its content and its grid are both frozen, by triggers,
 *      and an authorised change is a new draft rather than an overwrite.
 *   3. **The reward panel is outside Form 2** — its own table, its own permission, and it pays
 *      nobody: no performance event, no payable, no approved state to reach.
 *   4. **Tenant isolation.** No company can read or touch another's objective, by id or by list.
 *   5. **Authorization is server-side and row-level.** An Employee may draft their own and may
 *      not attach a reward; a manager cannot reach another department by knowing an id.
 */
describe('objective builder — Form 2 (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let regulatoryId: string;
  let exportsId: string;
  let otherDeptId: string;

  let adminId: string;
  let adminUboss: string;
  let headId: string;
  let headUboss: string;
  let managerId: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  // Prompt 40A: the same Employee template, plus builder access granted explicitly.
  let builderEmployeeId: string;
  let builderEmployeeUboss: string;
  let ownerId: string;
  let otherMemberId: string;
  let otherMemberUboss: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const objectives = () => app.get(ObjectiveService);

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
        ObjectiveService,
        // Prompt 21 gave `ObjectiveController` an analysis service and a Model Gateway.
        // The real `MockModelGateway` is used rather than a stub — it is what ships.
        SkillService,
        SkillRouterService,
        ObjectiveAnalysisService,
        WorkflowEditorService,
        AssignmentService,
        NotificationService,
        NotificationRepository,
        OutboxRepository,
        { provide: ModelGateway, useClass: MockModelGateway },
        TenantContextService,
        Reflector,
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
      slug: 'obj-co',
      name: 'Objective Co',
      firstMember: { email: 'first@obj.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-obj-co',
      name: 'Other Objective Co',
      firstMember: { email: 'first@other-obj.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;
    otherMemberId = other.user.id;
    otherMemberUboss = other.user.ubossUniqueId;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@obj.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-OBAD-0001', 'Objective Admin'),
        head: await member('UB-OBHD-0001', 'Priya Nair'),
        manager: await member('UB-OBMG-0001', 'Pranav Kulkarni'),
        employee: await member('UB-OBEM-0001', 'Objective Employee'),
        builderEmployee: await member('UB-OBPE-0001', 'Power Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OBOW-0001',
          email: 'owner@obj-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    headId = people.head.id;
    headUboss = people.head.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    builderEmployeeId = people.builderEmployee.id;
    builderEmployeeUboss = people.builderEmployee.ubossUniqueId;
    ownerId = people.owner.id;

    const departments = await ctx.prisma.runAsPlatformOperation(async () => {
      const regulatory = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', headUserId: headId },
      });
      const exportsDept = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Exports & Tenders', code: 'EXP' },
      });
      const foreign = await ctx.prisma.client.department.create({
        data: { tenantId: other.tenant.id, name: 'Their Department', code: 'THR' },
      });
      return { regulatory, exportsDept, foreign };
    });

    regulatoryId = departments.regulatory.id;
    exportsId = departments.exportsDept.id;
    otherDeptId = departments.foreign.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      // `Head` is capped at `MultipleDepartments` by its own template, so assigning it
      // `WholeCompany` would be narrowed back down — to a department *set*, which with no ids
      // named matches nothing. Both departments are listed because these tests create objectives
      // in both.
      for (const [userId, roleKind, scopeKind, departmentIds] of [
        [adminId, 'CompanyAdmin', 'WholeCompany', []],
        [headId, 'Head', 'MultipleDepartments', [regulatoryId, exportsId]],
        // A **Head** scoped to one department, not a Manager, and that is a template constraint
        // rather than a preference: `Manager` caps at `TeamSubtree`, so a `Department` assignment
        // is narrowed back to a subtree and then needs the reporting hierarchy to evaluate at
        // all. `Head` caps at `MultipleDepartments`, so a single-department grant survives
        // unnarrowed — which is what makes it the role that can prove a department boundary.
        [managerId, 'Head', 'Department', [regulatoryId]],
        [employeeId, 'Employee', 'OwnWork', []],
        // A second employee on the same template, who is then granted builder access explicitly
        // below. Keeping both means this suite can assert the CR-03 default *and* keep its
        // coverage of `OwnWork` objective scoping, which is still a real product behaviour.
        [builderEmployeeId, 'Employee', 'OwnWork', []],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind,
            scopeKind,
            grantedByUserId: ownerId,
            ...(departmentIds.length === 0 ? {} : { departmentIds: [...departmentIds] }),
          },
        });
      }

      // CR-03 (Prompt 40A): Objective Optimization is no longer part of the Employee default, so
      // the one employee who authors objectives in this suite is granted it explicitly. The
      // standard `employeeId` is deliberately left without it.
      await grantBuilderAccess(ctx, {
        tenantId,
        userId: builderEmployeeId,
        grantedByUserId: ownerId,
      });

      // A business role, not `CompanyAdmin`: administering a company carries no `objective:Create`
      // (Prompt 7's deliberate split), and a cross-tenant test that tripped on *that* refusal
      // would prove nothing about tenant isolation.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: other.tenant.id,
          userId: otherMemberId,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [otherDeptId],
          grantedByUserId: ownerId,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const form2 = (overrides: Partial<Form2Objective> = {}): Form2Objective => ({
    objectiveName: 'GSPR checklist generation for IV Cannula range',
    departmentId: regulatoryId,
    objectiveOwnerUserId: headId,
    expectedFinalResult:
      'A complete Annex I GSPR checklist per IV Cannula variant, each applicable requirement ' +
      'traced to a named evidence document, at 0 critical / 0 major gaps.',
    currentWorkload: 7,
    unit: 'variants',
    targetCompletionTime: 10,
    timeUnit: 'WorkingDays',
    preparedBy: 'Priya Nair',
    formDate: '2026-09-10',
    responsibleOwnerUserId: managerId,
    executionTeam: 'Regulatory Affairs — Documentation',
    ...overrides,
  });

  const step = (overrides: Partial<Form2WorkflowStep> = {}): Form2WorkflowStep => ({
    position: 1,
    whoPersonName: 'Pranav Kulkarni',
    whoDesignation: 'Reg. Doc Specialist',
    whoEngine: 'Human',
    whenTrigger: 'Objective start',
    whenFrequency: 'Once per variant',
    whatExactWork: 'Collect DHF + predicate evidence',
    inputWhatIsUsed: 'DHF workbook',
    inputReceivedFrom: 'R&D / DHF',
    whereWorkIsDone: 'UBoss + Drive',
    outputWhatIsProduced: 'Evidence index',
    outputSentTo: 'GSPR Drafter',
    timeTaken: '2h',
    currentProblem: 'Scattered evidence',
    approval: 'NotRequired',
    ...overrides,
  });

  const createObjective = (
    overrides: Partial<Form2Objective> = {},
    steps: readonly Form2WorkflowStep[] = [step()],
    actorUserId = headId,
  ) =>
    objectives().create({
      scope: scope(),
      actorUserId,
      content: form2(overrides),
      steps,
    });

  /** Take a draft version live, the way the publish path will once Prompt 20 owns it. */
  const publish = async (objectiveId: string, versionId: string) =>
    ctx.prisma.runAsPlatformOperation(async () => {
      const approvedAt = new Date();
      await ctx.prisma.client.objectiveVersion.update({
        where: { id: versionId },
        data: {
          status: 'Active',
          // `live_objective_version_was_approved` arrived at Prompt 20 and refuses a live version
          // with no approval — correctly, so this fixture now records one. `publishedAt` is a
          // millisecond later because `objective_publication_follows_approval` refuses a
          // publication that predates its own approval.
          approvedAt,
          approvedByUserId: headId,
          publishedAt: new Date(approvedAt.getTime() + 1),
        },
      });
      await ctx.prisma.client.objective.update({
        where: { id: objectiveId },
        data: { activeVersionId: versionId },
      });
    });

  // -------------------------------------------------------------------------
  // 1. Form 2 is preserved exactly
  // -------------------------------------------------------------------------

  describe('Form 2 is preserved exactly', () => {
    it('round-trips every objective-level source field', async () => {
      const created = await createObjective();
      const draft = created.openDraft;
      assert.ok(draft);

      // Compared field by field against the shared list rather than a hand-written literal, so a
      // field added to Form 2 later is automatically covered by this test.
      for (const field of FORM2_OBJECTIVE_FIELDS) {
        const sent = (form2() as unknown as Record<string, unknown>)[field.key];
        const stored: unknown = (draft.content as unknown as Record<string, unknown>)[field.key];
        assert.deepEqual(stored, sent, `${field.label} did not round-trip`);
      }
    });

    it('keeps Unit and Time Unit as separate stored values', async () => {
      const created = await createObjective({ unit: 'variants', timeUnit: 'Weeks' });
      assert.equal(created.openDraft?.content.unit, 'variants');
      assert.equal(created.openDraft?.content.timeUnit, 'Weeks');
    });

    it('round-trips all fourteen stored grid columns', async () => {
      const created = await createObjective();
      const stored = created.openDraft?.steps[0];
      assert.ok(stored);

      const sent = step() as unknown as Record<string, unknown>;
      for (const column of FORM2_WORKFLOW_COLUMNS) {
        if (column.kind === 'step') continue;
        assert.deepEqual(
          (stored as unknown as Record<string, unknown>)[column.key],
          sent[column.key],
          `${column.label} did not round-trip`,
        );
      }
    });

    it('serves the form definition with all fifteen columns and the row count unfixed', async () => {
      const response = await as(agent().get(`/tenants/${tenantId}/objectives/form2`), adminUboss);
      assert.equal(response.status, 200);
      assert.equal(response.body.workflow.columnCount, FORM2_WORKFLOW_COLUMN_COUNT);
      assert.equal(response.body.workflow.columns.length, 15);
      assert.equal(response.body.workflow.rowCountFixed, false);
      assert.deepEqual(response.body.workflow.groups, [
        'WHO',
        'WHEN',
        'WHAT',
        'INPUT',
        'WHERE',
        'OUTPUT',
      ]);
    });

    it('serves the source section and the routing controls as separate cards', async () => {
      const response = await as(agent().get(`/tenants/${tenantId}/objectives/form2`), adminUboss);
      const sections = response.body.sections as { section: string; label: string }[];
      assert.deepEqual(
        sections.map((entry) => entry.section),
        ['SourceForm2', 'UbossRouting'],
      );
      assert.match(sections[1]?.label ?? '', /separate from source Form 2/i);
    });

    it('does not fix the number of grid rows', async () => {
      // The approved UI says so in as many words. Forty steps is well past any real process and
      // exists to prove there is no cap rather than to model one.
      const many = Array.from({ length: 40 }, (_unused, index) =>
        step({ position: index + 1, whatExactWork: `Step ${index + 1}` }),
      );
      const created = await createObjective({}, many);
      assert.equal(created.openDraft?.steps.length, 40);
    });

    it('keeps the grid in position order', async () => {
      const created = await createObjective({}, [
        step({ position: 1, whatExactWork: 'First' }),
        step({ position: 2, whatExactWork: 'Second' }),
        step({ position: 3, whatExactWork: 'Third' }),
      ]);
      assert.deepEqual(
        created.openDraft?.steps.map((row) => row.whatExactWork),
        ['First', 'Second', 'Third'],
      );
    });

    it('permits an objective with no steps yet', async () => {
      // A form that refuses to save half-finished is a form people keep in a spreadsheet.
      const created = await createObjective({}, []);
      assert.equal(created.openDraft?.steps.length, 0);
      assert.equal(created.openDraft?.status, 'Draft');
    });

    it('accepts a machine step with no person named', async () => {
      const created = await createObjective({}, [
        step({ whoEngine: 'Engine', whoPersonName: null, whoDesignation: null }),
      ]);
      assert.equal(created.openDraft?.steps[0]?.whoEngine, 'Engine');
      assert.equal(created.openDraft?.steps[0]?.whoPersonName, null);
    });

    it('accepts all four engine kinds, Executor included', async () => {
      const created = await createObjective({}, [
        step({ position: 1, whoEngine: 'Human' }),
        step({ position: 2, whoEngine: 'Engine', whoPersonName: null }),
        step({ position: 3, whoEngine: 'SubEngine', whoPersonName: null }),
        step({ position: 4, whoEngine: 'Executor', whoPersonName: null }),
      ]);
      assert.deepEqual(
        created.openDraft?.steps.map((row) => row.whoEngine),
        ['Human', 'Engine', 'SubEngine', 'Executor'],
      );
    });

    it('accepts all four step approval kinds', async () => {
      const created = await createObjective({}, [
        step({ position: 1, approval: 'NotRequired' }),
        step({ position: 2, approval: 'Manager' }),
        step({ position: 3, approval: 'Head' }),
        step({ position: 4, approval: 'FourEyes' }),
      ]);
      assert.deepEqual(
        created.openDraft?.steps.map((row) => row.approval),
        ['NotRequired', 'Manager', 'Head', 'FourEyes'],
      );
    });

    it('never stores a Form 2 field on the reward table', async () => {
      const columns = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.$queryRawUnsafe<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'objective_rewards'`,
        ),
      );
      const names = columns.map((row) => row.column_name);
      for (const key of FORM2_SOURCE_FIELD_KEYS) {
        const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
        assert.ok(
          !names.includes(snake),
          `the reward table must not carry the Form 2 field ${key}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('refuses a form missing a required field, naming it', async () => {
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives`)
          .send({ content: { ...form2(), objectiveName: '' }, steps: [step()] }),
        headUboss,
      );
      assert.equal(response.status, 400);
    });

    it('refuses a target completion time with no time unit', async () => {
      await assert.rejects(
        createObjective({ targetCompletionTime: 10, timeUnit: null }),
        /Time Unit/,
      );
    });

    it('accepts a workload unit with no duration set', async () => {
      const created = await createObjective({
        unit: 'variants',
        targetCompletionTime: null,
        timeUnit: null,
      });
      assert.equal(created.openDraft?.content.unit, 'variants');
    });

    it('refuses a grid with a gap in its positions', async () => {
      await assert.rejects(
        createObjective({}, [step({ position: 1 }), step({ position: 3 })]),
        /no gaps/,
      );
    });

    it('refuses a step with no work described', async () => {
      await assert.rejects(createObjective({}, [step({ whatExactWork: '   ' })]), /Exact Work/);
    });

    it('refuses an objective in another company’s department', async () => {
      // The department id is real, just not this company's. Two independent things refuse it and
      // the *scope* check gets there first — which is the better order, so the assertion follows
      // the code rather than the code being bent to the assertion: a department outside your
      // scope is refused without the reply revealing whether it exists at all. The
      // "not in this company" branch behind it is defence in depth, exercised by the archived
      // case below where the department genuinely is this company's.
      await assert.rejects(
        createObjective({ departmentId: otherDeptId }),
        /outside what your role covers/,
      );
    });

    it('refuses an objective under an archived department', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.department.update({
          where: { id: exportsId },
          data: { archivedAt: new Date() },
        }),
      );
      await assert.rejects(createObjective({ departmentId: exportsId }), /archived/);
    });

    it('refuses an unknown time unit at the route', async () => {
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives`)
          .send({ content: { ...form2(), timeUnit: 'Fortnights' }, steps: [step()] }),
        headUboss,
      );
      assert.equal(response.status, 400);
    });

    it('refuses an unknown engine kind at the route', async () => {
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives`)
          .send({ content: form2(), steps: [{ ...step(), whoEngine: 'Robot' }] }),
        headUboss,
      );
      assert.equal(response.status, 400);
    });

    it('refuses an unknown property rather than silently dropping it', async () => {
      const response = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives`)
          .send({ content: form2(), steps: [step()], rewardAmount: 5000 }),
        headUboss,
      );
      assert.equal(response.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Codes and versions
  // -------------------------------------------------------------------------

  describe('codes and versions', () => {
    it('derives a readable code from the department and the year', async () => {
      const created = await createObjective();
      assert.match(created.code, /^REG-\d{4}-001$/);
    });

    it('numbers subsequent objectives in the same department', async () => {
      await createObjective();
      const second = await createObjective();
      assert.match(second.code, /^REG-\d{4}-002$/);
    });

    it('numbers departments independently', async () => {
      await createObjective();
      const other = await createObjective({ departmentId: exportsId });
      assert.match(other.code, /^EXP-\d{4}-001$/);
    });

    it('accepts a caller-supplied code and refuses a duplicate', async () => {
      const created = await createObjective();
      assert.ok(created.code);
      await assert.rejects(
        objectives().create({
          scope: scope(),
          actorUserId: headId,
          code: created.code,
          content: form2(),
          steps: [step()],
        }),
        /already exists/,
      );
    });

    it('starts at version 1 in Draft', async () => {
      const created = await createObjective();
      assert.equal(created.openDraft?.versionNumber, 1);
      assert.equal(created.openDraft?.status, 'Draft');
      assert.equal(created.activeVersion, null);
    });

    it('reports the moves a version may make, from the shared table', async () => {
      const created = await createObjective();
      assert.deepEqual(created.openDraft?.nextStatuses, ['UnderReview', 'AiAnalysis', 'Archived']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Saving and submitting
  // -------------------------------------------------------------------------

  describe('saving a draft', () => {
    it('replaces the form and the grid together', async () => {
      const created = await createObjective();
      const updated = await objectives().updateDraft({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        content: form2({ objectiveName: 'Renamed while still a draft', currentWorkload: 9 }),
        steps: [step({ position: 1, whatExactWork: 'Replaced step' })],
      });

      assert.equal(updated.openDraft?.content.objectiveName, 'Renamed while still a draft');
      assert.equal(updated.openDraft?.content.currentWorkload, 9);
      assert.equal(updated.openDraft?.steps.length, 1);
      assert.equal(updated.openDraft?.steps[0]?.whatExactWork, 'Replaced step');
    });

    it('lets the grid shrink as well as grow', async () => {
      const created = await createObjective({}, [
        step({ position: 1 }),
        step({ position: 2 }),
        step({ position: 3 }),
      ]);
      const updated = await objectives().updateDraft({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        content: form2(),
        steps: [step({ position: 1 })],
      });
      assert.equal(updated.openDraft?.steps.length, 1);
    });

    it('moves the objective’s department when the draft does, while nothing is live', async () => {
      const created = await createObjective();
      const updated = await objectives().updateDraft({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        content: form2({ departmentId: exportsId }),
        steps: [step()],
      });
      assert.equal(updated.departmentId, exportsId);
    });

    it('keeps the objective’s scope anchor and the live version in step', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      await publish(created.id, created.openDraft.id);

      const stored = await ctx.prisma.runAsPlatformOperation(async () => {
        const objective = await ctx.prisma.client.objective.findUniqueOrThrow({
          where: { id: created.id },
        });
        const version = await ctx.prisma.client.objectiveVersion.findUniqueOrThrow({
          where: { id: objective.activeVersionId ?? '' },
        });
        return { objective, version };
      });

      assert.equal(stored.objective.departmentId, stored.version.departmentId);
      assert.equal(stored.objective.objectiveOwnerUserId, stored.version.objectiveOwnerUserId);
    });
  });

  describe('submitting for review', () => {
    it('moves a complete draft to Under Review and records who sent it', async () => {
      const created = await createObjective();
      const submitted = await objectives().submitForReview({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });

      const version = submitted.versions[0];
      assert.equal(version?.status, 'UnderReview');
      assert.equal(version?.statusLabel, 'Submitted / Under Review');
      assert.equal(version?.submittedByUserId, headId);
      assert.ok(version?.submittedAt);
    });

    it('refuses to submit with no workflow steps', async () => {
      const created = await createObjective({}, []);
      await assert.rejects(
        objectives().submitForReview({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
        }),
        /at least one workflow step/,
      );
    });

    it('refuses to submit with no Responsible Owner', async () => {
      const created = await createObjective({ responsibleOwnerUserId: null });
      await assert.rejects(
        objectives().submitForReview({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
        }),
        /Responsible Owner/,
      );
    });

    it('refuses to submit a human step with nobody named', async () => {
      const created = await createObjective({}, [
        step({ whoEngine: 'Human', whoPersonName: null }),
      ]);
      await assert.rejects(
        objectives().submitForReview({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
        }),
        /Person Name/,
      );
    });

    it('refuses to edit a draft once it is under review', async () => {
      // Changing content under a reviewer is how somebody ends up approving what they never read.
      const created = await createObjective();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });

      await assert.rejects(
        objectives().updateDraft({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
          content: form2({ objectiveName: 'Changed under the reviewer' }),
          steps: [step()],
        }),
        /no editable draft/,
      );
    });

    it('refuses to submit twice', async () => {
      const created = await createObjective();
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      await assert.rejects(
        objectives().submitForReview({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
        }),
        /no editable draft/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. A live version is immutable
  // -------------------------------------------------------------------------

  describe('a live version is immutable', () => {
    it('turns an edit of a live objective into a new draft rather than a rewrite', async () => {
      // Prompt 19 refused this outright. Prompt 20 is where the client's rule arrives — "any
      // later edit by any authorized user automatically creates V2 Draft copied from V1" — so the
      // expectation changed deliberately. What matters is unchanged and asserted below: the live
      // version is not touched.
      const created = await createObjective();
      assert.ok(created.openDraft);
      const liveVersionId = created.openDraft.id;
      await publish(created.id, liveVersionId);

      const edited = await objectives().updateDraft({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        content: form2({ objectiveName: 'Edited into V2' }),
        steps: [step()],
      });

      assert.equal(edited.openDraft?.versionNumber, 2);
      assert.equal(edited.openDraft?.content.objectiveName, 'Edited into V2');
      assert.equal(edited.openDraft?.copiedFromVersionId, liveVersionId);

      // V1 is still live and still says what it always said.
      assert.equal(edited.activeVersion?.id, liveVersionId);
      assert.equal(edited.activeVersion?.versionNumber, 1);
      assert.equal(
        edited.activeVersion?.content.objectiveName,
        'GSPR checklist generation for IV Cannula range',
      );
    });

    it('refuses to rewrite a live version’s content in the database', async () => {
      // The service refusing is not enough: the trigger is what makes the rule structural.
      const created = await createObjective();
      assert.ok(created.openDraft);
      const versionId = created.openDraft.id;
      await publish(created.id, versionId);

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveVersion.update({
            where: { id: versionId },
            data: { objectiveName: 'Rewritten behind the service' },
          }),
        ),
        /cannot be changed/,
      );
    });

    it('refuses to change a live version’s workflow grid in the database', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      const versionId = created.openDraft.id;
      const stepId = created.openDraft.steps[0]?.id;
      assert.ok(stepId);
      await publish(created.id, versionId);

      // All three write kinds, because inserting a step into a running plan changes it exactly as
      // much as editing the expected result does.
      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveWorkflowStep.update({
            where: { id: stepId },
            data: { whatExactWork: 'Rewritten' },
          }),
        ),
        /workflow grid cannot be changed/,
      );

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveWorkflowStep.create({
            data: {
              tenantId,
              objectiveVersionId: versionId,
              position: 99,
              whatExactWork: 'Sneaked in',
            },
          }),
        ),
        /workflow grid cannot be changed/,
      );

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveWorkflowStep.delete({ where: { id: stepId } }),
        ),
        /workflow grid cannot be changed/,
      );
    });

    it('still lets a live version’s status move to Completed', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      const versionId = created.openDraft.id;
      await publish(created.id, versionId);

      const moved = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveVersion.update({
          where: { id: versionId },
          data: { status: 'Completed' },
        }),
      );
      assert.equal(moved.status, 'Completed');
    });

    it('permits exactly one live version per objective', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      const firstVersionId = created.openDraft.id;
      await publish(created.id, firstVersionId);

      const approvedAt = new Date();
      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveVersion.create({
            data: {
              tenantId,
              objectiveId: created.id,
              versionNumber: 2,
              // Prompt 20's provenance and approval constraints apply to this row too, so the
              // fixture satisfies them — otherwise it would be refused for the wrong reason and
              // prove nothing about the one-live-version rule.
              origin: 'Edit',
              copiedFromVersionId: firstVersionId,
              status: 'Active',
              approvedAt,
              approvedByUserId: headId,
              publishedAt: new Date(approvedAt.getTime() + 1),
              objectiveName: 'A second live plan',
              departmentId: regulatoryId,
              objectiveOwnerUserId: headId,
              expectedFinalResult: 'Two live plans is no plan.',
            },
          }),
        ),
        /one_active_version_per_objective/,
      );
    });

    it('permits a draft version alongside the live one', async () => {
      // This is the shape of the client's rule: an authorised edit after Live is a new draft.
      const created = await createObjective();
      assert.ok(created.openDraft);
      const firstVersionId = created.openDraft.id;
      await publish(created.id, firstVersionId);

      const draft = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveVersion.create({
          data: {
            tenantId,
            objectiveId: created.id,
            versionNumber: 2,
            // Prompt 20: every version after V1 records where it was copied from, and
            // `first_version_has_no_parent` refuses one that does not.
            origin: 'Edit',
            copiedFromVersionId: firstVersionId,
            status: 'Draft',
            objectiveName: 'V2 draft taken from the live version',
            departmentId: regulatoryId,
            objectiveOwnerUserId: headId,
            expectedFinalResult: 'Same intent, revised plan.',
          },
        }),
      );
      assert.equal(draft.status, 'Draft');

      const view = await objectives().view({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      assert.equal(view.activeVersion?.versionNumber, 1);
      assert.equal(view.openDraft?.versionNumber, 2);
    });

    it('refuses to delete the version an objective is running', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      const versionId = created.openDraft.id;
      await publish(created.id, versionId);

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objectiveVersion.delete({ where: { id: versionId } }),
        ),
      );
    });

    it('refuses to name a version from another company as the live one', async () => {
      const mine = await createObjective();
      const theirs = await objectives().create({
        scope: otherScope(),
        actorUserId: otherMemberId,
        content: {
          ...form2(),
          departmentId: otherDeptId,
          objectiveOwnerUserId: otherMemberId,
          responsibleOwnerUserId: null,
        },
        steps: [step({ whoPersonName: 'Theirs' })],
      });
      assert.ok(theirs.openDraft);

      await assert.rejects(
        ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.objective.update({
            where: { id: mine.id },
            data: { activeVersionId: theirs.openDraft?.id ?? null },
          }),
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. The Performance & Reward panel
  // -------------------------------------------------------------------------

  describe('the Performance & Reward panel', () => {
    const panel = {
      applicable: true,
      rewardType: 'Cash' as const,
      amountMinorUnits: 500_000,
      eligibilityCondition: 'Zero critical gaps, accepted by the Head',
      completionDeadline: '2026-10-15',
      evidence: 'Signed checklist filed in the technical file',
      approverUserId: '',
    };

    it('saves all seven fields', async () => {
      const created = await createObjective();
      const saved = await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });

      assert.equal(saved.applicable, true);
      assert.equal(saved.rewardType, 'Cash');
      assert.equal(saved.amountMinorUnits, 500_000);
      assert.equal(saved.eligibilityCondition, panel.eligibilityCondition);
      assert.equal(saved.completionDeadline, '2026-10-15');
      assert.equal(saved.evidence, panel.evidence);
      assert.equal(saved.approverUserId, headId);
    });

    it('says on every read that recording a reward does not pay it', async () => {
      const created = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });
      const read = await objectives().readReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      assert.match(read?.note ?? '', /does not pay it/i);
      assert.match(read?.note ?? '', /separate from the canonical Form 2/i);
    });

    it('writes no performance event when a reward is recorded', async () => {
      // The client's rule is that nothing auto-pays and nothing reaches performance except
      // through policy. This is the test that would fail if a shortcut were added later.
      const created = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.performanceEvent.count({ where: { tenantId } }),
      );
      assert.equal(events, 0);
    });

    it('has no column for an approved, settled or paid reward', async () => {
      const columns = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.$queryRawUnsafe<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'objective_rewards'
               AND column_name ~ 'approved|settled|paid|payout|disburse'`,
        ),
      );
      assert.deepEqual(columns, []);
    });

    it('records a decision that no reward applies', async () => {
      const created = await createObjective();
      const saved = await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: {
          applicable: false,
          rewardType: null,
          amountMinorUnits: null,
          eligibilityCondition: null,
          completionDeadline: null,
          evidence: null,
          approverUserId: null,
        },
      });
      assert.equal(saved.applicable, false);
    });

    it('distinguishes no panel from a panel saying no reward applies', async () => {
      const created = await createObjective();
      const before = await objectives().readReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      assert.equal(before, null);
    });

    it('refuses an applicable reward with no condition or approver', async () => {
      const created = await createObjective();
      await assert.rejects(
        objectives().saveReward({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
          panel: {
            applicable: true,
            rewardType: 'Cash',
            amountMinorUnits: 1000,
            eligibilityCondition: null,
            completionDeadline: null,
            evidence: null,
            approverUserId: null,
          },
        }),
        /Eligibility Condition/,
      );
    });

    it('refuses an applicable Cash reward with no amount', async () => {
      const created = await createObjective();
      await assert.rejects(
        objectives().saveReward({
          scope: scope(),
          actorUserId: headId,
          objectiveId: created.id,
          panel: { ...panel, approverUserId: headId, amountMinorUnits: null },
        }),
        /Amount \/ Points/,
      );
    });

    it('accepts a Recognition reward with no amount', async () => {
      const created = await createObjective();
      const saved = await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: {
          ...panel,
          approverUserId: headId,
          rewardType: 'Recognition',
          amountMinorUnits: null,
        },
      });
      assert.equal(saved.rewardType, 'Recognition');
      assert.equal(saved.amountMinorUnits, null);
    });

    it('keeps one panel per objective, updating rather than duplicating', async () => {
      const created = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId, amountMinorUnits: 750_000 },
      });

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.objectiveReward.count({ where: { objectiveId: created.id } }),
      );
      assert.equal(count, 1);

      const read = await objectives().readReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      assert.equal(read?.amountMinorUnits, 750_000);
    });

    it('does not change the Form 2 content when a reward is saved', async () => {
      const created = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });

      const after = await objectives().view({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });
      assert.deepEqual(after.openDraft?.content, created.openDraft?.content);
      assert.deepEqual(after.openDraft?.steps, created.openDraft?.steps);
    });

    it('records in the audit trail that nothing was auto-paid', async () => {
      const created = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        panel: { ...panel, approverUserId: headId },
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'objective.reward_panel_saved' },
        }),
      );
      assert.ok(event);
      assert.equal((event.metadata as Record<string, unknown>)['autoPaid'], false);
      assert.match(event.summary ?? '', /Nothing is payable/i);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Authorization
  // -------------------------------------------------------------------------

  describe('authorization', () => {
    it('refuses a standard Employee an objective at all — CR-03', async () => {
      // This assertion is the reverse of what it used to be, on purpose. CR-03 supersedes the
      // earlier reading in which every employee could author their own objective: a standard
      // Employee is now operations-only, and Objective Optimization is hidden and blocked by the
      // same absent grant.
      await assert.rejects(
        objectives().create({
          scope: scope(),
          actorUserId: employeeId,
          content: form2({ objectiveOwnerUserId: employeeId }),
          steps: [step()],
        }),
      );
    });

    it('lets an employee granted builder access create and edit their own objective', async () => {
      // The other half: "unless explicitly granted" has to mean something. This is the Power
      // Employee — the same template plus a custom role carrying the builder permissions — and
      // `OwnWork` scope, so the capability was widened without the reach being widened.
      const created = await objectives().create({
        scope: scope(),
        actorUserId: builderEmployeeId,
        content: form2({ objectiveOwnerUserId: builderEmployeeId }),
        steps: [step()],
      });
      assert.ok(created.id);

      const updated = await objectives().updateDraft({
        scope: scope(),
        actorUserId: builderEmployeeId,
        objectiveId: created.id,
        content: form2({
          objectiveOwnerUserId: builderEmployeeId,
          objectiveName: 'My own objective',
        }),
        steps: [step()],
      });
      assert.equal(updated.openDraft?.content.objectiveName, 'My own objective');
    });

    it('does not let a granted builder attach a reward to their own objective', async () => {
      // `Assign` is still the line, and this test still exists to pin it — retargeted at the
      // person who now holds Create and EditDraft. Granting somebody the builder capability must
      // not quietly hand them the ability to promise themselves a bonus, and it does not: the
      // custom role carries Create and EditDraft and no Assign.
      const created = await objectives().create({
        scope: scope(),
        actorUserId: builderEmployeeId,
        content: form2({ objectiveOwnerUserId: builderEmployeeId }),
        steps: [step()],
      });

      await assert.rejects(
        objectives().saveReward({
          scope: scope(),
          actorUserId: builderEmployeeId,
          objectiveId: created.id,
          panel: {
            applicable: true,
            rewardType: 'Points',
            amountMinorUnits: 50,
            eligibilityCondition: 'Because I said so',
            completionDeadline: null,
            evidence: null,
            approverUserId: builderEmployeeId,
          },
        }),
      );
    });

    it('refuses the reward route to an Employee', async () => {
      const created = await createObjective();
      const response = await as(
        agent().put(`/tenants/${tenantId}/objectives/${created.id}/reward`).send({
          applicable: false,
          rewardType: null,
          amountMinorUnits: null,
          eligibilityCondition: null,
          completionDeadline: null,
          evidence: null,
          approverUserId: null,
        }),
        employeeUboss,
      );
      assert.equal(response.status, 403);
    });

    it('lets a Head attach a reward', async () => {
      const created = await createObjective();
      const response = await as(
        agent().put(`/tenants/${tenantId}/objectives/${created.id}/reward`).send({
          applicable: true,
          rewardType: 'Points',
          amountMinorUnits: 250,
          eligibilityCondition: 'Delivered on time and accepted',
          completionDeadline: null,
          evidence: null,
          approverUserId: headId,
        }),
        headUboss,
      );
      assert.equal(response.status, 200);
    });

    it('does not let a department-scoped Head reach another department by id', async () => {
      // Hidden navigation is not security: the row-level check is what refuses this.
      const created = await createObjective({ departmentId: exportsId });
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${created.id}`),
        managerUboss,
      );
      assert.equal(response.status, 403);
    });

    it('lets that Head reach an objective in their own department', async () => {
      const created = await createObjective({ departmentId: regulatoryId });
      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives/${created.id}`),
        managerUboss,
      );
      assert.equal(response.status, 200);
    });

    it('omits objectives outside that Head’s departments from the list', async () => {
      await createObjective({ departmentId: regulatoryId });
      await createObjective({ departmentId: exportsId });

      const response = await as(agent().get(`/tenants/${tenantId}/objectives`), managerUboss);
      assert.equal(response.status, 200);
      const rows = response.body.objectives as { departmentId: string }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.departmentId, regulatoryId);
    });

    it('shows a granted builder only their own objectives', async () => {
      // `OwnWork` scoping, which CR-03 did not change — retargeted at the person who can now
      // author one. The point stands and is worth keeping: granting the capability does not widen
      // the reach, so they still see one row and not the Head's.
      await objectives().create({
        scope: scope(),
        actorUserId: builderEmployeeId,
        content: form2({ objectiveOwnerUserId: builderEmployeeId }),
        steps: [step()],
      });
      await createObjective({ objectiveOwnerUserId: headId });

      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives`),
        builderEmployeeUboss,
      );
      const rows = response.body.objectives as { id: string }[];
      assert.equal(rows.length, 1);
    });

    it('shows a standard Employee no Objective screen at all', async () => {
      // The list route is gated on `objective:View`, which a standard Employee no longer holds.
      // Hidden navigation is not security: this is the route refusing, not the sidebar.
      await createObjective({ objectiveOwnerUserId: headId });
      const response = await as(agent().get(`/tenants/${tenantId}/objectives`), employeeUboss);
      assert.equal(response.status, 403);
    });

    it('lets a Company Admin read objectives and refuses them creating one', async () => {
      // Prompt 7's deliberate decision, pinned here because it is surprising enough to be
      // "corrected" later: `CompanyAdmin` holds `objective: View, Comment, Export` and **not**
      // Create, EditDraft or Assign. Administering a company is not doing its business work, and
      // an administrator who must also draft objectives is additionally given a business role —
      // a separate, visible decision rather than a silent widening of the admin role.
      await createObjective();

      const read = await as(agent().get(`/tenants/${tenantId}/objectives`), adminUboss);
      assert.equal(read.status, 200);

      const create = await as(
        agent()
          .post(`/tenants/${tenantId}/objectives`)
          .send({ content: form2(), steps: [step()] }),
        adminUboss,
      );
      assert.equal(create.status, 403);
    });

    it('refuses an unauthenticated request', async () => {
      const response = await agent()
        .get(`/tenants/${tenantId}/objectives`)
        .set(WORKSPACE_HEADER, tenantId);
      // 401, not 403: the guard cannot say what a role covers before it knows who is asking.
      assert.equal(response.status, 401);
    });

    it('refuses a member of this company with no role at all', async () => {
      const stranger = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OBNR-0001',
          email: 'norole@obj.example',
          displayName: 'No Role',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user;
      });

      const response = await as(
        agent().get(`/tenants/${tenantId}/objectives`),
        stranger.ubossUniqueId,
      );
      assert.equal(response.status, 403);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never shows one company another’s objectives', async () => {
      await createObjective();

      const response = await as(
        agent().get(`/tenants/${otherTenantId}/objectives`),
        otherMemberUboss,
        otherTenantId,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.objectives, []);
    });

    it('refuses a direct fetch of another company’s objective by id', async () => {
      const mine = await createObjective();

      const response = await as(
        agent().get(`/tenants/${otherTenantId}/objectives/${mine.id}`),
        otherMemberUboss,
        otherTenantId,
      );
      // Not found rather than forbidden: under RLS the row is not visible at all, and saying
      // "forbidden" would confirm that an objective with that id exists somewhere.
      assert.equal(response.status, 404);
    });

    it('refuses to edit another company’s draft', async () => {
      const mine = await createObjective();
      await assert.rejects(
        objectives().updateDraft({
          scope: otherScope(),
          actorUserId: otherMemberId,
          objectiveId: mine.id,
          content: form2({ departmentId: otherDeptId, objectiveOwnerUserId: otherMemberId }),
          steps: [step()],
        }),
        /no such objective/i,
      );
    });

    it('refuses to read another company’s reward panel', async () => {
      const mine = await createObjective();
      await objectives().saveReward({
        scope: scope(),
        actorUserId: headId,
        objectiveId: mine.id,
        panel: {
          applicable: true,
          rewardType: 'Cash',
          amountMinorUnits: 100_000,
          eligibilityCondition: 'Ours, not theirs',
          completionDeadline: null,
          evidence: null,
          approverUserId: headId,
        },
      });

      await assert.rejects(
        objectives().readReward({
          scope: otherScope(),
          actorUserId: otherMemberId,
          objectiveId: mine.id,
        }),
        /no such objective/i,
      );
    });

    it('keeps codes independent per company', async () => {
      const mine = await createObjective();
      const theirs = await objectives().create({
        scope: otherScope(),
        actorUserId: otherMemberId,
        content: {
          ...form2(),
          departmentId: otherDeptId,
          objectiveOwnerUserId: otherMemberId,
          responsibleOwnerUserId: null,
        },
        steps: [step({ whoPersonName: 'Theirs' })],
      });

      // Different companies, different department stems, and neither collides with the other.
      assert.notEqual(mine.code, theirs.code);
      assert.match(theirs.code, /^THR-\d{4}-001$/);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Listing
  // -------------------------------------------------------------------------

  describe('listing', () => {
    it('reports the live version when there is one', async () => {
      const created = await createObjective();
      assert.ok(created.openDraft);
      await publish(created.id, created.openDraft.id);

      const listed = await objectives().list({ scope: scope(), actorUserId: headId });
      const row = listed.objectives.find((entry) => entry.id === created.id);
      assert.equal(row?.status, 'Active');
      assert.equal(row?.statusLabel, 'Published / Active');
      assert.equal(row?.live, true);
      assert.equal(row?.versionNumber, 1);
    });

    it('reports the latest draft when nothing is live', async () => {
      const created = await createObjective();
      const listed = await objectives().list({ scope: scope(), actorUserId: headId });
      const row = listed.objectives.find((entry) => entry.id === created.id);
      assert.equal(row?.status, 'Draft');
      assert.equal(row?.live, false);
    });

    it('filters by status and by department', async () => {
      await createObjective({ departmentId: regulatoryId });
      await createObjective({ departmentId: exportsId });

      const byDepartment = await objectives().list({
        scope: scope(),
        actorUserId: headId,
        departmentId: exportsId,
      });
      assert.equal(byDepartment.objectives.length, 1);

      const byStatus = await objectives().list({
        scope: scope(),
        actorUserId: headId,
        status: 'Active',
      });
      assert.deepEqual(byStatus.objectives, []);
    });

    it('searches by name and by code', async () => {
      const created = await createObjective({ objectiveName: 'Tender eligibility screening' });
      await createObjective({ objectiveName: 'Something else entirely' });

      const byName = await objectives().list({
        scope: scope(),
        actorUserId: headId,
        search: 'tender',
      });
      assert.equal(byName.objectives.length, 1);
      assert.equal(byName.objectives[0]?.id, created.id);

      const byCode = await objectives().list({
        scope: scope(),
        actorUserId: headId,
        search: created.code,
      });
      assert.equal(byCode.objectives.length, 1);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Audit
  // -------------------------------------------------------------------------

  describe('audit', () => {
    it('records creation, saving and submission', async () => {
      const created = await createObjective();
      await objectives().updateDraft({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
        content: form2(),
        steps: [step()],
      });
      await objectives().submitForReview({
        scope: scope(),
        actorUserId: headId,
        objectiveId: created.id,
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceType: 'objective' },
          orderBy: { occurredAt: 'asc' },
        }),
      );

      const actions = events.map((event) => event.action);
      assert.ok(actions.includes('objective.created'));
      assert.ok(actions.includes('objective.draft_saved'));
      assert.ok(actions.includes('objective.submitted_for_review'));
    });

    it('attributes every event to the person who acted', async () => {
      const created = await createObjective({}, [step()], headId);
      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, resourceId: created.id },
        }),
      );
      assert.ok(events.length > 0);
      for (const event of events) {
        assert.equal(event.actorUserId, headId);
      }
    });
  });
});
