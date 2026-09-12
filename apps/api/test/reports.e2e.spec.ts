import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { DASHBOARD_ALLOWED_KEYS } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { DashboardService } from '../src/reports/dashboard.service.js';
import { ReportScopeService } from '../src/reports/report-scope.service.js';
import { ReportsController } from '../src/reports/reports.controller.js';
import { ReportsService } from '../src/reports/reports.service.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
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
 * Reporting and the locked dashboard — Prompt 37, against real PostgreSQL.
 *
 * The prompt asks for **leakage tests** by name, and that is where the weight of this suite is:
 *
 *  * the dashboard returning **exactly** the permitted keys, so the locked contract cannot erode;
 *  * counts and rows confined to the signed-in person's authorized scope, proved with a real
 *    reporting tree rather than a stub;
 *  * a report absent — not empty — when its second permission is missing;
 *  * export refused to somebody who may read the same report on screen;
 *  * one company's rows invisible to another.
 */
describe('reports and the company dashboard (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let managerId: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let strangerId: string;
  let otherAdminUboss: string;
  let platformId: string;
  let departmentId: string;

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
      controllers: [ReportsController],
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
        ReportsService,
        DashboardService,
        ReportScopeService,
        AuthorizationService,
        RoleAdministrationService,
        TcsionMappingService,
        TenantContextService,
        // The real resolver, not a stub: `TeamSubtree` scoping is the thing under test, and a
        // stub would prove only that the stub works.
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
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
      slug: 'reports-co',
      name: 'Reports Co',
      firstMember: { email: 'first@reports.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-reports-co',
      name: 'Other Reports Co',
      firstMember: { email: 'first@other-reports.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (unique: string, email: string, name: string, tenant: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: tenant, userId: user.id, accountState: 'Active' },
        });
        return user;
      };
      return {
        admin: await make('UB-RPAD-0001', 'admin@reports.example', 'Admin', provisioned.tenant.id),
        manager: await make(
          'UB-RPMG-0001',
          'manager@reports.example',
          'Manager',
          provisioned.tenant.id,
        ),
        employee: await make(
          'UB-RPEM-0001',
          'employee@reports.example',
          'Employee',
          provisioned.tenant.id,
        ),
        // Somebody in the same company but outside the manager's subtree. The leakage control.
        stranger: await make(
          'UB-RPST-0001',
          'stranger@reports.example',
          'Stranger',
          provisioned.tenant.id,
        ),
        otherAdmin: await make(
          'UB-RPOA-0001',
          'admin@other-reports.example',
          'Other Admin',
          other.tenant.id,
        ),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    strangerId = people.stranger.id;
    otherAdminUboss = people.otherAdmin.ubossUniqueId;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-RPPL-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      const department = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Operations' },
      });
      departmentId = department.id;

      // A real reporting tree: employee reports to manager; stranger reports to nobody.
      // Indexed rather than derived from the uuid: v7 ids minted in the same millisecond share
      // a prefix, so `userId.slice(0, 8)` collided on the unique employee-id constraint.
      const tree = [
        [adminId, null],
        [managerId, null],
        [employeeId, managerId],
        [strangerId, null],
      ] as const;

      for (const [index, [userId, managerUserId]] of tree.entries()) {
        await ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId,
            userId,
            employeeId: `E-${index + 1}`,
            departmentId,
            designation: 'Tester',
            ...(managerUserId === null ? {} : { reportingManagerUserId: managerUserId }),
          },
        });
      }

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [managerId, 'Manager', 'TeamSubtree'],
        [employeeId, 'Employee', 'OwnWork'],
        [strangerId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: platformId },
        });
      }
    });

    await ctx.prisma.runInTenantTransaction(scope(otherTenantId), async () => {
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: otherTenantId,
          userId: people.otherAdmin.id,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          grantedByUserId: platformId,
        },
      });
    });
  });

  // ---- helpers ----

  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** An Engine Agent owned by somebody, so the dashboard has something to count. */
  const seedAgent = async (ownerUserId: string, tenant = tenantId) =>
    ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.engineAgent.create({
        data: {
          tenantId: tenant,
          name: `Agent for ${ownerUserId} ${Math.random().toString(36).slice(2, 8)}`,
          ownerUserId,
          // `Ready`, not `Active`: an active agent needs an activation timestamp
          // (`activated_engine_agent_records_when`), and nothing activated this one. It is still
          // an agent the dashboard counts, which is the point.
          status: 'Ready',
        },
      }),
    );

  /** An approval request raised by somebody, for the aging report. */
  const seedApproval = async (requestedByUserId: string, tenant = tenantId) =>
    ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.approvalRequest.create({
        data: {
          tenantId: tenant,
          type: 'ObjectiveReview',
          status: 'Pending',
          title: `Approval for ${requestedByUserId.slice(0, 8)}`,
          subjectType: 'objective',
          requestedByUserId,
        },
      }),
    );

  const dashboardFor = async (uboss: string): Promise<{ agents: number; pendingJobs: number; scope: string }> => {
    const response = await asPerson(agent().get(`/tenants/${tenantId}/dashboard`), uboss).expect(
      200,
    );
    return response.body;
  };

  const reportFor = async (uboss: string, key: string, expected = 200): Promise<{ rows: Record<string, string>[]; summary: Record<string, unknown> }> =>
    (await asPerson(agent().get(`/tenants/${tenantId}/reports/${key}`), uboss).expect(expected))
      .body;

  // -------------------------------------------------------------------------
  // The locked dashboard contract
  // -------------------------------------------------------------------------

  it('returns exactly the permitted keys and no others', async () => {
    await seedAgent(adminId);
    const body: Record<string, unknown> = await dashboardFor(adminUboss);

    // The contract erodes by addition, so this asserts the *whole* key set rather than the
    // presence of the two it needs.
    assert.deepEqual(Object.keys(body).sort(), [...DASHBOARD_ALLOWED_KEYS].sort());

    for (const forbidden of ['cost', 'tokens', 'notifications', 'kpis', 'objectives', 'badges']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(body, forbidden),
        false,
        `the dashboard returned "${forbidden}", which the locked contract forbids`,
      );
    }
  });

  it('counts agents in the signed-in person’s own authorized scope', async () => {
    await seedAgent(adminId);
    await seedAgent(managerId);
    await seedAgent(employeeId);
    await seedAgent(strangerId);

    // WholeCompany sees all four.
    assert.equal((await dashboardFor(adminUboss)).agents, 4);

    // TeamSubtree: the manager and the one person reporting to them. Not the stranger, not the
    // admin — this is the leakage control, against a real reporting tree.
    assert.equal((await dashboardFor(managerUboss)).agents, 2);

    // OwnWork: one.
    assert.equal((await dashboardFor(employeeUboss)).agents, 1);
  });

  it('does not count an archived agent, so the donut matches the list it drills into', async () => {
    const live = await seedAgent(employeeId);
    const archived = await seedAgent(employeeId);
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.engineAgent.update({
        where: { id: archived.id },
        // Two constraints here, and both are right: `archived_engine_agent_records_when` wants
        // the timestamp alongside the status, and `engine_agent_archival_is_attributed` wants a
        // name against it. Archiving an agent is a decision somebody made.
        data: { status: 'Archived', archivedAt: new Date(), archivedByUserId: adminId },
      }),
    );

    const body = await dashboardFor(employeeUboss);
    assert.equal(body.agents, 1);
    assert.equal(typeof live.id, 'string');
  });

  it('tells the reader what the counts cover', async () => {
    assert.equal((await dashboardFor(adminUboss)).scope, 'The whole company.');
    assert.equal(
      (await dashboardFor(managerUboss)).scope,
      'You and everyone who reports to you, at any depth.',
    );
    assert.equal((await dashboardFor(employeeUboss)).scope, 'Your own work only.');
  });

  it('names both slices and where each one drills to', async () => {
    const response = await asPerson(
      agent().get(`/tenants/${tenantId}/dashboard/meta`),
      employeeUboss,
    ).expect(200);

    const body = response.body as { slices: { key: string; href: string }[] };
    assert.equal(body.slices.length, 2, 'exactly two slices, forever');
    assert.deepEqual(
      body.slices.map((slice: { key: string }) => slice.key),
      ['agents', 'pendingJobs'],
    );
    assert.deepEqual(
      body.slices.map((slice: { href: string }) => slice.href),
      ['/agents', '/todo'],
    );
  });

  // -------------------------------------------------------------------------
  // The catalogue is filtered by permission
  // -------------------------------------------------------------------------

  it('withholds a report whose second permission the reader lacks, rather than showing it empty', async () => {
    const asEmployee = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), employeeUboss).expect(200)
    ).body as { reports: { key: string }[] };
    const employeeKeys = asEmployee.reports.map((report) => report.key);

    // An Employee holds `settings:View` but not `settings:Administer` or `settings:Audit`, so
    // the company's AI spend and its audit trail are **absent** — an empty table would imply
    // there was nothing to see.
    assert.equal(employeeKeys.includes('AiUsageAndCost'), false);
    assert.equal(employeeKeys.includes('AuditActivity'), false);
    assert.equal(employeeKeys.includes('EmployeeWorkload'), true, 'they can still see their own');

    const asAdmin = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), adminUboss).expect(200)
    ).body as { reports: { key: string }[] };
    const adminKeys = asAdmin.reports.map((report) => report.key);
    assert.equal(adminKeys.includes('AiUsageAndCost'), true);
    assert.equal(adminKeys.includes('AuditActivity'), true);
  });

  it('refuses the withheld report at its own route, not only in the catalogue', async () => {
    // The catalogue hiding it is presentation. This is the control.
    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/AiUsageAndCost`),
      employeeUboss,
    ).expect(403);

    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/AuditActivity`),
      employeeUboss,
    ).expect(403);
  });

  /**
   * Every report actually runs.
   *
   * Added after Prompt 38 found that Objective Progress selected a column that does not exist —
   * `ObjectiveVersion.title`, where the field is `objectiveName`. tsc passed and the original
   * suite never ran that report, so the bug shipped. This loop would have caught it: it asks for
   * each report in the catalogue and asserts a 200, which is enough to execute every query.
   */
  it('runs every report in the catalogue without throwing', async () => {
    const catalogue = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), adminUboss).expect(200)
    ).body as { reports: { key: string }[] };

    assert.equal(catalogue.reports.length, 10, 'an admin sees all ten');

    for (const report of catalogue.reports) {
      await asPerson(
        agent().get(`/tenants/${tenantId}/reports/${report.key}`),
        adminUboss,
      ).expect(200);
    }
  });

  it('404s an invented report name', async () => {
    await asPerson(agent().get(`/tenants/${tenantId}/reports/MadeUpReport`), adminUboss).expect(
      404,
    );
  });

  // -------------------------------------------------------------------------
  // Rows are scoped
  // -------------------------------------------------------------------------

  it('shows a manager their subtree’s agents and nobody else’s', async () => {
    await seedAgent(adminId);
    await seedAgent(managerId);
    await seedAgent(employeeId);
    await seedAgent(strangerId);

    const body = await reportFor(managerUboss, 'EngineAgentHealth');
    assert.equal(body.rows.length, 2);

    // **Full ids, not prefixes.** An earlier version of this assertion compared
    // `strangerId.slice(0, 8)`, and uuid v7 ids minted in the same millisecond share that prefix —
    // so it matched every row and "failed" against correct behaviour.
    const serialized = JSON.stringify(body);
    assert.equal(
      serialized.includes(strangerId),
      false,
      'a manager must not see an agent belonging to somebody outside their subtree',
    );
    assert.equal(serialized.includes(adminId), false);
    assert.equal(serialized.includes(managerId), true, 'they do see their own');
    assert.equal(serialized.includes(employeeId), true, 'and their report’s');
  });

  it('shows an employee only their own approvals', async () => {
    await seedApproval(adminId);
    await seedApproval(managerId);
    await seedApproval(employeeId);

    const asEmployee = await reportFor(employeeUboss, 'ApprovalAging');
    assert.equal(asEmployee.rows.length, 1);
    assert.equal(asEmployee.rows[0]?.requestedBy, employeeId);

    const asManager = await reportFor(managerUboss, 'ApprovalAging');
    assert.equal(asManager.rows.length, 2, 'the manager and their report');

    const asAdmin = await reportFor(adminUboss, 'ApprovalAging');
    assert.equal(asAdmin.rows.length, 3);
  });

  it('returns nothing rather than everything when a scope resolves to nobody', async () => {
    await seedApproval(adminId);

    // A manager with nobody beneath them still has themselves, so the empty case is constructed
    // directly: a Department grant for somebody with no employment record resolves to [].
    const orphan = await ctx.prisma.runAsPlatformOperation(async () => {
      const user = await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-RPOR-0001',
        email: 'orphan@reports.example',
        displayName: 'Orphan',
      });
      await ctx.prisma.client.tenantMembership.create({
        data: { tenantId, userId: user.id, accountState: 'Active' },
      });
      return user;
    });

    await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: orphan.id,
          roleKind: 'Manager',
          scopeKind: 'Department',
          grantedByUserId: platformId,
        },
      }),
    );

    const resolved = await app.get(ReportScopeService).forDashboard({
      scope: scope(),
      actorUserId: orphan.id,
    });

    assert.deepEqual(
      resolved.userIds,
      [],
      'a department grant with no department is nobody, not everybody',
    );

    const body = await reportFor(orphan.ubossUniqueId, 'ApprovalAging');
    assert.deepEqual(body.rows, [], 'an empty scope must produce an empty report, not all of them');
  });

  // -------------------------------------------------------------------------
  // Export is its own permission
  // -------------------------------------------------------------------------

  it('lets a manager export and refuses an employee the same report', async () => {
    await seedApproval(employeeId);

    // The employee can read it on screen.
    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging`),
      employeeUboss,
    ).expect(200);

    // And cannot take it away.
    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging/export`),
      employeeUboss,
    ).expect(403);

    const exported = await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging/export`),
      managerUboss,
    ).expect(200);

    assert.equal(exported.text.startsWith('"title","type"'), true);
  });

  it('records an export in the audit trail, and a read not at all', async () => {
    await seedApproval(managerId);

    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging`),
      managerUboss,
    ).expect(200);

    const afterRead = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.auditEvent.findMany({ where: { tenantId, action: 'report.exported' } }),
    );
    assert.equal(afterRead.length, 0, 'reading a report is ordinary work and is not audited');

    await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging/export`),
      managerUboss,
    ).expect(200);

    const afterExport = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.auditEvent.findMany({ where: { tenantId, action: 'report.exported' } }),
    );
    assert.equal(afterExport.length, 1, 'data leaving the building is the event worth recording');
  });

  it('neutralises a formula a company typed into a title', async () => {
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.approvalRequest.create({
        data: {
          tenantId,
          type: 'ObjectiveReview',
          status: 'Pending',
          title: '=cmd|"/c calc"!A1',
          subjectType: 'objective',
          requestedByUserId: managerId,
        },
      }),
    );

    const exported = await asPerson(
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging/export`),
      managerUboss,
    ).expect(200);

    assert.equal(
      exported.text.includes(`"'=cmd`),
      true,
      'a cell beginning = executes as a formula when the file is opened',
    );
  });

  // -------------------------------------------------------------------------
  // Ranges
  // -------------------------------------------------------------------------

  it('refuses a range longer than the ceiling', async () => {
    await asPerson(
      agent()
        .get(`/tenants/${tenantId}/reports/ApprovalAging`)
        .query({ range: 'Custom', from: '2020-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
      adminUboss,
    ).expect(400);
  });

  it('excludes a row outside the window', async () => {
    const old = await seedApproval(adminId);
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.approvalRequest.update({
        where: { id: old.id },
        data: { createdAt: new Date(Date.now() - 200 * 86_400_000) },
      }),
    );
    await seedApproval(managerId);

    const recent = await reportFor(adminUboss, 'ApprovalAging');
    assert.equal(recent.rows.length, 1, 'the default window is 30 days');

    const wide = (
      await asPerson(
        agent().get(`/tenants/${tenantId}/reports/ApprovalAging`).query({ range: 'Last90Days' }),
        adminUboss,
      ).expect(200)
    ).body as { rows: unknown[] };
    assert.equal(wide.rows.length, 1, '200 days ago is outside 90 days too');
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('shows one company nothing of another', async () => {
    await seedAgent(adminId);
    await seedApproval(adminId);
    await seedAgent(adminId, otherTenantId);

    const theirs = (
      await asPerson(
        agent().get(`/tenants/${otherTenantId}/reports/EngineAgentHealth`),
        otherAdminUboss,
        otherTenantId,
      ).expect(200)
    ).body as { rows: unknown[] };

    assert.equal(theirs.rows.length, 1, 'their own agent only');

    const theirDashboard = (
      await asPerson(
        agent().get(`/tenants/${otherTenantId}/dashboard`),
        otherAdminUboss,
        otherTenantId,
      ).expect(200)
    ).body as { agents: number };
    assert.equal(theirDashboard.agents, 1);

    // And our admin cannot reach their workspace by putting its id in the path.
    await asPerson(
      agent().get(`/tenants/${otherTenantId}/reports/EngineAgentHealth`),
      adminUboss,
      otherTenantId,
    ).expect(403);
  });
});
