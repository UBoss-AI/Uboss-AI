import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  NEVER_IN_A_PORTABLE_PROFILE,
  PORTABLE_EMPLOYMENT_FIELDS,
  PORTABLE_PERFORMANCE_FIELDS,
  PORTABLE_PROFILE_FIELDS,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { ProfileSearchController } from '../src/organization/profile-search.controller.js';
import { ProfileSearchService } from '../src/organization/profile-search.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
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
 * Portable UBoss Profile Search — Prompt 37A, against real PostgreSQL.
 *
 * The prompt asks for **two-tenant security tests**, and this suite is built as one: a person who
 * worked at **Alpha** and now works at **Beta**, and an HR administrator at **Gamma** who has
 * never met either. What Gamma may learn about that person is the whole subject.
 *
 * Three companies rather than two, deliberately: two would let a leak hide behind "well, the
 * searcher is one of the employers". Gamma employs nobody in the profile.
 *
 * Company names are chosen to contain none of the words in `NEVER_IN_A_PORTABLE_PROFILE`, because
 * the leak test greps the serialized response — a company called "TaskForce Ltd" would fail a
 * correct response and somebody would then weaken the grep instead of the field.
 */
describe('portable profile search (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let alphaId: string;
  let betaId: string;
  let gammaId: string;

  let personId: string;
  let personUboss: string;

  let gammaAdminId: string;
  let gammaAdminUboss: string;
  let gammaEmployeeUboss: string;
  let betaAdminId: string;
  let betaAdminUboss: string;
  let platformId: string;

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
      controllers: [ProfileSearchController],
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
        CompanySettingsService,
        ProfileSearchService,
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

    const provision = async (slug: string, name: string) => {
      const created = await ctx.provisioning.provision({
        slug,
        name,
        firstMember: { email: `first@${slug}.example`, displayName: `${name} First` },
      });
      await activateTenant(ctx, created.tenant.id);
      await activateMembership(ctx, created.user.id, created.tenant.id);
      return created.tenant.id;
    };

    // Names with no forbidden substring in them — see the suite comment.
    alphaId = await provision('alpha-works', 'Alpha Works');
    betaId = await provision('beta-labs', 'Beta Labs');
    gammaId = await provision('gamma-hr', 'Gamma HR');

    const made = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (email: string, name: string, memberships: string[]) => {
        // A real generated id, because the service validates the format — `UB-XXXX-XXXX` over an
        // alphabet with no I, O, 0 or 1.
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: name,
        });
        for (const tenantId of memberships) {
          await ctx.prisma.client.tenantMembership.create({
            data: { tenantId, userId: user.id, accountState: 'Active' },
          });
        }
        return user;
      };

      return {
        // Worked at Alpha, now at Beta. Not a member of Gamma at all.
        person: await make('person@alpha-works.example', 'Priya Nair', [alphaId, betaId]),
        gammaAdmin: await make('admin@gamma-hr.example', 'Gamma Admin', [gammaId]),
        gammaEmployee: await make('staff@gamma-hr.example', 'Gamma Staff', [gammaId]),
        betaAdmin: await make('admin@beta-labs.example', 'Beta Admin', [betaId]),
      };
    });

    personId = made.person.id;
    personUboss = made.person.ubossUniqueId;
    gammaAdminId = made.gammaAdmin.id;
    gammaAdminUboss = made.gammaAdmin.ubossUniqueId;
    gammaEmployeeUboss = made.gammaEmployee.ubossUniqueId;
    betaAdminId = made.betaAdmin.id;
    betaAdminUboss = made.betaAdmin.ubossUniqueId;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: generateUbossUniqueId(),
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;

    // Employment: Alpha 2023–2025 as Analyst, Beta 2025–present as Senior Analyst.
    for (const [tenantId, designation, joined, ended] of [
      [alphaId, 'Analyst', new Date('2023-04-01'), new Date('2025-03-31')],
      [betaId, 'Senior Analyst', new Date('2025-04-01'), null],
    ] as const) {
      await ctx.prisma.runInTenantTransaction(scope(tenantId), async () => {
        const department = await ctx.prisma.client.department.create({
          data: { tenantId, name: 'Delivery' },
        });
        await ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId,
            userId: personId,
            employeeId: `EMP-${designation.slice(0, 3).toUpperCase()}`,
            departmentId: department.id,
            designation,
            joinedOn: joined,
            // `employment_end_state_and_date_agree` pairs the state with the date, in both
            // directions. An ended employment with a live state would be a record that says two
            // things at once, which is exactly what a verification must not read.
            ...(ended === null ? {} : { endedAt: ended, state: 'Ended' as const }),
            // Contact details the source company holds. These must never travel.
            workEmail: `${designation.replace(' ', '.').toLowerCase()}@internal.example`,
            workPhone: '+91 90000 00000',
          },
        });
      });
    }

    // Roles: a Gamma CompanyAdmin (HR), a Gamma Employee, a Beta CompanyAdmin.
    for (const [tenantId, userId, roleKind] of [
      [gammaId, gammaAdminId, 'CompanyAdmin'],
      [gammaId, made.gammaEmployee.id, 'Employee'],
      [betaId, made.betaAdmin.id, 'CompanyAdmin'],
    ] as const) {
      await ctx.prisma.runInTenantTransaction(scope(tenantId), () =>
        ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind,
            scopeKind: roleKind === 'Employee' ? 'OwnWork' : 'WholeCompany',
            grantedByUserId: platformId,
          },
        }),
      );
    }
  });

  // ---- helpers ----

  const scope = (id: string) => tenantScopeForPlatformOperation(id);

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace: string): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const settings = () => app.get(CompanySettingsService);

  const enableSearchFor = async (tenantId: string, adminUserId: string) =>
    settings().update({
      scope: scope(tenantId),
      actorUserId: adminUserId,
      values: { 'security.portable_profile_search_enabled': true },
      reason: 'We verify employment history as part of hiring.',
    });

  const shareFrom = async (tenantId: string, adminUserId: string, mode: string) =>
    settings().update({
      scope: scope(tenantId),
      actorUserId: adminUserId,
      values: { 'security.portable_performance_sharing': mode },
      reason: 'Agreed with our people.',
    });

  const search = async (uboss: string, workspace: string, query = personUboss, expected = 200) =>
    (
      await asPerson(
        agent().get(`/tenants/${workspace}/profile-search`).query({ ubossUniqueId: query }),
        uboss,
        workspace,
      ).expect(expected)
    ).body as Record<string, unknown>;

  // -------------------------------------------------------------------------
  // The capability is off until a company turns it on
  // -------------------------------------------------------------------------

  it('refuses a lookup for a company that has not enabled portable search', async () => {
    const response = await asPerson(
      agent().get(`/tenants/${gammaId}/profile-search`).query({ ubossUniqueId: personUboss }),
      gammaAdminUboss,
      gammaId,
    ).expect(403);

    assert.equal(
      JSON.stringify(response.body).includes('switched off'),
      true,
      'the refusal has to say it is a setting rather than a permission',
    );
  });

  it('tells the screen the feature is off, so it need not offer a box that always 403s', async () => {
    const before = (
      await asPerson(
        agent().get(`/tenants/${gammaId}/profile-search/meta`),
        gammaAdminUboss,
        gammaId,
      ).expect(200)
    ).body as { enabled: boolean };
    assert.equal(before.enabled, false);

    await enableSearchFor(gammaId, gammaAdminId);

    const after_ = (
      await asPerson(
        agent().get(`/tenants/${gammaId}/profile-search/meta`),
        gammaAdminUboss,
        gammaId,
      ).expect(200)
    ).body as { enabled: boolean };
    assert.equal(after_.enabled, true);
  });

  // -------------------------------------------------------------------------
  // Only authorized HR/Admin
  // -------------------------------------------------------------------------

  it('refuses an Employee even when the company has enabled it', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    // An Employee holds `profile-search:View` — that is what puts the nav item on their screen.
    // The control is `users:Administer`, which is the "Authorized HR/Admin" the documents name.
    await asPerson(
      agent().get(`/tenants/${gammaId}/profile-search`).query({ ubossUniqueId: personUboss }),
      gammaEmployeeUboss,
      gammaId,
    ).expect(403);
  });

  it('lets a CompanyAdmin search once it is enabled', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    const profile = await search(gammaAdminUboss, gammaId);

    assert.equal(profile['ubossUniqueId'], personUboss);
    assert.equal(profile['displayName'], 'Priya Nair');
  });

  // -------------------------------------------------------------------------
  // The input is a UBoss Unique ID and nothing else
  // -------------------------------------------------------------------------

  it('refuses an email, a name and an Aadhaar-shaped number', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    for (const attempt of ['person@alpha-works.example', 'Priya Nair', '123412341234']) {
      const response = await asPerson(
        agent().get(`/tenants/${gammaId}/profile-search`).query({ ubossUniqueId: attempt }),
        gammaAdminUboss,
        gammaId,
      ).expect(400);

      assert.equal(
        JSON.stringify(response.body).includes('nothing else'),
        true,
        `"${attempt}" must be refused as not a UBoss Unique ID`,
      );
    }
  });

  it('404s an unknown but well-formed id', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    await search(gammaAdminUboss, gammaId, generateUbossUniqueId(), 404);
  });

  // -------------------------------------------------------------------------
  // The projection — the leakage test
  // -------------------------------------------------------------------------

  it('returns exactly the whitelisted fields and nothing else', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    const profile = await search(gammaAdminUboss, gammaId);

    assert.deepEqual(Object.keys(profile).sort(), [...PORTABLE_PROFILE_FIELDS].sort());

    const employments = profile['employments'] as Record<string, unknown>[];
    assert.equal(employments.length, 2, 'Alpha and Beta');
    for (const employment of employments) {
      assert.deepEqual(
        Object.keys(employment).sort(),
        [...PORTABLE_EMPLOYMENT_FIELDS].sort(),
        'an employment entry grew a field the whitelist does not permit',
      );
    }
  });

  /**
   * The prompt's forbidden list, greped against the serialized response.
   *
   * Crude on purpose. A test that checked the shape would pass the moment somebody nested a
   * forbidden thing one level deeper; this one would not.
   */
  it('leaks nothing the prompt forbids, including the source company’s contact details', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    const profile = await search(gammaAdminUboss, gammaId);

    const serialized = JSON.stringify(profile).toLowerCase();
    for (const forbidden of NEVER_IN_A_PORTABLE_PROFILE) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `the portable profile contained the forbidden word "${forbidden}"`,
      );
    }

    // And the specific values the source companies hold about this person.
    for (const held of [
      'internal.example',
      '90000 00000',
      'EMP-ANA',
      'EMP-SEN',
      'Delivery',
      'person@alpha-works.example',
    ]) {
      assert.equal(
        JSON.stringify(profile).includes(held),
        false,
        `the portable profile leaked "${held}", which belongs to the employer rather than the person`,
      );
    }
  });

  it('returns employment facts a verification actually needs', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    const profile = await search(gammaAdminUboss, gammaId);

    const employments = profile['employments'] as {
      companyName: string;
      designation: string;
      isCurrent: boolean;
    }[];

    const beta = employments.find((entry) => entry.companyName === 'Beta Labs');
    const alpha = employments.find((entry) => entry.companyName === 'Alpha Works');

    assert.equal(beta?.designation, 'Senior Analyst');
    assert.equal(beta?.isCurrent, true);
    assert.equal(alpha?.designation, 'Analyst');
    assert.equal(alpha?.isCurrent, false, 'an ended employment is not current');
  });

  // -------------------------------------------------------------------------
  // The source company decides whether its performance travels
  // -------------------------------------------------------------------------

  it('withholds performance from a company that has not chosen to share it', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    const profile = await search(gammaAdminUboss, gammaId);

    const employments = profile['employments'] as { performance: unknown }[];
    for (const employment of employments) {
      assert.equal(
        employment.performance,
        null,
        'Nothing is the default, so no performance should travel',
      );
    }
  });

  it('shares a badge without a score under BadgeOnly, and the score under BadgeAndScore', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    await ctx.prisma.runInTenantTransaction(scope(betaId), () =>
      ctx.prisma.client.badgeHistory.create({
        data: {
          tenantId: betaId,
          subjectUserId: personId,
          level: 'Gold',
          scoreAtChange: 80,
          startedAt: new Date('2025-06-01'),
        },
      }),
    );

    await shareFrom(betaId, betaAdminId, 'BadgeOnly');

    const badgeOnly = await search(gammaAdminUboss, gammaId);
    const beta = (
      badgeOnly['employments'] as {
        companyName: string;
        performance: Record<string, unknown> | null;
      }[]
    ).find((entry) => entry.companyName === 'Beta Labs');

    assert.notEqual(beta?.performance, null, 'BadgeOnly shares something');
    assert.deepEqual(
      Object.keys(beta?.performance ?? {}).sort(),
      [...PORTABLE_PERFORMANCE_FIELDS].sort(),
    );
    assert.equal(beta?.performance?.['badge'], 'Gold');
    assert.equal(beta?.performance?.['score'], null, 'BadgeOnly must withhold the number');

    await shareFrom(betaId, betaAdminId, 'BadgeAndScore');

    const withScore = await search(gammaAdminUboss, gammaId);
    const betaAgain = (
      withScore['employments'] as {
        companyName: string;
        performance: Record<string, unknown> | null;
      }[]
    ).find((entry) => entry.companyName === 'Beta Labs');
    assert.equal(typeof betaAgain?.performance?.['score'], 'number');
  });

  it('keeps one source company’s choice from affecting another’s', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    await shareFrom(betaId, betaAdminId, 'BadgeAndScore');

    const profile = await search(gammaAdminUboss, gammaId);
    const employments = profile['employments'] as {
      companyName: string;
      performance: unknown;
    }[];

    assert.notEqual(
      employments.find((entry) => entry.companyName === 'Beta Labs')?.performance,
      null,
      'Beta chose to share',
    );
    assert.equal(
      employments.find((entry) => entry.companyName === 'Alpha Works')?.performance,
      null,
      'Alpha did not, and Beta’s choice must not speak for them',
    );
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('records every lookup in the searching company’s trail, including one that found nobody', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    await search(gammaAdminUboss, gammaId);
    const missing = generateUbossUniqueId();
    await search(gammaAdminUboss, gammaId, missing, 404);

    const events = await ctx.prisma.runInTenantTransaction(scope(gammaId), () =>
      ctx.prisma.client.auditEvent.findMany({
        where: { tenantId: gammaId, action: 'profile_search.performed' },
        orderBy: { occurredAt: 'asc' },
      }),
    );

    assert.equal(events.length, 2, 'a search that found nobody is as interesting as one that did');
    assert.equal(events[0]?.resourceId, personUboss);
    assert.equal(
      events[1]?.resourceId,
      missing,
      'the trail records what was searched for, not only that a search happened',
    );
  });

  it('writes the audit row in the searcher’s company, not the subject’s', async () => {
    await enableSearchFor(gammaId, gammaAdminId);
    await search(gammaAdminUboss, gammaId);

    for (const tenantId of [alphaId, betaId]) {
      const events = await ctx.prisma.runInTenantTransaction(scope(tenantId), () =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'profile_search.performed' },
        }),
      );
      assert.deepEqual(
        events,
        [],
        'a company must not learn who has been verifying their former employees',
      );
    }
  });

  // -------------------------------------------------------------------------
  // Cross-tenant and IDOR
  // -------------------------------------------------------------------------

  it('refuses a searcher who puts another company’s id in the path', async () => {
    await enableSearchFor(gammaId, gammaAdminId);

    // Gamma's admin is not a member of Beta, so the tenant guard refuses before anything reads.
    await asPerson(
      agent().get(`/tenants/${betaId}/profile-search`).query({ ubossUniqueId: personUboss }),
      gammaAdminUboss,
      betaId,
    ).expect(403);
  });

  it('does not let the searching company’s own enablement decide another company’s', async () => {
    // Gamma enabled it; Beta did not. Beta's admin still cannot search.
    await enableSearchFor(gammaId, gammaAdminId);

    await asPerson(
      agent().get(`/tenants/${betaId}/profile-search`).query({ ubossUniqueId: personUboss }),
      betaAdminUboss,
      betaId,
    ).expect(403);
  });
});
