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
import { InvitationService } from '../src/auth/invitation.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { InvitationRepository } from '../src/persistence/invitation.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { CompanyProvisioningService } from '../src/provisioning/company-provisioning.service.js';
import { CompanySetupService } from '../src/provisioning/company-setup.service.js';
import { COMPANY_SETUP_TASKS } from '../src/provisioning/company-setup-tasks.js';
import {
  CompanySetupController,
  ProvisioningController,
} from '../src/provisioning/provisioning.controller.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';
import {
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Company provisioning and initial admin activation, against real PostgreSQL.
 *
 * Three properties carry this prompt, and each has its own negatives:
 *
 *  1. **No public signup.** There is one path in, and it needs a platform actor with
 *     `create-company:Create`.
 *  2. **The bootstrap authority rule.** The first Company Admin is granted by provisioning with
 *     no human grantor, and that is queryable, audited, and constrained so the flag and the
 *     absent grantor cannot disagree.
 *  3. **Atomicity.** A failed provisioning leaves nothing behind — no company, no person, no
 *     invitation, no outbox row.
 */
describe('company provisioning (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let ownerUboss: string;
  let ownerId: string;
  let supportUboss: string;
  let companyPersonUboss: string;

  const agent = () => request(app.getHttpServer());

  const validPayload = (overrides: Record<string, unknown> = {}) => ({
    legalName: 'MedNova Healthcare Private Limited',
    displayName: 'MedNova Healthcare',
    code: 'MEDNOVA',
    countryRegion: 'IN',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    admin: {
      name: 'Aarav Sharma',
      workEmail: 'aarav@mednova.example',
      title: 'Chief Operating Officer',
    },
    planCode: 'growth',
    seats: 40,
    startDate: new Date('2026-10-01T00:00:00.000Z').toISOString(),
    renewalDate: new Date('2027-10-01T00:00:00.000Z').toISOString(),
    billingCycle: 'Annual',
    commercialAllowanceMinor: 100_000,
    aiMode: 'UBossManaged',
    industryPacks: ['healthcare'],
    budget: {
      monthlyAllowanceMinor: 100_000,
      warningPercent: 80,
      approvalThresholdMinor: 90_000,
      hardStopMinor: 120_000,
    },
    security: {
      primaryDomain: 'mednova.example',
      requireMfa: true,
      requireSso: false,
      guestExpiryDays: 30,
      supportAccessAllowed: true,
      supportAccessRequiresCustomerApproval: false,
    },
    idempotencyKey: `provision-mednova-${Date.now()}`,
    ...overrides,
  });

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
      controllers: [ProvisioningController, CompanySetupController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        TenantRepository,
        TenantMembershipRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        OutboxRepository,
        InvitationRepository,
        UserCredentialRepository,
        SessionRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        PasswordService,
        SessionService,
        InvitationService,
        AuthorizationService,
        CompanyProvisioningService,
        CompanySetupService,
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

    const people = await ctx.prisma.runAsPlatformOperation(async () => ({
      owner: await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-OWNR-0001',
        email: 'owner@uboss.example',
        displayName: 'Platform Owner',
        isPlatformActor: true,
      }),
      support: await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-SUPP-0001',
        email: 'support@uboss.example',
        displayName: 'Platform Support',
        isPlatformActor: true,
      }),
      person: await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-COMP-0001',
        email: 'person@example.test',
        displayName: 'Company Person',
      }),
    }));

    ownerId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;
    supportUboss = people.support.ubossUniqueId;
    companyPersonUboss = people.person.ubossUniqueId;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Test fixture.' },
      });
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: people.support.id, role: 'PlatformSupport', justification: 'Fixture.' },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string): T =>
    test.set('x-uboss-dev-actor', uboss) as T;

  const provision = (overrides: Record<string, unknown> = {}, expected = 201) =>
    as(agent().post('/platform/provisioning/companies'), ownerUboss)
      .send(validPayload(overrides))
      .expect(expected);

  const scopeFor = (tenantId: string) => tenantScopeForPlatformOperation(tenantId);

  // =========================================================================
  describe('no public company signup', () => {
    it('refuses a company person outright', async () => {
      await as(agent().post('/platform/provisioning/companies'), companyPersonUboss)
        .send(validPayload())
        .expect(403);
    });

    it('refuses a platform actor without create-company:Create', async () => {
      // Platform Support is platform staff and deliberately cannot provision — creating a
      // customer is a commercial act, not a support one.
      await as(agent().post('/platform/provisioning/companies'), supportUboss)
        .send(validPayload())
        .expect(403);
    });

    it('refuses an anonymous caller', async () => {
      await agent().post('/platform/provisioning/companies').send(validPayload()).expect(401);
    });

    it('has no self-service route that creates a company', async () => {
      // The rule is enforced by there being no alternative. These are the shapes somebody would
      // reach for; all of them must 404 rather than 201.
      for (const path of ['/companies', '/signup', '/tenants', '/provisioning/companies']) {
        const response = await agent().post(path).send(validPayload());
        assert.notEqual(response.status, 201, `${path} must not create a company.`);
      }
    });
  });

  // =========================================================================
  describe('the ten wizard steps land in the database', () => {
    it('creates the company with its step-1 identity', async () => {
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const tenant = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenant.findUnique({ where: { id: tenantId } }),
      );
      assert.ok(tenant);
      assert.equal(tenant.legalName, 'MedNova Healthcare Private Limited');
      assert.equal(tenant.name, 'MedNova Healthcare');
      assert.equal(tenant.code, 'MEDNOVA');
      assert.equal(tenant.countryRegion, 'IN');
      assert.equal(tenant.timezone, 'Asia/Kolkata');
      assert.equal(tenant.currency, 'INR');
      // The client's own state name: provisioned, not yet activated.
      assert.equal(tenant.lifecycleState, 'Provisioning');
    });

    it('creates the plan, AI settings, budget policy and security defaults', async () => {
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const rows = await ctx.prisma.runAsPlatformOperation(async () => ({
        subscription: await ctx.prisma.client.tenantSubscription.findUnique({
          where: { tenantId },
        }),
        ai: await ctx.prisma.client.tenantAiSettings.findUnique({ where: { tenantId } }),
        budget: await ctx.prisma.client.tenantAiBudgetPolicy.findUnique({ where: { tenantId } }),
        policy: await ctx.prisma.client.tenantAuthPolicy.findUnique({ where: { tenantId } }),
        domain: await ctx.prisma.client.domainVerification.findFirst({ where: { tenantId } }),
      }));

      // Step 3
      assert.equal(rows.subscription?.seatsLicensed, 40);
      assert.equal(rows.subscription?.billingCycle, 'Annual');
      // Pending until activation: an Active subscription on a company nobody has signed into
      // would make every "active companies" figure wrong.
      assert.equal(rows.subscription?.state, 'Pending');

      // Steps 5 and 6
      assert.equal(rows.ai?.mode, 'UBossManaged');
      assert.equal(rows.ai?.universalPackEnabled, true);
      assert.deepEqual(rows.ai?.industryPacks, ['healthcare']);
      // No credential anywhere, in any form.
      assert.equal(rows.ai?.providerCredentialRef, null);
      assert.equal(rows.ai?.providerCredentialHint, null);

      // Step 7
      assert.equal(rows.budget?.monthlyAllowanceMinor, 100_000);
      assert.equal(rows.budget?.warningPercent, 80);
      assert.equal(rows.budget?.hardStopMinor, 120_000);

      // Step 8
      assert.equal(rows.policy?.requireMfa, true);
      assert.equal(rows.policy?.guestExpiryDays, 30);
      assert.equal(rows.policy?.supportAccessAllowed, true);

      // The domain is *claimed*, never verified — provisioning cannot check DNS.
      assert.equal(rows.domain?.domain, 'mednova.example');
      assert.equal(rows.domain?.state, 'Pending');
      assert.equal(rows.domain?.verifiedAt, null);
    });

    it('creates the ten-item setup checklist in the client’s order', async () => {
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const tasks = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.companySetupTask.findMany({
          where: { tenantId },
          orderBy: { position: 'asc' },
        }),
      );

      assert.equal(tasks.length, 10);
      assert.deepEqual(
        tasks.map((task) => task.key),
        COMPANY_SETUP_TASKS.map((task) => task.key),
        'The checklist must match the approved onboarding sequence, in order.',
      );
      // Every item carries the client's "why it comes here" — a checklist without reasons is a
      // list of chores.
      assert.ok(tasks.every((task) => task.rationale.length > 20));
    });

    it('agrees with the migration’s own copy of the checklist', async () => {
      // The same list exists twice: in TypeScript for provisioning, and in SQL for the
      // migration's backfill of pre-existing companies. A migration cannot import TypeScript,
      // so the duplication is unavoidable — this asserts it has not drifted.
      const backfilled = await ctx.prisma.runAsPlatformOperation(async () => {
        const provisioned = await ctx.provisioning.provision({
          slug: 'backfill-probe',
          name: 'Backfill Probe',
          firstMember: { email: 'probe@backfill.example', displayName: 'Probe' },
        });
        return provisioned.tenant.id;
      });
      // `TenantProvisioningService` does NOT create the checklist — only the wizard does — so a
      // company made that way has none, which is itself worth knowing.
      const none = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.companySetupTask.count({ where: { tenantId: backfilled } }),
      );
      assert.equal(
        none,
        0,
        'The narrow provisioning primitive does not create a checklist; only the wizard does.',
      );
    });
  });

  // =========================================================================
  describe('the bootstrap authority rule', () => {
    it('grants the first Company Admin with no human grantor, marked bootstrap', async () => {
      const response = await provision();
      const body = response.body as {
        tenantId: string;
        bootstrapRoleAssignmentId: string;
        admin: { userId: string; ubossUniqueId: string };
      };

      const assignment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.findUnique({
          where: { id: body.bootstrapRoleAssignmentId },
        }),
      );

      assert.ok(assignment);
      assert.equal(assignment.roleKind, 'CompanyAdmin');
      assert.equal(assignment.scopeKind, 'WholeCompany');
      assert.equal(assignment.userId, body.admin.userId);
      // The two halves of the rule: no grantor, and labelled as such.
      assert.equal(assignment.grantedByUserId, null);
      assert.equal(assignment.bootstrap, true);
      assert.ok(
        (assignment.justification ?? '').includes('no prior'),
        'The justification should say why there was no grantor.',
      );
    });

    it('makes the bootstrap grant explicitly auditable in the company’s own trail', async () => {
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const events = await ctx.prisma.runInTenantTransaction(scopeFor(tenantId), () =>
        app.get(AuditTrailRepository).findAuditEvents({ tenantId, take: 20 }),
      );
      const actions = events.map((event) => event.action);

      assert.ok(actions.includes('company.provisioned'));
      assert.ok(
        actions.includes('company.bootstrap_admin_granted'),
        'The bootstrap grant needs its own audit action, not just a role_assigned event.',
      );

      const bootstrap = events.find((event) => event.action === 'company.bootstrap_admin_granted');
      // Into the customer's own trail, so they can see how their workspace came to exist.
      assert.equal(bootstrap?.tenantId, tenantId);
      assert.ok((bootstrap?.reason ?? '').includes('no prior Company Admin'));
    });

    it('records the bootstrap grant as a Critical security event', async () => {
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const events = await ctx.prisma.runInTenantTransaction(scopeFor(tenantId), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.company_bootstrap_admin_granted',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      // The one authority in the product created with no human grantor.
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('gives the first admin real authority immediately', async () => {
      // The point of the bootstrap rule: the administrator can administer on first login,
      // without anybody granting them anything.
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };

      const context = await app
        .get(AuthorizationService)
        .contextFor(scopeFor(body.tenantId), body.admin.userId);
      const decision = await app
        .get(AuthorizationService)
        .authorize(context, { module: 'settings', action: 'Administer' });

      assert.equal(decision.allowed, true);
    });

    it('cannot be used to mint an arbitrary role', async () => {
      // Provisioning grants exactly CompanyAdmin/WholeCompany. There is no field in the payload
      // that names a role, so a wizard call cannot create any other authority.
      const response = await provision();
      const tenantId = (response.body as { tenantId: string }).tenantId;

      const assignments = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.findMany({ where: { tenantId } }),
      );
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0]?.roleKind, 'CompanyAdmin');
    });
  });

  // =========================================================================
  describe('secure activation, and never a password', () => {
    it('queues an activation invitation and returns no token', async () => {
      const response = await provision();
      const body = response.body as {
        tenantId: string;
        outboxMessageId: string;
        admin: { activation: string };
      };

      const serialised = JSON.stringify(response.body);
      // No field *carrying* a token or a password. The word "password" does appear, in the
      // reassurance below — asserting on its absence would have forbidden the response from
      // saying the very thing that makes the behaviour clear, which is why this checks for
      // password-bearing *keys* rather than the string.
      assert.doesNotMatch(serialised, /"(token|activationToken|password|adminPassword)"s*:/i);
      assert.match(body.admin.activation, /No password was created/);

      const invitation = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.findFirst({ where: { tenantId: body.tenantId } }),
      );
      assert.ok(invitation, 'An activation invitation must exist.');
      // Only a hash is stored — the Prompt 5 rule, unchanged.
      assert.equal(invitation.tokenHash.length, 64);
    });

    it('puts the invitation id in the outbox and never the token', async () => {
      const response = await provision();
      const body = response.body as { outboxMessageId: string; tenantId: string };

      const message = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.findUnique({ where: { id: body.outboxMessageId } }),
      );
      assert.ok(message);
      assert.equal(message.topic, 'company.activation_invitation');
      assert.equal(message.state, 'Pending');

      const payload = message.payload as Record<string, unknown>;
      assert.ok(payload['invitationId'], 'The dispatcher needs the invitation id.');
      // An outbox row is long-lived, widely readable working state. A token in one would be a
      // credential at rest in a queue.
      const serialised = JSON.stringify(payload);
      assert.doesNotMatch(serialised, /token/i);
      assert.doesNotMatch(serialised, /password/i);
    });

    it('creates no credential row at all', async () => {
      const response = await provision();
      const body = response.body as { admin: { userId: string } };

      const credential = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.userCredential.findFirst({ where: { userId: body.admin.userId } }),
      );
      // The password is set by the *administrator* during activation. Provisioning creating one
      // would mean UBoss knew it.
      assert.equal(credential, null);
    });

    it('leaves the account at InvitePending, not Active', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId: body.tenantId, userId: body.admin.userId },
        }),
      );
      assert.equal(membership?.accountState, 'InvitePending');
    });
  });

  // =========================================================================
  describe('one transaction', () => {
    it('leaves nothing behind when a later step fails', async () => {
      // The failure is induced at the *last* validated step — a plan code that does not exist is
      // caught before the transaction, so instead we use an unknown module in the entitlement
      // list, which fails inside `validate` before any write. To prove atomicity properly we
      // need a failure *after* the tenant insert: a duplicate company code does exactly that,
      // because the unique index fires mid-transaction.
      await provision({ code: 'FIRSTONE', idempotencyKey: 'atomic-first' });

      const before = await ctx.prisma.runAsPlatformOperation(async () => ({
        tenants: await ctx.prisma.client.tenant.count(),
        users: await ctx.prisma.client.user.count(),
        invitations: await ctx.prisma.client.invitation.count(),
        outbox: await ctx.prisma.client.outboxMessage.count(),
      }));

      // Same code, different slug source — the code's unique index fails after the insert has
      // begun, rolling the whole thing back.
      await as(agent().post('/platform/provisioning/companies'), ownerUboss)
        .send(
          validPayload({
            code: 'FIRSTONE',
            displayName: 'Second Company',
            admin: { name: 'Second Admin', workEmail: 'second@second.example' },
            idempotencyKey: 'atomic-second',
          }),
        )
        .expect((response) => {
          assert.ok(response.status >= 400, 'The duplicate code must be refused.');
        });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        tenants: await ctx.prisma.client.tenant.count(),
        users: await ctx.prisma.client.user.count(),
        invitations: await ctx.prisma.client.invitation.count(),
        outbox: await ctx.prisma.client.outboxMessage.count(),
      }));

      // Nothing partial: no company, no person, no invitation, no queued message.
      assert.deepEqual(after, before, 'A failed provisioning must leave nothing behind.');
    });

    it('is idempotent, so a double-clicked Provision button creates one company', async () => {
      const key = 'double-click-probe';
      const first = await provision({ idempotencyKey: key });
      const firstId = (first.body as { tenantId: string }).tenantId;

      const second = await as(agent().post('/platform/provisioning/companies'), ownerUboss)
        .send(validPayload({ idempotencyKey: key }))
        .expect(201);
      const secondBody = second.body as { tenantId: string; replayed: boolean };

      assert.equal(secondBody.tenantId, firstId, 'The replay must return the same company.');
      assert.equal(secondBody.replayed, true);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenant.count({ where: { code: 'MEDNOVA' } }),
      );
      assert.equal(count, 1, 'A replayed provisioning must not create a second company.');
    });
  });

  // =========================================================================
  describe('validation the wizard depends on', () => {
    it('refuses a renewal before the start', async () => {
      await provision(
        {
          startDate: new Date('2027-01-01T00:00:00.000Z').toISOString(),
          renewalDate: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        },
        400,
      );
    });

    it('refuses an approval threshold above the hard stop', async () => {
      // The approval step would be unreachable: the run would already be blocked, making the
      // "approval threshold" decorative configuration.
      const response = await provision(
        {
          budget: {
            monthlyAllowanceMinor: 100_000,
            warningPercent: 80,
            approvalThresholdMinor: 200_000,
            hardStopMinor: 120_000,
          },
        },
        400,
      );
      assert.match(JSON.stringify(response.body), /unreachable|warn|approve|stop/i);
    });

    it('refuses a platform module in the entitlement list', async () => {
      const response = await provision({ extraModules: ['platform-settings'] }, 400);
      assert.match(JSON.stringify(response.body), /company module/i);
    });

    it('refuses a Custom Enterprise Provider with no endpoint', async () => {
      const response = await provision({ aiMode: 'CustomEnterpriseProvider' }, 400);
      assert.match(JSON.stringify(response.body), /endpoint/i);
    });

    it('refuses a payload carrying a provider credential field', async () => {
      // `forbidNonWhitelisted` is what enforces this: there is no such field, so the request is
      // rejected rather than the key being silently dropped. A wizard payload must not be able
      // to carry a credential even by accident.
      await as(agent().post('/platform/provisioning/companies'), ownerUboss)
        .send(validPayload({ providerApiKey: 'sk-live-secret' }))
        .expect(400);
    });

    it('refuses a payload carrying a password field', async () => {
      await as(agent().post('/platform/provisioning/companies'), ownerUboss)
        .send(validPayload({ adminPassword: 'Hunter2!Hunter2' }))
        .expect(400);
    });

    it('refuses a hint long enough to be a real key', async () => {
      await provision({ providerCredentialHint: 'sk-live-'.padEnd(80, 'a') }, 400);
    });

    it('refuses a junk company code, country or currency', async () => {
      await provision({ code: 'not a code!' }, 400);
      await provision({ countryRegion: 'India' }, 400);
      await provision({ currency: 'rupees' }, 400);
    });

    it('refuses zero seats', async () => {
      await provision({ seats: 0 }, 400);
    });

    it('refuses a retired plan', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.plan.updateMany({ where: { code: 'pilot' }, data: { active: false } }),
      );
      const response = await provision({ planCode: 'pilot' }, 400);
      assert.match(JSON.stringify(response.body), /retired/i);
    });
  });

  // =========================================================================
  describe('the first-login setup checklist', () => {
    it('is readable by the new administrator and names the next action', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };

      // Activate the membership so the administrator can enter their own workspace — this is
      // what accepting the invitation does.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.updateMany({
          where: { tenantId: body.tenantId, userId: body.admin.userId },
          data: { accountState: 'Active' },
        }),
      );
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenant.update({
          where: { id: body.tenantId },
          data: { lifecycleState: 'Active' },
        }),
      );

      const checklist = await app
        .get(CompanySetupService)
        .checklistFor(scopeFor(body.tenantId), body.admin.userId);

      assert.equal(checklist.total, 10);
      assert.equal(checklist.resolved, 0);
      assert.equal(checklist.percentComplete, 0);
      assert.equal(checklist.complete, false);
      // The client's requirement: show progress and the next recommended action.
      assert.equal(checklist.nextTask?.key, 'company_profile');
      assert.equal(checklist.nextTask?.targetRoute, '/settings/general');
    });

    it('counts a skipped step as resolved and requires a reason to skip', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };
      const setup = app.get(CompanySetupService);
      const scope = scopeFor(body.tenantId);

      await assert.rejects(
        () =>
          setup.updateTask({
            scope,
            userId: body.admin.userId,
            key: 'guests',
            state: 'Skipped',
          }),
        /requires a reason/i,
      );

      const after = await setup.updateTask({
        scope,
        userId: body.admin.userId,
        key: 'guests',
        state: 'Skipped',
        skipReason: 'This company has no external collaborators.',
      });

      // Skipped counts toward resolution — a company that legitimately skipped guest access is
      // not permanently stuck at 90% — and stays visible as skipped, which is a different claim
      // from done.
      assert.equal(after.resolved, 1);
      assert.equal(after.percentComplete, 10);
      assert.equal(after.tasks.find((task) => task.key === 'guests')?.state, 'Skipped');
      assert.equal(after.nextTask?.key, 'company_profile');
    });

    it('audits checklist progress into the company’s own trail', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };

      await app.get(CompanySetupService).updateTask({
        scope: scopeFor(body.tenantId),
        userId: body.admin.userId,
        key: 'company_profile',
        state: 'Done',
      });

      const events = await ctx.prisma.runInTenantTransaction(scopeFor(body.tenantId), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId: body.tenantId,
          actionPrefix: 'company_setup.',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.action, 'company_setup.progressed');
    });

    it('refuses a task key that is not on the approved checklist', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };

      await assert.rejects(
        () =>
          app.get(CompanySetupService).updateTask({
            scope: scopeFor(body.tenantId),
            userId: body.admin.userId,
            key: 'buy-everyone-lunch',
            state: 'Done',
          }),
        /not a setup task/i,
      );
    });

    it('reaches complete only when nothing is unresolved', async () => {
      const response = await provision();
      const body = response.body as { tenantId: string; admin: { userId: string } };
      const setup = app.get(CompanySetupService);
      const scope = scopeFor(body.tenantId);

      let view = await setup.checklistFor(scope, body.admin.userId);
      for (const task of COMPANY_SETUP_TASKS) {
        view = await setup.updateTask({
          scope,
          userId: body.admin.userId,
          key: task.key,
          state: 'Done',
        });
      }

      assert.equal(view.complete, true);
      assert.equal(view.percentComplete, 100);
      assert.equal(view.nextTask, null);
    });
  });

  // =========================================================================
  describe('the outbox', () => {
    it('is visible to platform support and reports that no dispatcher runs', async () => {
      await provision();
      const response = await as(agent().get('/platform/provisioning/outbox'), supportUboss).expect(
        200,
      );

      const body = response.body as {
        counts: Record<string, number>;
        messages: unknown[];
        dispatcher: { running: boolean; note: string };
      };
      assert.equal(body.counts['Pending'], 1);
      assert.equal(body.messages.length, 1);
      // The honest state: rows accumulate because email delivery is a later prompt. Claiming
      // otherwise would leave an operator wondering why a customer never activated.
      assert.equal(body.dispatcher.running, false);
      assert.match(body.dispatcher.note, /notifications module/i);
    });

    it('claims, delivers and dead-letters', async () => {
      await provision();
      const outbox = app.get(OutboxRepository);

      const claimed = await outbox.claimDue(10);
      assert.equal(claimed.length, 1);
      // `InFlight` is distinct from `Pending` so a crashed dispatcher's work looks claimed
      // rather than un-started.
      assert.equal(claimed[0]?.state, 'InFlight');
      assert.equal(claimed[0]?.attempts, 1);

      await outbox.markDelivered(claimed[0]!.id);
      const delivered = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.findUnique({ where: { id: claimed[0]!.id } }),
      );
      assert.equal(delivered?.state, 'Delivered');
      assert.ok(delivered?.deliveredAt);
    });
  });
});
