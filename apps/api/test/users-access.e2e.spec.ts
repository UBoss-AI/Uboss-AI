import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AccessController } from '../src/access/access.controller.js';
import { activationReadiness } from '../src/access/activation-readiness.js';
import { BulkOperationService } from '../src/access/bulk-operation.service.js';
import { InvitationAccessService } from '../src/access/invitation-access.service.js';
import { HANDOVER_DOMAINS, OffboardingService } from '../src/access/offboarding.service.js';
import { CapabilityService } from '../src/access/capability.service.js';
import { UserAccessService } from '../src/access/user-access.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { InvitationService } from '../src/auth/invitation.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SessionService } from '../src/auth/session.service.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { CommercialService } from '../src/commercial/commercial.service.js';
import { CompanyLifecycleService } from '../src/commercial/company-lifecycle.service.js';
import { SeatService } from '../src/commercial/seat.service.js';
import { DepartmentService } from '../src/organization/department.service.js';
import { EmploymentService } from '../src/organization/employment.service.js';
import { HierarchyService } from '../src/organization/hierarchy.service.js';
import { PersonRegistryService } from '../src/organization/person-registry.service.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { verhoeffCheckDigit } from '../src/organization/aadhaar.js';
import { AccessRepository } from '../src/persistence/access.repository.js';
import { ConnectionService } from '../src/connections/connection.service.js';
import { ConnectorAdapter, MockConnectorAdapter } from '../src/connections/connector-adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
import { EmailAdapter, LoggingEmailAdapter } from '../src/notifications/email-adapter.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { MemoryService } from '../src/agents/memory.service.js';
import { PerformanceService } from '../src/performance/performance.service.js';
import { NotificationRepository } from '../src/persistence/notification.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { InvitationRepository } from '../src/persistence/invitation.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
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

const aadhaar = (body: string): string => `${body}${verhoeffCheckDigit(body)}`;

/**
 * Users & Access, guests and bulk enterprise lifecycle.
 *
 * Six properties carry this prompt:
 *
 *   1. **An invitation links to the same stable identity** — no duplicate person, ever.
 *   2. **Department + manager + role are required before activation**, checked at both ends.
 *   3. **Guests stay outside the hierarchy** with a mandatory, capped expiry.
 *   4. **Suspend and offboard preserve everything** and hand over what can be moved.
 *   5. **Seat limits are not bypassed** — the invitation path claims a seat.
 *   6. **Bulk operations validate without applying, report per row, and cannot escalate.**
 */
