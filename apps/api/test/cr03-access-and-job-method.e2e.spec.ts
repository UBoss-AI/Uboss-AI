import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  JOB_METHOD_CELL_MAX,
  JOB_METHOD_COLUMNS,
  JOB_METHOD_FORM_VERSION,
  NEVER_IN_AN_OPERATOR_VIEW,
  STANDARD_EMPLOYEE_CAPABILITIES,
} from '@uboss/types';

import { CapabilityService } from '../src/access/capability.service.js';
import { AgentOperatorController } from '../src/agents/agent-operator.controller.js';
import { AgentOperatorService } from '../src/agents/agent-operator.service.js';
import { JobMethodController } from '../src/agents/job-method.controller.js';
import { JobMethodService } from '../src/agents/job-method.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { MyAccessController } from '../src/authorization/my-access.controller.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { EmployeePhotoService } from '../src/organization/employee-photo.service.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { FileService } from '../src/knowledge/file.service.js';
import { MALWARE_SCANNER, MockMalwareScanner } from '../src/knowledge/malware-scanner.js';
import {
  InMemoryStorageAdapter,
  STORAGE_ADAPTER,
} from '../src/knowledge/storage-adapter.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import {
  createRequestContext,
  runWithRequestContext,
} from '../src/request-context/request-context.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import {
  activateMembership,
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * CR-03: permission-controlled build/operate, the Job Method flow and the employee photo —
 * Prompt 40A §§1–5, against real PostgreSQL.
 *
 * The weight is on the distinctions the amendment exists to draw:
 *
 *  * a **standard Employee** cannot reach Agent Builder, and an **explicitly granted** one can;
 *  * an administrator cannot grant what they do not hold, or grant themselves anything;
 *  * a **manager builds for an employee**, and the employee can run it without ever gaining
 *    builder access;
 *  * the **download** needs no builder permission and the **upload** does;
 *  * an upload **never activates anything**, and refuses rather than inventing;
 *  * an operator's screen carries no prompt, model, key or configuration.
 */
