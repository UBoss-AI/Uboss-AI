import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { SECURITY_CENTER_VIEWS, type SecurityMetric } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { AuditQueryService } from '../src/audit/audit-query.service.js';
import { SecurityCenterController } from '../src/audit/security-center.controller.js';
import { SecurityCenterService } from '../src/audit/security-center.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { UserRepository } from '../src/persistence/user.repository.js';
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
 * The Security Center — Prompt 32, against real PostgreSQL.
 *
 * The vocabulary's arithmetic is proved without a database in
 * `packages/types/src/security-center.test.ts`. What can only be proved here is the part that
 * makes the screen trustworthy: that it is permission-aware rather than merely permission-shaped,
 * that one company cannot see another's, that the tamper protection the client requires is real
 * at the database rather than in a guard, and that a company administrator can now sign somebody
 * out — with the cross-company consequence recorded.
 */
describe('the Security Center (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let auditorId: string;
  let auditorUboss: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let guestId: string;
  let platformId: string;
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
      controllers: [SecurityCenterController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        SessionRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuditQueryService,
        SecurityCenterService,
        SessionService,
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
      slug: 'security-co',
      name: 'Security Co',
      firstMember: { email: 'first@security.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-security-co',
      name: 'Other Security Co',
      firstMember: { email: 'first@other-security.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (
        unique: string,
        email: string,
        name: string,
        options: { userType?: 'InternalUser' | 'ExternalGuest'; guestExpiresAt?: Date } = {},
      ) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: {
            tenantId: provisioned.tenant.id,
            userId: user.id,
            accountState: 'Active',
            userType: options.userType ?? 'InternalUser',
            ...(options.guestExpiresAt === undefined
              ? {}
              : { guestAccessExpiresAt: options.guestExpiresAt }),
          },
        });
        return user;
      };

      return {
        admin: await make('UB-SCAD-0001', 'admin@security.example', 'Security Admin'),
        auditor: await make('UB-SCAU-0001', 'auditor@security.example', 'Security Auditor'),
        manager: await make('UB-SCMG-0001', 'manager@security.example', 'Security Manager'),
        employee: await make('UB-SCEM-0001', 'employee@security.example', 'Security Employee'),
        // A guest whose access has already lapsed: the case §23's expiry rule exists for.
        guest: await make('UB-SCGU-0001', 'guest@partner.example', 'Partner Guest', {
          userType: 'ExternalGuest',
          guestExpiresAt: new Date(Date.now() - 86_400_000),
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    auditorId = people.auditor.id;
    auditorUboss = people.auditor.ubossUniqueId;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    guestId = people.guest.id;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-SCPL-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;
    platformUboss = platform.ubossUniqueId;

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [auditorId, 'Auditor', 'WholeCompany'],
        [people.manager.id, 'Manager', 'MultipleDepartments'],
        [employeeId, 'Employee', 'OwnWork'],
        [guestId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: platformId },
        });
      }

      await ctx.prisma.client.tenantAuthPolicy.upsert({
        where: { tenantId },
        create: { tenantId, requireMfa: true, guestExpiryDays: 30 },
        update: { requireMfa: true, guestExpiryDays: 30 },
      });
    });
  });

  // ---- helpers ----

  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const centre = () => app.get(SecurityCenterService);
  const securityEvents = () => app.get(SecurityEventPublisher);
  const sessions = () => app.get(SessionService);

  const metric = (posture: { metrics: { metric: SecurityMetric }[] }, name: SecurityMetric) => {
    const found = posture.metrics.find((reading) => reading.metric === name);
    assert.ok(found, `no ${name} metric`);
    return found as { metric: SecurityMetric; value: string; caption: string; tone: string };
  };

  const seedEvent = async (
    action: Parameters<typeof securityEvents extends never ? never : never> extends never
      ? string
      : string,
    options: { actorUserId?: string; tenantId?: string; resourceId?: string } = {},
  ) => {
    await securityEvents().record({
      action: action as never,
      tenantId: options.tenantId ?? tenantId,
      ...(options.actorUserId === undefined ? {} : { actorUserId: options.actorUserId }),
      ...(options.resourceId === undefined ? {} : { resourceId: options.resourceId }),
      summary: `Seeded ${action}.`,
    });
  };

  const seedSession = async (userId: string) =>
    sessions().establish(userId, { deviceLabel: 'Test device', clientHint: 'node-test' });

  // -------------------------------------------------------------------------
  // 1. Permission-aware, not permission-shaped
  // -------------------------------------------------------------------------

  describe('who may look', () => {
    it('lets a Company Admin read the posture', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        adminUboss,
      ).expect(200);

      assert.equal(response.body.metrics.length, 11);
      assert.equal(response.body.mayExport, true);
      assert.equal(response.body.mayRevokeSessions, true);
    });

    it('lets an Auditor read but not act', async () => {
      // `Auditor` holds View, Export and Audit across the company and no write action anywhere.
      // The Security Center must reflect that rather than treating "can investigate" as "can
      // sign people out".
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        auditorUboss,
      ).expect(200);

      assert.equal(response.body.mayExport, true);
      assert.equal(response.body.mayRevokeSessions, false);
    });

    it('refuses an Employee', async () => {
      await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        employeeUboss,
      ).expect(403);
    });

    it('refuses a Manager', async () => {
      // A Manager holds no `settings:Audit` in the role templates, and a department-scoped grant
      // could not be honoured anyway: security events are not department-scoped.
      await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        managerUboss,
      ).expect(403);
    });

    it('refuses a guest', async () => {
      await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        'UB-SCGU-0001',
      ).expect(403);
    });

    it('refuses a UBoss platform actor on the company route', async () => {
      // UBoss's own staff hold no membership in a customer's company, and the company Security
      // Center is a `@TenantScoped` surface. Support reaching a customer's security history
      // goes through break-glass — explicit, reasoned, time-limited and notified — rather than
      // through the customer's own screen. Worth a test because the route *looks* administrative,
      // and a platform actor is the one caller who might have been let through by accident.
      await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/posture`),
        platformUboss,
      ).expect(403);
    });

    it('refuses an Auditor the revoke route', async () => {
      const established = await seedSession(employeeId);
      await asPerson(
        agent().post(
          `/tenants/${tenantId}/security-center/sessions/${established.sessionId}/revoke?reason=Testing`,
        ),
        auditorUboss,
      ).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // 2. One company cannot see another's
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('refuses a member of one company reading another', async () => {
      await asPerson(
        agent().get(`/tenants/${otherTenantId}/security-center/posture`),
        adminUboss,
        otherTenantId,
      ).expect(403);
    });

    it('does not show another company’s security events', async () => {
      await seedEvent('security.login_failed', { tenantId: otherTenantId });
      await seedEvent('security.login_failed', { tenantId, actorUserId: employeeId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });

      assert.equal(page.total, 1);
      assert.equal(page.rows.length, 1);
    });

    it('does not show another company’s guests', async () => {
      const outsider = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SCOG-0001',
          email: 'guest@other-partner.example',
          displayName: 'Other Guest',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: {
            tenantId: otherTenantId,
            userId: user.id,
            accountState: 'Active',
            userType: 'ExternalGuest',
            guestAccessExpiresAt: new Date(Date.now() + 86_400_000),
          },
        });
        return user;
      });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'GuestAccess',
      });

      assert.equal(page.rows.length, 1);
      assert.ok(!page.rows.some((row) => row.resourceId === outsider.id));
    });

    it('does not count another company’s live sessions', async () => {
      const outsiderId = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SCOS-0001',
          email: 'outsider@other-security.example',
          displayName: 'Outsider',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: otherTenantId, userId: user.id, accountState: 'Active' },
        });
        return user.id;
      });

      await seedSession(outsiderId);
      await seedSession(employeeId);

      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      assert.equal(metric(posture, 'ActiveSessions').value, '1');
    });
  });

  // -------------------------------------------------------------------------
  // 3. The posture is built from real data
  // -------------------------------------------------------------------------

  describe('the posture', () => {
    it('reports MFA coverage against the company’s own policy', async () => {
      // Nobody has a factor and the company requires MFA, so this is a real finding rather than
      // a red badge this module invented.
      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      const reading = metric(posture, 'MfaCoverage');

      assert.equal(reading.value, '0%');
      assert.equal(reading.tone, 'bad');
      assert.match(reading.caption, /MFA is required by policy/);
    });

    it('counts a confirmed factor and nothing else', async () => {
      await ctx.prisma.runAsPlatformOperation(async () => {
        // One confirmed, one pending. Only the confirmed one is coverage.
        await ctx.prisma.client.mfaFactor.create({
          data: { userId: adminId, state: 'Active', confirmedAt: new Date() },
        });
        await ctx.prisma.client.mfaFactor.create({
          data: { userId: employeeId, state: 'Pending' },
        });
      });

      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      // Six active members: the provisioning admin plus the five seeded people.
      assert.match(metric(posture, 'MfaCoverage').caption, /have no confirmed factor/);
      assert.notEqual(metric(posture, 'MfaCoverage').value, '0%');
    });

    it('says SSO is not configured rather than showing a zero', async () => {
      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      assert.equal(metric(posture, 'SsoStatus').value, 'Not configured');
    });

    it('reports a lapsed guest as a problem', async () => {
      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      const guests = metric(posture, 'Guests');

      assert.equal(guests.value, '1');
      assert.equal(guests.tone, 'bad');
      assert.match(guests.caption, /1 lapsed/);
    });

    it('counts failed logins inside the chosen window and not outside it', async () => {
      await seedEvent('security.login_failed', { actorUserId: employeeId });

      const recent = await centre().posture({
        scope: scope(),
        actorUserId: adminId,
        range: 'Last24Hours',
      });
      assert.equal(metric(recent, 'FailedLogins').value, '1');
      assert.match(metric(recent, 'FailedLogins').caption, /last 24 hours/);

      // The same event, asked about a window that ended before it happened.
      const stale = await centre().posture({
        scope: scope(),
        actorUserId: adminId,
        range: 'Last24Hours',
        now: new Date(Date.now() + 3 * 86_400_000),
      });
      assert.equal(metric(stale, 'FailedLogins').value, '0');
    });

    it('treats a new-device sign-in as suspicious without inventing a threshold', async () => {
      await seedEvent('security.new_device_sign_in', { actorUserId: employeeId });

      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      assert.equal(metric(posture, 'SuspiciousEvents').value, '1');
      assert.equal(metric(posture, 'SuspiciousEvents').tone, 'watch');
    });

    it('warns when the company has a single administrator', async () => {
      // Which is exactly the lockout the client asks for a break-glass path for.
      // A grant ends by expiring; there is no `revoked_at` on `role_assignments`. Expiring the
      // provisioning bootstrap admin leaves exactly one live administrator, which also proves the
      // count uses the live-grant predicate rather than counting rows.
      await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.roleAssignment.updateMany({
          where: { tenantId, roleKind: 'CompanyAdmin', userId: { not: adminId } },
          data: { expiresAt: new Date(Date.now() - 86_400_000) },
        }),
      );

      const posture = await centre().posture({ scope: scope(), actorUserId: adminId });
      assert.equal(metric(posture, 'AdminAccounts').value, '1');
      assert.equal(metric(posture, 'AdminAccounts').tone, 'watch');
      assert.match(metric(posture, 'AdminAccounts').caption, /lockout risk/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The seven views
  // -------------------------------------------------------------------------

  describe('the views', () => {
    it('serves every view it advertises', async () => {
      // A vocabulary that names a view the server cannot serve is a broken tab.
      for (const view of SECURITY_CENTER_VIEWS) {
        const page = await centre().view({ scope: scope(), actorUserId: adminId, view });
        assert.equal(page.view, view);
        assert.ok(page.label.length > 0, view);
        assert.ok(page.purpose.length > 0, view);
      }
    });

    it('refuses a view that does not exist', async () => {
      await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/views/Everything`),
        adminUboss,
      ).expect(404);
    });

    it('shows a sign-out as an authentication event', async () => {
      // `Session` events would be invisible if Active Sessions were the only place they could
      // appear: that view shows live state and has no history in it.
      await seedEvent('security.logout_all_devices', { actorUserId: employeeId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });
      assert.ok(page.rows.some((row) => row.title === 'security.logout_all_devices'));
    });

    it('shows a live session with the person, the device and a revoke handle', async () => {
      const established = await seedSession(employeeId);

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'ActiveSessions',
      });

      const row = page.rows.find((candidate) => candidate.id === established.sessionId);
      assert.ok(row, 'the session is not listed');
      assert.equal(row.title, 'Security Employee');
      assert.equal(row.state, 'Live');
      assert.equal(row.revocableSessionId, established.sessionId);
      assert.match(row.detail ?? '', /Test device/);
    });

    it('says out loud that a session is person-level', async () => {
      // The consequence of revoking one is not something to leave an administrator to discover.
      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'ActiveSessions',
      });
      assert.match(page.limitation ?? '', /signs that person out of UBoss entirely/);
    });

    it('shows a permission grant and who gave it', async () => {
      await seedEvent('security.role_assigned', { actorUserId: adminId, resourceId: employeeId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AdminAndPermissionChanges',
      });

      const row = page.rows.find((candidate) => candidate.title === 'security.role_assigned');
      assert.ok(row);
      assert.equal(row.actor, 'Security Admin');
    });

    it('shows a refused permission, which is the row an investigation wants', async () => {
      await seedEvent('security.permission_denied', { actorUserId: employeeId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AdminAndPermissionChanges',
      });
      assert.ok(page.rows.some((row) => row.title === 'security.permission_denied'));
    });

    it('shows a lapsed guest as lapsed rather than as active', async () => {
      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'GuestAccess',
      });

      const row = page.rows.find((candidate) => candidate.resourceId === guestId);
      assert.ok(row);
      assert.equal(row.state, 'Lapsed');
      assert.equal(row.severity, 'Warning');
    });

    it('cannot be shown a guest with no end date, because the database refuses one', async () => {
      // §23 requires guest access to be expiry-capable, and `guest_membership_has_an_expiry`
      // makes it mandatory rather than merely possible. That is a better guarantee than the
      // screen flagging a blank, so this asserts the refusal — the screen keeps the badge as
      // defence for a nullable column, and it should never have anything to show.
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.tenantMembership.updateMany({
              where: { tenantId, userId: guestId },
              data: { guestAccessExpiresAt: null },
            }),
          ),
        /guest_membership_has_an_expiry/,
      );
    });

    it('says what the agent view cannot show', async () => {
      // It shows authority, not use, and nothing pretends otherwise: no run performs an external
      // tool action yet, so there is no invocation log to read.
      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AgentHighRiskActions',
      });
      assert.match(page.limitation ?? '', /no tool-invocation log yet/);
    });

    it('filters by correlation id', async () => {
      await seedEvent('security.login_failed', { actorUserId: employeeId });
      const all = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });
      assert.ok(all.rows.length > 0);

      const nothing = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
        correlationId: 'a-request-that-never-happened',
      });
      assert.equal(nothing.rows.length, 0);
      assert.equal(nothing.total, 0);
    });

    it('filters by actor', async () => {
      await seedEvent('security.login_failed', { actorUserId: employeeId });
      await seedEvent('security.login_failed', { actorUserId: adminId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
        actorFilter: employeeId,
      });

      assert.equal(page.total, 1);
      assert.equal(page.rows[0]?.actor, 'Security Employee');
    });

    it('counts the filter, not the trail', async () => {
      // A view saying "12 of 4,318" would be telling the reader about the audit trail's size.
      for (let index = 0; index < 3; index += 1) {
        await seedEvent('security.login_failed', { actorUserId: employeeId });
      }
      await seedEvent('security.role_assigned', { actorUserId: adminId });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });
      assert.equal(page.total, 3);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Export
  // -------------------------------------------------------------------------

  describe('export', () => {
    it('records its own export, so it appears in the exports view', async () => {
      await centre().exportView({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'DataExports',
      });

      const row = page.rows.find(
        (candidate) => candidate.title === 'security.security_center_exported',
      );
      assert.ok(row, 'the export did not record itself');
      assert.equal(row.actor, 'Security Admin');
      assert.equal(row.resourceId, 'AuthenticationEvents');
    });

    it('refuses an export to somebody who may only read', async () => {
      // Built by granting `Audit` without `Export`, which is the separation the client asks for:
      // investigating and taking the evidence away are different decisions.
      const readerId = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SCRO-0001',
          email: 'reader@security.example',
          displayName: 'Read Only',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user.id;
      });

      const role = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.customRole.create({
          data: {
            tenantId,
            displayName: 'Investigator',
            description: 'May read the security history and take nothing away.',
            // `Audit` without `Export`. The pairing the audit trail already insists on means
            // this role can investigate and cannot remove the evidence.
            permissions: { settings: ['View', 'Audit'] },
            maxScope: 'WholeCompany',
            createdByUserId: adminId,
          },
        }),
      );

      await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: readerId,
            // `role_assignments_custom_role_consistency`: a custom role is assigned as
            // `Custom`, and a template role carries no custom id. Both directions are checked.
            roleKind: 'Custom',
            customRoleId: role.id,
            scopeKind: 'WholeCompany',
            grantedByUserId: platformId,
          },
        }),
      );

      await assert.rejects(
        () =>
          centre().exportView({
            scope: scope(),
            actorUserId: readerId,
            view: 'AuthenticationEvents',
          }),
        /Export|permission/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Signing somebody out
  // -------------------------------------------------------------------------

  describe('revoking a session', () => {
    it('lets a Company Admin sign a colleague out', async () => {
      const established = await seedSession(employeeId);

      const result = await centre().revokeSession({
        scope: scope(),
        actorUserId: adminId,
        sessionId: established.sessionId,
        reason: 'Laptop reported stolen.',
      });

      assert.equal(result.revoked, true);
      assert.equal(result.personDisplayName, 'Security Employee');

      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findUniqueOrThrow({ where: { id: established.sessionId } }),
      );
      assert.notEqual(after.revokedAt, null);
      assert.equal(after.revokedReason, 'company_admin_revoke');
    });

    it('records the revoke as a company act, distinct from a platform one', async () => {
      const established = await seedSession(employeeId);
      await centre().revokeSession({
        scope: scope(),
        actorUserId: adminId,
        sessionId: established.sessionId,
        reason: 'Laptop reported stolen.',
      });

      const page = await centre().view({
        scope: scope(),
        actorUserId: adminId,
        view: 'AuthenticationEvents',
      });

      const row = page.rows.find(
        (candidate) => candidate.title === 'security.session_revoked_by_company_admin',
      );
      assert.ok(row, 'the revoke is not in the trail');
      assert.equal(row.actor, 'Security Admin');
      assert.equal(row.subject, 'Security Employee');
    });

    it('refuses a session belonging to another company’s person', async () => {
      // A session row carries a user id and no tenant id, so without the membership check a
      // company administrator could sign out somebody who has never worked for them.
      const outsiderId = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SCOO-0001',
          email: 'outsider2@other-security.example',
          displayName: 'Outsider Two',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: otherTenantId, userId: user.id, accountState: 'Active' },
        });
        return user.id;
      });

      const established = await seedSession(outsiderId);

      await assert.rejects(
        () =>
          centre().revokeSession({
            scope: scope(),
            actorUserId: adminId,
            sessionId: established.sessionId,
            reason: 'Trying it on.',
          }),
        // The same answer as a session that does not exist: telling an administrator "that one
        // belongs to another company" confirms the id is real.
        /not live/,
      );

      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findUniqueOrThrow({ where: { id: established.sessionId } }),
      );
      assert.equal(after.revokedAt, null);
    });

    it('insists on a reason', async () => {
      const established = await seedSession(employeeId);
      await assert.rejects(
        () =>
          centre().revokeSession({
            scope: scope(),
            actorUserId: adminId,
            sessionId: established.sessionId,
            reason: '   ',
          }),
        /Say why/,
      );
    });

    it('refuses a session that is already revoked', async () => {
      const established = await seedSession(employeeId);
      await centre().revokeSession({
        scope: scope(),
        actorUserId: adminId,
        sessionId: established.sessionId,
        reason: 'First time.',
      });

      await assert.rejects(
        () =>
          centre().revokeSession({
            scope: scope(),
            actorUserId: adminId,
            sessionId: established.sessionId,
            reason: 'Again.',
          }),
        /not live/,
      );
    });

    it('records the cross-company consequence when the person belongs to two companies', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.create({
          data: { tenantId: otherTenantId, userId: employeeId, accountState: 'Active' },
        }),
      );

      const established = await seedSession(employeeId);
      const result = await centre().revokeSession({
        scope: scope(),
        actorUserId: adminId,
        sessionId: established.sessionId,
        reason: 'Laptop reported stolen.',
      });

      // Two memberships, one session: signing them out here ends their access to both, and the
      // number is reported rather than left to be inferred.
      assert.equal(result.signedOutOfCompanies, 2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Tamper protection is structural, not a permission
  // -------------------------------------------------------------------------

  describe('tamper protection', () => {
    it('refuses a company administrator editing a security event, at the database', async () => {
      // The refusal is `permission denied`, not a trigger message, and that is the stronger
      // answer: the application role holds no UPDATE or DELETE grant on the trail tables at
      // all, so PostgreSQL refuses before a trigger would ever run. Both are accepted below,
      // because the guarantee is "the application cannot alter this row", not "by which
      // mechanism".
      await seedEvent('security.login_failed', { actorUserId: employeeId });

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.securityEvent.findFirstOrThrow({ where: { tenantId } }),
      );

      // Attempted with the *application* role, which is what a company administrator's request
      // runs as. The refusal comes from the trigger, below the application.
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.securityEvent.update({
              where: { id: row.id },
              data: { reason: 'Nothing to see here.' },
            }),
          ),
        /append-only|permission denied|cannot be/i,
      );
    });

    it('refuses a delete too', async () => {
      await seedEvent('security.login_failed', { actorUserId: employeeId });

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.securityEvent.findFirstOrThrow({ where: { tenantId } }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.securityEvent.delete({ where: { id: row.id } }),
          ),
        /append-only|permission denied|cannot be/i,
      );
    });

    it('refuses an edit to the audit trail as well', async () => {
      await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditEventService).appendWithinCurrentScope(tenantId, {
          action: 'objective.published',
          resourceType: 'objective',
          resourceId: 'obj-1',
          actorUserId: adminId,
          summary: 'Published.',
        }),
      );

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findFirstOrThrow({ where: { tenantId } }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.auditEvent.update({
              where: { id: row.id },
              data: { summary: 'Something else.' },
            }),
          ),
        /append-only|permission denied|cannot be/i,
      );
    });

    it('offers no route that edits or deletes anything it shows', async () => {
      // The Security Center is a read surface with exactly one act on it. Asserted rather than
      // assumed, because a later prompt adding a "clear" or "acknowledge" route here would
      // break the client's tamper-protection requirement without touching a trigger.
      const server = app.getHttpServer();
      await asPerson(
        request(server).delete(`/tenants/${tenantId}/security-center/views/AuthenticationEvents`),
        adminUboss,
      ).expect(404);
      await asPerson(
        request(server).patch(`/tenants/${tenantId}/security-center/views/AuthenticationEvents`),
        adminUboss,
      ).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The vocabulary the screen builds from
  // -------------------------------------------------------------------------

  describe('vocabulary', () => {
    it('tells the screen which views carry a correlation id', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/vocabulary`),
        adminUboss,
      ).expect(200);

      const views = response.body.views as { view: string; hasCorrelationIds: boolean }[];
      assert.equal(views.length, 7);
      assert.equal(views.find((view) => view.view === 'ActiveSessions')?.hasCorrelationIds, false);
      assert.equal(
        views.find((view) => view.view === 'AuthenticationEvents')?.hasCorrelationIds,
        true,
      );
    });

    it('says what the Security Center is', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/security-center/vocabulary`),
        adminUboss,
      ).expect(200);

      assert.match(response.body.note, /stores nothing of its own/);
    });
  });
});