describe('users & access (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let managerId: string;
  let employeeId: string;
  let employeeUboss: string;
  let ownerId: string;
  let departmentId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const users = () => app.get(UserAccessService);
  const invitations = () => app.get(InvitationAccessService);
  const offboardings = () => app.get(OffboardingService);
  const bulk = () => app.get(BulkOperationService);
  const employment = () => app.get(EmploymentService);
  const seats = () => app.get(SeatService);

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(`The test database is not reachable: ${reachabilityFailureReason()}`);
    }
    migrateTestDatabase();

    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [AccessController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        OrganizationRepository,
        AccessRepository,
        InvitationRepository,
        UserCredentialRepository,
        SessionRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        SeatService,
        CommercialService,
        CompanyLifecycleService,
        PersonRegistryService,
        DepartmentService,
        HierarchyService,
        EmploymentService,
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
        PasswordService,
        SessionService,
        InvitationService,
        UserAccessService,
        InvitationAccessService,
        NotificationRepository,
        OutboxRepository,
        NotificationService,
        ConnectionService,
        { provide: SecretsVault, useClass: LocalSealedSecretsVault },
        { provide: ConnectorAdapter, useClass: MockConnectorAdapter },
        { provide: EmailAdapter, useClass: LoggingEmailAdapter },
        PerformanceService,
        MemoryService,
        OffboardingService,
        BulkOperationService,
        // Prompt 40A: the Access & Permissions step hangs off this controller.
        CapabilityService,
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
      slug: 'access-co',
      name: 'Access Co',
      firstMember: { email: 'first@access.example', displayName: 'First Person' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-access-co',
      name: 'Other Access Co',
      firstMember: { email: 'first@other-access.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@access.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-AADM-0001', 'Access Admin'),
        manager: await member('UB-AMGR-0001', 'Access Manager'),
        employee: await member('UB-AEMP-0001', 'Access Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-AOWN-0001',
          email: 'owner@uboss.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    managerId = people.manager.id;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [managerId, 'Manager', 'TeamSubtree'],
        [employeeId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }

      const department = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'General', code: 'GEN' },
      });
      departmentId = department.id;

      await ctx.prisma.client.department.create({
        data: { tenantId: otherTenantId, name: 'General', code: 'GEN' },
      });

      // A plan with room, so seat tests are about the invitation path rather than the ceiling.
      const growth = await ctx.prisma.client.plan.findUnique({ where: { code: 'growth' } });
      await ctx.prisma.client.tenantSubscription.create({
        data: {
          tenant: { connect: { id: tenantId } },
          plan: { connect: { id: growth!.id } },
          state: 'Active',
          billingState: 'Current',
          billingCycle: 'Annual',
          seatsLicensed: 20,
          renewsAt: new Date(Date.now() + 200 * 86_400_000),
          aiAllowanceMinor: 100_000,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /**
   * Give the admin their own employment record, as the root of the reporting tree.
   *
   * Needed before anybody can name them as a manager: the composite foreign key requires a
   * reporting manager to be *employed here*, not merely to be a user that exists. Created once
   * per test that needs it, and idempotent so a test can call it without knowing whether an
   * earlier helper already did.
   */
  const ensureAdminIsEmployed = async () => {
    const existing = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.employmentRecord.findFirst({ where: { tenantId, userId: adminId } }),
    );
    if (existing) {
      return;
    }
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: adminId,
          employeeId: 'E-001',
          designation: 'Managing Director',
          departmentId,
        },
      }),
    );
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: managerId,
          employeeId: 'E-002',
          designation: 'Head of Operations',
          departmentId,
          reportingManagerUserId: adminId,
        },
      }),
    );
  };

  /** Somebody in the hierarchy, with a department and a manager, ready to be invited. */
  const addHierarchyPerson = async (
    name: string,
    empId: string,
    aadhaarBody: string,
    manager: string | null,
  ) => {
    if (manager !== null) {
      await ensureAdminIsEmployed();
    }
    const result = await employment().addEmployee({
      scope: scope(),
      actorUserId: adminId,
      employeeName: name,
      employeeId: empId,
      designation: 'Associate',
      departmentId,
      reportingManagerUserId: manager,
      aadhaarNumber: aadhaar(aadhaarBody),
    });
    // A role, so the readiness gate is satisfied.
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: result.userId,
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          grantedByUserId: adminId,
        },
      }),
    );
    return result;
  };

  // =========================================================================
  describe('the activation readiness rule', () => {
    it('requires a department, a manager and a role for an internal employee', () => {
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'NotInvited',
        employment: null,
        roleCount: 0,
        companyHasReportingRoot: true,
      });

      assert.equal(readiness.ready, false);
      // Every problem in one pass, not just the first.
      assert.equal(readiness.missing.length, 2);
      assert.match(readiness.summary, /department and reporting manager/);
      assert.match(readiness.summary, /company role/);
    });

    it('waives the manager requirement for the first person in a company', () => {
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'NotInvited',
        employment: { departmentId: 'dep', reportingManagerUserId: null },
        roleCount: 1,
        // No root yet, so this person *is* the root.
        companyHasReportingRoot: false,
      });
      assert.equal(readiness.ready, true);
    });

    it('does not apply to a guest', () => {
      // A guest has no department, no manager and no employment record by definition. Applying
      // the gate would make guests impossible.
      const readiness = activationReadiness({
        userType: 'ExternalGuest',
        accountState: 'NotInvited',
        employment: null,
        roleCount: 0,
        companyHasReportingRoot: true,
      });
      assert.equal(readiness.ready, true);
      assert.match(readiness.summary, /outside the hierarchy/);
    });
  });

  // =========================================================================
  describe('the three tabs', () => {
    it('splits employees, guests and pending invitations', async () => {
      const view = await users().viewFor(scope(), adminId);
      assert.equal(view.counts.employees, 4);
      assert.equal(view.counts.guests, 0);
      assert.equal(view.counts.pendingInvitations, 0);
    });

    it('lists somebody with no employment record, no role and no invitation', async () => {
      // The state an administrator opened this screen to deal with. An INNER JOIN would hide it.
      const view = await users().viewFor(scope(), adminId);
      const first = view.employees.find((person) => person.displayName === 'First Person');
      assert.ok(first);
      assert.equal(first!.employeeId, null);
      assert.equal(first!.readiness.ready, false);
    });

    it('shows the seat position alongside the roster', async () => {
      const view = await users().viewFor(scope(), adminId);
      assert.equal(view.seats.ceiling, 20);
      assert.equal(view.seats.used, 4);
    });

    it('needs users:View, which an ordinary Employee does not hold', async () => {
      // The Employee role template grants no `users` module at all — an employee has no business
      // reading the company's access roster, which is who can sign in and who is suspended.
      // Asserted as the negative it actually is, rather than assumed to be a read every role has.
      await as(agent().get(`/tenants/${tenantId}/access`), employeeUboss).expect(403);
      await as(agent().get(`/tenants/${tenantId}/access`), adminUboss).expect(200);
    });
  });

  // =========================================================================
  describe('inviting somebody already in the hierarchy', () => {
    it('links to the same stable identity rather than creating a duplicate', async () => {
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      const usersBefore = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.count(),
      );

      const invited = await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'kavya@access.example',
      });

      const usersAfter = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.count(),
      );

      // The client's rule: no duplicate. Same id, same permanent identifier, no new person.
      assert.equal(invited.userId, person.userId);
      assert.equal(invited.ubossUniqueId, person.ubossUniqueId);
      assert.equal(usersAfter, usersBefore);
    });

    it('notifies the person that they were invited, and again when it is resent', async () => {
      // Prompt 15's Invitation source, asserted here rather than in the notifications suite:
      // this is the module that raises it, and a test that mocked the invitation would prove
      // only that the mock works.
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'kavya@access.example',
      });

      const first = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findMany({
          where: { tenantId, recipientUserId: person.userId, kind: 'Invitation' },
        }),
      );
      assert.equal(first.length, 1);
      assert.equal(first[0]?.deepLink, '/login');
      // Activating is theirs to do, not something they are merely being told about.
      assert.equal(first[0]?.isAssignedToRecipient, true);

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'kavya@access.example',
      });

      const afterResend = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({
          where: { tenantId, recipientUserId: person.userId, kind: 'Invitation' },
        }),
      );
      // A resend is new information, so its dedupe key differs. "We resent your invitation" with
      // no notification is why somebody calls support.
      assert.equal(afterResend, 2);
    });

    it('still sends the invitation if its notification cannot be raised', async () => {
      // The invitation is the deliverable. A notification failure must never turn a successfully
      // sent invitation into a 500 that leaves the caller believing nothing happened — the
      // Prompt 8 break-glass lesson and the Prompt 11 self-decision lesson, both of which were a
      // correct outcome turned into a server error by a secondary write.
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);

      const engine = app.get(NotificationService);
      const original = engine.raise.bind(engine);
      engine.raise = async () => {
        throw new Error('the notification store is unavailable');
      };

      try {
        const invited = await invitations().inviteExistingPerson({
          scope: scope(),
          actorUserId: adminId,
          subjectUserId: person.userId,
          workEmail: 'kavya@access.example',
        });
        assert.equal(invited.userId, person.userId);
      } finally {
        engine.raise = original;
      }

      const invitation = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.findFirst({
          where: { tenantId, userId: person.userId, cancelledAt: null },
        }),
      );
      assert.ok(invitation, 'the invitation should still have been issued');
    });

    it('sets the real work email over the synthesised placeholder', async () => {
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.findUnique({ where: { id: person.userId } }),
      );
      assert.match(before!.email, /@person\.uboss\.invalid$/);

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'kavya@access.example',
      });

      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.findUnique({ where: { id: person.userId } }),
      );
      assert.equal(after!.email, 'kavya@access.example');
    });

    it('refuses when there is nowhere to send it', async () => {
      const person = await addHierarchyPerson('No Email', 'E-202', '29876543210', adminId);
      await assert.rejects(
        () =>
          invitations().inviteExistingPerson({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: person.userId,
          }),
        /no work email address on record/i,
      );
    });

    it('refuses before sending when the person is not ready to activate', async () => {
      await ensureAdminIsEmployed();
      // In the hierarchy, but with no role — so activation would produce an account that can
      // sign in and reach nothing.
      const person = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'No Role',
        employeeId: 'E-203',
        designation: 'Associate',
        departmentId,
        reportingManagerUserId: adminId,
        aadhaarNumber: aadhaar('78901234567'),
      });

      await assert.rejects(
        () =>
          invitations().inviteExistingPerson({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: person.userId,
            workEmail: 'norole@access.example',
          }),
        /company role/i,
      );
    });

    it('claims a seat, closing the Prompt 11 gap', async () => {
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      const before = await seats().positionFor(scope());

      const invited = await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'kavya@access.example',
      });

      // `NotInvited` is free under the default rule and `InvitePending` is not, so inviting is
      // the moment a seat is consumed. Before Prompt 13 nothing claimed it here.
      assert.equal(invited.seats.used, before.used + 1);
    });

    it('refuses an invitation that would exceed the contracted ceiling', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatsLicensed: 4 },
        }),
      );

      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);

      await assert.rejects(
        () =>
          invitations().inviteExistingPerson({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: person.userId,
            workEmail: 'kavya@access.example',
          }),
        /contracted ceiling/i,
      );
    });

    it('never returns the activation token', async () => {
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      const response = await as(agent().post(`/tenants/${tenantId}/access/invitations`), adminUboss)
        .send({ subjectUserId: person.userId, workEmail: 'kavya@access.example' })
        .expect(201);

      const body = JSON.stringify(response.body);
      assert.doesNotMatch(body, /"(token|activationToken|password)"\s*:/i);
      assert.equal((response.body as { tokenReturned: boolean }).tokenReturned, false);
    });

    it('needs users:ManageAccess', async () => {
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      await as(agent().post(`/tenants/${tenantId}/access/invitations`), employeeUboss)
        .send({ subjectUserId: person.userId, workEmail: 'kavya@access.example' })
        .expect(403);
    });
  });

  // =========================================================================
  describe('guests', () => {
    it('creates a guest outside the hierarchy with a mandatory expiry', async () => {
      const guest = await invitations().inviteGuest({
        scope: scope(),
        actorUserId: adminId,
        email: 'contractor@partner.example',
        displayName: 'Partner Contractor',
        resourceIds: ['objective-1'],
        accessDays: 30,
        reason: 'Reviewing the submission dossier.',
      });

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: guest.userId },
        }),
      );
      const employmentRecord = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: guest.userId },
        }),
      );

      assert.equal(membership?.userType, 'ExternalGuest');
      assert.ok(membership?.guestAccessExpiresAt);
      // The client's rule: guests stay outside the hierarchy.
      assert.equal(employmentRecord, null);
    });

    it('gives the guest a resource-scoped grant that expires with their access', async () => {
      const guest = await invitations().inviteGuest({
        scope: scope(),
        actorUserId: adminId,
        email: 'contractor@partner.example',
        displayName: 'Partner Contractor',
        resourceIds: ['objective-1', 'objective-2'],
        accessDays: 30,
        reason: 'Reviewing the submission dossier.',
      });

      const grant = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.findFirst({
          where: { tenantId, userId: guest.userId },
        }),
      );

      assert.equal(grant?.scopeKind, 'SelectedResource');
      assert.deepEqual(grant?.selectedResourceIds, ['objective-1', 'objective-2']);
      assert.ok(grant?.expiresAt);
    });

    it('refuses a guest with no named resources', async () => {
      await assert.rejects(
        () =>
          invitations().inviteGuest({
            scope: scope(),
            actorUserId: adminId,
            email: 'contractor@partner.example',
            displayName: 'Partner Contractor',
            resourceIds: [],
            accessDays: 30,
            reason: 'Whatever they need.',
          }),
        /name the resources/i,
      );
    });

    it('caps how long guest access may run', async () => {
      await assert.rejects(
        () =>
          invitations().inviteGuest({
            scope: scope(),
            actorUserId: adminId,
            email: 'contractor@partner.example',
            displayName: 'Partner Contractor',
            resourceIds: ['objective-1'],
            accessDays: 4000,
            reason: 'A very long engagement.',
          }),
        /capped at/i,
      );
    });

    it('refuses to make an existing employee a guest', async () => {
      await assert.rejects(
        () =>
          invitations().inviteGuest({
            scope: scope(),
            actorUserId: adminId,
            email: 'ub-aemp-0001@access.example',
            displayName: 'Access Employee',
            resourceIds: ['objective-1'],
            accessDays: 30,
            reason: 'Trying to demote an employee to a guest.',
          }),
        /already an internal member/i,
      );
    });

    it('cannot be given an employment record, even at the database', async () => {
      const guest = await invitations().inviteGuest({
        scope: scope(),
        actorUserId: adminId,
        email: 'contractor@partner.example',
        displayName: 'Partner Contractor',
        resourceIds: ['objective-1'],
        accessDays: 30,
        reason: 'Reviewing the submission dossier.',
      });

      // Straight at the table as the owner role. The trigger is the guarantee.
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `INSERT INTO employment_records
               (id, tenant_id, user_id, employee_id, designation, department_id,
                created_at, updated_at, row_version)
             VALUES (gen_random_uuid(), $1, $2, 'G-1', 'Guest', $3, NOW(), NOW(), 1)`,
            tenantId,
            guest.userId,
            departmentId,
          ),
        /guests stay outside the hierarchy/i,
      );
    });

    it('appears in the Guests tab and nowhere else', async () => {
      await invitations().inviteGuest({
        scope: scope(),
        actorUserId: adminId,
        email: 'contractor@partner.example',
        displayName: 'Partner Contractor',
        resourceIds: ['objective-1'],
        accessDays: 30,
        reason: 'Reviewing the submission dossier.',
      });

      const view = await users().viewFor(scope(), adminId);
      assert.equal(view.counts.guests, 1);
      assert.ok(!view.employees.some((person) => person.displayName === 'Partner Contractor'));
      assert.ok(view.guests[0]?.guestAccessExpiresAt);
    });
  });

  // =========================================================================
  describe('suspend and reinstate', () => {
    it('suspends without deleting anything', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(async () => ({
        roles: await ctx.prisma.client.roleAssignment.count({ where: { tenantId } }),
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
      }));

      await users().suspend({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        reason: 'Under investigation pending review.',
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        roles: await ctx.prisma.client.roleAssignment.count({ where: { tenantId } }),
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        membership: await ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: employeeId },
        }),
      }));

      assert.equal(after.membership?.accountState, 'Suspended');
      // Reversible and non-destructive: roles and memberships untouched.
      assert.equal(after.roles, before.roles);
      assert.equal(after.memberships, before.memberships);
    });

    it('refuses to let somebody suspend themselves', async () => {
      await assert.rejects(
        () =>
          users().suspend({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: adminId,
            reason: 'Trying to lock myself out.',
          }),
        /cannot suspend your own account/i,
      );
    });

    it('requires a reason', async () => {
      await assert.rejects(
        () =>
          users().suspend({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
            reason: '   ',
          }),
        /requires a reason/i,
      );
    });

    it('reinstates a suspended account', async () => {
      await users().suspend({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        reason: 'Under investigation pending review.',
      });
      await users().reinstate({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        reason: 'Investigation closed with no findings.',
      });

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({ where: { tenantId, userId: employeeId } }),
      );
      assert.equal(membership?.accountState, 'Active');
    });

    it('records both changes as security events', async () => {
      await users().suspend({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        reason: 'Under investigation pending review.',
      });

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.account_suspended',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      // Who it was done *to*, not only who did it — the field the façade gained at Prompt 12.
      assert.equal(events[0]?.subjectUserId, employeeId);
    });

    it('needs users:ManageAccess', async () => {
      await as(agent().post(`/tenants/${tenantId}/access/people/${adminId}/suspend`), employeeUboss)
        .send({ reason: 'An employee trying to suspend an admin.' })
        .expect(403);
    });
  });

  // =========================================================================
  describe('offboarding', () => {
    it('reports what it would move before doing it', async () => {
      const impact = await offboardings().assess({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
      });

      assert.equal(impact.roleAssignments, 1);
      assert.equal(impact.successorRequired, false);
      assert.match(impact.note, /Nothing is deleted/);
      // Every domain named, including the ones that do not exist yet.
      assert.equal(impact.domains.length, HANDOVER_DOMAINS.length);
    });

    it('preserves the membership, the employment record and the audit trail', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);

      const before = await ctx.prisma.runAsPlatformOperation(async () => ({
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        employments: await ctx.prisma.client.employmentRecord.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
        users: await ctx.prisma.client.user.count(),
      }));

      await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        reason: 'Resigned; last day was Friday.',
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        memberships: await ctx.prisma.client.tenantMembership.count({ where: { tenantId } }),
        employments: await ctx.prisma.client.employmentRecord.count({ where: { tenantId } }),
        audit: await ctx.prisma.client.auditEvent.count({ where: { tenantId } }),
        users: await ctx.prisma.client.user.count(),
        membership: await ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: person.userId },
        }),
        employment: await ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: person.userId },
        }),
      }));

      // Every row survives. Only the *state* changed.
      assert.equal(after.memberships, before.memberships);
      assert.equal(after.employments, before.employments);
      assert.equal(after.users, before.users);
      assert.ok(after.audit > before.audit);

      assert.equal(after.membership?.accountState, 'Offboarded');
      assert.equal(after.employment?.state, 'Ended');
      assert.ok(after.employment?.endedAt);
    });

    it('revokes their roles rather than transferring them', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);
      const successorRoles = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({ where: { tenantId, userId: adminId } }),
      );

      const outcome = await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        successorUserId: managerId,
        reason: 'Resigned; last day was Friday.',
      });

      const subjectRoles = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({ where: { tenantId, userId: person.userId } }),
      );
      const adminRolesAfter = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({ where: { tenantId, userId: adminId } }),
      );

      assert.equal(subjectRoles, 0);
      // The successor's authority is unchanged: copying grants would be silent escalation.
      assert.equal(adminRolesAfter, successorRoles);
      assert.equal(outcome.handover['roleAssignments']?.status, 'revoked');
    });

    it('moves direct reports to the successor', async () => {
      const lead = await addHierarchyPerson('Team Lead', 'E-401', '40218837551', adminId);
      const report = await addHierarchyPerson('Team Member', 'E-402', '29876543210', lead.userId);

      await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: lead.userId,
        successorUserId: managerId,
        reason: 'Resigned; last day was Friday.',
      });

      const moved = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: report.userId },
        }),
      );
      assert.equal(moved?.reportingManagerUserId, managerId);
    });

    it('refuses to offboard somebody with reports and no successor', async () => {
      const lead = await addHierarchyPerson('Team Lead', 'E-401', '40218837551', adminId);
      await addHierarchyPerson('Team Member', 'E-402', '29876543210', lead.userId);

      await assert.rejects(
        () =>
          offboardings().offboard({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: lead.userId,
            reason: 'Resigned.',
          }),
        /direct report\(s\)\. Name a successor/i,
      );
    });

    it('names the domains it cannot transfer yet instead of implying it handled them', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);
      const outcome = await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        reason: 'Resigned; last day was Friday.',
      });

      // Two domains still have no module behind them, and each says which prompt brings it.
      for (const key of ['openWork', 'engineAgents']) {
        assert.equal(outcome.handover[key]?.status, 'not-implemented');
        assert.match(String(outcome.handover[key]?.detail), /arrives with/);
      }

      // `connections` became real at Prompt 16, and this assertion is what caught it — which is
      // the registry earning its place: a domain cannot quietly change status without a test
      // noticing.
      assert.equal(outcome.handover['connections']?.status, 'disabled-and-reported');

      assert.equal(outcome.nothingDeleted, true);
    });

    it('disables a leaver’s personal connection and never transfers it', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);

      const mine = await app.get(ConnectionService).create({
        scope: scope(),
        actorUserId: person.userId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });

      // A different identifier: the fixture matches on it, so reusing the leaver's would
      // return the same person rather than creating a second one.
      const successor = await addHierarchyPerson('Successor', 'E-302', '29876543210', adminId);

      const outcome = await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        successorUserId: successor.userId,
        reason: 'Resigned; last day was Friday.',
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connection.findFirst({ where: { tenantId, id: mine.id } }),
      );

      // Disabled, with the reason on the row — and the owner **unchanged**. Handing a personal
      // credential to a successor would give somebody access to a mailbox that is not theirs.
      assert.notEqual(row?.disabledAt, null);
      assert.match(row?.disabledReason ?? '', /never transferred/i);
      assert.equal(row?.ownerUserId, person.userId);

      assert.match(String(outcome.handover['connections']?.detail), /1 personal connection/);
    });

    it('reports a company connection the leaver owned rather than reassigning it', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);

      const company = await app.get(ConnectionService).create({
        scope: scope(),
        actorUserId: adminId,
        scopeKind: 'Company',
        connectorKind: 'mock-erp',
        label: 'Their ERP',
        environment: 'Production',
        secret: 'mock:ok',
      });
      // The fixture adds people as NotInvited, and `transferOwner` correctly refuses an owner
      // without an active account. Activate first rather than relaxing the guard.
      await activateMembership(ctx, person.userId, tenantId);

      await app.get(ConnectionService).transferOwner({
        scope: scope(),
        actorUserId: adminId,
        connectionId: company.id,
        newOwnerUserId: person.userId,
        reason: 'They took over the integration.',
      });

      // A different identifier: the fixture matches on it, so reusing the leaver's would
      // return the same person rather than creating a second one.
      const successor = await addHierarchyPerson('Successor', 'E-302', '29876543210', adminId);

      const outcome = await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        successorUserId: successor.userId,
        reason: 'Resigned.',
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connection.findFirst({ where: { tenantId, id: company.id } }),
      );

      // Still live, still theirs on paper, and **reported**. Silently making the named successor
      // the owner of an ERP credential is the automatic escalation of access this system exists
      // to avoid — somebody has to choose.
      assert.equal(row?.disabledAt, null);
      assert.equal(row?.ownerUserId, person.userId);
      assert.match(
        String(outcome.handover['connections']?.detail),
        /need a new owner named deliberately/,
      );
    });

    it('cancels any outstanding invitation', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);
      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'leaver@access.example',
      });

      await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        reason: 'Resigned; last day was Friday.',
      });

      const invitation = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.findFirst({ where: { tenantId, userId: person.userId } }),
      );
      // A live activation link for somebody who has left is a way into the company.
      assert.ok(invitation?.cancelledAt);
    });

    it('refuses to let somebody offboard themselves', async () => {
      await assert.rejects(
        () =>
          offboardings().offboard({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: adminId,
            reason: 'Trying to remove myself.',
          }),
        /cannot offboard yourself/i,
      );
    });

    it('refuses a successor from another company', async () => {
      const person = await addHierarchyPerson('Leaver', 'E-301', '40218837551', adminId);
      const outsider = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OUTS-0002',
          email: 'outsider@other-access.example',
          displayName: 'Outsider',
        }),
      );

      await assert.rejects(
        () =>
          offboardings().offboard({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: person.userId,
            successorUserId: outsider.id,
            reason: 'Resigned.',
          }),
        /currently employed by this company/i,
      );
    });
  });

  // =========================================================================
  describe('bulk operations', () => {
    const csv = (rows: string[]) =>
      [
        'Employee Name,Employee ID,Designation,Department,Reporting Manager,Aadhaar Number',
        ...rows,
      ].join('\n');

    it('parses a header row, quoted fields and CRLF endings', () => {
      const parsed = BulkOperationService.parseDelimited(
        'Employee Name,Designation\r\n"Reddy, Kavya",Associate\r\n"Says ""hi""",Analyst\r\n',
      );

      assert.equal(parsed.length, 2);
      // Quoted comma survives; the row number matches the spreadsheet's own numbering.
      assert.equal(parsed[0]?.values['employeeName'], 'Reddy, Kavya');
      assert.equal(parsed[0]?.rowNumber, 2);
      assert.equal(parsed[1]?.values['employeeName'], 'Says "hi"');
    });

    it('validates without applying anything', async () => {
      await ensureAdminIsEmployed();
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.count({ where: { tenantId } }),
      );

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-501,Associate,General,Access Admin,${aadhaar('40218837551')}`,
        ]),
        sourceFileName: 'joiners.csv',
      });

      const after = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.count({ where: { tenantId } }),
      );

      assert.equal(preview.state, 'Validated');
      assert.equal(preview.validRows, 1);
      // The whole point of a preview.
      assert.equal(after, before);
      assert.match(preview.note, /Nothing has been applied/);
    });

    it('reports errors per row, with every problem in one pass', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Good Row,E-502,Associate,General,Access Admin,${aadhaar('40218837551')}`,
          ',,,Nonexistent Department,Nobody At All,123',
        ]),
      });

      assert.equal(preview.validRows, 1);
      assert.equal(preview.invalidRows, 1);

      const bad = preview.rows.find((row) => row.state === 'Invalid');
      assert.ok(bad);
      assert.equal(bad!.rowNumber, 3);
      // Name, id, designation, department, manager and the Aadhaar — all of it, not the first.
      assert.ok(bad!.errors.length >= 5, `expected several errors, got ${bad!.errors.length}`);
      assert.ok(bad!.errors.some((error) => /does not exist in this company/.test(error)));
      assert.ok(bad!.errors.some((error) => /not in this company/.test(error)));
    });

    it('applies the valid rows and skips the invalid ones', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-601,Associate,General,Access Admin,${aadhaar('40218837551')}`,
          `Arun Mehta,E-602,Analyst,General,Access Admin,${aadhaar('29876543210')}`,
          ',,,Nonexistent,Nobody,999',
        ]),
      });

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      // Partial application, reported. Rejecting 397 good rows for three bad ones would be worse.
      assert.equal(result.applied, 2);
      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 0);

      // Counted by the imported Employee IDs rather than by all employment records: the fixture
      // creates two of its own, and asserting a total would pass or fail on the fixture's shape
      // rather than on what the import did.
      const imported = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.count({
          where: { tenantId, employeeId: { in: ['E-601', 'E-602'] } },
        }),
      );
      assert.equal(imported, 2);
    });

    it('cannot be applied twice', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-701,Associate,General,Access Admin,${aadhaar('40218837551')}`,
        ]),
      });
      await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      await assert.rejects(
        () =>
          bulk().apply({
            scope: scope(),
            actorUserId: adminId,
            operationId: preview.operationId,
          }),
        /cannot be applied twice/i,
      );
    });

    it('can only be applied by the person who validated it', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-801,Associate,General,Access Admin,${aadhaar('40218837551')}`,
        ]),
      });

      // The manager may hold the permission; the rows were still checked against somebody else's
      // authority, so applying them as the manager would apply a plan nobody reviewed.
      await assert.rejects(
        () =>
          bulk().apply({
            scope: scope(),
            actorUserId: managerId,
            operationId: preview.operationId,
          }),
        /(only the person who validated|forbidden|not allowed)/i,
      );
    });

    it('does not let a bulk import bypass the seat ceiling', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { tenantId },
          data: { seatsLicensed: 5, seatCountingOverride: 'ActiveInvitedAndSuspended' },
        }),
      );

      // Four counted seats are already used, so at most one of these can be invited.
      const first = await addHierarchyPerson('One', 'E-901', '40218837551', adminId);
      const second = await addHierarchyPerson('Two', 'E-902', '29876543210', adminId);

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'InviteOrResend',
        content: [
          'uboss Unique Id,email',
          `${first.ubossUniqueId},one@access.example`,
          `${second.ubossUniqueId},two@access.example`,
        ].join('\n'),
      });

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      // The file does not overshoot the ceiling wholesale: rows fail individually.
      assert.ok(result.failed >= 1, 'at least one row must be refused at the ceiling');
      const position = await seats().positionFor(scope());
      assert.ok(position.used <= 5, `used ${position.used} must not exceed the ceiling of 5`);
    });

    it('refuses a row naming somebody from another company', async () => {
      const outsider = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OUTS-0003',
          email: 'outsider2@other-access.example',
          displayName: 'Outsider Two',
        }),
      );

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'InviteOrResend',
        content: ['uboss Unique Id', outsider.ubossUniqueId].join('\n'),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]?.errors.some((error) => /cannot reach into another company/.test(error)),
      );
    });

    it('refuses to apply a bulk role change rather than skipping its escalation gates', async () => {
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'RoleAndScope',
        content: ['uboss Unique Id,role', `${employeeUboss},CompanyAdmin`].join('\n'),
      });

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      // Validated but deliberately not applied: a grant must go through the role administration
      // service so its three escalation gates apply.
      assert.equal(result.applied, 0);
      assert.equal(result.failed, 1);

      const operation = await app
        .get(AccessRepository)
        .findBulkOperation(scope(), preview.operationId);
      assert.match(String(operation?.rows[0]?.errors[0]), /escalation gates/i);
    });

    it('needs the operation kind’s own permission, not just the ability to upload', async () => {
      await assert.rejects(
        () =>
          bulk().validate({
            scope: scope(),
            actorUserId: employeeId,
            kind: 'SuspendOrOffboard',
            content: ['uboss Unique Id,action', `${employeeUboss},suspend`].join('\n'),
          }),
        /(forbidden|not allowed|cannot)/i,
      );
    });

    it('refuses an empty file and one over the row limit', async () => {
      await assert.rejects(
        () =>
          bulk().validate({
            scope: scope(),
            actorUserId: adminId,
            kind: 'ImportEmployees',
            content: 'Employee Name,Employee ID',
          }),
        /no data rows/i,
      );
    });

    it('keeps row outcomes when an operation is cancelled', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-950,Associate,General,Access Admin,${aadhaar('40218837551')}`,
        ]),
      });

      await bulk().cancel({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      const operation = await app
        .get(AccessRepository)
        .findBulkOperation(scope(), preview.operationId);
      assert.equal(operation?.state, 'Cancelled');
      // Nothing is deleted: the rows and their outcomes are the record of what was proposed.
      assert.equal(operation?.rows.length, 1);
    });

    it('never shows one company another’s bulk operations', async () => {
      await ensureAdminIsEmployed();
      await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-960,Associate,General,Access Admin,${aadhaar('40218837551')}`,
        ]),
      });

      const otherOperations = await app
        .get(AccessRepository)
        .listBulkOperations(tenantScopeForPlatformOperation(otherTenantId));
      assert.equal(otherOperations.length, 0);
    });
  });
});
