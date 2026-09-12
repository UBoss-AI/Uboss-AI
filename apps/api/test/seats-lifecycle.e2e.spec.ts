import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import {
  CompanyCommercialController,
  PlatformCommercialController,
} from '../src/commercial/commercial.controller.js';
import { CommercialService } from '../src/commercial/commercial.service.js';
import {
  ALLOWED_LIFECYCLE_TRANSITIONS,
  CompanyLifecycleService,
} from '../src/commercial/company-lifecycle.service.js';
import { COUNTED_ACCOUNT_STATES, SeatService } from '../src/commercial/seat.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
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
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Plans, entitlements, seats and company lifecycle, against real PostgreSQL.
 *
 * Four properties carry this prompt:
 *
 *  1. **Nothing silently exceeds the contracted ceiling** — including two concurrent claims for
 *     the last seat, which is the case a displayed count cannot handle.
 *  2. **Reducing seats destroys nothing.** Users, memberships, audit history all survive; a
 *     grace window holds the old ceiling instead.
 *  3. **Plan is not RBAC.** Buying a bigger plan grants nobody any authority.
 *  4. **Each lifecycle state has exact, enforced behaviour**, and illegal transitions are
 *     refused rather than merely unusual.
 */
describe('plans, seats and company lifecycle (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let adminId: string;
  let adminUboss: string;
  let employeeUboss: string;
  let ownerUboss: string;
  let ownerId: string;
  let commercialUboss: string;

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
      controllers: [CompanyCommercialController, PlatformCommercialController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        SeatService,
        CommercialService,
        CompanyLifecycleService,
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
      slug: 'seat-co',
      name: 'Seat Co',
      firstMember: { email: 'first@seat.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@seat.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };
      const platform = async (unique: string, name: string) =>
        ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@uboss.example`,
          displayName: name,
          isPlatformActor: true,
        });

      return {
        admin: await member('UB-ADM1-0001', 'Company Admin'),
        employee: await member('UB-EMP1-0001', 'Employee'),
        owner: await platform('UB-OWNR-0001', 'Platform Owner'),
        commercial: await platform('UB-COMM-0001', 'Platform Commercial'),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    employeeUboss = people.employee.ubossUniqueId;
    ownerId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    commercialUboss = people.commercial.ubossUniqueId;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });
      await ctx.prisma.client.platformRoleAssignment.create({
        data: {
          userId: people.commercial.id,
          role: 'PlatformCommercial',
          justification: 'Fixture.',
        },
      });

      for (const [userId, roleKind] of [
        [adminId, 'CompanyAdmin'],
        [people.employee.id, 'Employee'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind,
            scopeKind: roleKind === 'CompanyAdmin' ? 'WholeCompany' : 'OwnWork',
            grantedByUserId: ownerId,
          },
        });
      }

      const growth = await ctx.prisma.client.plan.findUnique({ where: { code: 'growth' } });
      await ctx.prisma.client.tenantSubscription.create({
        data: {
          tenant: { connect: { id: tenantId } },
          plan: { connect: { id: growth!.id } },
          state: 'Active',
          billingState: 'Current',
          billingCycle: 'Annual',
          // Three counted seats exist (first member + admin + employee), so a ceiling of 4
          // leaves exactly one — which is what the race test needs.
          seatsLicensed: 4,
          renewsAt: new Date(Date.now() + 200 * 86_400_000),
          aiAllowanceMinor: 100_000,
          aiConsumedMinor: 20_000,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const asPlatform = <T extends request.Test>(test: T, uboss: string): T =>
    test.set('x-uboss-dev-actor', uboss) as T;

  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const seats = () => app.get(SeatService);
  const commercial = () => app.get(CommercialService);
  const lifecycle = () => app.get(CompanyLifecycleService);

  const addMember = async (unique: string, accountState = 'NotInvited') =>
    ctx.prisma.runAsPlatformOperation(async () => {
      const user = await ctx.users.createForPlatform({
        ubossUniqueId: unique,
        email: `${unique.toLowerCase()}@seat.example`,
        displayName: unique,
      });
      await ctx.prisma.client.tenantMembership.create({
        data: { tenantId, userId: user.id, accountState: accountState as never },
      });
      return user.id;
    });

  // =========================================================================
  describe('seat counting rules', () => {
    it('counts exactly the states its rule names', () => {
      // The whole of "what counts as a seat", auditable in three lines.
      assert.deepEqual(COUNTED_ACCOUNT_STATES.ActiveOnly, ['Active']);
      assert.deepEqual(COUNTED_ACCOUNT_STATES.ActiveAndInvited, ['Active', 'InvitePending']);
      assert.deepEqual(COUNTED_ACCOUNT_STATES.ActiveInvitedAndSuspended, [
        'Active',
        'InvitePending',
        'Suspended',
      ]);
    });

    it('reports used, available and a per-state breakdown', async () => {
      const position = await seats().positionFor(scope());
      assert.equal(position.ceiling, 4);
      assert.equal(position.used, 3);
      assert.equal(position.available, 1);
      assert.equal(position.rule, 'ActiveAndInvited');
      // The breakdown exists so "why is used 3" has an answer on the screen.
      assert.equal(position.breakdown['Active'], 3);
    });

    it('counts an outstanding invitation under the default rule', async () => {
      await addMember('UB-INV1-0001', 'InvitePending');
      const position = await seats().positionFor(scope());
      // An outstanding invitation is a committed seat, so the ceiling is reached at invitation
      // time — where an administrator can still act — rather than at activation time, where the
      // person has already been told they have an account.
      assert.equal(position.used, 4);
      assert.equal(position.atCeiling, true);
    });

    it('does not count an invitation under ActiveOnly', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatCountingOverride: 'ActiveOnly' },
        }),
      );
      await addMember('UB-INV2-0001', 'InvitePending');

      const position = await seats().positionFor(scope());
      assert.equal(position.rule, 'ActiveOnly');
      assert.equal(position.used, 3);
    });

    it('counts a suspended account under ActiveInvitedAndSuspended', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatCountingOverride: 'ActiveInvitedAndSuspended' },
        }),
      );
      await addMember('UB-SUS1-0001', 'Suspended');

      const position = await seats().positionFor(scope());
      // Suspending somebody does not free their seat. That is the point for a
      // per-provisioned-person contract: it stops seat churn running a 50-person company on 10.
      assert.equal(position.used, 4);
    });

    it('honours a per-company override over the plan rule', async () => {
      const before = await seats().positionFor(scope());
      assert.equal(before.rule, 'ActiveAndInvited');

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatCountingOverride: 'ActiveOnly' },
        }),
      );

      const after = await seats().positionFor(scope());
      assert.equal(after.rule, 'ActiveOnly');
    });
  });

  // =========================================================================
  describe('the ceiling cannot be silently exceeded', () => {
    it('warns near the ceiling', async () => {
      const position = await seats().positionFor(scope());
      // 3 of 4 is 75% — not yet a warning.
      assert.equal(position.nearCeiling, false);

      await addMember('UB-NEAR-0001', 'Active');
      const near = await seats().positionFor(scope());
      // 4 of 4 is at the ceiling, which is also near it.
      assert.equal(near.nearCeiling, true);
      assert.equal(near.atCeiling, true);
    });

    it('permits a claim while there is room', async () => {
      const claimed = await ctx.prisma.runAsPlatformOperation(() =>
        seats().claimSeat({ tenantId, targetState: 'Active' }),
      );
      assert.equal(claimed.used, 4);
      assert.equal(claimed.available, 0);
    });

    it('refuses a claim at the ceiling, and says whether more can be requested', async () => {
      await addMember('UB-FULL-0001', 'Active');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            seats().claimSeat({ tenantId, targetState: 'Active' }),
          ),
        (error: Error) => {
          assert.match(error.message, /contracted ceiling of 4/);
          // The client's "block OR Request/Buy More Seats according to policy" — the Growth plan
          // allows requests, so the refusal says so.
          assert.match(error.message, /Request more seats/);
          return true;
        },
      );
    });

    it('says the plan forbids requests when it does', async () => {
      await ctx.prisma.runAsPlatformOperation(async () => {
        await ctx.prisma.client.plan.updateMany({
          where: { code: 'growth' },
          data: { allowSeatRequests: false },
        });
      });
      await addMember('UB-NOREQ-001', 'Active');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            seats().claimSeat({ tenantId, targetState: 'Active' }),
          ),
        /does not allow seat requests/,
      );
    });

    it('does not consume a seat for a state the rule does not count', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatCountingOverride: 'ActiveOnly' },
        }),
      );
      await addMember('UB-FULL-0002', 'Active');

      // At the ceiling under ActiveOnly (4 active), but an invitation costs nothing, so the
      // claim succeeds.
      const claimed = await ctx.prisma.runAsPlatformOperation(() =>
        seats().claimSeat({ tenantId, targetState: 'InvitePending' }),
      );
      assert.equal(claimed.atCeiling, true);
    });

    it('does not double-charge somebody already occupying a seat', async () => {
      await addMember('UB-FULL-0003', 'Active');
      // At the ceiling. Moving an already-counted person between counted states must not need a
      // new seat, or reinstating a suspended user would be impossible at a full ceiling.
      const claimed = await ctx.prisma.runAsPlatformOperation(() =>
        seats().claimSeat({ tenantId, targetState: 'Active', alreadyCounted: true }),
      );
      assert.equal(claimed.used, 4);
    });

    it('refuses a company with no plan rather than treating it as unlimited', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.deleteMany({ where: { tenantId } }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            seats().claimSeat({ tenantId, targetState: 'Active' }),
          ),
        /no contracted seat ceiling/,
      );
    });

    it('serialises concurrent claims for the last seat', async () => {
      // The case a displayed count cannot handle: both callers read `used = 3` against a ceiling
      // of 4, both decide there is room, and the company ends up at 5 with no error anywhere.
      //
      // Each claim runs in its own transaction and takes the tenant's advisory lock, so the
      // second sees the first's write. Exactly one must succeed.
      const attempt = async (unique: string) =>
        ctx.prisma.runAsPlatformOperation(async () => {
          await seats().claimSeat({ tenantId, targetState: 'Active' });
          const user = await ctx.users.createForPlatform({
            ubossUniqueId: unique,
            email: `${unique.toLowerCase()}@seat.example`,
            displayName: unique,
          });
          await ctx.prisma.client.tenantMembership.create({
            data: { tenantId, userId: user.id, accountState: 'Active' },
          });
        });

      const results = await Promise.allSettled([attempt('UB-RACE-0001'), attempt('UB-RACE-0002')]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
      const rejected = results.filter((result) => result.status === 'rejected').length;

      assert.equal(fulfilled, 1, 'Exactly one claim for the last seat must succeed.');
      assert.equal(rejected, 1, 'The other must be refused, not silently allowed.');

      const position = await seats().positionFor(scope());
      assert.equal(position.used, 4, 'The company must not exceed its contracted ceiling.');
      assert.ok(position.used <= (position.ceiling ?? 0));
    });
  });

  // =========================================================================
  describe('reducing seats destroys nothing', () => {
    it('assesses a reduction and states that nothing is deleted', async () => {
      const assessment = await seats().assessReduction({ tenantId, newCeiling: 2 });
      assert.equal(assessment.used, 3);
      assert.equal(assessment.overBy, 1);
      assert.equal(assessment.needsGrace, true);
      assert.match(assessment.note, /Nobody is removed/);
      assert.match(assessment.note, /no user, employment record, task, Agent history or audit/i);
    });

    it('holds the old ceiling with a grace window, and removes nobody', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(async () => ({
        users: await ctx.prisma.client.user.count(),
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
      }));

      await commercial().setContractedSeats({
        tenantId,
        seats: 2,
        reason: 'Customer downsized at renewal.',
        actorUserId: ownerId,
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        users: await ctx.prisma.client.user.count(),
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
      }));

      // The client's rule, asserted rather than asserted-about: no users, no memberships and no
      // audit rows disappear. Audit only grows.
      assert.equal(after.users, before.users);
      assert.equal(after.memberships, before.memberships);
      assert.ok(after.audit > before.audit);

      const position = await seats().positionFor(scope());
      // The contracted number dropped, but the *enforced* ceiling is still the old one while the
      // company gets under it.
      assert.equal(position.contractedCeiling, 2);
      assert.equal(position.ceiling, 4);
      assert.ok(position.grace);
      assert.equal(position.grace?.heldCeiling, 4);
      assert.equal(position.grace?.contractedCeiling, 2);
    });

    it('enforces the lower ceiling once grace has passed', async () => {
      await commercial().setContractedSeats({
        tenantId,
        seats: 2,
        reason: 'Customer downsized at renewal.',
        actorUserId: ownerId,
      });

      // Rewind the window rather than waiting a month.
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `UPDATE tenant_subscriptions SET seat_grace_until = NOW() - INTERVAL '1 day'
         WHERE tenant_id = $1`,
        tenantId,
      );

      const position = await seats().positionFor(scope());
      assert.equal(position.ceiling, 2);
      assert.equal(position.grace, null);
      assert.equal(position.atCeiling, true);

      // Now over the ceiling, so a new person is refused — but the existing three are untouched.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            seats().claimSeat({ tenantId, targetState: 'Active' }),
          ),
        /contracted ceiling of 2/,
      );
      const memberships = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
      );
      assert.equal(memberships, 3);
    });

    it('records the reduction with nothingDeleted in the company’s own trail', async () => {
      await commercial().setContractedSeats({
        tenantId,
        seats: 2,
        reason: 'Customer downsized at renewal.',
        actorUserId: ownerId,
      });

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'commercial.seats_changed',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal((events[0]?.metadata as { nothingDeleted: boolean }).nothingDeleted, true);
      assert.equal(events[0]?.reason, 'Customer downsized at renewal.');
    });

    it('applies no grace when the company is already under the new ceiling', async () => {
      await commercial().setContractedSeats({
        tenantId,
        seats: 10,
        reason: 'Contract increased.',
        actorUserId: ownerId,
      });
      const position = await seats().positionFor(scope());
      // A window holding a ceiling nobody is near would be a screen element that only confuses.
      assert.equal(position.grace, null);
      assert.equal(position.ceiling, 10);
    });
  });

  // =========================================================================
  describe('plan is not RBAC', () => {
    it('omits roles from the commercial position, and says why', async () => {
      const position = await commercial().positionForCompany(scope(), adminId);
      const serialised = JSON.stringify(position);

      // Nothing role-shaped anywhere in the object.
      assert.doesNotMatch(serialised, /"(roleKind|roles|permissions|scopeKind)"\s*:/);
      assert.match(position.rbacNote, /separate questions/i);
      assert.match(position.rbacNote, /grants nobody any authority/i);
    });

    it('keeps the five concepts as five separate groups', async () => {
      const position = await commercial().positionForCompany(scope(), adminId);
      assert.ok(position.plan.code, '(1) Commercial Plan');
      assert.ok(position.entitlements.planModules.length > 0, '(2) Module Entitlements');
      assert.equal(position.release.channel, 'Stable', '(3) Feature / Release Channel');
      assert.equal(position.allowance.aiAllowanceMinor, 100_000, '(4) Commercial Allowance');
      assert.equal(position.seats.ceiling, 4, 'seats are commercial, not permissions');
    });

    it('does not change anybody’s authority when the plan changes', async () => {
      const authorization = app.get(AuthorizationService);
      const beforeContext = await authorization.contextFor(scope(), adminId);
      const beforeMatrix = JSON.stringify(authorization.matrixFor(beforeContext));

      await commercial().setContractedSeats({
        tenantId,
        seats: 40,
        reason: 'Upgraded to a larger contract.',
        actorUserId: ownerId,
      });
      await ctx.prisma.runAsPlatformOperation(async () => {
        const enterprise = await ctx.prisma.client.plan.findUnique({
          where: { code: 'enterprise' },
        });
        await ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { planId: enterprise!.id },
        });
      });

      const afterContext = await authorization.contextFor(scope(), adminId);
      const afterMatrix = JSON.stringify(authorization.matrixFor(afterContext));

      // The classic SaaS bug this separation exists to prevent: buying a bigger plan quietly
      // widening somebody's authority.
      assert.equal(afterMatrix, beforeMatrix, 'A plan change must not alter any permission.');
    });

    it('applies withheld over extra when resolving entitlements', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { extraModules: ['performance'], removedModules: ['performance', 'reports'] },
        }),
      );

      const modules = await commercial().entitledModulesFor(tenantId);
      assert.ok(!modules.includes('performance'));
      assert.ok(!modules.includes('reports'));
    });

    it('separates the release channel from the entitlement', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { releaseChannelOverride: 'Early' },
        }),
      );
      const position = await commercial().positionForCompany(scope(), adminId);
      // A design partner on an otherwise Stable plan. Which *version* they see is not which
      // modules they have.
      assert.equal(position.release.channel, 'Early');
      assert.equal(position.release.fromPlan, 'Stable');
      assert.equal(position.release.overridden, true);
    });
  });

  // =========================================================================
  describe('company views and requests, platform decides', () => {
    it('lets any company role read the seat position', async () => {
      // A manager who cannot see the remaining seats will invite somebody into a refusal.
      await as(agent().get(`/tenants/${tenantId}/commercial/seats`), employeeUboss).expect(200);
    });

    it('lets a Company Admin request more seats', async () => {
      const response = await as(
        agent().post(`/tenants/${tenantId}/commercial/requests`),
        adminUboss,
      )
        .send({
          kind: 'MoreSeats',
          requestedSeats: 20,
          justification: 'Hiring twelve people in the next quarter.',
        })
        .expect(201);
      assert.equal((response.body as { state: string }).state, 'Requested');
    });

    it('refuses a request from a role that is not Company Admin', async () => {
      await as(agent().post(`/tenants/${tenantId}/commercial/requests`), employeeUboss)
        .send({
          kind: 'MoreSeats',
          requestedSeats: 20,
          justification: 'I would like more seats please.',
        })
        .expect(403);
    });

    it('gives the company no way to set its own ceiling', async () => {
      // The client's rule: the contracted ceiling is a contract, not a preference. There is no
      // company-side route that changes it.
      for (const path of [
        `/tenants/${tenantId}/commercial/seats`,
        `/tenants/${tenantId}/commercial/position`,
      ]) {
        const response = await as(agent().put(path), adminUboss).send({ seats: 500 });
        assert.notEqual(response.status, 200, `${path} must not accept a PUT.`);
      }
    });

    it('refuses a request that names nothing actionable', async () => {
      await as(agent().post(`/tenants/${tenantId}/commercial/requests`), adminUboss)
        .send({ kind: 'MoreSeats', justification: 'We need more seats than we have.' })
        .expect(400);
    });

    it('refuses a second open request of the same kind', async () => {
      await as(agent().post(`/tenants/${tenantId}/commercial/requests`), adminUboss)
        .send({ kind: 'MoreSeats', requestedSeats: 20, justification: 'Hiring in Q3 and Q4.' })
        .expect(201);
      await as(agent().post(`/tenants/${tenantId}/commercial/requests`), adminUboss)
        .send({ kind: 'MoreSeats', requestedSeats: 30, justification: 'Hiring even more now.' })
        .expect(409);
    });

    it('refuses a requester deciding their own request', async () => {
      // The whole point of the request/decide split.
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'MoreSeats',
        requestedSeats: 20,
        justification: 'Hiring twelve people next quarter.',
      });

      await assert.rejects(
        () =>
          commercial().decideChange({
            requestId: created.id,
            actorUserId: adminId,
            approve: true,
          }),
        /cannot decide your own/i,
      );

      const blocked = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.commercial_self_decision_blocked',
          take: 5,
        }),
      );
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]?.severity, 'Critical');
    });

    it('approves and applies a seat increase immediately', async () => {
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'MoreSeats',
        requestedSeats: 20,
        justification: 'Hiring twelve people next quarter.',
      });

      await asPlatform(
        agent().post(`/platform/commercial/requests/${created.id}/decide`),
        ownerUboss,
      )
        .send({ decision: 'approve', apply: 'now', note: 'Agreed on the renewal call.' })
        .expect(201);

      const position = await seats().positionFor(scope());
      // An increase applies at once: there is no reason to make a customer wait for capacity
      // they have agreed to pay for.
      assert.equal(position.ceiling, 20);
    });

    it('schedules a downgrade for the future rather than applying it now', async () => {
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'PlanDowngrade',
        requestedPlanCode: 'starter',
        justification: 'Moving to the smaller plan at renewal.',
      });

      const effectiveAt = new Date(Date.now() + 60 * 86_400_000);
      await commercial().decideChange({
        requestId: created.id,
        actorUserId: ownerId,
        approve: true,
        applyNow: true,
        effectiveAt,
      });

      const position = await commercial().positionForCompany(scope(), adminId);
      // Applying a downgrade the moment it is agreed would take away capacity the customer has
      // already paid for through the end of the term.
      assert.equal(position.plan.code, 'growth', 'The current plan is unchanged.');
      assert.ok(position.pendingChange);
      assert.equal(position.pendingChange?.planCode, 'starter');
    });

    it('applies a scheduled plan change when its date arrives', async () => {
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'PlanDowngrade',
        requestedPlanCode: 'starter',
        justification: 'Moving to the smaller plan at renewal.',
      });
      await commercial().decideChange({
        requestId: created.id,
        actorUserId: ownerId,
        approve: true,
        applyNow: true,
        effectiveAt: new Date(Date.now() + 60 * 86_400_000),
      });

      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `UPDATE tenant_subscriptions SET pending_effective_at = NOW() - INTERVAL '1 hour'
         WHERE tenant_id = $1`,
        tenantId,
      );

      const applied = await commercial().applyDuePlanChanges();
      assert.equal(applied, 1);

      const position = await commercial().positionForCompany(scope(), adminId);
      assert.equal(position.plan.code, 'starter');
      assert.equal(position.pendingChange, null);
      assert.equal(position.seats.ceiling, 10, 'The ceiling is now the starter plan’s.');
      // Three people against a ceiling of ten: no window, because an unnecessary one would let
      // this company add seven more and then be over its contract the moment it shut.
      assert.equal(position.seats.grace, null);
    });

    it('opens a grace window when a scheduled downgrade lands on a company that is over', async () => {
      await commercial().setContractedSeats({
        tenantId,
        seats: 3,
        reason: 'Contract trimmed to the people actually using it.',
        actorUserId: ownerId,
      });
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'FewerSeats',
        requestedSeats: 1,
        justification: 'Down to a single seat at the end of the term.',
      });
      await commercial().decideChange({
        requestId: created.id,
        actorUserId: ownerId,
        approve: true,
        applyNow: true,
      });

      const position = await seats().positionFor(scope());
      // Three people, a contracted ceiling of one. Nobody is removed: the old ceiling holds.
      assert.equal(position.contractedCeiling, 1);
      assert.equal(position.ceiling, 3);
      assert.equal(position.grace?.heldCeiling, 3);
    });

    it('lets a company withdraw an open request', async () => {
      const created = await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'MoreSeats',
        requestedSeats: 20,
        justification: 'Hiring twelve people next quarter.',
      });
      const withdrawn = await commercial().withdrawChange({
        scope: scope(),
        userId: adminId,
        requestId: created.id,
      });
      assert.equal(withdrawn.state, 'Withdrawn');
    });

    it('never shows one company another’s commercial requests', async () => {
      await commercial().requestChange({
        scope: scope(),
        userId: adminId,
        kind: 'MoreSeats',
        requestedSeats: 20,
        justification: 'Hiring twelve people next quarter.',
      });

      const other = await ctx.provisioning.provision({
        slug: 'other-seat-co',
        name: 'Other Seat Co',
        firstMember: { email: 'first@other.example', displayName: 'Other First' },
      });
      await activateTenant(ctx, other.tenant.id);

      const requests = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(other.tenant.id),
        () =>
          ctx.prisma.client.commercialChangeRequest.findMany({
            where: { tenantId: other.tenant.id },
          }),
      );
      assert.equal(requests.length, 0);
    });
  });

  // =========================================================================
  describe('company lifecycle', () => {
    it('reports the state, what it permits, and where it may go', async () => {
      const view = await lifecycle().viewFor(tenantId);
      assert.equal(view.state, 'Active');
      assert.equal(view.capability.canAccess, true);
      assert.equal(view.capability.canWrite, true);
      // The behaviour table comes from the Prompt 4 capability model — one source, not two.
      assert.deepEqual([...view.allowedNext], ['Suspended', 'ReadOnly', 'Closed']);
    });

    it('enforces exact behaviour for each state', () => {
      // Read-only is the interesting one: accessible but not writable, which is what makes it
      // different from Suspended.
      assert.deepEqual(
        [...ALLOWED_LIFECYCLE_TRANSITIONS.Active],
        ['Suspended', 'ReadOnly', 'Closed'],
      );
      assert.deepEqual([...ALLOWED_LIFECYCLE_TRANSITIONS.Closed], []);
      assert.ok(ALLOWED_LIFECYCLE_TRANSITIONS.Suspended.includes('Active'));
      assert.ok(ALLOWED_LIFECYCLE_TRANSITIONS.ReadOnly.includes('Active'));
    });

    it('suspends with a reason and records it in the company’s own trail', async () => {
      const view = await lifecycle().transition({
        tenantId,
        toState: 'Suspended',
        reason: 'Payment overdue beyond the grace period.',
        actorUserId: ownerId,
      });
      assert.equal(view.state, 'Suspended');
      assert.equal(view.capability.canAccess, false);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'company.lifecycle_changed',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.reason, 'Payment overdue beyond the grace period.');
      // The question a customer asks first, answerable from the trail.
      assert.equal((events[0]?.metadata as { nothingDeleted: boolean }).nothingDeleted, true);
    });

    it('refuses a lifecycle change with no reason', async () => {
      await assert.rejects(
        () =>
          lifecycle().transition({
            tenantId,
            toState: 'Suspended',
            reason: '   ',
            actorUserId: ownerId,
          }),
        /requires a reason/i,
      );
    });

    it('refuses reopening a closed company', async () => {
      await lifecycle().transition({
        tenantId,
        toState: 'Closed',
        reason: 'Contract ended and the customer did not renew.',
        actorUserId: ownerId,
      });

      await assert.rejects(
        () =>
          lifecycle().transition({
            tenantId,
            toState: 'Active',
            reason: 'They changed their mind.',
            actorUserId: ownerId,
          }),
        (error: Error) => {
          // Terminal through this route: reopening would restore access to data whose retention
          // decision has already been made.
          assert.match(error.message, /terminal through this route/);
          return true;
        },
      );
    });

    it('closes a company without deleting anything', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(async () => ({
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
        roles: await ctx.prisma.client.roleAssignment.count({ where: { tenantId } }),
      }));

      await lifecycle().transition({
        tenantId,
        toState: 'Closed',
        reason: 'Contract ended and the customer did not renew.',
        actorUserId: ownerId,
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
        roles: await ctx.prisma.client.roleAssignment.count({ where: { tenantId } }),
      }));

      assert.equal(after.memberships, before.memberships);
      assert.equal(after.roles, before.roles);
      assert.ok(after.audit > before.audit);
    });

    it('records a scheduled transition without applying it', async () => {
      const view = await lifecycle().transition({
        tenantId,
        toState: 'ReadOnly',
        reason: 'End of term; read-only from the renewal date.',
        actorUserId: ownerId,
        effectiveAt: new Date(Date.now() + 30 * 86_400_000),
      });

      // Still Active: the company has not been restricted yet, and showing otherwise would be
      // wrong.
      assert.equal(view.state, 'Active');
      assert.ok(view.scheduled);
      assert.equal(view.scheduled?.toState, 'ReadOnly');
    });

    it('applies a scheduled transition when its date arrives', async () => {
      await lifecycle().transition({
        tenantId,
        toState: 'ReadOnly',
        reason: 'End of term; read-only from the renewal date.',
        actorUserId: ownerId,
        effectiveAt: new Date(Date.now() + 30 * 86_400_000),
      });

      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `UPDATE tenant_lifecycle_transitions SET effective_at = NOW() - INTERVAL '1 hour'
         WHERE tenant_id = $1 AND applied_at IS NULL`,
        tenantId,
      );

      const applied = await lifecycle().applyDueTransitions();
      assert.equal(applied, 1);

      const view = await lifecycle().viewFor(tenantId);
      assert.equal(view.state, 'ReadOnly');
      assert.equal(view.capability.canAccess, true);
      // The distinguishing property of ReadOnly.
      assert.equal(view.capability.canWrite, false);
      assert.equal(view.scheduled, null);
    });

    it('keeps a durable history so "what state, when" is a query', async () => {
      await lifecycle().transition({
        tenantId,
        toState: 'Suspended',
        reason: 'Payment overdue beyond the grace period.',
        actorUserId: ownerId,
      });
      await lifecycle().transition({
        tenantId,
        toState: 'Active',
        reason: 'Payment received.',
        actorUserId: ownerId,
      });

      const view = await lifecycle().viewFor(tenantId);
      // Two transitions plus the migration's reconstructed starting point.
      assert.ok(view.history.length >= 2);
      assert.equal(view.history[0]?.toState, 'Active');
      assert.equal(view.history[1]?.toState, 'Suspended');
    });

    it('is platform-only at the request layer', async () => {
      await as(
        agent().get(`/platform/commercial/companies/${tenantId}/lifecycle`),
        adminUboss,
      ).expect(403);
      await asPlatform(
        agent().get(`/platform/commercial/companies/${tenantId}/lifecycle`),
        ownerUboss,
      ).expect(200);
    });

    it('refuses lifecycle control to a Commercial platform role', async () => {
      // Platform Commercial defines plans; deciding a customer's operating state is not a
      // commercial act.
      await asPlatform(
        agent().post(`/platform/commercial/companies/${tenantId}/lifecycle`),
        commercialUboss,
      )
        .send({ toState: 'Suspended', reason: 'Trying to suspend from the wrong role.' })
        .expect(403);
    });
  });
});
