import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Controller, Get, type INestApplication, Post, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationController } from '../src/authorization/authorization.controller.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import {
  RequireAnyPermission,
  RequirePermission,
  RequireUserType,
} from '../src/authorization/authorization.decorators.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantScoped } from '../src/tenancy/tenancy.decorators.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';
import { WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
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
 * A controller that exists only in this suite, to exercise the decorators at the request layer.
 *
 * Declared here rather than shipped, for the same reason Prompt 4's guard tests declare their
 * own: proving the guard works needs a route that carries the decorators, and adding one to the
 * application would be a feature endpoint the prompt did not ask for.
 */
@Controller('test-authz')
@TenantScoped()
class PermissionProbeController {
  @Get('view-objective')
  @RequirePermission({ module: 'objective', action: 'View' })
  viewObjective() {
    return { reached: true };
  }

  @Post('approve-objective')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  approveObjective() {
    return { reached: true };
  }

  // ---- Prompt 40A ----
  //
  // The same probes on `agents`, which is what a standard Employee holds after CR-03. Added
  // rather than swapped: the `objective` routes above are still used by the custom-role tests,
  // where the grant comes from a stored matrix instead of the template.
  @Get('view-agents')
  @RequirePermission({ module: 'agents', action: 'View' })
  viewAgents() {
    return { reached: true };
  }

  @Post('approve-agents')
  @RequirePermission({ module: 'agents', action: 'Approve' })
  approveAgents() {
    return { reached: true };
  }

  @Get('either-agents')
  @RequireAnyPermission(
    { module: 'agents', action: 'Approve' },
    { module: 'agents', action: 'View' },
  )
  eitherAgents() {
    return { reached: true };
  }

  @Get('both-agents')
  @RequirePermission(
    { module: 'agents', action: 'View' },
    { module: 'agents', action: 'Approve' },
  )
  bothAgents() {
    return { reached: true };
  }

  @Post('administer-roles')
  @RequirePermission({ module: 'roles', action: 'Administer' })
  administerRoles() {
    return { reached: true };
  }

  @Get('either')
  @RequireAnyPermission(
    { module: 'objective', action: 'Approve' },
    { module: 'objective', action: 'View' },
  )
  either() {
    return { reached: true };
  }

  @Get('both')
  @RequirePermission(
    { module: 'objective', action: 'View' },
    { module: 'objective', action: 'Approve' },
  )
  both() {
    return { reached: true };
  }

  @Get('internal-only')
  @RequireUserType('InternalUser')
  internalOnly() {
    return { reached: true };
  }

  /** No authorization decorator: still tenancy-checked, never permission-checked. */
  @Get('undecorated')
  undecorated() {
    return { reached: true };
  }
}

/**
 * Authorization at the request layer, against real PostgreSQL.
 *
 * The engine itself is tested exhaustively as a pure function in `authorization-engine.spec.ts`.
 * This suite tests the parts that only exist once a database and a request are involved: the
 * guard, the context assembly, the three privilege-escalation gates on granting, Row-Level
 * Security on the authorization tables, and the TCSiON extension point.
 */
describe('authorization (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let employeeId: string;
  let employeeUboss: string;
  let managerId: string;
  let managerUboss: string;
  let guestId: string;
  let guestUboss: string;
  let platformUboss: string;

  const agent = () => request(app.getHttpServer());

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

    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [PermissionProbeController, AuthorizationController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuthorizationRepository,
        PlatformRepository,
        AuditTrailRepository,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        RoleAdministrationService,
        TcsionMappingService,
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
        // Ordered after TenantGuard, which is what guarantees a permission check only ever runs
        // on a route that has already established membership and lifecycle state.
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
      slug: 'authz-co',
      name: 'Authz Co',
      firstMember: { email: 'admin@authz.example', displayName: 'Admin' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-authz-co',
      name: 'Other Authz Co',
      firstMember: { email: 'admin@other.example', displayName: 'Other Admin' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (unique: string, email: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        employee: await make('UB-EMP1-0001', 'employee@authz.example', 'Employee'),
        manager: await make('UB-MGR1-0001', 'manager@authz.example', 'Manager'),
        guest: await make('UB-GST1-0001', 'guest@authz.example', 'Guest'),
      };
    });

    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    guestId = people.guest.id;
    guestUboss = people.guest.ubossUniqueId;

    // A guest carries a mandatory access expiry since Prompt 13, in both directions: a guest
    // must have one and nobody else may. An expiry that is optional is one somebody forgets, and
    // a guest account with no end date is the one still open two years after the project
    // finished — so the check constraint refuses this fixture without it.
    await ctx.admin.unsafeRootClient.tenantMembership.updateMany({
      where: { tenantId: provisioned.tenant.id, userId: guestId },
      data: {
        userType: 'ExternalGuest',
        guestAccessExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-PLAT-0007',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformUboss = platform.ubossUniqueId;
  });

  // ---- helpers ----

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const asPlatform = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', platformUboss) as T;

  const scope = () => tenantScopeForPlatformOperation(tenantId);

  const assign = async (userId: string, body: Record<string, unknown>, expected = 201) =>
    asPlatform(agent().post(`/tenants/${tenantId}/authorization/assignments`))
      .send({ userId, ...body })
      .expect(expected);

  // =========================================================================
  describe('the guard', () => {
    it('refuses someone with no role assignment at all', async () => {
      const response = await asPerson(
        agent().get('/test-authz/view-objective'),
        employeeUboss,
      ).expect(403);

      assert.match((response.body as { message: string }).message, /no role in this company/i);
    });

    it('permits an action the assigned role grants', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      // `agents` since CR-03: an Employee is operations-only, so the module they demonstrably
      // hold is the one their work lives in.
      const response = await asPerson(
        agent().get('/test-authz/view-agents'),
        employeeUboss,
      ).expect(200);

      assert.equal((response.body as { reached: boolean }).reached, true);
    });

    it('refuses an action the assigned role lacks, and says which', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      // The module is visible and the action is not granted, which is what makes the reason
      // `role-lacks-action` rather than "you cannot see this module at all" — the distinction
      // this test exists to pin.
      const response = await asPerson(
        agent().post('/test-authz/approve-agents'),
        employeeUboss,
      ).expect(403);

      assert.match((response.body as { message: string }).message, /does not include "Approve"/);
    });

    it('never leaks the decision trace in a 403', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const response = await asPerson(
        agent().post('/test-authz/approve-objective'),
        employeeUboss,
      ).expect(403);

      // The trace describes the company's policy configuration; a refused caller has no business
      // reading it.
      const serialised = JSON.stringify(response.body);
      assert.ok(!serialised.includes('trace'));
      assert.ok(!serialised.includes('decidedBy'));
    });

    it('leaves an undecorated route permission-unchecked but still tenancy-checked', async () => {
      // No @RequirePermission, so the permission guard passes it through — but TenantGuard still
      // demands a verified membership, so adding authorization cannot have opened it.
      await asPerson(agent().get('/test-authz/undecorated'), employeeUboss).expect(200);
      await agent().get('/test-authz/undecorated').expect(401);
    });

    it('treats several required permissions as ALL required', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      // Employee has View but not Approve, so the "both" route is refused.
      await asPerson(agent().get('/test-authz/both-agents'), employeeUboss).expect(403);
      await asPerson(agent().get('/test-authz/either-agents'), employeeUboss).expect(200);
    });

    it('enforces a user-type requirement independently of the role', async () => {
      await assign(guestId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const response = await asPerson(agent().get('/test-authz/internal-only'), guestUboss).expect(
        403,
      );

      assert.match((response.body as { message: string }).message, /kind of account/i);
    });

    it('unions several assignments', async () => {
      await assign(managerId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      // Employee alone cannot approve; Approver alone cannot be assigned Employee's modules.
      // Together, both routes pass phase 1.
      await asPerson(agent().get('/test-authz/view-objective'), managerUboss).expect(200);
      // 201: Nest's default for a POST, and the probe controller does not override it.
      await asPerson(agent().post('/test-authz/approve-objective'), managerUboss).expect(201);
    });

    it('stops granting once an assignment has expired', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      await asPerson(agent().get('/test-authz/view-agents'), employeeUboss).expect(200);

      await ctx.admin.unsafeRootClient.roleAssignment.updateMany({
        where: { tenantId, userId: employeeId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await asPerson(
        agent().get('/test-authz/view-agents'),
        employeeUboss,
      ).expect(403);
      assert.match((response.body as { message: string }).message, /no role in this company/i);
    });

    it('keeps an expired assignment on the record rather than deleting it', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      await ctx.admin.unsafeRootClient.roleAssignment.updateMany({
        where: { tenantId, userId: employeeId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const still = await ctx.admin.unsafeRootClient.roleAssignment.count({
        where: { tenantId, userId: employeeId },
      });
      assert.equal(still, 1, '"this person did have access, until this date" must survive');
    });
  });

  // =========================================================================
  describe('privilege-escalation gates on granting', () => {
    it('refuses an assignment wider than the role supports', async () => {
      const response = await assign(
        employeeId,
        { roleKind: 'Employee', scopeKind: 'WholeCompany' },
        400,
      );

      assert.match((response.body as { message: string }).message, /widest it supports is OwnWork/);
    });

    it('caps an over-wide assignment at read time too, if one is written directly', async () => {
      // Belt and braces: the API refuses it, and the engine caps it. A row written by any other
      // path — a migration, a console — still cannot over-grant.
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      await ctx.admin.unsafeRootClient.roleAssignment.updateMany({
        where: { tenantId, userId: employeeId },
        data: { scopeKind: 'WholeCompany' },
      });

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), employeeId);

      assert.equal(context.scope.kind, 'OwnWork', 'the engine caps it back to the role ceiling');
    });

    it('refuses self-assignment outright', async () => {
      // The shortest escalation path in any RBAC system.
      const response = await asPlatform(
        agent().post(`/tenants/${tenantId}/authorization/assignments`),
      )
        .send({
          userId: await platformUserId(),
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
        })
        .expect(400);

      assert.match(
        (response.body as { message: string }).message,
        /cannot assign a role to yourself/i,
      );
    });

    it('refuses a role for someone who is not a member', async () => {
      const outsider = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId: otherTenantId },
      });

      await assign(outsider?.userId as string, { roleKind: 'Employee', scopeKind: 'OwnWork' }, 404);
    });

    it('refuses a role for an offboarded person', async () => {
      await ctx.admin.unsafeRootClient.tenantMembership.updateMany({
        where: { tenantId, userId: employeeId },
        data: { accountState: 'Offboarded' },
      });

      const response = await assign(
        employeeId,
        { roleKind: 'Employee', scopeKind: 'OwnWork' },
        400,
      );
      assert.match((response.body as { message: string }).message, /Offboarded/);
    });

    it('refuses a department scope with no department', async () => {
      await assign(managerId, { roleKind: 'Head', scopeKind: 'Department' }, 400);
    });

    it('refuses a selected-resource scope with nothing selected', async () => {
      await assign(managerId, { roleKind: 'Approver', scopeKind: 'SelectedResource' }, 400);
    });

    it('refuses a Custom assignment that names no custom role', async () => {
      await assign(employeeId, { roleKind: 'Custom', scopeKind: 'OwnWork' }, 400);
    });

    it('refuses a built-in assignment that also names a custom role', async () => {
      const role = await createCustomRole({ objective: ['View'] });
      await assign(
        employeeId,
        { roleKind: 'Employee', scopeKind: 'OwnWork', customRoleId: role },
        400,
      );
    });

    it('refuses an expiry in the past', async () => {
      await assign(
        employeeId,
        {
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
        400,
      );
    });

    it('records every grant and revocation as suspicious activity', async () => {
      const created = await assign(employeeId, {
        roleKind: 'Employee',
        scopeKind: 'OwnWork',
        justification: 'Joined the delivery team.',
      });

      await asPlatform(
        agent().delete(
          `/tenants/${tenantId}/authorization/assignments/${(created.body as { id: string }).id}`,
        ),
      ).expect(204);

      // ADR-045 (Prompt 8): `security.*` events now live in `security_events`, not in
      // `audit_events`. Only the destination changed — the events themselves are the same.
      const actions = (
        await ctx.admin.unsafeRootClient.securityEvent.findMany({ select: { action: true } })
      ).map((event) => event.action);

      assert.ok(actions.includes('security.role_assigned'));
      assert.ok(actions.includes('security.role_revoked'));
    });

    it('records whether a justification was written, without requiring one', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const event = await ctx.admin.unsafeRootClient.securityEvent.findFirst({
        where: { action: 'security.role_assigned' },
      });

      assert.equal((event?.metadata as { hasJustification: boolean }).hasJustification, false);
    });
  });

  // =========================================================================
  describe('custom roles', () => {
    it('cannot grant a permission its creator does not have', async () => {
      // The escalation: mint a role carrying something you lack, then assign it to a colleague
      // — or to a second account you control.
      const authorization = app.get(AuthorizationService);
      const roles = app.get(RoleAdministrationService);

      await assign(managerId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      const creatorContext = await authorization.contextFor(scope(), managerId);
      const creatorMatrix = authorization.matrixFor(creatorContext);

      await assert.rejects(
        roles.createCustomRole(
          scope(),
          {
            displayName: 'Sneaky Approver',
            permissions: { objective: ['Approve'] },
            maxScope: 'OwnWork',
          },
          managerId,
          creatorMatrix,
        ),
        /cannot grant permissions you do not have yourself/,
      );
    });

    it('grants only what its matrix names, and nothing else', async () => {
      const roleId = await createCustomRole({ objective: ['View', 'Comment'] });
      await assign(employeeId, {
        roleKind: 'Custom',
        scopeKind: 'OwnWork',
        customRoleId: roleId,
      });

      await asPerson(agent().get('/test-authz/view-objective'), employeeUboss).expect(200);
      await asPerson(agent().post('/test-authz/approve-objective'), employeeUboss).expect(403);
    });

    it('grants nothing once disabled, and keeps its assignments', async () => {
      const roleId = await createCustomRole({ objective: ['View'] });
      await assign(employeeId, { roleKind: 'Custom', scopeKind: 'OwnWork', customRoleId: roleId });
      await asPerson(agent().get('/test-authz/view-objective'), employeeUboss).expect(200);

      await ctx.admin.unsafeRootClient.customRole.update({
        where: { id: roleId },
        data: { enabled: false },
      });

      await asPerson(agent().get('/test-authz/view-objective'), employeeUboss).expect(403);
      assert.equal(
        await ctx.admin.unsafeRootClient.roleAssignment.count({ where: { customRoleId: roleId } }),
        1,
      );
    });

    it('is refused by the database if it names a custom role inconsistently', async () => {
      // The check constraint, tested directly: the service enforces it, and this proves the
      // service is not the only thing that does.
      await assert.rejects(
        ctx.admin.unsafeRootClient.roleAssignment.create({
          data: {
            tenantId,
            userId: employeeId,
            roleKind: 'Custom',
            scopeKind: 'OwnWork',
            departmentIds: [],
            selectedResourceIds: [],
          },
        }),
      );
    });
  });

  // =========================================================================
  describe('policy precedence through the database', () => {
    it('lets a company rule deny an action the role grants', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });
      await asPerson(agent().get('/test-authz/view-agents'), employeeUboss).expect(200);

      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/policy-rules`))
        .send({
          layer: 'Company',
          module: 'agents',
          action: 'View',
          effect: 'Deny',
          mandatory: false,
          reason: 'Agents are paused during the audit.',
        })
        .expect(201);

      const response = await asPerson(
        agent().get('/test-authz/view-agents'),
        employeeUboss,
      ).expect(403);

      assert.equal(
        (response.body as { message: string }).message,
        'Agents are paused during the audit.',
      );
    });

    it('refuses to create a Platform-layer rule from a company endpoint', async () => {
      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/policy-rules`))
        .send({
          layer: 'Platform',
          effect: 'Deny',
          mandatory: true,
          reason: 'Trying to write a platform rule.',
        })
        .expect(400);
    });

    it('refuses a mandatory Allow', async () => {
      const response = await asPlatform(
        agent().post(`/tenants/${tenantId}/authorization/policy-rules`),
      )
        .send({
          layer: 'Company',
          effect: 'Allow',
          mandatory: true,
          reason: 'A mandatory grant.',
        })
        .expect(400);

      assert.match((response.body as { message: string }).message, /not a thing/i);
    });

    it('is refused by the database too, if written directly', async () => {
      await assert.rejects(
        ctx.admin.unsafeRootClient.policyRule.create({
          data: {
            layer: 'Company',
            tenantId,
            effect: 'Allow',
            mandatory: true,
            reason: 'A mandatory grant.',
          },
        }),
      );
    });

    it('refuses a Department rule with no department', async () => {
      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/policy-rules`))
        .send({
          layer: 'Department',
          effect: 'Deny',
          mandatory: false,
          reason: 'No department named.',
        })
        .expect(400);
    });

    it('narrows scope through a rule', async () => {
      await assign(managerId, { roleKind: 'Manager', scopeKind: 'TeamSubtree' });

      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/policy-rules`))
        .send({
          layer: 'Company',
          module: 'objective',
          action: 'View',
          effect: 'Allow',
          mandatory: false,
          maxScope: 'OwnWork',
          reason: 'Narrowed during the freeze.',
        })
        .expect(201);

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), managerId);

      assert.equal(authorization.scopeForListing(context, 'objective', 'View'), 'OwnWork');
    });
  });

  // =========================================================================
  describe('separation of duties', () => {
    it('applies the seeded platform baseline to a company that configured nothing', async () => {
      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), managerId);

      const decision = await authorization.authorize(context, {
        module: 'objective',
        action: 'Approve',
        resource: { id: 'obj-1', createdByUserId: managerId },
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'separation-of-duties');
      assert.match(decision.message, /cannot approve something you created/i);
    });

    it('lets the same person approve someone else’s work', async () => {
      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), managerId);

      const decision = await authorization.authorize(context, {
        module: 'objective',
        action: 'Approve',
        resource: { id: 'obj-1', createdByUserId: employeeId },
      });

      assert.equal(decision.allowed, true);
    });

    it('records a blocked self-approval as suspicious activity', async () => {
      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), managerId);
      await authorization.authorize(context, {
        module: 'objective',
        action: 'Approve',
        resource: { id: 'obj-1', createdByUserId: managerId },
      });

      const event = await ctx.admin.unsafeRootClient.securityEvent.findFirst({
        where: { action: 'security.separation_of_duties_blocked' },
      });

      assert.ok(event, 'an attempted self-approval is exactly what an audit wants to see');
      assert.equal((event?.metadata as { rule: string }).rule, 'NoSelfApproval');
    });

    it('never lets the Executor Agent complete a required approval', async () => {
      // The locked rule, at the request layer: an automated actor is refused and has to escalate.
      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/separation-of-duties`))
        .send({
          action: 'Approve',
          rule: 'FourEyes',
          mandatory: true,
          reason: 'Two people must approve a released version.',
        })
        .expect(201);

      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      const authorization = app.get(AuthorizationService);
      const context = await authorization.contextFor(scope(), managerId);

      const decision = await authorization.authorize(context, {
        module: 'objective',
        action: 'Approve',
        resource: { id: 'obj-1', createdByUserId: employeeId, priorActorUserIds: [employeeId] },
        actingAsAgent: true,
      });

      assert.equal(decision.allowed, false);
      assert.match(decision.message, /escalated to a person/);
    });

    it('exposes the platform baseline as inherited and not removable', async () => {
      const response = await asPlatform(
        agent().get(`/tenants/${tenantId}/authorization/separation-of-duties`),
      ).expect(200);

      const body = response.body as {
        platformBaseline: { action: string; rule: string; mandatory: boolean }[];
      };

      const baseline = body.platformBaseline.find((policy) => policy.action === 'Approve');
      assert.ok(baseline, 'the seeded baseline must be visible');
      assert.equal(baseline?.rule, 'NoSelfApproval');
      assert.equal(baseline?.mandatory, true);
    });
  });

  // =========================================================================
  describe('the internal permission test endpoint', () => {
    it('answers a question with the full reasoning', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const response = await asPlatform(agent().post(`/tenants/${tenantId}/authorization/evaluate`))
        .send({ userId: employeeId, module: 'agents', action: 'Approve' })
        .expect(200);

      const body = response.body as {
        decision: { allowed: boolean; reason: string };
        trace: { layer: string; outcome: string }[];
        subject: { userType: string; assignedScope: string };
      };

      assert.equal(body.decision.allowed, false);
      assert.equal(body.decision.reason, 'role-lacks-action');
      assert.equal(body.subject.userType, 'InternalUser');
      assert.equal(body.subject.assignedScope, 'OwnWork');
      assert.ok(body.trace.length > 0, 'the trace is what makes this endpoint worth having');
    });

    it('evaluates against a hypothetical resource', async () => {
      await assign(managerId, {
        roleKind: 'Approver',
        scopeKind: 'SelectedResource',
        selectedResourceIds: ['obj-1'],
      });

      const response = await asPlatform(agent().post(`/tenants/${tenantId}/authorization/evaluate`))
        .send({
          userId: managerId,
          module: 'objective',
          action: 'Approve',
          resourceId: 'obj-1',
          resourceCreatedByUserId: managerId,
        })
        .expect(200);

      const body = response.body as { decision: { reason: string } };
      assert.equal(body.decision.reason, 'separation-of-duties');
    });

    it('returns a matrix that agrees with the enforcement', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const response = await asPlatform(
        agent().get(`/tenants/${tenantId}/authorization/matrix/${employeeId}`),
      ).expect(200);

      const body = response.body as { matrix: Record<string, string[]> };

      assert.ok(body.matrix.agents?.includes('View'));
      assert.ok(!body.matrix.agents?.includes('Approve'));
      // And the guard agrees.
      await asPerson(agent().get('/test-authz/view-agents'), employeeUboss).expect(200);
      await asPerson(agent().post('/test-authz/approve-agents'), employeeUboss).expect(403);

      // CR-03, asserted here because this is the test that compares the published matrix with
      // what the guard does: a standard Employee holds neither builder module, so neither
      // appears in the matrix and neither route is reachable. One mechanism, not two.
      assert.equal(body.matrix['agent-builder'], undefined);
      assert.equal(body.matrix.objective, undefined);
      await asPerson(agent().get('/test-authz/view-objective'), employeeUboss).expect(403);
    });

    it('publishes the vocabulary the UI must render from', async () => {
      const response = await asPlatform(
        agent().get(`/tenants/${tenantId}/authorization/vocabulary`),
      ).expect(200);

      const body = response.body as {
        actions: { value: string }[];
        scopes: { value: string }[];
        userTypes: { value: string; forbiddenActions: string[] }[];
      };

      assert.equal(body.actions.length, 14);
      assert.equal(body.scopes.length, 6);
      const guest = body.userTypes.find((userType) => userType.value === 'ExternalGuest');
      assert.ok((guest?.forbiddenActions ?? []).includes('Approve'));
    });
  });

  // =========================================================================
  describe('tenant isolation of the authorization tables', () => {
    it('does not show one company another’s assignments', async () => {
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const response = await asPlatform(
        agent().get(`/tenants/${otherTenantId}/authorization/assignments`),
      ).expect(200);

      assert.equal((response.body as { assignments: unknown[] }).assignments.length, 0);
    });

    it('gives a person no authority in a company they hold no assignment in', async () => {
      await assign(employeeId, { roleKind: 'CompanyAdmin', scopeKind: 'WholeCompany' });

      const authorization = app.get(AuthorizationService);
      const elsewhere = await authorization.contextFor(
        tenantScopeForPlatformOperation(otherTenantId),
        employeeId,
      );

      // No membership there, so `contextFor` cannot find one — and the person is not silently
      // treated as a platform actor with company powers.
      assert.equal(elsewhere.roleSummary.length, 0);
    });

    it('fails closed when no tenant scope is declared', async () => {
      // RLS, directly: the authorization tables are the last place a missing WHERE should be
      // survivable, because a row here IS someone's authority.
      await assign(employeeId, { roleKind: 'Employee', scopeKind: 'OwnWork' });

      const rows = await ctx.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT COUNT(*)::bigint AS count FROM role_assignments',
      );

      assert.equal(Number(rows[0]?.count ?? -1), 0, 'no scope declared must see nothing');
    });
  });

  // =========================================================================
  describe('the TCSiON extension point', () => {
    it('ships with no mappings and says why', async () => {
      const response = await asPlatform(
        agent().get(`/tenants/${tenantId}/authorization/tcsion-mappings`),
      ).expect(200);

      const body = response.body as { loaded: number; note: string; mappings: unknown[] };

      assert.equal(body.loaded, 0);
      assert.equal(body.mappings.length, 0);
      // The note is the point: an empty table should read as "not supplied yet", not as a bug.
      assert.match(body.note, /external client dependency/i);
      assert.match(body.note, /not invented/i);
    });

    it('refuses to resolve an unmapped external type, rather than defaulting', async () => {
      const response = await asPlatform(
        agent().post(`/tenants/${tenantId}/authorization/tcsion-mappings/resolve`),
      )
        .send({ externalUserType: 'SomeExternalType' })
        .expect(200);

      const body = response.body as { resolved: boolean; message: string };

      assert.equal(body.resolved, false);
      assert.match(body.message, /No approved TCSiON mapping/);
      // A silent default to Employee is how an external user ends up with permissions nobody chose.
      assert.ok(!body.message.includes('Employee'));
    });

    it('records a missing mapping as a security event, so the gap is findable', async () => {
      await asPlatform(agent().post(`/tenants/${tenantId}/authorization/tcsion-mappings/resolve`))
        .send({ externalUserType: 'SomeExternalType' })
        .expect(200);

      const event = await ctx.admin.unsafeRootClient.securityEvent.findFirst({
        where: { action: 'security.tcsion_mapping_missing' },
      });

      assert.ok(event);
      assert.equal(
        (event?.metadata as { externalUserType: string }).externalUserType,
        'SomeExternalType',
      );
    });

    it('loads a mapping and resolves it to UBoss dimensions', async () => {
      await asPlatform(agent().put(`/tenants/${tenantId}/authorization/tcsion-mappings`))
        .send({
          externalUserType: 'ClientSuppliedType',
          externalAllotment: 'ClientSuppliedAllotment',
          ubossUserType: 'ExternalGuest',
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          moduleVisibility: { objective: true, todo: true },
          allowedActions: { objective: ['View'] },
          approvedReference: 'Client reference doc v1, section 4',
        })
        .expect(200);

      const response = await asPlatform(
        agent().post(`/tenants/${tenantId}/authorization/tcsion-mappings/resolve`),
      )
        .send({
          externalUserType: 'ClientSuppliedType',
          externalAllotment: 'ClientSuppliedAllotment',
        })
        .expect(200);

      const body = response.body as {
        resolved: boolean;
        ubossUserType: string;
        roleKind: string;
        visibleModules: string[];
        approvedReference: string;
      };

      assert.equal(body.resolved, true);
      assert.equal(body.ubossUserType, 'ExternalGuest');
      assert.deepEqual(body.visibleModules.sort(), ['objective', 'todo']);
      assert.equal(body.approvedReference, 'Client reference doc v1, section 4');
    });

    it('requires an approved reference, so a mapping is traceable', async () => {
      await asPlatform(agent().put(`/tenants/${tenantId}/authorization/tcsion-mappings`))
        .send({
          externalUserType: 'X',
          ubossUserType: 'InternalUser',
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          moduleVisibility: { objective: true },
          allowedActions: {},
          approvedReference: '',
        })
        .expect(400);
    });

    it('refuses a mapping that names a module UBoss does not have', async () => {
      const response = await asPlatform(
        agent().put(`/tenants/${tenantId}/authorization/tcsion-mappings`),
      )
        .send({
          externalUserType: 'X',
          ubossUserType: 'InternalUser',
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          moduleVisibility: { 'not-a-module': true },
          allowedActions: {},
          approvedReference: 'doc v1',
        })
        .expect(400);

      assert.match((response.body as { message: string }).message, /not-a-module/);
    });

    it('refuses an action restriction on a module it does not make visible', async () => {
      await asPlatform(agent().put(`/tenants/${tenantId}/authorization/tcsion-mappings`))
        .send({
          externalUserType: 'X',
          ubossUserType: 'InternalUser',
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          moduleVisibility: { objective: true },
          allowedActions: { todo: ['View'] },
          approvedReference: 'doc v1',
        })
        .expect(400);
    });

    it('treats the action list as a ceiling, never a grant', async () => {
      // The escalation: use the mapping table to award an action the role does not have.
      const tcsion = app.get(TcsionMappingService);

      const ceiling = tcsion.applyCeiling(
        { objective: ['View', 'Comment'] },
        { objective: ['View', 'Approve'] },
      );

      assert.deepEqual(ceiling.objective, ['View'], 'Approve must not appear from the mapping');
    });

    it('leaves a module the ceiling does not mention untouched', async () => {
      const tcsion = app.get(TcsionMappingService);
      const ceiling = tcsion.applyCeiling(
        { objective: ['View'], todo: ['View'] },
        { objective: ['View'] },
      );

      assert.deepEqual(ceiling.todo, ['View']);
    });

    it('does not leak one company’s mappings to another', async () => {
      await asPlatform(agent().put(`/tenants/${tenantId}/authorization/tcsion-mappings`))
        .send({
          externalUserType: 'ClientSuppliedType',
          ubossUserType: 'InternalUser',
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          moduleVisibility: { objective: true },
          allowedActions: {},
          approvedReference: 'doc v1',
        })
        .expect(200);

      const response = await asPlatform(
        agent().get(`/tenants/${otherTenantId}/authorization/tcsion-mappings`),
      ).expect(200);

      assert.equal((response.body as { loaded: number }).loaded, 0);
    });
  });

  // -------------------------------------------------------------------------

  async function platformUserId(): Promise<string> {
    const user = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.findByUbossUniqueIdForPlatform(platformUboss),
    );
    return user?.id as string;
  }

  async function createCustomRole(permissions: Record<string, string[]>): Promise<string> {
    const response = await asPlatform(
      agent().post(`/tenants/${tenantId}/authorization/custom-roles`),
    )
      .send({
        displayName: `Role ${Math.random().toString(36).slice(2, 8)}`,
        permissions,
        maxScope: 'OwnWork',
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }
});
