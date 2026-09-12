import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { COMPANY_MODULES, PLATFORM_ROLE_TEMPLATES } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { BreakGlassService } from '../src/audit/break-glass.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { HealthService } from '../src/health/health.service.js';
import { ProviderAdapter, PROVIDER_ADAPTERS } from '../src/model-gateway/provider-adapter.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { PlatformAdministrationService } from '../src/platform/platform-administration.service.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { InlineRunQueue, RunQueue } from '../src/runs/run-queue.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import { SupportController, ServiceStatusController } from '../src/support/support.controller.js';
import { SupportTicketService } from '../src/support/support-ticket.service.js';
import { SystemHealthService } from '../src/support/system-health.service.js';
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
 * Support, authorized support sessions and system health — Prompt 36, against real PostgreSQL.
 *
 * The rules are proved without a database in `packages/types/src/support.test.ts`. What can only be
 * proved here is what the prompt makes the whole point of the module:
 *
 *  * **A support session the company declined cannot be activated**, and there is no bypass.
 *  * **Platform support holds nothing on a company** — asserted against the real role template.
 *  * **An operator's internal note never reaches the company**, through the API.
 *  * **The customer-visible status carries no internal detail**, whatever is failing inside.
 */
describe('support, support sessions and system health (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let otherAdminId: string;
  let otherAdminUboss: string;
  let platformId: string;
  let operatorId: string;

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
      controllers: [SupportController, ServiceStatusController],
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
        BreakGlassService,
        SupportTicketService,
        SystemHealthService,
        PlatformAdministrationService,
        HealthService,
        // The inline queue, which reports its depths as *unmeasured* rather than as zero.
        { provide: RunQueue, useClass: InlineRunQueue },
        // No provider adapter is configured to reach a real provider, which is the honest state
        // and what the health view must say.
        { provide: PROVIDER_ADAPTERS, useValue: [] as readonly ProviderAdapter[] },
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
      slug: 'support-co',
      name: 'Support Co',
      firstMember: { email: 'first@support.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-support-co',
      name: 'Other Support Co',
      firstMember: { email: 'first@other-support.example', displayName: 'Other First' },
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
        admin: await make('UB-SPAD-0001', 'admin@support.example', 'Admin', provisioned.tenant.id),
        employee: await make(
          'UB-SPEM-0001',
          'employee@support.example',
          'Employee',
          provisioned.tenant.id,
        ),
        otherAdmin: await make(
          'UB-SPOA-0001',
          'admin@other-support.example',
          'Other Admin',
          other.tenant.id,
        ),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    otherAdminId = people.otherAdmin.id;
    otherAdminUboss = people.otherAdmin.ubossUniqueId;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-SPPL-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;

    const operator = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-SPOP-0001',
        email: 'operator@uboss.example',
        displayName: 'Support Operator',
        isPlatformActor: true,
      }),
    );
    operatorId = operator.id;

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
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

  const tickets = () => app.get(SupportTicketService);
  const breakGlass = () => app.get(BreakGlassService);
  const health = () => app.get(SystemHealthService);
  const administration = () => app.get(PlatformAdministrationService);
  const settings = () => app.get(CompanySettingsService);

  const raise = async (overrides: { subject?: string; actor?: string } = {}) =>
    tickets().raise({
      scope: scope(),
      actorUserId: overrides.actor ?? employeeId,
      subject: overrides.subject ?? 'Runs are slow',
      body: 'Every run takes several minutes to start.',
      kind: 'Problem',
    });

  /** An alert an operator can declare an incident on. */
  const seedAlert = async (summary = 'Model gateway latency above target') =>
    ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.serviceAlert.create({
        data: { service: 'model-gateway', severity: 'Warning', state: 'Open', summary },
      }),
    );

  const requireAuthorization = async () =>
    settings().update({
      scope: scope(),
      actorUserId: adminId,
      values: { 'security.support_session_authorization': 'Required' },
      reason: 'We want to approve each support session ourselves.',
    });

  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  it('lets an Employee raise a ticket — reporting a problem is not an administrative act', async () => {
    const ticket = await raise();

    assert.equal(ticket.reference, 1);
    assert.equal(ticket.state, 'New');
    assert.equal(ticket.isOpen, true);

    await asPerson(agent().post(`/tenants/${tenantId}/support/tickets`), employeeUboss)
      .send({
        subject: 'Another problem',
        body: 'The dashboard will not load for anybody in our team.',
        kind: 'Problem',
      })
      .expect(201);
  });

  it('numbers tickets per company, so two companies both start at 1', async () => {
    const mine = await raise();
    const theirs = await tickets().raise({
      scope: scope(otherTenantId),
      actorUserId: otherAdminId,
      subject: 'A different company',
      body: 'Something else entirely, in another tenancy.',
      kind: 'Question',
    });

    assert.equal(mine.reference, 1);
    assert.equal(theirs.reference, 1, 'references are per company, not global');
  });

  it('never shows an operator’s internal note to the company', async () => {
    const ticket = await raise();

    await tickets().addOperatorNote({
      ticketId: ticket.id,
      actorUserId: operatorId,
      body: 'Their connection pool is misconfigured — do not say that yet.',
    });
    await tickets().addOperatorNote({
      ticketId: ticket.id,
      actorUserId: operatorId,
      body: 'We are looking into this and will update you shortly.',
      isInternal: false,
    });

    const asCompany = await tickets().companyDetail({
      scope: scope(),
      actorUserId: employeeId,
      ticketId: ticket.id,
    });

    assert.equal(asCompany.notes.length, 1);
    assert.equal(asCompany.notes[0]?.isInternal, false);
    assert.equal(
      asCompany.notes.some((note) => note.body.includes('do not say that yet')),
      false,
      'an internal note must never reach the company',
    );

    // And through the API, which is the path that actually matters.
    const response = await asPerson(
      agent().get(`/tenants/${tenantId}/support/tickets/${ticket.id}`),
      employeeUboss,
    ).expect(200);

    const body = response.body as { notes: { body: string }[] };
    assert.equal(body.notes.length, 1);
    assert.equal(JSON.stringify(body).includes('do not say that yet'), false);

    // The operator sees both.
    const asOperator = await tickets().operatorDetail(ticket.id);
    assert.equal(asOperator.notes.length, 2);
  });

  it('defaults an operator note to internal', async () => {
    const ticket = await raise();
    const note = await tickets().addOperatorNote({
      ticketId: ticket.id,
      actorUserId: operatorId,
      body: 'Checking their logs.',
    });
    assert.equal(note.isInternal, true, 'the safe default, because the two mistakes differ in cost');
  });

  it('refuses to resolve a ticket with no explanation', async () => {
    const ticket = await raise();

    await assert.rejects(
      () => tickets().transition({ ticketId: ticket.id, actorUserId: operatorId, to: 'Resolved' }),
      (error: Error) => error.message.includes('Say what the answer was'),
    );

    const resolved = await tickets().transition({
      ticketId: ticket.id,
      actorUserId: operatorId,
      to: 'Resolved',
      resolutionNote: 'We raised the pool size; runs start immediately now.',
    });
    assert.equal(resolved.state, 'Resolved');
    assert.equal(resolved.isOpen, false);
  });

  it('never reopens a closed ticket', async () => {
    const ticket = await raise();
    await tickets().transition({
      ticketId: ticket.id,
      actorUserId: operatorId,
      to: 'Closed',
      resolutionNote: 'Duplicate of an earlier ticket.',
    });

    await assert.rejects(
      () =>
        tickets().transition({ ticketId: ticket.id, actorUserId: operatorId, to: 'InProgress' }),
      (error: Error) => error.message.includes('stays closed'),
    );
  });

  it('puts a ticket back in UBoss’s queue when the company replies', async () => {
    const ticket = await raise();
    // Acknowledged first, deliberately: `New -> WaitingOnCustomer` is not a transition, because
    // parking a ticket on the customer before anybody has read it is how a queue lies about its
    // own backlog.
    await tickets().transition({
      ticketId: ticket.id,
      actorUserId: operatorId,
      to: 'Acknowledged',
    });
    await tickets().transition({
      ticketId: ticket.id,
      actorUserId: operatorId,
      to: 'WaitingOnCustomer',
    });

    await tickets().replyAsCompany({
      scope: scope(),
      actorUserId: employeeId,
      ticketId: ticket.id,
      body: 'Here are the run ids you asked for.',
    });

    const after_ = await tickets().companyDetail({
      scope: scope(),
      actorUserId: employeeId,
      ticketId: ticket.id,
    });
    assert.equal(
      after_.ticket.state,
      'InProgress',
      'a company reply must not leave the ticket parked where nobody looks',
    );
  });

  it('keeps one company’s tickets invisible to another', async () => {
    const mine = await raise();

    const theirs = await asPerson(
      agent().get(`/tenants/${otherTenantId}/support/tickets`),
      otherAdminUboss,
      otherTenantId,
    ).expect(200);
    assert.deepEqual((theirs.body as { tickets: unknown[] }).tickets, []);

    await asPerson(
      agent().get(`/tenants/${otherTenantId}/support/tickets/${mine.id}`),
      otherAdminUboss,
      otherTenantId,
    ).expect(404);

    const visible = await ctx.prisma.runInTenantTransaction(scope(otherTenantId), () =>
      ctx.prisma.client.supportTicket.findMany({ where: { id: mine.id } }),
    );
    assert.deepEqual(visible, [], 'RLS makes the row invisible, not merely filtered');
  });

  // -------------------------------------------------------------------------
  // Customer authorization of a support session
  // -------------------------------------------------------------------------

  it('activates a session without asking, when the company’s policy does not require it', async () => {
    const requested = await breakGlass().request({
      tenantId,
      requesterUserId: operatorId,
      reason: 'The customer reported that no runs start, and we need to read their run rows.',
      allowedModules: ['reports'],
      allowedActions: ['View'],
    });
    assert.equal(requested.customerAuthorizationState, 'NotRequired');

    await breakGlass().verifyIdentity({
      requestId: requested.id,
      verifierUserId: platformId,
      result: 'VerifiedByHuman',
      note: 'Called the number on file.',
    });
    await breakGlass().approve({
      requestId: requested.id,
      approverUserId: platformId,
      minutes: 60,
      note: 'Approved for one hour, read-only.',
    });

    const active = await breakGlass().activate({
      requestId: requested.id,
      actorUserId: operatorId,
    });
    assert.equal(active.state, 'Active');
  });

  it('refuses to activate a session the company has not authorized, with no bypass', async () => {
    await requireAuthorization();

    const requested = await breakGlass().request({
      tenantId,
      requesterUserId: operatorId,
      reason: 'The customer reported that no runs start, and we need to read their run rows.',
      allowedModules: ['reports'],
      allowedActions: ['View'],
    });
    assert.equal(requested.customerAuthorizationState, 'Pending');

    await breakGlass().verifyIdentity({
      requestId: requested.id,
      verifierUserId: platformId,
      result: 'VerifiedByHuman',
      note: 'Called the number on file.',
    });
    await breakGlass().approve({
      requestId: requested.id,
      approverUserId: platformId,
      minutes: 60,
      note: 'Approved, pending the customer.',
    });

    await assert.rejects(
      () => breakGlass().activate({ requestId: requested.id, actorUserId: operatorId }),
      (error: Error) => error.message.includes('no emergency bypass'),
    );

    // The refusal is recorded — a control that works invisibly is one nobody can show a regulator.
    const blocked = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { action: 'security.break_glass_customer_authorization_blocked' },
      }),
    );
    assert.equal(blocked.length, 1);
  });

  it('activates once the company authorizes, and refuses for good once they decline', async () => {
    await requireAuthorization();

    const authorizeFlow = async () => {
      const requested = await breakGlass().request({
        tenantId,
        requesterUserId: operatorId,
        reason: 'The customer reported that no runs start, and we need to read their run rows.',
        allowedModules: ['reports'],
        allowedActions: ['View'],
      });
      await breakGlass().verifyIdentity({
        requestId: requested.id,
        verifierUserId: platformId,
        result: 'VerifiedByHuman',
        note: 'Called the number on file.',
      });
      await breakGlass().approve({
        requestId: requested.id,
        approverUserId: platformId,
        minutes: 60,
        note: 'Approved, pending the customer.',
      });
      return requested;
    };

    const yes = await authorizeFlow();
    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${yes.id}`),
      adminUboss,
    )
      .send({ authorized: true })
      .expect(201);

    const active = await breakGlass().activate({ requestId: yes.id, actorUserId: operatorId });
    assert.equal(active.state, 'Active');

    const no = await authorizeFlow();
    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${no.id}`),
      adminUboss,
    )
      .send({ authorized: false, note: 'We are handling this ourselves.' })
      .expect(201);

    await assert.rejects(
      () => breakGlass().activate({ requestId: no.id, actorUserId: operatorId }),
      (error: Error) => error.message.includes('not retried'),
    );
  });

  it('refuses a decline with no reason, and a second decision on the same session', async () => {
    await requireAuthorization();

    const requested = await breakGlass().request({
      tenantId,
      requesterUserId: operatorId,
      reason: 'The customer reported that no runs start, and we need to read their run rows.',
      allowedModules: ['reports'],
      allowedActions: ['View'],
    });

    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${requested.id}`),
      adminUboss,
    )
      .send({ authorized: false })
      .expect(400);

    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${requested.id}`),
      adminUboss,
    )
      .send({ authorized: true })
      .expect(201);

    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${requested.id}`),
      adminUboss,
    )
      .send({ authorized: false, note: 'Changed our mind.' })
      .expect(409);
  });

  it('refuses an Employee the authorization decision', async () => {
    await requireAuthorization();
    const requested = await breakGlass().request({
      tenantId,
      requesterUserId: operatorId,
      reason: 'The customer reported that no runs start, and we need to read their run rows.',
      allowedModules: ['reports'],
      allowedActions: ['View'],
    });

    await asPerson(
      agent().post(`/tenants/${tenantId}/support/access-requests/${requested.id}`),
      employeeUboss,
    )
      .send({ authorized: true })
      .expect(403);

    await asPerson(
      agent().get(`/tenants/${tenantId}/support/access-requests`),
      employeeUboss,
    ).expect(403);
  });

  it('will not let one company decide about another company’s session', async () => {
    await requireAuthorization();
    const mine = await breakGlass().request({
      tenantId,
      requesterUserId: operatorId,
      reason: 'The customer reported that no runs start, and we need to read their run rows.',
      allowedModules: ['reports'],
      allowedActions: ['View'],
    });

    await assert.rejects(
      () =>
        breakGlass().recordCustomerAuthorization({
          requestId: mine.id,
          tenantId: otherTenantId,
          decidedByUserId: adminId,
          authorized: true,
        }),
      (error: Error) => error.message.includes('No such support session'),
    );
  });

  // -------------------------------------------------------------------------
  // Platform support holds nothing on a company
  // -------------------------------------------------------------------------

  it('grants PlatformSupport no action on any company module', () => {
    const support = PLATFORM_ROLE_TEMPLATES.PlatformSupport;
    for (const module of COMPANY_MODULES) {
      assert.deepEqual(
        [...(support.permissions[module] ?? [])],
        [],
        `PlatformSupport was granted something on the company module "${module}"`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Incidents and system health
  // -------------------------------------------------------------------------

  it('declares an alert an incident, and refuses to publish without customer wording', async () => {
    const alert = await seedAlert();

    const declared = await administration().declareIncident({
      actorUserId: platformId,
      alertId: alert.id,
      severity: 'P1',
      ownerUserId: operatorId,
    });
    assert.equal(declared.incidentSeverity, 'P1');
    assert.equal(declared.state, 'Acknowledged', 'declaring is acknowledging');

    await assert.rejects(
      () =>
        administration().publishIncident({
          actorUserId: platformId,
          alertId: alert.id,
          customerVisible: true,
        }),
      (error: Error) => error.message.includes('Write what customers should be told'),
    );
  });

  it('refuses to declare an alert twice or to publish an undeclared one', async () => {
    const alert = await seedAlert();

    await assert.rejects(
      () =>
        administration().publishIncident({
          actorUserId: platformId,
          alertId: alert.id,
          customerVisible: true,
          customerImpact: 'Something is wrong.',
        }),
      (error: Error) => error.message.includes('has not been declared an incident'),
    );

    await administration().declareIncident({
      actorUserId: platformId,
      alertId: alert.id,
      severity: 'P2',
      ownerUserId: operatorId,
    });

    await assert.rejects(
      () =>
        administration().declareIncident({
          actorUserId: platformId,
          alertId: alert.id,
          severity: 'P0',
          ownerUserId: operatorId,
        }),
      (error: Error) => error.message.includes('already a declared'),
    );
  });

  it('gives a company the published wording and nothing internal', async () => {
    const alert = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.serviceAlert.create({
        data: {
          service: 'db-primary-2',
          severity: 'Critical',
          state: 'Open',
          summary: 'db-primary-2 exhausted its connection pool',
          detail: 'host db-primary-2.internal, pool max 200, query 40s',
        },
      }),
    );

    await administration().declareIncident({
      actorUserId: platformId,
      alertId: alert.id,
      severity: 'P0',
      ownerUserId: operatorId,
    });
    await administration().publishIncident({
      actorUserId: platformId,
      alertId: alert.id,
      customerVisible: true,
      customerImpact: 'Runs are not starting. We are working on it.',
    });

    const response = await asPerson(
      agent().get(`/tenants/${tenantId}/service-status`),
      employeeUboss,
    ).expect(200);

    const serialized = JSON.stringify(response.body);
    const body = response.body as { status: string; incidents: { customerImpact: string }[] };

    // The shape itself is the control: there is no title or summary field for an internal string
    // to travel in, which is the fix for the leak this test originally caught.
    assert.equal(
      Object.keys((body.incidents[0] ?? {}) as Record<string, unknown>).includes('title'),
      false,
      'a customer-facing incident must carry no headline written for operators',
    );

    assert.equal(body.status, 'down', 'an active P0 is down by its own definition');
    assert.equal(body.incidents.length, 1);
    assert.equal(body.incidents[0]?.customerImpact, 'Runs are not starting. We are working on it.');

    // The whole point: none of the internal detail travels.
    for (const secret of ['db-primary-2.internal', 'pool max 200', 'query 40s', 'exhausted']) {
      assert.equal(
        serialized.includes(secret),
        false,
        `the customer status leaked internal detail: ${secret}`,
      );
    }
  });

  it('reads ok to a company when nothing has been published, even with an active incident', async () => {
    const alert = await seedAlert('Everything is on fire internally');
    await administration().declareIncident({
      actorUserId: platformId,
      alertId: alert.id,
      severity: 'P0',
      ownerUserId: operatorId,
    });

    const status = await health().customerVisibleStatus();
    assert.equal(
      status.status,
      'ok',
      'an unpublished incident is not disclosed — UBoss says nothing rather than leaking a reading',
    );
    assert.deepEqual(status.incidents, []);

    // And the operator sees it, which is the other half of the same decision.
    const operatorView = await health().operatorView();
    assert.equal(operatorView.summary.activeIncidents, 1);
    assert.equal(operatorView.summary.p0Incidents, 1);
    assert.equal(operatorView.summary.publishedIncidents, 0);
  });

  it('reports the inline queue and the absent providers as unmeasured rather than green', async () => {
    const view = await health().operatorView();

    const queue = view.components.find((component) => component.component === 'Queue');
    assert.equal(queue?.measured, false, 'the inline queue has no backlog to measure');

    const providers = view.components.find((component) => component.component === 'Providers');
    assert.equal(providers?.measured, false);
    assert.equal(
      providers?.detail.includes('mock adapter'),
      true,
      'the health page must say no real provider is configured',
    );

    const database = view.components.find((component) => component.component === 'Database');
    assert.equal(database?.measured, true);
    assert.equal(database?.status, 'ok');
  });

  it('ties tickets to an incident so "how many companies" is answerable', async () => {
    const alert = await seedAlert();
    await administration().declareIncident({
      actorUserId: platformId,
      alertId: alert.id,
      severity: 'P1',
      ownerUserId: operatorId,
    });

    const mine = await raise();
    const theirs = await tickets().raise({
      scope: scope(otherTenantId),
      actorUserId: otherAdminId,
      subject: 'Same problem',
      body: 'Our runs are not starting either, since this morning.',
      kind: 'Problem',
    });

    for (const ticket of [mine, theirs]) {
      await tickets().linkToIncident({
        ticketId: ticket.id,
        serviceAlertId: alert.id,
        actorUserId: operatorId,
      });
    }

    const impact = await tickets().ticketsForIncident(alert.id);
    assert.equal(impact.ticketCount, 2);
    assert.equal(impact.affectedTenantIds.length, 2);
  });

  it('refuses to link a ticket to an alert nobody declared an incident', async () => {
    const alert = await seedAlert();
    const ticket = await raise();

    await assert.rejects(
      () =>
        tickets().linkToIncident({
          ticketId: ticket.id,
          serviceAlertId: alert.id,
          actorUserId: operatorId,
        }),
      (error: Error) => error.message.includes('has not been declared an incident'),
    );
  });
});
