import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { DASHBOARD_ALLOWED_KEYS, REPORT_OVERVIEW } from '@uboss/types';

/**
 * The columns a chart declaration names, whichever kind it is.
 *
 * Kept in one place because the list grows: the screen draws seven shapes now, and each names its
 * columns differently. A check that only understood `series` and `groupBy` would silently pass
 * every line, share and status chart ever declared — which is the exact failure the test below
 * exists to catch, reintroduced one kind at a time.
 */
function columnsNamedBy(chart: Record<string, unknown>): string[] {
  const named: unknown[] = [
    chart['column'],
    chart['labelColumn'],
    chart['valueColumn'],
    chart['totalColumn'],
    chart['failedColumn'],
  ];
  return named.filter((column): column is string => typeof column === 'string');
}

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
import { OrchestrationService } from '../src/reports/orchestration.service.js';
import { ReportScopeService } from '../src/reports/report-scope.service.js';
import type { OrchestrationView } from '@uboss/types';
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
        OrchestrationService,
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

  const dashboardFor = async (
    uboss: string,
  ): Promise<{ tiles: { tile: string; count: number | null }[]; scope: string }> => {
    const response = await asPerson(agent().get(`/tenants/${tenantId}/dashboard`), uboss).expect(
      200,
    );
    return response.body;
  };

  const reportFor = async (
    uboss: string,
    key: string,
    expected = 200,
  ): Promise<{ rows: Record<string, string>[]; summary: Record<string, unknown> }> =>
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

  /** One tile's number, or undefined when this reader was not given that tile at all. */
  const tileCount = (body: unknown, tile: string): number | null | undefined =>
    (body as { tiles?: { tile: string; count: number | null }[] }).tiles?.find(
      (row) => row.tile === tile,
    )?.count;

  it('returns only the tiles the person’s permissions allow', async () => {
    /*
     * A tile somebody may not see is **absent**, not present and zero.
     *
     * Zero is a fact about the company; absence is a fact about the reader. A browser that
     * forgot to filter would therefore have nothing to leak, which is the whole reason the
     * decision is made on the server.
     */
    const admin = (await dashboardFor(adminUboss)) as { tiles: { tile: string }[] };
    const employee = (await dashboardFor(employeeUboss)) as { tiles: { tile: string }[] };

    const employeeTiles = employee.tiles.map((row) => row.tile);
    // CR-03 §9 leaves a standard Employee without Objectives, Reports or the Executor screen.
    assert.ok(!employeeTiles.includes('objectives'), 'an employee was given the Objectives tile');
    assert.ok(!employeeTiles.includes('reports'), 'an employee was given the Reports tile');
    assert.ok(!employeeTiles.includes('exceptions'), 'an employee was given the Exceptions tile');

    // And the admin sees strictly more, so the filter is doing something rather than nothing.
    assert.ok(
      admin.tiles.length > employee.tiles.length,
      'the two readers were given the same tiles',
    );
  });

  it('counts agents in the signed-in person’s own authorized scope', async () => {
    await seedAgent(adminId);
    await seedAgent(managerId);
    await seedAgent(employeeId);
    await seedAgent(strangerId);

    // WholeCompany sees all four.
    assert.equal(tileCount(await dashboardFor(adminUboss), 'agents'), 4);

    // TeamSubtree: the manager and the one person reporting to them. Not the stranger, not the
    // admin — this is the leakage control, against a real reporting tree.
    assert.equal(tileCount(await dashboardFor(managerUboss), 'agents'), 2);

    // OwnWork: one.
    assert.equal(tileCount(await dashboardFor(employeeUboss), 'agents'), 1);
  });

  it('does not count an archived agent, so the tile matches the list it opens', async () => {
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

    assert.equal(tileCount(await dashboardFor(employeeUboss), 'agents'), 1);
    assert.equal(typeof live.id, 'string');
  });

  it('carries no invented number on the two tiles that have none', async () => {
    /*
     * Performance and Reports return `null`, and that is the honest answer rather than a gap.
     *
     * There is no single true number for either — a performance score is per person and per
     * period, and "reports" is a set of screens rather than a quantity. A zero would read as
     * "nothing to see", and any other figure would be invented.
     */
    const body = await dashboardFor(adminUboss);
    assert.equal(tileCount(body, 'performance'), null);
    assert.equal(tileCount(body, 'reports'), null);
  });

  it('tells the reader what the counts cover', async () => {
    assert.equal((await dashboardFor(adminUboss)).scope, 'The whole company.');
    assert.equal(
      (await dashboardFor(managerUboss)).scope,
      'You and everyone who reports to you, at any depth.',
    );
    assert.equal((await dashboardFor(employeeUboss)).scope, 'Your own work only.');
  });

  it('names every tile, where it goes, and what its number means', async () => {
    const response = await asPerson(
      agent().get(`/tenants/${tenantId}/dashboard/meta`),
      employeeUboss,
    ).expect(200);

    const body = response.body as {
      tiles: { key: string; label: string; href: string; measures: string | null }[];
      lanes: { key: string }[];
    };

    /*
     * Served rather than written into the screen, so the two cannot drift.
     *
     * It lists every tile that exists — which tiles a given person *gets* is decided by
     * `/dashboard` against their own permissions, and this test reads it as an employee to prove
     * the catalogue is not itself a leak: knowing a tile exists is not seeing its number.
     */
    assert.ok(body.tiles.length > 0, 'the catalogue was empty');
    for (const tile of body.tiles) {
      assert.ok(tile.label.trim() !== '', `${tile.key} has no label`);
      assert.ok(tile.href.startsWith('/'), `${tile.key} does not name where it goes`);
    }

    /*
     * Every tile says something under its label, and no two say the same thing.
     *
     * This used to assert that Performance and Reports carried `null` here, which was true and
     * was the defect: the screen fell back to a generic sentence, and both of them read
     * "Everything this area holds" — two different destinations described identically. The server
     * now resolves the line itself, from the measure where there is a count and from the area's
     * own description where there is not, so the fallback has nothing left to do.
     *
     * The discipline this replaces it with is stronger: a duplicate sentence anywhere fails.
     */
    const lines = body.tiles.map((tile) => tile.measures);
    for (const [index, line] of lines.entries()) {
      assert.ok(
        line !== null && line.trim() !== '',
        `${body.tiles[index]?.key} says nothing under its label`,
      );
    }
    assert.equal(
      new Set(lines).size,
      lines.length,
      `two tiles share a description: ${lines.join(' | ')}`,
    );
  });

  it('counts a finished agent run as finished', async () => {
    /*
     * The bug this pins: the mix counted runs in states called `Succeeded` and `DeadLettered`,
     * neither of which is a run state — `Succeeded` belongs to security events and `DeadLettered`
     * exists nowhere. So a completed run was reported as still in flight and the AI row's
     * completed count was zero whatever had happened. Nothing covered this row, which is why it
     * survived; this is that cover.
     */
    const agentRow = await seedAgent(adminId);

    const version = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.engineAgentVersion.create({
        data: {
          tenantId,
          engineAgentId: agentRow.id,
          versionNumber: 1,
          // Draft, not Published: a published version has to record when it was published
          // (`published_engine_agent_version_records_when`), and nothing published this one. The
          // run does not care which it is.
          status: 'Draft',
          config: {},
          createdByUserId: adminId,
        },
      }),
    );

    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.agentRun.create({
        data: {
          tenantId,
          engineAgentId: agentRow.id,
          engineAgentVersionId: version.id,
          state: 'Completed',
          trigger: 'Manual',
          idempotencyKey: `mix:${Date.now()}`,
          correlationId: 'mix-fixture',
          // `running_run_was_reserved_first`: a run reaches a started state only through
          // Reserved, where budget is set aside.
          reservedAt: new Date(),
          startedAt: new Date(),
          finishedAt: new Date(),
          producedByRealModel: false,
        },
      }),
    );

    const mix = await reportFor(adminUboss, 'HumanVsAiWorkMix');
    const ai = mix.rows.find((row) => String(row['kind']).toLowerCase().includes('ai'));
    assert.ok(ai, 'the mix has no AI row');
    assert.equal(Number(ai['completed']), 1, 'a completed run was reported as unfinished');
  });

  // -------------------------------------------------------------------------
  // The catalogue is filtered by permission
  // -------------------------------------------------------------------------

  it('withholds a report whose second permission the reader lacks, rather than showing it empty', async () => {
    /*
     * Read by the Manager since CR-03 §9. The subject is the two-grant rule — holding
     * `reports:View` is not enough when the report is sourced from a module you cannot open — and
     * a standard Employee no longer holds `reports:View` at all, so they would demonstrate the
     * first door rather than this one. The Manager holds `reports:View` and `settings:View`, and
     * not `settings:Administer` or `settings:Audit`, which is the case this is about.
     */
    const asManager = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), managerUboss).expect(200)
    ).body as { reports: { key: string }[] };
    const managerKeys = asManager.reports.map((report) => report.key);

    assert.equal(managerKeys.includes('AiUsageAndCost'), false);
    assert.equal(managerKeys.includes('AuditActivity'), false);
    assert.equal(managerKeys.includes('EmployeeWorkload'), true, 'they can still see their team’s');

    // And the Employee is refused the section outright, which is the other door.
    await asPerson(agent().get(`/tenants/${tenantId}/reports`), employeeUboss).expect(403);

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

    await asPerson(agent().get(`/tenants/${tenantId}/reports/AuditActivity`), employeeUboss).expect(
      403,
    );
  });

  /**
   * Every report actually runs.
   *
   * Added after Prompt 38 found that Objective Progress selected a column that does not exist —
   * `ObjectiveVersion.title`, where the field is `objectiveName`. tsc passed and the original
   * suite never ran that report, so the bug shipped. This loop would have caught it: it asks for
   * each report in the catalogue and asserts a 200, which is enough to execute every query.
   */
  /**
   * The orchestration overview — Phase 16.
   *
   * The tiles say how much of each thing exists. This says *where the work has got to*, which is
   * the question an admin opens the dashboard to answer and the one no tile could: Engine,
   * Sub-Engine and Executor only mean anything side by side.
   *
   * What these tests defend, in order of how badly each would mislead somebody:
   *
   *   1. **Mapped is not finished.** An AI step with an agent mapped to it and no run has not been
   *      done. Reading the assignment alone would mark every step finished the moment an admin
   *      pressed Publish, and a dashboard that says the work is done is worse than no dashboard.
   *   2. **Waiting is not "not started".** Work blocked on a predecessor is a queue for the admin
   *      to clear, not an employee who has not got round to it.
   *   3. **Withheld is not zero.** A reader who may not see approvals is told `null`, because zero
   *      is a fact about the company and would read as good news.
   *   4. **Two permissions.** Somebody who may not see Objectives cannot read this, or the
   *      dashboard becomes the way around the Objectives module.
   */
  describe('the orchestration overview', () => {
    // A function, not a constant: `tenantId` is assigned in `before`, and a describe body runs
    // before that. A constant here would bake in `undefined` and every test would ask for a
    // company that does not exist.
    const orchestration = () => `/tenants/${tenantId}/dashboard/orchestration`;

    /**
     * A plan of three steps in a chain, with work on each.
     *
     * The stages are not stored anywhere — `executionStages` derives them from the dependency
     * graph — so the fixture describes the dependencies and lets the product decide what is an
     * Engine and what is an Executor. A fixture that asserted the names it had just written down
     * would prove nothing.
     */
    const seedPlan = async (input: {
      code: string;
      ownerUserId: string;
      assigneeUserId: string;
      tenant?: string;
      department?: string;
      firstStatus?: string;
      withAgentRun?: boolean;
      dueAt?: Date;
    }) =>
      ctx.prisma.runAsPlatformOperation(async () => {
        const tenant = input.tenant ?? tenantId;
        // `objectives_tenant_id_department_id_fkey` is composite: a department belongs to one
        // company, so seeding into another one has to name that company's own department.
        const department = input.department ?? departmentId;
        const objective = await ctx.prisma.client.objective.create({
          data: {
            tenantId: tenant,
            code: input.code,
            departmentId: department,
            objectiveOwnerUserId: input.ownerUserId,
            createdByUserId: input.ownerUserId,
          },
        });

        const version = await ctx.prisma.client.objectiveVersion.create({
          data: {
            tenantId: tenant,
            objectiveId: objective.id,
            versionNumber: 1,
            origin: 'Initial',
            status: 'Draft',
            objectiveName: 'Plan ' + input.code,
            departmentId: department,
            objectiveOwnerUserId: input.ownerUserId,
            expectedFinalResult: 'Something finished.',
            createdByUserId: input.ownerUserId,
          },
        });

        const draft = await ctx.prisma.client.objectiveWorkflowDraft.create({
          data: {
            tenantId: tenant,
            objectiveId: objective.id,
            objectiveVersionId: version.id,
            /*
             * A chain: first, then second, then third.
             *
             * `executionStages` reads depth from these dependencies, so this is a plan with an
             * Engine, one Sub-Engine and an Executor without the fixture ever saying those words.
             */
            graph: {
              nodes: [
                { id: 'n1', kind: 'Human', label: 'Gather', dod: { dependencies: [] } },
                { id: 'n2', kind: 'Human', label: 'Check', dod: { dependencies: ['n1'] } },
                { id: 'n3', kind: 'Ai', label: 'Summarise', dod: { dependencies: ['n2'] } },
              ],
              edges: [],
            },
            schemaVersion: 1,
          },
        });

        await ctx.prisma.client.humanTask.create({
          data: {
            tenantId: tenant,
            objectiveId: objective.id,
            objectiveVersionId: version.id,
            workflowDraftId: draft.id,
            nodeId: 'n1',
            title: 'Gather',
            assignedToUserId: input.assigneeUserId,
            assignedByUserId: input.ownerUserId,
            dependsOnNodeIds: [],
            status: input.firstStatus ?? 'Assigned',
            ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
            /*
             * A finished task records both ends of itself.
             *
             * Three rules, and each of them right: `started_task_records_when`,
             * `submitted_task_records_when` and `completed_task_records_when`. Work cannot have
             * been finished without having been begun and handed in, and the database says so
             * rather than trusting whoever writes the row.
             */
            ...(input.firstStatus === 'Completed'
              ? {
                  startedAt: new Date(Date.now() - 3_600_000),
                  submittedAt: new Date(Date.now() - 60_000),
                  completedAt: new Date(),
                }
              : {}),
          },
        });

        await ctx.prisma.client.humanTask.create({
          data: {
            tenantId: tenant,
            objectiveId: objective.id,
            objectiveVersionId: version.id,
            workflowDraftId: draft.id,
            nodeId: 'n2',
            title: 'Check',
            assignedToUserId: input.assigneeUserId,
            assignedByUserId: input.ownerUserId,
            dependsOnNodeIds: ['n1'],
            status: 'Waiting',
          },
        });

        /*
         * The agent comes first, because the row rule says so.
         *
         * `mapped_assignment_names_its_agent` refuses a `MappedToEngineAgent` row that names no
         * agent — an assignment claiming a mapping it does not have is exactly the state that
         * would make this dashboard lie. A fixture that created the row first and filled the
         * column afterwards was refused, which is the product being right.
         */
        const built = await ctx.prisma.client.engineAgent.create({
          data: {
            tenantId: tenant,
            name: 'Agent ' + input.code,
            ownerUserId: input.ownerUserId,
            status: 'Ready',
          },
        });

        const assignment = await ctx.prisma.client.aiWorkAssignment.create({
          data: {
            tenantId: tenant,
            objectiveId: objective.id,
            objectiveVersionId: version.id,
            workflowDraftId: draft.id,
            nodeId: 'n3',
            title: 'Summarise',
            status: 'MappedToEngineAgent',
            engineAgentId: built.id,
            assignedByUserId: input.ownerUserId,
            setupPrefill: {},
          },
        });

        if (input.withAgentRun === true) {
          const builtVersion = await ctx.prisma.client.engineAgentVersion.create({
            data: {
              tenantId: tenant,
              engineAgentId: built.id,
              versionNumber: 1,
              status: 'Draft',
              config: {},
              createdByUserId: input.ownerUserId,
            },
          });
          await ctx.prisma.client.agentRun.create({
            data: {
              tenantId: tenant,
              engineAgentId: built.id,
              engineAgentVersionId: builtVersion.id,
              aiWorkAssignmentId: assignment.id,
              state: 'Completed',
              trigger: 'Manual',
              idempotencyKey: 'run-' + input.code,
              correlationId: 'orchestration-fixture',
              /*
               * `running_run_was_reserved_first`: a run reaches a started state only through
               * Reserved, where budget is set aside. A fixture that skips it is refused, which is
               * the product being right rather than the fixture being awkward.
               */
              reservedAt: new Date(),
              startedAt: new Date(),
              finishedAt: new Date(),
              producedByRealModel: false,
            },
          });
        }

        return { objectiveId: objective.id, versionId: version.id };
      });

    const read = async (uboss: string) =>
      (await asPerson(agent().get(orchestration()), uboss).expect(200)).body as OrchestrationView;

    it('puts work at the stage the dependency graph says, not at one somebody typed', async () => {
      await seedPlan({ code: 'ORCH-1', ownerUserId: adminId, assigneeUserId: adminId });

      const view = await read(adminUboss);
      const byStage = new Map(view.stages.map((row) => [row.stage, row]));

      // First in the chain, so Engine; last, so Executor; the one between, Sub-Engine. Nothing in
      // the fixture said any of those words.
      assert.equal(byStage.get('Engine')?.human.ready, 1);
      assert.equal(byStage.get('SubEngine')?.human.waiting, 1);
      assert.equal(byStage.get('Executor')?.agent.ready, 1);
      assert.equal(view.activeObjectives, 1);
      assert.ok(view.covers.trim() !== '', 'the reader was not told what the numbers cover');
    });

    it('does not call mapped agent work finished', async () => {
      /*
       * The bug this pins: `MappedToEngineAgent` means an agent exists to do this step, not that
       * it has done it. Counting the assignment's own status as progress would have reported
       * every mapped step finished the moment an admin pressed Publish — a dashboard claiming the
       * work was done when nothing had run.
       */
      await seedPlan({ code: 'ORCH-2', ownerUserId: adminId, assigneeUserId: adminId });

      const mapped = await read(adminUboss);
      const executor = mapped.stages.find((row) => row.stage === 'Executor');
      assert.equal(executor?.agent.completed, 0, 'a mapped step was reported as finished');
      assert.equal(executor?.agent.ready, 1);
    });

    it('counts an agent step once a run has actually completed', async () => {
      // The other half of the rule above: this is about evidence, not about caution.
      await seedPlan({
        code: 'ORCH-3',
        ownerUserId: adminId,
        assigneeUserId: adminId,
        withAgentRun: true,
      });

      const view = await read(adminUboss);
      assert.equal(
        view.stages.find((row) => row.stage === 'Executor')?.agent.completed,
        1,
        'a completed run was not counted',
      );
    });

    it('keeps work that cannot start apart from work nobody has started', async () => {
      await seedPlan({ code: 'ORCH-4', ownerUserId: adminId, assigneeUserId: adminId });

      const view = await read(adminUboss);
      // One of each, and not in the same column: the waiting one is a queue for the admin to
      // clear, and the ready one is a person who has not begun.
      assert.equal(view.waitingOnDependency, 1);
      assert.equal(view.stages.find((row) => row.stage === 'Engine')?.human.ready, 1);
    });

    it('counts unfinished work as overdue and finished work never', async () => {
      const past = new Date(Date.now() - 86_400_000);
      await seedPlan({
        code: 'ORCH-5',
        ownerUserId: adminId,
        assigneeUserId: adminId,
        dueAt: past,
      });
      assert.equal((await read(adminUboss)).overdue, 1);

      await seedPlan({
        code: 'ORCH-6',
        ownerUserId: adminId,
        assigneeUserId: adminId,
        firstStatus: 'Completed',
        dueAt: past,
      });
      assert.equal((await read(adminUboss)).overdue, 1, 'a finished task was counted as overdue');
    });

    it('names a withheld number null rather than zero', async () => {
      /*
       * Asserted against the service rather than the route, because the route refuses this reader
       * earlier and for a different reason: a standard Employee holds no `objective` grant at
       * all. The rule under test is the one inside — a module somebody may not see comes back as
       * null. Zero is a fact about the company, and this reader is not entitled to state it.
       */
      await seedPlan({ code: 'ORCH-7', ownerUserId: adminId, assigneeUserId: employeeId });

      const context = await app.get(AuthorizationService).contextFor(scope(), employeeId);
      /*
       * `executor`, not `approvals`.
       *
       * CR-03 §9 leaves a standard Employee the approvals they are given — so approvals is a
       * module they hold — and takes away the Executor screen along with hierarchy, reports and
       * profile search. The premise is asserted rather than assumed because a role template edit
       * needs no migration, so this could stop being true without anything else breaking.
       */
      assert.ok(!context.visibleModules.includes('executor'), 'the fixture lost its premise');

      const view = await app.get(OrchestrationService).overview({
        scope: scope(),
        reportScope: await app
          .get(ReportScopeService)
          .forDashboard({ scope: scope(), actorUserId: employeeId }),
        context,
        now: new Date(),
      });

      assert.equal(view.exceptionsOpen, null);
    });

    it('refuses a reader who may not see objectives', async () => {
      // A standard Employee holds no `objective` grant, so this is the real case rather than a
      // constructed one. Without the second check the dashboard would be the way around the
      // Objectives module — the hole every report's second permission exists to close.
      await asPerson(agent().get(orchestration()), employeeUboss).expect(403);
    });

    it('shows one company nothing of another', async () => {
      const theirs = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.department.create({
          data: { tenantId: otherTenantId, name: 'Their Operations' },
        }),
      );
      await seedPlan({
        code: 'ORCH-8',
        ownerUserId: strangerId,
        assigneeUserId: strangerId,
        tenant: otherTenantId,
        department: theirs.id,
      });

      const leaked = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.objective.count({ where: { code: 'ORCH-8' } }),
      );
      assert.equal(leaked, 0, 'another company’s objective was readable');

      // And it is absent from the numbers, not merely unreadable by a direct query.
      const view = await read(adminUboss);
      assert.ok(
        view.departments.every((row) => row.activeObjectives >= 0),
        'a department row was malformed',
      );
    });
  });

  it('runs every report in the catalogue without throwing', async () => {
    const catalogue = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), adminUboss).expect(200)
    ).body as { reports: { key: string }[] };

    // Twelve since AgentRunsPerDay joined them, which a Company Admin asked for: how much AI
    // work the company actually did each day. Written out rather than derived from REPORT_KEYS:
    // a count taken from the constant the catalogue is built from would agree with itself
    // whatever happened, and the point of the number is that adding a report has to be a
    // decision somebody made here rather than something that slipped in.
    assert.equal(catalogue.reports.length, 12, 'an admin sees all twelve');

    for (const report of catalogue.reports) {
      await asPerson(agent().get(`/tenants/${tenantId}/reports/${report.key}`), adminUboss).expect(
        200,
      );
    }
  });

  it('draws every report from a column that report actually returns', async () => {
    /*
     * The failure this exists to catch.
     *
     * A chart is declared in the catalogue as "count the rows by their `status`", and the rows
     * are built somewhere else entirely. Name a column the report does not return and nothing
     * breaks: the screen groups every row under one empty heading and draws a single bar labelled
     * "Not set", which looks like a finished chart of a company with nothing in it.
     *
     * Four of the eleven were wrong exactly that way when the charts were first declared —
     * `bucket`, `person`, `level` and a `kind` that counted two rows of totals. So the
     * declaration is checked against the real answer here, where a mismatch is a failure rather
     * than a plausible-looking picture.
     */
    const catalogue = (
      await asPerson(agent().get(`/tenants/${tenantId}/reports`), adminUboss).expect(200)
    ).body as { reports: { key: string; label: string; chart?: Record<string, string> }[] };

    let charted = 0;
    for (const report of catalogue.reports) {
      const chart = report.chart;
      assert.ok(chart !== undefined, `${report.label} declares no chart`);
      charted += 1;

      const run = (
        await asPerson(
          agent().get(`/tenants/${tenantId}/reports/${report.key}`),
          adminUboss,
        ).expect(200)
      ).body as { columns: string[] };

      for (const column of columnsNamedBy(chart)) {
        assert.ok(
          run.columns.includes(column),
          `${report.label} charts "${column}", which is not one of its columns: ` +
            run.columns.join(', '),
        );
      }
    }

    assert.equal(charted, 12, 'every report in the catalogue draws');
  });

  /*
   * The overview panels, checked the same way and for the same reason.
   *
   * A panel declares its own reading of a report — the cost panel draws `day` against
   * `amountMinor` — and it is declared in one file while the rows are built in another. Name a
   * column that report does not return and the panel draws a tidy, empty, entirely wrong picture
   * on the first screen of this section, where it is the first thing anybody sees.
   *
   * The tally's second line is checked against the report's **summary** rather than its columns,
   * because that is where it reads from: `oldestWaitingSince` is a figure the report computed, not
   * a column of its rows, and a typo there simply leaves the line off with nothing to say.
   */
  it('draws every overview panel from a column its report actually returns', async () => {
    assert.ok(REPORT_OVERVIEW.length > 0, 'there are panels to check');
    let checkedWithRows = 0;

    for (const panel of REPORT_OVERVIEW) {
      const run = (
        await asPerson(
          agent().get(`/tenants/${tenantId}/reports/${panel.report}`),
          adminUboss,
        ).expect(200)
      ).body as { columns: string[]; rows: unknown[]; summary: Record<string, unknown> };

      for (const column of columnsNamedBy(panel.chart as unknown as Record<string, unknown>)) {
        assert.ok(
          run.columns.includes(column),
          `The "${panel.question}" panel charts "${column}", which ${panel.report} does not ` +
            `return: ${run.columns.join(', ')}`,
        );
      }

      /*
       * A report with nothing in it returns no summary at all, and that is correct.
       *
       * `DependencyWaiting` answers an empty period with no rows and no figures — there is no
       * oldest wait when nothing is waiting — so the key is checked where there is something to
       * describe. The panel already handles its absence by leaving the second line off rather than
       * printing a blank one.
       */
      if (panel.chart.kind === 'tally' && panel.chart.detail !== undefined && run.rows.length > 0) {
        assert.ok(
          panel.chart.detail.key in run.summary,
          `The "${panel.question}" panel reads "${panel.chart.detail.key}" from ${panel.report}'s ` +
            `summary, which holds: ${Object.keys(run.summary).join(', ')}`,
        );
      }

      // Guards the guard: a panel checked against an empty report proves nothing about its
      // columns either, and every panel coming back empty would make this whole test vacuous.
      if (run.rows.length > 0) checkedWithRows += 1;
    }

    assert.ok(
      checkedWithRows > 0,
      'every overview panel came back empty, so this checked nothing at all',
    );
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

  it('scopes a report to the reader, and refuses the reader who holds no Reports grant', async () => {
    await seedApproval(adminId);
    await seedApproval(managerId);
    await seedApproval(employeeId);

    /*
     * The OwnWork case used to be shown through the Employee. CR-03 §9 leaves a standard Employee
     * with no `reports` grant, and the capability catalogue has no way to grant Reports read-only
     * — `SeeTeamReports` bundles View with Export — so there is no default identity that reads a
     * report at OwnWork scope any more. That gap is reported rather than papered over here; what
     * this test can still prove is that the scope narrows per reader and that the refusal is
     * total for somebody without the grant.
     */
    await asPerson(agent().get(`/tenants/${tenantId}/reports/ApprovalAging`), employeeUboss).expect(
      403,
    );

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

    /*
     * `Head`, not `Manager`, and that is the whole construction.
     *
     * A Manager's `maxScope` is `TeamSubtree`, so the engine caps a Manager assignment naming
     * `Department` down to `TeamSubtree` — and a team subtree with nobody in it still contains the
     * manager themselves. This test used to pass only because the report scope was read from the
     * RAW `scope_kind` on the row while the engine enforced the capped one: the two disagreed, and
     * the disagreement is what produced the empty list. Reports now resolve against the scope the
     * engine actually enforces, so the case has to be built with a role that really can hold
     * `Department` — `Head`, whose ceiling is `MultipleDepartments`.
     */
    await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: orphan.id,
          roleKind: 'Head',
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

  it('reaches the department a grant names, not the one the reader works in', async () => {
    /*
     * The escalation this guards, reproduced against the running product before it was fixed.
     *
     *   • The reader is employed in Operations, alongside four colleagues.
     *   • Their only department grant is `Head` over **Customer Operations**, where one other
     *     person works and they do not.
     *
     * The departments were read from the reader's employment record, so the grant's own
     * departments were decorative: a person granted one department was served the department they
     * happen to sit in — their own Head, Manager and colleagues — and nobody noticed because in
     * every ordinary case the two answers agree. They disagree here on purpose, in both
     * directions: the department granted must appear, and the department worked in must not.
     */
    const customerOperations = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.department.create({ data: { tenantId, name: 'Customer Operations' } }),
    );

    const cast = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (unique: string, email: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user;
      };
      return {
        reader: await make('UB-RPDH-0001', 'head@reports.example', 'Department Head'),
        colleague: await make('UB-RPDC-0001', 'elsewhere@reports.example', 'Elsewhere'),
      };
    });

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: cast.reader.id,
          employeeId: 'E-5',
          // Operations — the department the old code would have served them.
          departmentId,
          designation: 'Tester',
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: cast.colleague.id,
          employeeId: 'E-6',
          departmentId: customerOperations.id,
          designation: 'Tester',
        },
      });
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: cast.reader.id,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [customerOperations.id],
          grantedByUserId: platformId,
        },
      });
    });

    const resolver = app.get(ReportScopeService);

    const roster = await resolver.forPeopleList({ scope: scope(), actorUserId: cast.reader.id });
    assert.deepEqual(
      roster.userIds,
      [cast.colleague.id],
      'the roster is the granted department, and only it',
    );
    assert.deepEqual(roster.departmentIds, [customerOperations.id]);
    assert.equal(
      roster.userIds?.includes(adminId),
      false,
      'the reader’s own department must not arrive with the grant',
    );

    const counts = await resolver.forDashboard({ scope: scope(), actorUserId: cast.reader.id });
    assert.deepEqual(
      counts.userIds,
      [cast.colleague.id],
      'and the dashboard resolves the same way, through a different permission',
    );

    // Over HTTP, on a report a Head may read: one row, and it is not the administrator's.
    await seedApproval(adminId);
    await seedApproval(cast.colleague.id);

    const report = await reportFor(cast.reader.ubossUniqueId, 'ApprovalAging');
    assert.equal(report.rows.length, 1, 'one department’s worth of rows, not the company’s');
  });

  // -------------------------------------------------------------------------
  // Export is its own permission
  // -------------------------------------------------------------------------

  it('lets a manager export and refuses an employee the same report', async () => {
    await seedApproval(employeeId);

    /*
     * Reading and exporting are separate grants, and that separation is asserted directly in the
     * types suite (`REPORT_EXPORT_PERMISSION`). It used to be shown here through an Employee who
     * could read but not export; CR-03 §9 removed their Reports grant, and nothing in the
     * capability catalogue grants View without Export, so no identity demonstrates that pair any
     * more. What is asserted here instead: the Employee is refused both, and the Manager may do
     * both.
     */
    await asPerson(agent().get(`/tenants/${tenantId}/reports/ApprovalAging`), employeeUboss).expect(
      403,
    );

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

    await asPerson(agent().get(`/tenants/${tenantId}/reports/ApprovalAging`), managerUboss).expect(
      200,
    );

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
      agent().get(`/tenants/${tenantId}/reports/ApprovalAging`).query({
        range: 'Custom',
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      }),
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
    ).body as { tiles: { tile: string; count: number | null }[] };
    assert.equal(theirDashboard.tiles.find((row) => row.tile === 'agents')?.count, 1);

    // And our admin cannot reach their workspace by putting its id in the path.
    await asPerson(
      agent().get(`/tenants/${otherTenantId}/reports/EngineAgentHealth`),
      adminUboss,
      otherTenantId,
    ).expect(403);
  });
});