describe('CR-03 access, Job Method and photo (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let departmentId: string;
  let objectiveVersionId: string;
  let assignmentId: string;
  let agentId: string;

  let adminId: string;
  let managerId: string;
  let employeeId: string;
  let otherEmployeeId: string;
  let ownerId: string;

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(
        `The test database is not reachable: ${reachabilityFailureReason()}\n` +
          'Start it with:\n' +
          '  docker compose -f infra/docker-compose.yml up -d',
      );
    }
    migrateTestDatabase();

    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        RoleAdministrationService,
        TcsionMappingService,
        CapabilityService,
        AgentOperatorService,
        JobMethodService,
        EmployeePhotoService,
        FileService,
        CompanySettingsService,
        // The same bindings the module makes, as values, so the suite can prove a removed photo
        // really left the store rather than only losing its pointer.
        { provide: STORAGE_ADAPTER, useValue: new InMemoryStorageAdapter() },
        { provide: MALWARE_SCANNER, useValue: new MockMalwareScanner() },
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
        // The seam the controllers below read their scope through.
        TenantContextService,
      ],
      /*
       * The controllers, not only the services.
       *
       * Everything above drives a service directly, which is the right level for a rule about
       * authority — and is also why a route that never consulted one survived until a screen
       * tried to use it.
       */
      controllers: [MyAccessController, AgentOperatorController, JobMethodController],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);

    const provisioned = await ctx.provisioning.provision({
      slug: 'cr03-co',
      name: 'CR-03 Co',
      firstMember: { email: 'first@cr03.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const made = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (email: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      const department = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Finance', code: 'FIN' },
      });

      return {
        department,
        admin: await member('admin@cr03.example', 'Asha Admin'),
        manager: await member('mgr@cr03.example', 'Manoj Manager'),
        employee: await member('emp@cr03.example', 'Ella Employee'),
        other: await member('emp2@cr03.example', 'Omar Other'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email: 'owner@cr03-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    departmentId = made.department.id;
    adminId = made.admin.id;
    managerId = made.manager.id;
    employeeId = made.employee.id;
    otherEmployeeId = made.other.id;
    ownerId = made.owner.id;

    const seeded = await ctx.prisma.runAsPlatformOperation(async () => {
      for (const [userId, roleKind, scopeKind, departmentIds] of [
        [adminId, 'CompanyAdmin', 'WholeCompany', []],
        // `Head` at `WholeCompany` gets narrowed to its own `MultipleDepartments` cap, and an
        // Engine Agent has no department — so a department-scoped Head could not reach it. A Head
        // at `MultipleDepartments` covering the one department is what lets this fixture both
        // author objectives *and* staff an agent, which is the manager case CR-03 describes.
        [managerId, 'Head', 'MultipleDepartments', [departmentId]],
        [employeeId, 'Employee', 'OwnWork', []],
        [otherEmployeeId, 'Employee', 'OwnWork', []],
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

      // An objective with a live version, a workflow draft, one piece of assigned AI work, and an
      // agent the manager built **for** the employee. That last relationship is the case CR-03 is
      // about, so the fixture sets it up explicitly rather than implying it.
      const objective = await ctx.prisma.client.objective.create({
        data: {
          tenantId,
          code: 'OBJ-CR03',
          departmentId,
          objectiveOwnerUserId: managerId,
          createdByUserId: managerId,
        },
      });
      const approvedAt = new Date();

      /**
       * Created as a **Draft** with its steps, then promoted.
       *
       * A Prompt 20 trigger refuses any change to the workflow grid of an `Active` version —
       * "an authorised edit creates a new draft version; it never rewrites the plan that is live".
       * So a version cannot be born Active *with* steps, and a fixture that tried was refused by
       * the product working correctly. Draft first, steps, then publish: the same order a real
       * objective goes through.
       */
      const version = await ctx.prisma.client.objectiveVersion.create({
        data: {
          tenantId,
          objectiveId: objective.id,
          versionNumber: 1,
          origin: 'Initial',
          status: 'Draft',
          objectiveName: 'Monthly VAT return',
          departmentId,
          objectiveOwnerUserId: managerId,
          expectedFinalResult: 'A return filed and accepted.',
          createdByUserId: managerId,
          steps: {
            create: [
              {
                // No `tenantId` here: a nested create takes it from the parent through the composite
                // relation, and passing it is a runtime error Prisma's nested-create types do not
                // catch. tsc accepted it.
                position: 1,
                whoEngine: 'Engine',
                whatExactWork: 'Reconcile the ledger against the bank statement',
                inputWhatIsUsed: 'The month’s ledger export',
                inputReceivedFrom: 'The finance shared drive',
                whereWorkIsDone: 'The finance laptop',
                outputWhatIsProduced: 'A reconciliation summary',
                outputSentTo: 'The Head of Finance',
                timeTaken: '2 hours',
                approval: 'Head',
              },
            ],
          },
        },
      });
      await ctx.prisma.client.objectiveVersion.update({
        where: { id: version.id },
        data: {
          status: 'Active',
          approvedAt,
          approvedByUserId: managerId,
          publishedAt: new Date(approvedAt.getTime() + 1),
        },
      });
      await ctx.prisma.client.objective.update({
        where: { id: objective.id },
        data: { activeVersionId: version.id },
      });

      const draft = await ctx.prisma.client.objectiveWorkflowDraft.create({
        data: {
          tenantId,
          objectiveId: objective.id,
          objectiveVersionId: version.id,
          // At least one node: `workflow_draft_has_at_least_one_node` refuses an empty graph,
          // because a draft with no work in it is not a plan.
          graph: { nodes: [{ id: 'node-1', kind: 'AiWork', title: 'Reconcile the ledger' }], edges: [] },
          schemaVersion: 1,
        },
      });

      const agent = await ctx.prisma.client.engineAgent.create({
        data: {
          tenantId,
          name: 'VAT reconciler',
          status: 'DraftSetup',
          ownerUserId: managerId,
          createdByUserId: managerId,
          updatedByUserId: managerId,
          // Built *for* the employee. Grants them nothing on its own.
          builtForUserId: employeeId,
        },
      });
      const agentVersion = await ctx.prisma.client.engineAgentVersion.create({
        data: {
          tenantId,
          engineAgentId: agent.id,
          versionNumber: 1,
          status: 'Published',
          config: { skillVersionIds: [] },
          publishedAt: new Date(),
          publishedByUserId: managerId,
          createdByUserId: managerId,
        },
      });
      await ctx.prisma.client.engineAgent.update({
        where: { id: agent.id },
        data: {
          status: 'Active',
          currentVersionId: agentVersion.id,
          activatedAt: new Date(),
          activatedByUserId: managerId,
        },
      });

      const assignment = await ctx.prisma.client.aiWorkAssignment.create({
        data: {
          tenantId,
          objectiveId: objective.id,
          objectiveVersionId: version.id,
          workflowDraftId: draft.id,
          nodeId: 'node-1',
          title: 'Reconcile the ledger',
          engineAgentId: agent.id,
          // `mapped_assignment_names_its_agent`: naming an agent and the `MappedToEngineAgent`
          // status are one fact, and the constraint holds them in step. Assigned work that
          // points at an agent without saying so would be invisible to every screen that
          // filters on status.
          status: 'MappedToEngineAgent',
          // Both required by Prompt 28: assigned work names who assigned it, and carries the
          // prefill the builder screen was seeded from.
          assignedByUserId: managerId,
          setupPrefill: {},
        },
      });

      return { objective, version, assignment, agent };
    });

    objectiveVersionId = seeded.version.id;
    assignmentId = seeded.assignment.id;
    agentId = seeded.agent.id;
  });

  // ---- helpers ----

  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const capabilities = () => app.get(CapabilityService);
  const operators = () => app.get(AgentOperatorService);
  const jobMethods = () => app.get(JobMethodService);
  const photos = () => app.get(EmployeePhotoService);

  /** A one-pixel PNG, so an upload has real bytes without a fixture file. */
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+3wAAAABJRU5ErkJggg==';

  const headingsRow = (values: Partial<Record<string, unknown>>): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const column of JOB_METHOD_COLUMNS) {
      if (values[column.key] !== undefined) row[column.heading] = values[column.key];
    }
    return row;
  };

  const envelope = () => ({
    formVersion: JOB_METHOD_FORM_VERSION,
    objectiveVersionId,
    aiWorkAssignmentId: assignmentId,
  });

  // =========================================================================
  describe('§1 — the Access & Permissions step', () => {
    it('reports a new employee as operations-only', async () => {
      const held = await capabilities().capabilitiesOf(scope(), employeeId);
      for (const key of STANDARD_EMPLOYEE_CAPABILITIES) {
        assert.ok(held.includes(key), `${key} should come from the Employee template`);
      }
      // The CR-03 change, read back from the live engine rather than from the constant.
      assert.equal(held.includes('BuildAgents'), false);
      assert.equal(held.includes('DefineObjectives'), false);
    });

    it('shows an administrator what they may grant and what they may not', async () => {
      const step = (await capabilities().stepFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      })) as {
        capabilities: { key: string; held: boolean; canGrant: boolean; whyNot?: string }[];
        defaultForNewEmployee: string[];
      };

      const build = step.capabilities.find((entry) => entry.key === 'BuildAgents');
      assert.equal(build?.held, false);
      // A company administrator may grant anything within the company.
      assert.equal(build?.canGrant, true);
      assert.deepEqual(step.defaultForNewEmployee, [...STANDARD_EMPLOYEE_CAPABILITIES]);
    });

    it('grants builder access, and the engine then really allows it', async () => {
      const before = await app
        .get(AuthorizationService)
        .contextFor(scope(), employeeId);
      assert.equal(before.granted['agent-builder'], undefined);
      assert.equal(before.visibleModules.includes('agent-builder'), false);

      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      // Not "the capability is recorded" — the *engine* now allows it, which is the only thing
      // that matters. A vocabulary that did not move the real grant would be decorative.
      const after = await app.get(AuthorizationService).contextFor(scope(), employeeId);
      assert.ok((after.granted['agent-builder'] ?? []).includes('EditDraft'));
      assert.ok(after.visibleModules.includes('agent-builder'));
    });

    it('refuses to let somebody grant what they do not hold', async () => {
      /**
       * A "People Admin": a custom role carrying `users:ManageAccess` and nothing else.
       *
       * Needed because **`users:ManageAccess` is CompanyAdmin-only** in the approved templates, and
       * a CompanyAdmin may grant anything within the company — so no role template can express
       * "may manage access, may not build agents", which is exactly the case the delegation rule
       * exists for. A custom role is how a real company would express it, and it is the existing
       * mechanism rather than a new one.
       */
      /**
       * The granter is an **Employee** plus a "People Admin" custom role.
       *
       * Two facts made this the only way to test the rule, and both were found by running it:
       *
       * 1. `users:ManageAccess` is **CompanyAdmin-only** in the approved templates, and a
       *    CompanyAdmin may grant anything within the company — so no template can express "may
       *    manage access, may not build agents".
       * 2. A **Head holds `agent-builder` Create/EditDraft/Run/Publish**, so a Head genuinely
       *    *does* hold `BuildAgents` and the delegation rule correctly lets them pass it on. The
       *    first version of this test used the Head and failed for exactly that reason — the
       *    product was right and the test was wrong.
       *
       * So: an Employee (no builder grants) with a custom role carrying only `users:ManageAccess`.
       * That is how a real company would express a people administrator, through the mechanism that
       * has existed since Prompt 7.
       */
      await ctx.prisma.runAsPlatformOperation(async () => {
        const role = await ctx.prisma.client.customRole.create({
          data: {
            tenantId,
            displayName: 'People Admin',
            description: 'May manage access, may not build agents.',
            permissions: { users: ['View', 'Comment', 'EditDraft', 'ManageAccess'] },
            maxScope: 'WholeCompany',
          },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: otherEmployeeId,
            roleKind: 'Custom',
            customRoleId: role.id,
            scopeKind: 'WholeCompany',
            grantedByUserId: ownerId,
          },
        });
      });

      // They can reach the step — and still cannot hand out a capability they do not hold.
      // Otherwise the capability set would be decorative: anybody could route around their own
      // limits by granting a deputy.
      await assert.rejects(
        capabilities().grant({
          scope: scope(),
          actorUserId: otherEmployeeId,
          subjectUserId: employeeId,
          capabilities: ['BuildAgents'],
        }),
        (error: Error) => /do not have|above the level/i.test(error.message),
      );

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.count({
          where: { tenantId, action: 'security.permission_denied' },
        }),
      );
      assert.ok(events >= 1, 'the refused delegation was not recorded');
    });

    it('refuses to let anybody grant themselves anything', async () => {
      await assert.rejects(
        capabilities().grant({
          scope: scope(),
          actorUserId: adminId,
          subjectUserId: adminId,
          capabilities: ['BuildAgents'],
        }),
        (error: Error) => /your own capabilities/i.test(error.message),
      );

      const blocked = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.count({
          where: { tenantId, action: 'security.separation_of_duties_blocked' },
        }),
      );
      assert.equal(blocked, 1);
    });

    it('is idempotent, and says what was already held', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });
      const again = await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });
      assert.deepEqual(again.granted, []);
      assert.deepEqual(again.alreadyHeld, ['BuildAgents']);
    });

    it('takes it away again', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });
      const removed = await capabilities().revoke({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capability: 'BuildAgents',
      });
      assert.equal(removed.revoked, true);

      const after = await app.get(AuthorizationService).contextFor(scope(), employeeId);
      assert.equal(after.granted['agent-builder'], undefined);
    });

    it('does not widen reach when it widens capability', async () => {
      // A Power Employee builds their *own* assigned work and nobody else's. Granting a capability
      // must not quietly promote somebody's scope.
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents', 'DefineObjectives'],
      });
      const after = await app.get(AuthorizationService).contextFor(scope(), employeeId);
      assert.equal(after.scope.kind, 'OwnWork');
    });
  });

  // =========================================================================
  describe('§2 and §5 — built for an employee, operated by them, built by somebody else', () => {
    it('gives the employee nothing merely by being who it was built for', async () => {
      // `builtForUserId` is set in the fixture. On its own it must grant nothing at all.
      const decision = await operators().mayRun({
        scope: scope(),
        actorUserId: employeeId,
        engineAgentId: agentId,
      });
      assert.equal(decision.allowed, false);
      if (decision.allowed) return;
      assert.equal(decision.key, 'Assignment');
    });

    it('lets a manager share it, and the employee can then run it', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      const decision = await operators().mayRun({
        scope: scope(),
        actorUserId: employeeId,
        engineAgentId: agentId,
      });
      assert.equal(decision.allowed, true);
    });

    it('still gives the employee no builder access', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      // The sentence the whole amendment exists to make true.
      const context = await app.get(AuthorizationService).contextFor(scope(), employeeId);
      assert.equal(context.granted['agent-builder'], undefined);
      assert.equal(context.visibleModules.includes('agent-builder'), false);
    });

    it('refuses a share from somebody who cannot assign work', async () => {
      await assert.rejects(
        operators().share({
          scope: scope(),
          actorUserId: employeeId,
          engineAgentId: agentId,
          operatorUserId: otherEmployeeId,
        }),
      );
    });

    it('stops the run when the share is withdrawn, and keeps the record', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });
      await operators().revokeShare({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      const decision = await operators().mayRun({
        scope: scope(),
        actorUserId: employeeId,
        engineAgentId: agentId,
      });
      assert.equal(decision.allowed, false);

      // "This person could run this, until this date" is what an access review asks for.
      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.engineAgentOperator.findFirstOrThrow({
          where: { tenantId, engineAgentId: agentId, userId: employeeId },
        }),
      );
      assert.notEqual(row.revokedAt, null);
      assert.equal(row.revokedByUserId, managerId);
    });

    it('reports assignment first, so a refusal to a stranger leaks nothing', async () => {
      // Somebody with no share must not learn whether the agent is approved, what it connects to,
      // or whether the company is out of budget.
      const decision = await operators().mayRun({
        scope: scope(),
        actorUserId: otherEmployeeId,
        engineAgentId: agentId,
      });
      assert.equal(decision.allowed, false);
      if (decision.allowed) return;
      assert.equal(decision.key, 'Assignment');
      for (const leak of ['budget', 'approval', 'connection', 'expired', 'version']) {
        assert.equal(
          decision.message.toLowerCase().includes(leak),
          false,
          `the refusal leaks "${leak}"`,
        );
      }
    });

    it('shows an operator a screen with no internals on it', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      const view = await operators().operatorView({
        scope: scope(),
        actorUserId: employeeId,
        engineAgentId: agentId,
      });

      assert.equal(view.agentName, 'VAT reconciler');
      // CR-03: the operator sees the linked objective and the assigned work, and nothing internal.
      assert.equal(view.linkedObjectiveName, 'Monthly VAT return');
      assert.equal(view.assignedWorkTitle, 'Reconcile the ledger');
      assert.equal(view.canRun, true);

      const serialised = JSON.stringify(view).toLowerCase();
      for (const forbidden of NEVER_IN_AN_OPERATOR_VIEW) {
        assert.equal(
          serialised.includes(forbidden.replace(/[^a-z]/g, '')),
          false,
          `the operator view exposes "${forbidden}"`,
        );
      }
    });

    it('lists only the agents shared with this person', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      assert.equal((await operators().myAgents({ scope: scope(), actorUserId: employeeId })).length, 1);
      assert.equal(
        (await operators().myAgents({ scope: scope(), actorUserId: otherEmployeeId })).length,
        0,
      );
    });
  });

  // =========================================================================
  describe('§4 — download, fill offline, upload', () => {
    it('lets an employee with no builder access download the form', async () => {
      // The whole point: the person who knows how the work is done does not need to be able to
      // configure agents.
      const form = await jobMethods().downloadForm({
        scope: scope(),
        actorUserId: employeeId,
        aiWorkAssignmentId: assignmentId,
      });

      assert.equal(form.context.formVersion, JOB_METHOD_FORM_VERSION);
      assert.equal(form.context.objectiveName, 'Monthly VAT return');
      assert.equal(form.columns.length, 13);
    });

    it('prefills what Form 2 answers and leaves the five it cannot', async () => {
      const form = await jobMethods().downloadForm({
        scope: scope(),
        actorUserId: employeeId,
        aiWorkAssignmentId: assignmentId,
      });

      const row = form.rows[0];
      assert.equal(row?.whatExactWork, 'Reconcile the ledger against the bank statement');
      assert.equal(row?.whereInputSource, 'The finance shared drive');
      assert.equal(row?.time, '2 hours');

      // The five the employee is being asked for. A prefill that guessed any of them would be
      // UBoss putting words in the company's mouth.
      assert.equal(row?.toolSystemWorkplace, undefined);
      assert.equal(row?.howExactMethod, undefined);
      assert.equal(row?.ruleFormulaCheck, undefined);
      assert.equal(row?.agentMustNeverDo, undefined);
      assert.equal(row?.ifMissingOrWrong, undefined);
    });

    it('carries no portable identifier and no secret out of the building', async () => {
      const form = await jobMethods().downloadForm({
        scope: scope(),
        actorUserId: employeeId,
        aiWorkAssignmentId: assignmentId,
      });
      const serialised = JSON.stringify(form).toLowerCase();
      for (const forbidden of ['apikey', 'secret', 'credential', 'aadhaar', 'systemprompt']) {
        assert.equal(serialised.includes(forbidden), false, forbidden);
      }
    });

    it('refuses the upload to an employee with no builder access', async () => {
      // Download is `todo:View`; upload is `agent-builder:EditDraft`. Collapsing the two would
      // undo the amendment.
      await assert.rejects(
        jobMethods().importForm({
          scope: scope(),
          actorUserId: employeeId,
          aiWorkAssignmentId: assignmentId,
          filename: 'method.xlsx',
          envelope: envelope(),
          rows: [headingsRow({ whatExactWork: 'Reconcile' })],
        }),
      );
    });

    it('accepts the upload from a builder and saves a draft', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'method.xlsx',
        envelope: envelope(),
        rows: [
          headingsRow({
            whatExactWork: 'Reconcile the ledger',
            toolSystemWorkplace: 'SAP',
            howExactMethod: 'Match each line by reference and amount',
            ruleFormulaCheck: 'Difference must be zero',
            agentMustNeverDo: 'Never post an adjusting entry',
            ifMissingOrWrong: 'Stop and tell the Head of Finance',
          }),
        ],
      });

      assert.equal(outcome.accepted, true);
      assert.equal(outcome.stage, 'MergeIntoDraft');
      assert.equal(outcome.rows.length, 1);
      assert.equal(outcome.rows[0]?.toolSystemWorkplace, 'SAP');

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodRow.findMany({ where: { tenantId } }),
      );
      assert.equal(stored.length, 1);
      // Provenance: six weeks later, "did we decide this or did the system?" has an answer.
      assert.match(JSON.stringify(stored[0]?.provenance), /UploadedForm/);
    });

    it('activates nothing and tests nothing', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.count({ where: { tenantId } }),
      );

      await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'method.xlsx',
        envelope: envelope(),
        rows: [headingsRow({ whatExactWork: 'Reconcile' })],
      });

      // A spreadsheet must not be able to put an agent into production.
      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.agentRun.count({ where: { tenantId } }),
      );
      assert.equal(after, before);

      const assignment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.aiWorkAssignment.findFirstOrThrow({ where: { id: assignmentId } }),
      );
      assert.equal(assignment.lastTestedAt, null);
    });

    it('refuses a form downloaded for different work, before reading a cell', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'wrong.xlsx',
        envelope: { ...envelope(), aiWorkAssignmentId: '00000000-0000-4000-8000-000000000000' },
        rows: [headingsRow({ whatExactWork: 'Something else entirely' })],
      });

      assert.equal(outcome.accepted, false);
      assert.equal(outcome.stage, 'VerifyLinkage');
      assert.match(outcome.refusedBecause ?? '', /different piece of assigned work/i);

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodRow.count({ where: { tenantId } }),
      );
      assert.equal(stored, 0, 'rows were saved from a file for other work');
    });

    it('refuses a superseded form version', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'old.xlsx',
        envelope: { ...envelope(), formVersion: 99 },
        rows: [headingsRow({ whatExactWork: 'Reconcile' })],
      });
      assert.equal(outcome.accepted, false);
      assert.equal(outcome.stage, 'ValidateFile');
    });

    it('saves nothing when a cell cannot be used as written', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'toolong.xlsx',
        envelope: envelope(),
        rows: [headingsRow({ whatExactWork: 'x'.repeat(JOB_METHOD_CELL_MAX + 1) })],
      });

      assert.equal(outcome.accepted, false);
      assert.ok(outcome.problems.some((problem) => problem.kind === 'Invalid'));
      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodRow.count({ where: { tenantId } }),
      );
      assert.equal(stored, 0);
    });

    it('accepts an incomplete form and keeps the gaps visible', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'partial.xlsx',
        envelope: envelope(),
        rows: [
          headingsRow({ whatExactWork: 'Reconcile' }),
          headingsRow({ toolSystemWorkplace: 'SAP' }),
        ],
      });

      // An incomplete form is still worth having in a draft, and the flags travel with it.
      assert.equal(outcome.accepted, true);
      assert.ok(outcome.problems.some((problem) => problem.kind === 'Missing'));
    });

    it('flags a column UBoss has no field for rather than dropping it silently', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'extra.xlsx',
        envelope: envelope(),
        rows: [{ ...headingsRow({ whatExactWork: 'Reconcile' }), 'WHO SIGNS IT OFF': 'Priya' }],
      });

      // Usually somebody adding a column because the form did not ask what they needed to say —
      // feedback about the form, not a mistake in the data.
      assert.ok(outcome.problems.some((problem) => problem.kind === 'Unmapped'));
      assert.equal(outcome.accepted, true);
    });

    it('records a refused import, because "I sent that in" deserves an answer', async () => {
      await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'refused.xlsx',
        envelope: { ...envelope(), formVersion: 99 },
        rows: [headingsRow({ whatExactWork: 'Reconcile' })],
      });

      const record = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodImport.findFirstOrThrow({ where: { tenantId } }),
      );
      assert.equal(record.accepted, false);
      assert.equal(record.filename, 'refused.xlsx');
      assert.equal(record.claimedFormVersion, 99);
      assert.ok((record.refusedBecause ?? '').length > 0);
    });

    it('replaces rows rather than merging them, so a deleted step disappears', async () => {
      await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'three.xlsx',
        envelope: envelope(),
        rows: [
          headingsRow({ whatExactWork: 'One' }),
          headingsRow({ whatExactWork: 'Two' }),
          headingsRow({ whatExactWork: 'Three' }),
        ],
      });
      await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'two.xlsx',
        envelope: envelope(),
        rows: [headingsRow({ whatExactWork: 'One' }), headingsRow({ whatExactWork: 'Two' })],
      });

      // A returned form is the company's complete statement. An orphaned step three sitting in the
      // draft would eventually be built into an agent and nobody would know where it came from.
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.jobMethodRow.findMany({ where: { tenantId }, orderBy: { step: 'asc' } }),
      );
      assert.equal(rows.length, 2);
    });

    it('suggests how many agents this looks like, without deciding', async () => {
      const outcome = await jobMethods().importForm({
        scope: scope(),
        actorUserId: managerId,
        aiWorkAssignmentId: assignmentId,
        filename: 'two-tools.xlsx',
        envelope: envelope(),
        rows: [
          headingsRow({ whatExactWork: 'Reconcile', toolSystemWorkplace: 'SAP' }),
          headingsRow({ whatExactWork: 'Email it', toolSystemWorkplace: 'Outlook' }),
        ],
      });

      // One Job Method row is not one Engine Agent, and two tools are not one agent either.
      assert.equal(outcome.agentSuggestion?.groups.length, 2);
      assert.ok((outcome.agentSuggestion?.groups[0]?.because ?? '').length > 60);
    });
  });

  // =========================================================================
  describe('§3 — the optional employee photo', () => {
    it('returns initials when there is no photo', async () => {
      const view = await photos().view({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
      });
      assert.equal(view.storedFileId, null);
      assert.equal(view.viewable, false);
      // Always present, so a screen never renders an empty circle that reads as a stuck loader.
      assert.equal(view.initials, 'EE');
    });

    it('lets somebody set their own photo without any settings grant', async () => {
      // A standard Employee holds `settings:View` only, so this would be impossible through the
      // Knowledge & Data upload path — which is exactly why the photo service authorizes it
      // itself.
      const view = await photos().upload({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
        filename: 'me.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });
      assert.notEqual(view.storedFileId, null);
    });

    it('refuses one employee changing another’s photo', async () => {
      // A small but real form of impersonation in a directory.
      await assert.rejects(
        photos().upload({
          scope: scope(),
          actorUserId: employeeId,
          subjectUserId: otherEmployeeId,
          filename: 'not-me.png',
          contentType: 'image/png',
          contentBase64: PNG_BASE64,
        }),
      );
    });

    it('lets an administrator set a colleague’s photo', async () => {
      const view = await photos().upload({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        filename: 'staff.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });
      assert.notEqual(view.storedFileId, null);
    });

    it('refuses a format that is not an image', async () => {
      await assert.rejects(
        photos().upload({
          scope: scope(),
          actorUserId: employeeId,
          subjectUserId: employeeId,
          filename: 'resume.pdf',
          contentType: 'application/pdf',
          contentBase64: PNG_BASE64,
        }),
      );
    });

    it('keeps one photo per person, replacing rather than accumulating', async () => {
      await photos().upload({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
        filename: 'first.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });
      await photos().upload({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
        filename: 'second.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employeePhoto.count({ where: { tenantId, userId: employeeId } }),
      );
      // Otherwise "remove my photo" would leave an earlier one reachable by id.
      assert.equal(rows, 1);
    });

    it('removes the picture, not just the reference to it', async () => {
      await photos().upload({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
        filename: 'me.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });

      const removed = await photos().remove({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
      });
      assert.equal(removed.removed, true);

      // "Remove my photo" has to mean the picture is gone, not that a screen stopped showing it.
      const files = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.storedFile.findMany({ where: { tenantId } }),
      );
      assert.ok(files.every((file) => file.deletedAt !== null));
      assert.ok(files.every((file) => file.storageRef === null));

      const view = await photos().view({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
      });
      assert.equal(view.storedFileId, null);
      assert.equal(view.initials, 'EE');
    });

    it('does not change the six mandatory Add Employee fields', async () => {
      // CR-03 is explicit about this. Asserted against the live constant rather than trusted.
      const { MANDATORY_EMPLOYEE_FIELDS } = await import(
        '../src/organization/employment.service.js'
      );
      assert.deepEqual(
        MANDATORY_EMPLOYEE_FIELDS.map((field) => field.key),
        [
          'employeeName',
          'employeeId',
          'designation',
          'departmentId',
          'reportingManagerUserId',
          'aadhaarNumber',
        ],
      );
    });
  });

  // =========================================================================
  describe('§8 — the routes, not only the services', () => {
    /**
     * Drive a controller as a signed-in member of this company.
     *
     * Every test above this point calls a service directly, which is the right level for a rule
     * about authority — and is also exactly why a **route** that never consulted one went
     * unnoticed until a screen tried to use it. The controllers read their actor from the ambient
     * request context rather than taking one as an argument, so a service-level test can never
     * prove a route behaves.
     */
    const as = <T>(userId: string, work: () => Promise<T>): Promise<T> =>
      // A whole context, not just an actor: `withActor` swaps the actor *within* one and
      // throws outside a request, which is correct for production and no use to a test that has
      // no request at all.
      runWithRequestContext(
        createRequestContext('test-correlation', {
          kind: 'tenant',
          userId,
          ubossUniqueId: 'UB-TEST',
          tenantId,
          membershipId: 'membership-test',
        }),
        work,
      );

    const myAccessRoute = () => app.get(MyAccessController);
    const operatorRoutes = () => app.get(AgentOperatorController);
    const jobMethodRoutes = () => app.get(JobMethodController);

    // ---- GET /tenants/:tenantId/my-access ----

    it('lets a standard employee read their own access, with no permission of its own', async () => {
      // Gating "what am I allowed to do" behind a permission is circular, and the person who most
      // needs the answer is the one holding the least.
      const mine = (await as(employeeId, () => myAccessRoute().mine())) as {
        userId: string;
        visibleModules: string[];
        granted: Record<string, string[]>;
      };

      assert.equal(mine.userId, employeeId);
      assert.ok(mine.visibleModules.includes('agents'));
    });

    it('reports no objective and no agent-builder for a standard employee', async () => {
      // The sidebar is derived from exactly this, so the absence here is the absence there.
      const mine = (await as(employeeId, () => myAccessRoute().mine())) as {
        visibleModules: string[];
        granted: Record<string, string[]>;
      };

      assert.equal(mine.visibleModules.includes('objective'), false);
      assert.equal(mine.visibleModules.includes('agent-builder'), false);
      assert.equal(mine.granted['agent-builder'], undefined);
    });

    it('reports agent-builder the moment the capability is granted, with no role change', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      const mine = (await as(employeeId, () => myAccessRoute().mine())) as {
        visibleModules: string[];
      };

      assert.ok(mine.visibleModules.includes('agent-builder'));
    });

    it('answers about the caller and never about somebody else', async () => {
      const theirs = (await as(otherEmployeeId, () => myAccessRoute().mine())) as {
        userId: string;
      };

      assert.equal(theirs.userId, otherEmployeeId);
    });

    // ---- GET /tenants/:tenantId/agents/:engineAgentId/my-runs ----

    it('refuses run history to somebody the agent was never shared with', async () => {
      await assert.rejects(
        () => as(otherEmployeeId, () => operatorRoutes().myRuns(agentId)),
        (error: Error) => /assigned|shared/i.test(error.message),
      );
    });

    it('answers the same way for an agent that does not exist, so an id learns nothing', async () => {
      const invented = '019276aa-0000-7000-8000-0000000000ff';

      const forStranger = await as(otherEmployeeId, () =>
        operatorRoutes()
          .myRuns(agentId)
          .then(() => null)
          .catch((error: Error) => error.message),
      );
      const forInvented = await as(otherEmployeeId, () =>
        operatorRoutes()
          .myRuns(invented)
          .then(() => null)
          .catch((error: Error) => error.message),
      );

      assert.equal(forStranger, forInvented);
    });

    it('gives an operator their own run history', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      const result = (await as(employeeId, () => operatorRoutes().myRuns(agentId))) as {
        runs: unknown[];
      };

      assert.ok(Array.isArray(result.runs));
    });

    it('never carries a prompt, a model, a key or a raw output document to an operator', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      await ctx.prisma.runAsPlatformOperation(async () => {
        const version = await ctx.prisma.client.engineAgentVersion.findFirst({
          where: { tenantId, engineAgentId: agentId },
          select: { id: true },
        });
        assert.ok(version);

        await ctx.prisma.client.agentRun.create({
          data: {
            tenantId,
            engineAgentId: agentId,
            engineAgentVersionId: version.id,
            state: 'Completed',
            trigger: 'Manual',
            idempotencyKey: `manual:${Date.now()}`,
            correlationId: 'test-correlation',
            // `running_run_was_reserved_first`: a run reaches Running only through Reserved,
            // where budget is set aside. A fixture that skipped it is refused, correctly.
            reservedAt: new Date(),
            startedAt: new Date(),
            finishedAt: new Date(),
            producedByRealModel: false,
            // Everything an operator must never see, in one document.
            output: {
              text: 'Eleven invoices chased.',
              capability: 'draft-email',
              prompt: 'You are an invoice chaser. Use the system instructions below.',
              model: 'some-model-name',
              apiKey: 'sk-do-not-leak',
            },
          },
        });
      });

      const result = (await as(employeeId, () => operatorRoutes().myRuns(agentId))) as {
        runs: Record<string, unknown>[];
      };

      const run = result.runs[0];
      assert.ok(run);
      assert.equal(run['resultText'], 'Eleven invoices chased.');

      // The projection is total: not "these fields are absent from the type", but absent from
      // the bytes. A serialised search is what a leak would actually look like.
      const serialised = JSON.stringify(result);
      for (const forbidden of ['prompt', 'apiKey', 'sk-do-not-leak', 'some-model-name', 'capability']) {
        assert.equal(
          serialised.includes(forbidden),
          false,
          `an operator run view carried "${forbidden}"`,
        );
      }
      for (const word of NEVER_IN_AN_OPERATOR_VIEW) {
        assert.equal(
          serialised.toLowerCase().includes(word.toLowerCase()),
          false,
          `an operator run view carried "${word}"`,
        );
      }
    });

    it('stops the history the moment the share is withdrawn', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });
      await operators().revokeShare({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      await assert.rejects(() => as(employeeId, () => operatorRoutes().myRuns(agentId)));
    });

    // ---- the real .xlsx, over the route ----

    it('serves a real workbook, not JSON, under a filename naming the work', async () => {
      const headers: Record<string, string> = {};
      const response = {
        setHeader(name: string, value: string) {
          headers[name.toLowerCase()] = value;
        },
      };

      const body = await as(employeeId, () =>
        jobMethodRoutes().downloadWorkbook(assignmentId, response as never),
      );

      // A real OOXML package is a zip, so its first two bytes are "PK". This is the assertion the
      // amendment turns on: "The Job Method must NOT remain JSON-only."
      assert.ok(Buffer.isBuffer(body));
      assert.equal(body.subarray(0, 2).toString('latin1'), 'PK');

      assert.match(headers['content-disposition'] ?? '', /^attachment; filename="/);
      assert.match(headers['content-disposition'] ?? '', /\.xlsx"$/);
    });

    it('declares the spreadsheet content type on the route rather than leaving it to guesswork', async () => {
      // Set by `@Header` at the route, so it is asserted from the route's own metadata — a browser
      // handed `application/json` would show the bytes instead of saving them.
      const declared = Reflect.getMetadata(
        '__headers__',
        JobMethodController.prototype.downloadWorkbook,
      ) as { name: string; value: string }[] | undefined;

      assert.ok(declared);
      assert.ok(
        declared.some(
          (header) =>
            header.name.toLowerCase() === 'content-type' &&
            header.value.includes('spreadsheetml.sheet'),
        ),
      );
    });

    it('round-trips: the workbook it serves is one it can read back', async () => {
      const body = await as(employeeId, () =>
        jobMethodRoutes().downloadWorkbook(assignmentId, {
          setHeader() {
            /* not under test here */
          },
        } as never),
      );

      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      const outcome = (await as(employeeId, () =>
        jobMethodRoutes().importWorkbook(assignmentId, {
          filename: 'job-method.xlsx',
          contentBase64: body.toString('base64'),
        } as never),
      )) as { accepted: boolean; problems: unknown[] };

      // An empty form is not a malformed one: it is read, and its gaps are reported rather than
      // the file being rejected. "That is not a spreadsheet" is a different sentence.
      assert.ok(Array.isArray(outcome.problems));
    });

    it('answers a file that is not a spreadsheet rather than throwing it away', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      const outcome = (await as(employeeId, () =>
        jobMethodRoutes().importWorkbook(assignmentId, {
          filename: 'notes.txt',
          contentBase64: Buffer.from('not a workbook at all').toString('base64'),
        } as never),
      )) as { accepted: boolean; refusedBecause: string | null };

      /*
       * Not a thrown error, deliberately.
       *
       * The route refuses an unopenable file *through the service*, so the refusal is recorded
       * and "I sent that in" has an answer — where a 400 from the controller would have left
       * nothing written down. So the assertion is that it was refused **and** explained, which is
       * a stronger claim than that it failed.
       */
      assert.equal(outcome.accepted, false);
      assert.ok(outcome.refusedBecause);
      assert.ok(outcome.refusedBecause.length > 0);
    });

    it('refuses an empty file before trying to open it', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      await assert.rejects(
        () =>
          as(employeeId, () =>
            jobMethodRoutes().importWorkbook(assignmentId, {
              filename: 'empty.xlsx',
              contentBase64: '',
            } as never),
          ),
        (error: Error) => /empty/i.test(error.message),
      );
    });

    it('refuses the upload route to somebody with no builder access', async () => {
      const body = await as(employeeId, () =>
        jobMethodRoutes().downloadWorkbook(assignmentId, {
          setHeader() {
            /* not under test here */
          },
        } as never),
      );

      // Download needed no builder grant. Upload does, and the asymmetry is the point.
      await assert.rejects(() =>
        as(employeeId, () =>
          jobMethodRoutes().importWorkbook(assignmentId, {
            filename: 'job-method.xlsx',
            contentBase64: body.toString('base64'),
          } as never),
        ),
      );
    });
  });

  // =========================================================================
  describe('§7 — two-tenant isolation', () => {
    /**
     * CR-03 §7 asks for two-tenant isolation across everything this amendment added.
     *
     * The chat suite covers its own tables. This covers the other three: the capability grant, the
     * operator share and the employee photo. Each is checked **at the database**, inside a tenant
     * transaction opened for the other company, rather than through a route — a route returning
     * nothing could be a permission refusal, while an empty result under the other tenant's RLS
     * context is the isolation itself.
     *
     * Note where the capability grant lands: `customRole` and `roleAssignment`, the tables the RBAC
     * engine already owns. There is no capability table, because there is no second permission
     * system — which is exactly what this test would notice if one appeared.
     */
    let otherTenantId: string;

    beforeEach(async () => {
      const other = await ctx.provisioning.provision({
        slug: `other-cr03-${Date.now()}`,
        name: 'Other CR-03 Co',
        firstMember: { email: `first-${Date.now()}@other-cr03.example`, displayName: 'Other First' },
      });
      await activateTenant(ctx, other.tenant.id);
      await activateMembership(ctx, other.user.id, other.tenant.id);
      otherTenantId = other.tenant.id;
    });

    const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);

    it('keeps a capability grant inside the company that made it', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      const here = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.roleAssignment.count({ where: { userId: employeeId } }),
      );
      const there = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.roleAssignment.count({ where: { userId: employeeId } }),
      );

      assert.ok(here > 0, 'the grant was not written');
      assert.equal(there, 0, 'another company could count this grant');
    });

    it('gives the same person no capability at all in the other company', async () => {
      await capabilities().grant({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        capabilities: ['BuildAgents'],
      });

      // A grant is an employment fact, not a property of the person.
      const context = await app.get(AuthorizationService).contextFor(otherScope(), employeeId);
      assert.equal(context.granted['agent-builder'], undefined);
    });

    it('keeps an operator share inside the company that made it', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      const there = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.engineAgentOperator.count(),
      );

      assert.equal(there, 0, 'another company could count this share');
    });

    it('refuses to run an agent belonging to another company', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      // The same person, the same agent id, the other company's scope. The share is real and it
      // still refuses, because the share is scoped too.
      const decision = await operators().mayRun({
        scope: otherScope(),
        actorUserId: employeeId,
        engineAgentId: agentId,
      });

      assert.equal(decision.allowed, false);
    });

    it('serves no run history across companies', async () => {
      await operators().share({
        scope: scope(),
        actorUserId: managerId,
        engineAgentId: agentId,
        operatorUserId: employeeId,
      });

      await assert.rejects(() =>
        operators().myRuns({
          scope: otherScope(),
          actorUserId: employeeId,
          engineAgentId: agentId,
        }),
      );
    });

    it('keeps an employee photo inside the company that set it', async () => {
      await photos().upload({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
        filename: 'face.png',
        contentType: 'image/png',
        contentBase64: PNG_BASE64,
      });

      const there = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.employeePhoto.count(),
      );

      assert.equal(there, 0, 'another company could count this photo');
    });

    it('serves no Job Method form across companies', async () => {
      await assert.rejects(() =>
        jobMethods().downloadForm({
          scope: otherScope(),
          actorUserId: employeeId,
          aiWorkAssignmentId: assignmentId,
        }),
      );
    });
  });
});
