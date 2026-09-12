import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import type { PlatformRoleKind } from '@uboss/types';

import { AuditChainService } from '../src/audit/audit-chain.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { AuditQueryService } from '../src/audit/audit-query.service.js';
import { BreakGlassService } from '../src/audit/break-glass.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { PlatformAdministrationService } from '../src/platform/platform-administration.service.js';
import { PlatformConsoleController } from '../src/platform/platform-console.controller.js';
import { PlatformConsoleService } from '../src/platform/platform-console.service.js';
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
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * The Master Console at the request layer, against real PostgreSQL.
 *
 * The role arithmetic is proved without a database in `platform-roles.spec.ts`. What can only be
 * tested here is the thing the client actually asked for: **that the platform-role guards
 * refuse**. Before Prompt 9 they could not, because every platform actor was granted all fifteen
 * modules — so most of this suite is one shape repeated across roles, and the negatives are the
 * point.
 */
describe('the Master Console (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let ownerUboss: string;
  let ownerId: string;
  let adminUboss: string;
  let adminId: string;
  let supportUboss: string;
  let supportId: string;
  let securityUboss: string;
  let commercialUboss: string;
  let engineerUboss: string;
  let rolelessUboss: string;
  let rolelessId: string;
  let companyPersonUboss: string;
  let tenantId: string;
  let growthPlanId: string;

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
      controllers: [PlatformConsoleController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuditQueryService,
        AuditChainService,
        // Prompt 36: BreakGlassService reads the company support-access policy from here.
        CompanySettingsService,
        BreakGlassService,
        AuthorizationService,
        RoleAdministrationService,
        TcsionMappingService,
        PlatformConsoleService,
        PlatformAdministrationService,
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
      slug: 'console-co',
      name: 'Console Co',
      legalName: 'Console Co Ltd',
      firstMember: { email: 'first@console.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    // One platform actor per role, plus one with no role, plus a company person. Created as
    // platform actors and then granted a role by hand — `grantPlatformRole` refuses to promote a
    // company person, which is itself tested below.
    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const makePlatform = async (unique: string, name: string) =>
        ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@uboss.example`,
          displayName: name,
          isPlatformActor: true,
        });

      return {
        owner: await makePlatform('UB-OWNR-0001', 'Platform Owner'),
        admin: await makePlatform('UB-ADMN-0001', 'Platform Admin'),
        support: await makePlatform('UB-SUPP-0001', 'Platform Support'),
        security: await makePlatform('UB-SECU-0001', 'Platform Security'),
        commercial: await makePlatform('UB-COMM-0001', 'Platform Commercial'),
        engineer: await makePlatform('UB-ENGR-0001', 'Platform Engineer'),
        roleless: await makePlatform('UB-NONE-0001', 'No Role'),
        company: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-COMP-0001',
          email: 'person@console.example',
          displayName: 'Company Person',
        }),
      };
    });

    ownerId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    supportId = people.support.id;
    supportUboss = people.support.ubossUniqueId;
    securityUboss = people.security.ubossUniqueId;
    commercialUboss = people.commercial.ubossUniqueId;
    engineerUboss = people.engineer.ubossUniqueId;
    rolelessId = people.roleless.id;
    rolelessUboss = people.roleless.ubossUniqueId;
    companyPersonUboss = people.company.ubossUniqueId;

    await ctx.prisma.runAsPlatformOperation(async () => {
      for (const [userId, role] of [
        [ownerId, 'PlatformOwner'],
        [adminId, 'PlatformAdmin'],
        [supportId, 'PlatformSupport'],
        [people.security.id, 'PlatformSecurity'],
        [people.commercial.id, 'PlatformCommercial'],
        [people.engineer.id, 'PlatformEngineer'],
      ] as [string, PlatformRoleKind][]) {
        await ctx.prisma.client.platformRoleAssignment.create({
          data: { userId, role, justification: 'Test fixture.' },
        });
      }

      const growth = await ctx.prisma.client.plan.findUnique({ where: { code: 'growth' } });
      if (!growth) {
        throw new Error('The plans seeded by the Prompt 9 migration are missing.');
      }
      growthPlanId = growth.id;

      await ctx.prisma.client.tenantSubscription.create({
        data: {
          tenant: { connect: { id: tenantId } },
          plan: { connect: { id: growth.id } },
          state: 'Active',
          billingState: 'Current',
          seatsLicensed: 25,
          renewsAt: new Date(Date.now() + 90 * 86_400_000),
          aiAllowanceMinor: 100_000,
          aiConsumedMinor: 44_000,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string): T =>
    test.set('x-uboss-dev-actor', uboss) as T;

  const scope = () => tenantScopeForPlatformOperation(tenantId);

  // =========================================================================
  describe('platform-role guards', () => {
    it('refuses a company person outright — the console is for platform staff', async () => {
      await as(agent().get('/platform/console/dashboard'), companyPersonUboss)
        .set(WORKSPACE_HEADER, tenantId)
        .expect(403);
    });

    it('refuses a platform actor who holds no platform role', async () => {
      // The fail-closed change. Before Prompt 9 this account would have reached every module.
      const response = await as(agent().get('/platform/console/dashboard'), rolelessUboss).expect(
        403,
      );
      // The engine's standard refusal. Asserting on its exact wording would make this test own
      // a message it does not; asserting that access is refused is the property that matters.
      assert.match(
        (response.body as { message: string }).message,
        /do not have access|role|permission/i,
      );
    });

    it('lets a roleless platform actor discover that they hold nothing', async () => {
      // `me` deliberately carries no permission requirement: somebody locked out by a missing
      // assignment must be able to find out why, or the fail-closed design is undebuggable.
      const response = await as(agent().get('/platform/console/me'), rolelessUboss).expect(200);
      const body = response.body as { roles: unknown[]; matrix: Record<string, string[]> };
      assert.deepEqual(body.roles, []);
      assert.deepEqual(body.matrix, {});
    });

    it('lets every role read the dashboard', async () => {
      for (const uboss of [
        ownerUboss,
        adminUboss,
        supportUboss,
        securityUboss,
        commercialUboss,
        engineerUboss,
      ]) {
        await as(agent().get('/platform/console/dashboard'), uboss).expect(200);
      }
    });

    it('lets only Owner, Admin and Commercial administer plans', async () => {
      const permitted = [ownerUboss, adminUboss, commercialUboss];
      const refused = [supportUboss, securityUboss, engineerUboss];

      for (const uboss of permitted) {
        await as(agent().post('/platform/console/plans'), uboss)
          .send({
            code: `probe-${uboss.toLowerCase()}`,
            tier: 'Starter',
            name: 'Probe',
            entitledModules: ['dashboard'],
          })
          .expect(201);
      }
      for (const uboss of refused) {
        await as(agent().post('/platform/console/plans'), uboss)
          .send({ code: 'nope', tier: 'Starter', name: 'Nope', entitledModules: ['dashboard'] })
          .expect(403);
      }
    });

    it('lets ONLY the Owner control a release', async () => {
      // `release:Administer` is Platform Owner alone: a flag changes the product for every
      // customer at once. A Platform Admin, who can do nearly everything else, cannot.
      await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'owner-probe', description: 'Probe.' })
        .expect(201);

      for (const uboss of [adminUboss, engineerUboss, securityUboss, commercialUboss]) {
        await as(agent().post('/platform/console/feature-flags'), uboss)
          .send({ key: 'refused-probe', description: 'Probe.' })
          .expect(403);
      }
      // ...but everyone may read them.
      await as(agent().get('/platform/console/feature-flags'), engineerUboss).expect(200);
    });

    it('lets ONLY the Owner change a global setting', async () => {
      await as(agent().put('/platform/console/settings/provisioning.default_currency'), ownerUboss)
        .send({ value: 'EUR', reason: 'Testing the Owner path.' })
        .expect(200);

      for (const uboss of [adminUboss, commercialUboss, securityUboss]) {
        await as(agent().put('/platform/console/settings/provisioning.default_currency'), uboss)
          .send({ value: 'GBP', reason: 'Should be refused.' })
          .expect(403);
      }
      await as(agent().get('/platform/console/settings'), supportUboss).expect(200);
    });

    it('lets ONLY the Owner grant a platform role', async () => {
      for (const uboss of [adminUboss, securityUboss, commercialUboss, engineerUboss]) {
        await as(agent().post('/platform/console/platform-roles'), uboss)
          .send({
            userId: rolelessId,
            role: 'PlatformSupport',
            justification: 'Should be refused for this role.',
          })
          .expect(403);
      }

      await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: rolelessId,
          role: 'PlatformSupport',
          justification: 'Granted by the Owner in a test.',
        })
        .expect(201);
    });

    it('lets a Security reviewer read the access review without being able to grant', async () => {
      // The separation that makes a review meaningful: a reviewer who could also grant would be
      // reviewing their own decisions.
      await as(agent().get('/platform/console/platform-roles'), securityUboss).expect(200);
      await as(agent().post('/platform/console/platform-roles'), securityUboss)
        .send({ userId: rolelessId, role: 'PlatformSupport', justification: 'Refused.' })
        .expect(403);
    });

    it('lets only Owner and Engineer act on a service alert', async () => {
      const alertId = await ctx.prisma.runAsPlatformOperation(async () => {
        const alert = await ctx.prisma.client.serviceAlert.create({
          data: { service: 'probe', severity: 'Warning', summary: 'Probe alert.' },
        });
        return alert.id;
      });

      await as(
        agent().post(`/platform/console/service-alerts/${alertId}/acknowledge`),
        supportUboss,
      ).expect(403);
      await as(
        agent().post(`/platform/console/service-alerts/${alertId}/acknowledge`),
        engineerUboss,
      ).expect(201);
    });

    it('tells each caller which navigation they may see', async () => {
      const ownerNav = await as(agent().get('/platform/console/me'), ownerUboss).expect(200);
      const supportNav = await as(agent().get('/platform/console/me'), supportUboss).expect(200);

      const visible = (body: unknown) =>
        (body as { navigation: { navKey: string; visible: boolean }[] }).navigation
          .filter((item) => item.visible)
          .map((item) => item.navKey);

      // Every platform role can *see* every module — read is the floor — so the navigation is the
      // same and the difference is in the actions. That is deliberate: hiding a module from an
      // operator who can read it would make the platform harder to reason about.
      assert.equal(visible(ownerNav.body).length, 15);
      assert.equal(visible(supportNav.body).length, 15);

      const ownerMatrix = (ownerNav.body as { matrix: Record<string, string[]> }).matrix;
      const supportMatrix = (supportNav.body as { matrix: Record<string, string[]> }).matrix;
      assert.ok(ownerMatrix['release']?.includes('Administer'));
      assert.ok(!supportMatrix['release']?.includes('Administer'));
      assert.ok(supportMatrix['support']?.includes('Administer'));
    });
  });

  // =========================================================================
  describe('the dashboard', () => {
    it('reports companies, seats, renewals, billing, usage and alerts', async () => {
      const response = await as(agent().get('/platform/console/dashboard'), ownerUboss).expect(200);
      const body = response.body as {
        kpis: Record<string, Record<string, unknown>>;
        companies: { name: string; seatsLabel: string; billing: string; aiUsageLabel: string }[];
        provenanceNotes: { panel: string; provenance: string }[];
      };

      const company = body.companies.find((row) => row.name === 'Console Co');
      assert.ok(company, 'The provisioned company should be listed.');
      // Seats used is measured; licensed is configured. `1 / 25` is the real count.
      assert.equal(company.seatsLabel, '1 / 25');
      assert.equal(company.billing, 'Current');
      assert.equal(company.aiUsageLabel, '44%');

      assert.equal(body.kpis['activeCompanies']?.['provenance'], 'measured');
      assert.equal(body.kpis['aiSpend']?.['provenance'], 'demo');
      assert.equal(body.provenanceNotes.length, 6);
    });

    it('marks every panel with where its numbers come from', async () => {
      // The honesty mechanism. A dashboard that presents a seeded billing figure identically to a
      // measured one teaches its operator to trust both equally.
      const response = await as(agent().get('/platform/console/dashboard'), ownerUboss).expect(200);
      const notes = (response.body as { provenanceNotes: { panel: string; provenance: string }[] })
        .provenanceNotes;

      const byPanel = Object.fromEntries(notes.map((note) => [note.panel, note.provenance]));
      assert.equal(byPanel['Companies and status'], 'measured');
      assert.equal(byPanel['Security attention'], 'measured');
      assert.equal(byPanel['AI usage and spend'], 'demo');
      assert.equal(byPanel['Service alerts'], 'demo');
      assert.equal(byPanel['Seats'], 'configured');
    });

    it('surfaces a real break-glass obligation as a Security flag on the company', async () => {
      // The dashboard's security panel is fed by the Prompt 8 trails, and this proves the link
      // rather than asserting it: a break-glass record whose customer has not been notified must
      // move the company's flag to Security.
      const breakGlass = app.get(BreakGlassService);
      await breakGlass.request({
        tenantId,
        requesterUserId: supportId,
        reason: 'Customer reports every administrator is locked out after an SSO change.',
        allowedModules: ['settings'],
        allowedActions: ['View'],
      });

      const response = await as(agent().get('/platform/console/dashboard'), ownerUboss).expect(200);
      const body = response.body as {
        companies: { name: string; flag: string; attentionReasons: string[] }[];
        securityAttention: { pendingCustomerNotifications: number };
      };

      const company = body.companies.find((row) => row.name === 'Console Co');
      assert.equal(company?.flag, 'Security');
      assert.ok(
        company?.attentionReasons.some((reason) => reason.includes('not been notified')),
        'The outstanding notification must be named as the reason.',
      );
      assert.equal(body.securityAttention.pendingCustomerNotifications, 1);
    });

    it('counts only active memberships as used seats', async () => {
      await ctx.prisma.runAsPlatformOperation(async () => {
        const person = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SEAT-0001',
          email: 'seat@console.example',
          displayName: 'Not Yet Invited',
        });
        // Left at the default account state: an uninvited person is not a used seat.
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: person.id },
        });
      });

      const response = await as(agent().get('/platform/console/dashboard'), ownerUboss).expect(200);
      const company = (
        response.body as { companies: { name: string; seatsLabel: string }[] }
      ).companies.find((row) => row.name === 'Console Co');
      assert.equal(company?.seatsLabel, '1 / 25', 'An uninvited membership is not a used seat.');
    });
  });

  // =========================================================================
  describe('companies and company detail', () => {
    it('lists companies with their commercial position', async () => {
      const response = await as(agent().get('/platform/console/companies'), adminUboss).expect(200);
      const companies = (response.body as { companies: { name: string; plan: string }[] })
        .companies;
      assert.ok(companies.some((row) => row.name === 'Console Co' && row.plan === 'Growth'));
    });

    it('returns one company with its entitlements and its own trail', async () => {
      const response = await as(
        agent().get(`/platform/console/companies/${tenantId}`),
        adminUboss,
      ).expect(200);

      const body = response.body as {
        company: { name: string };
        entitlements: { planModules: string[]; effectiveModules: string[] };
        recentAudit: { action: string }[];
        provenance: { activity: string };
      };

      assert.equal(body.company.name, 'Console Co');
      assert.ok(body.entitlements.planModules.length > 0);
      // Provisioning writes into the company's own trail, so a freshly provisioned company
      // already has real activity to show.
      assert.ok(
        body.recentAudit.some((event) => event.action === 'tenant_membership.created'),
        'The company detail should show the company’s own audit trail.',
      );
      assert.equal(body.provenance.activity, 'measured');
    });

    it('applies withheld modules over extras', async () => {
      await as(agent().put(`/platform/console/companies/${tenantId}/subscription`), adminUboss)
        .send({
          planCode: 'growth',
          extraModules: ['performance'],
          removedModules: ['performance', 'reports'],
          reason: 'Testing entitlement precedence.',
        })
        .expect(200);

      const response = await as(
        agent().get(`/platform/console/companies/${tenantId}`),
        adminUboss,
      ).expect(200);
      const entitlements = (response.body as { entitlements: { effectiveModules: string[] } })
        .entitlements;

      // Withheld wins. An entitlement explicitly taken away must not be restorable by also
      // being listed as an extra, or the two columns would disagree.
      assert.ok(!entitlements.effectiveModules.includes('performance'));
      assert.ok(!entitlements.effectiveModules.includes('reports'));
    });

    it('records a commercial change in the company’s own audit trail', async () => {
      await as(agent().put(`/platform/console/companies/${tenantId}/subscription`), adminUboss)
        .send({ planCode: 'starter', reason: 'Downgraded at the customer’s request.' })
        .expect(200);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'subscription.changed',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      // A change to what a company is paying for is something that company is entitled to see.
      assert.equal(events[0]?.tenantId, tenantId);
      assert.equal(events[0]?.reason, 'Downgraded at the customer’s request.');
    });

    it('refuses a commercial change with no reason', async () => {
      await as(agent().put(`/platform/console/companies/${tenantId}/subscription`), adminUboss)
        .send({ planCode: 'starter' })
        .expect(400);
    });

    it('404s for a company that does not exist', async () => {
      await as(
        agent().get('/platform/console/companies/018f0000-0000-7000-8000-0000000000ff'),
        adminUboss,
      ).expect(404);
    });
  });

  // =========================================================================
  describe('plans', () => {
    it('lists the migration-seeded plans with their subscriber counts', async () => {
      const response = await as(agent().get('/platform/console/plans'), commercialUboss).expect(
        200,
      );
      const plans = (response.body as { plans: { code: string; subscribers: number }[] }).plans;

      assert.ok(plans.some((plan) => plan.code === 'growth'));
      assert.equal(plans.find((plan) => plan.code === 'growth')?.subscribers, 1);
    });

    it('refuses a plan that entitles a platform module', async () => {
      // A plan sells a company access to *company* modules. Naming a platform module would be
      // selling access to the platform's own control plane.
      const response = await as(agent().post('/platform/console/plans'), commercialUboss)
        .send({
          code: 'sneaky',
          tier: 'Starter',
          name: 'Sneaky',
          entitledModules: ['platform-settings'],
        })
        .expect(400);
      assert.match(JSON.stringify(response.body), /company module/i);
    });

    it('refuses a duplicate plan code', async () => {
      await as(agent().post('/platform/console/plans'), commercialUboss)
        .send({
          code: 'growth',
          tier: 'Growth',
          name: 'Growth again',
          entitledModules: ['dashboard'],
        })
        .expect(409);
    });

    it('refuses to retire a plan that companies are on, and names the count', async () => {
      const response = await as(
        agent().put(`/platform/console/plans/${growthPlanId}`),
        commercialUboss,
      )
        .send({ active: false })
        .expect(409);
      assert.match(JSON.stringify(response.body), /1 company/i);
    });

    it('refuses a negative price at the API and at the database', async () => {
      await as(agent().post('/platform/console/plans'), commercialUboss)
        .send({
          code: 'negative',
          tier: 'Starter',
          name: 'Negative',
          entitledModules: ['dashboard'],
          priceMinor: -100,
        })
        .expect(400);

      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `INSERT INTO plans (id, code, tier, name, entitled_modules, price_minor, currency,
               created_at, updated_at, row_version)
             VALUES (gen_random_uuid(), 'neg-direct', 'Starter', 'Neg', ARRAY['dashboard'],
                     -1, 'USD', NOW(), NOW(), 1)`,
          ),
        /plans_amounts_are_not_negative/,
      );
    });
  });

  // =========================================================================
  describe('feature flags', () => {
    it('creates a flag paused at 0% and cannot create one already live', async () => {
      const response = await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'new-thing', description: 'A probe.', rationale: 'Retire after rollout.' })
        .expect(201);

      const body = response.body as { stage: string; state: string };
      // A flag that could be created live would let one call ship an untested change to every
      // customer. Turning it on is a separate, separately audited decision.
      assert.equal(body.stage, 'Dev');
      assert.equal(body.state, 'Paused');

      // `stage` and `state` are not accepted on creation at all.
      await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'born-live', state: 'Active', rolloutPercent: 100 })
        .expect(400);
    });

    it('refuses an Active flag at 0% with nobody named', async () => {
      await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'zero-active' })
        .expect(201);

      const response = await as(
        agent().put('/platform/console/feature-flags/zero-active'),
        ownerUboss,
      )
        .send({ state: 'Active', rolloutPercent: 0, reason: 'Trying to turn it on.' })
        .expect(400);
      // Off in effect, reads as on. That is how a feature comes to be believed live.
      assert.match(JSON.stringify(response.body), /reads as on/i);
    });

    it('refuses a paused flag carrying a rollout, in the service and in the database', async () => {
      await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'paused-probe' })
        .expect(201);

      await as(agent().put('/platform/console/feature-flags/paused-probe'), ownerUboss)
        .send({ state: 'InReview', rolloutPercent: 50, reason: 'Should be refused.' })
        .expect(400);

      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `UPDATE feature_flags SET rollout_percent = 50 WHERE key = 'paused-probe'`,
          ),
        /paused_feature_flag_has_no_rollout/,
      );
    });

    it('requires a reason for every change, and records it as a security event', async () => {
      await as(agent().post('/platform/console/feature-flags'), ownerUboss)
        .send({ key: 'reasoned' })
        .expect(201);

      await as(agent().put('/platform/console/feature-flags/reasoned'), ownerUboss)
        .send({ state: 'Active', rolloutPercent: 10 })
        .expect(400);

      await as(agent().put('/platform/console/feature-flags/reasoned'), ownerUboss)
        .send({ state: 'Active', rolloutPercent: 10, reason: 'Design partner rollout.' })
        .expect(200);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId: null,
          action: 'security.feature_flag_changed',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.severity, 'Warning');
    });
  });

  // =========================================================================
  describe('platform settings', () => {
    it('refuses to change a locked setting even for the Owner', async () => {
      // A locked setting is a client-stated product rule, not a preference. Shown so the rule is
      // visible; refused on write so a click cannot change a requirement.
      const response = await as(
        agent().put('/platform/console/settings/governance.company_creation'),
        ownerUboss,
      )
        .send({ value: 'public_signup', reason: 'Should be refused.' })
        .expect(403);
      assert.match(JSON.stringify(response.body), /locked|product rule/i);
    });

    it('exposes the locked rules the client stated', async () => {
      const response = await as(agent().get('/platform/console/settings'), supportUboss).expect(
        200,
      );
      const settings = (response.body as { settings: { key: string; locked: boolean }[] }).settings;

      const locked = settings.filter((setting) => setting.locked).map((setting) => setting.key);
      assert.ok(locked.includes('governance.company_creation'), 'No public company signup.');
      assert.ok(locked.includes('governance.aadhaar_handling'), 'Aadhaar is matching-only.');
    });

    it('records a setting change as a Critical security event', async () => {
      await as(agent().put('/platform/console/settings/provisioning.default_timezone'), ownerUboss)
        .send({ value: 'Europe/Madrid', reason: 'Second region onboarding.' })
        .expect(200);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId: null,
          action: 'security.platform_setting_changed',
          take: 5,
        }),
      );
      // A global default has the widest blast radius a single change can have.
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('requires a reason', async () => {
      await as(agent().put('/platform/console/settings/provisioning.default_timezone'), ownerUboss)
        .send({ value: 'Europe/Madrid' })
        .expect(400);
    });
  });

  // =========================================================================
  describe('granting platform authority', () => {
    it('refuses a self-grant, and records the attempt', async () => {
      const response = await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: ownerId,
          role: 'PlatformSecurity',
          justification: 'Trying to grant myself a second role.',
        })
        .expect(403);
      assert.match(JSON.stringify(response.body), /cannot grant yourself/i);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId: null,
          action: 'security.platform_role_self_grant_blocked',
          take: 5,
        }),
      );
      // Recorded outside the refused operation, so the record survives the refusal — the Prompt 8
      // lesson applied here.
      assert.equal(events.length, 1);
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('refuses the database a self-granted row too', async () => {
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `INSERT INTO platform_role_assignments
               (id, user_id, role, granted_by_user_id, created_at, updated_at, row_version)
             VALUES (gen_random_uuid(), '${rolelessId}', 'PlatformOwner', '${rolelessId}',
                     NOW(), NOW(), 1)`,
          ),
        /platform_role_not_self_granted/,
      );
    });

    it('refuses to make a company person into platform staff', async () => {
      const companyPerson = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByUbossUniqueIdForPlatform(companyPersonUboss),
      );
      assert.ok(companyPerson);

      const response = await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: companyPerson.id,
          role: 'PlatformSupport',
          justification: 'Trying to promote a company person.',
        })
        .expect(400);
      // Promoting somebody to platform staff is a separate decision with a separate approval
      // path; conflating them would let "grant a support role" mean "create platform access".
      assert.match(JSON.stringify(response.body), /not platform staff/i);
    });

    it('refuses an expiry that has already passed', async () => {
      await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: rolelessId,
          role: 'PlatformSupport',
          justification: 'Expired before it starts.',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })
        .expect(400);
    });

    it('requires a justification', async () => {
      await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({ userId: rolelessId, role: 'PlatformSupport' })
        .expect(400);
    });

    it('stops honouring an expired grant without waiting for a sweep', async () => {
      const granted = await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: rolelessId,
          role: 'PlatformSupport',
          justification: 'A short-lived on-call grant.',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .expect(201);

      await as(agent().get('/platform/console/dashboard'), rolelessUboss).expect(200);

      // Rewind the expiry rather than waiting. Expiry is evaluated on read, so the very next
      // request must refuse — a role that expired a minute ago and still works is authority
      // nobody granted.
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `UPDATE platform_role_assignments SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        (granted.body as { id: string }).id,
      );

      await as(agent().get('/platform/console/dashboard'), rolelessUboss).expect(403);
    });

    it('refuses to revoke the last Platform Owner', async () => {
      const review = await as(
        agent().get('/platform/console/platform-roles'),
        securityUboss,
      ).expect(200);
      const ownerAssignment = (
        review.body as { assignments: { id: string; role: string }[] }
      ).assignments.find((assignment) => assignment.role === 'PlatformOwner');
      assert.ok(ownerAssignment);

      const response = await as(
        agent().post(`/platform/console/platform-roles/${ownerAssignment.id}/revoke`),
        ownerUboss,
      )
        .send({ reason: 'Stepping down.' })
        .expect(403);

      // The platform cannot be locked out of itself: Owner is the only role that can grant
      // roles, so removing the last one leaves nobody able to appoint anybody.
      assert.match(JSON.stringify(response.body), /last Platform Owner/i);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId: null,
          action: 'security.platform_lockout_prevented',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('allows revoking an Owner once a second one exists', async () => {
      await as(agent().post('/platform/console/platform-roles'), ownerUboss)
        .send({
          userId: adminId,
          role: 'PlatformOwner',
          justification: 'A second owner, so the first can step down.',
        })
        .expect(201);

      const review = await as(
        agent().get('/platform/console/platform-roles'),
        securityUboss,
      ).expect(200);
      const first = (
        review.body as { assignments: { id: string; role: string; userId: string }[] }
      ).assignments.find(
        (assignment) => assignment.role === 'PlatformOwner' && assignment.userId === ownerId,
      );
      assert.ok(first);

      await as(agent().post(`/platform/console/platform-roles/${first.id}/revoke`), adminUboss)
        .send({ reason: 'Handover complete.' })
        .expect(201);
    });

    it('surfaces platform staff who hold no role at all', async () => {
      const response = await as(
        agent().get('/platform/console/platform-roles'),
        securityUboss,
      ).expect(200);
      const body = response.body as {
        platformActorsWithoutRoles: { ubossUniqueId: string }[];
      };
      // The most useful row on an access review, and one a list of assignments cannot show.
      assert.ok(
        body.platformActorsWithoutRoles.some((actor) => actor.ubossUniqueId === rolelessUboss),
      );
    });
  });

  // =========================================================================
  describe('Create Company — the entry point only', () => {
    it('returns the prerequisites and states that the wizard is not built', async () => {
      const response = await as(
        agent().get('/platform/console/create-company/prerequisites'),
        adminUboss,
      ).expect(200);

      const body = response.body as {
        steps: string[];
        plans: unknown[];
        readiness: { wizardImplemented: boolean };
        constraints: { companyCreation: string };
      };

      assert.equal(body.steps.length, 5);
      assert.ok(body.plans.length >= 4);
      assert.equal(body.readiness.wizardImplemented, false);
      assert.equal(body.constraints.companyCreation, 'master_console_only');
    });

    it('has no provisioning endpoint at all', async () => {
      // The client's instruction was to not implement the wizard this prompt. The absence is the
      // deliverable: `TenantProvisioningService` already works, so a POST here would be a few
      // lines and would quietly become the real provisioning path, skipping the plan,
      // entitlement, budget and security steps.
      await as(agent().post('/platform/console/create-company'), ownerUboss)
        .send({ slug: 'sneaky', name: 'Sneaky' })
        .expect(404);
      await as(agent().post('/platform/console/create-company/prerequisites'), ownerUboss)
        .send({})
        .expect(404);
    });
  });

  // =========================================================================
  describe('module shells', () => {
    it('says what each unbuilt module is waiting for', async () => {
      const response = await as(agent().get('/platform/console/module-status'), adminUboss).expect(
        200,
      );
      const modules = (
        response.body as { modules: { navKey: string; state: string; blockedOn: string }[] }
      ).modules;

      // Seven entries, and the property that matters is not how many are shells — it is that
      // **every one says something specific**, rather than "coming in the next batch".
      //
      // `providers` went live at Prompt 29, and the assertion was updated rather than relaxed:
      // a live module still has to explain what it cannot do yet, and say what it can. The
      // original version of this test asserted every module was a shell, which stopped being
      // true the moment one was built.
      assert.equal(modules.length, 7);
      for (const module of modules) {
        assert.ok(
          ['shell', 'live'].includes(module.state),
          `${module.navKey} has an unknown state: ${module.state}`,
        );
        assert.ok(
          module.blockedOn.length > 40,
          `${module.navKey} needs a real explanation of what blocks it.`,
        );
      }

      // Still a shell, with a real blocker.
      assert.ok(modules.some((module) => module.navKey === 'billing' && module.state === 'shell'));

      // Live since Prompt 31, and honest about what is still missing: the figures are real but
      // stay at zero while no provider has ever been called.
      const credits = modules.find((module) => module.navKey === 'credits');
      assert.equal(credits?.state, 'live');
      assert.match(credits?.blockedOn ?? '', /credential|zero/i);

      // Live, and honest about the part that is not: adapters exist and have never reached a
      // provider, because no credential has been supplied.
      const providers = modules.find((module) => module.navKey === 'providers');
      assert.equal(providers?.state, 'live');
      assert.match(providers?.blockedOn ?? '', /credential/i);
    });
  });
});
