import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AccessController } from '../src/access/access.controller.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { activationReadiness } from '../src/access/activation-readiness.js';
import { BulkOperationService } from '../src/access/bulk-operation.service.js';
import { InvitationAccessService } from '../src/access/invitation-access.service.js';
import { HANDOVER_DOMAINS, OffboardingService } from '../src/access/offboarding.service.js';
import { CapabilityService } from '../src/access/capability.service.js';
import { ReportScopeService } from '../src/reports/report-scope.service.js';
import { UserAccessService } from '../src/access/user-access.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { IdentityMailService } from '../src/auth/identity-mail.service.js';
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
import { PasswordResetService } from '../src/auth/password-reset.service.js';
import { PasswordResetRepository } from '../src/persistence/password-reset.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
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
  const organization = () => app.get(OrganizationRepository);
  const access = () => app.get(AccessRepository);

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
        TenantMembershipRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        OrganizationRepository,
        AccessRepository,
        // Users & Access narrows its roster to the caller's scope, and this is what resolves it.
        ReportScopeService,
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
        // The activation link, which is the only part of an invitation a person can act on.
        IdentityMailService,
        // And the reset link an administrator sends on somebody else's behalf.
        PasswordResetService,
        PasswordResetRepository,
        PerformanceService,
        MemoryService,
        OffboardingService,
        BulkOperationService,
        // Prompt 40A: the Access & Permissions step hangs off this controller.
        CapabilityService,
        // Roles & Permissions on the company plane run the platform plane’s own service.
        RoleAdministrationService,
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
      // Required since CR-04. Derived from the employee id so each fixture person has their own:
      // a work email becomes a sign-in address, and those are unique across UBoss.
      workEmail: `${empId.toLowerCase()}@uboss.local`,
      workPhone: '+91 90000 00000',
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

    // The waiver exists for the person at the top of the chart, and it used to be unreachable by
    // exactly that person: the root IS an employment record with no manager, so counting every
    // such record included the subject and the answer was always "yes, a root exists". The first
    // employee could be placed at the top and then never invited, refused for lacking the manager
    // that being the root means not having.
    it('does not count the subject as the reporting root that disqualifies them', async () => {
      const repository = app.get(AccessRepository);

      await ensureAdminIsEmployed();
      const employment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, reportingManagerUserId: null },
          select: { userId: true },
        }),
      );
      assert.ok(employment, 'the fixture needs somebody at the top of the chart');

      // Asked about anybody else, the root is there.
      assert.equal(await repository.hasReportingRoot(scope()), true);
      // Asked about the root themselves, nobody else is above them.
      assert.equal(await repository.hasReportingRoot(scope(), employment.userId), false);
    });

    // A freshly provisioned company has no departments — the setup checklist has the admin build
    // them after signing in. Without this exception that admin can never activate, and nobody
    // else in the company can create the employment record they are missing.
    it('lets the initial administrator of an empty company activate', () => {
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'InvitePending',
        employment: null,
        roleCount: 1,
        companyHasReportingRoot: false,
        hasBootstrapRole: true,
      });
      assert.equal(readiness.ready, true);
    });

    // The narrowness is the point: it is the bootstrap grant plus an empty company, not either
    // one alone.
    it('still requires employment once the company has a reporting root', () => {
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'InvitePending',
        employment: null,
        roleCount: 1,
        companyHasReportingRoot: true,
        hasBootstrapRole: true,
      });
      assert.equal(readiness.ready, false);
      assert.match(readiness.summary, /employment record/);
    });

    /*
     * The same administrator, once they are in, is not still "missing" it.
     *
     * The rule above is a gate and is right to be narrow. What it produced afterwards was a
     * warning on Users & Access against the company's own administrator — Active, working, and
     * flagged "needs an employment record" — because they had built the hierarchy underneath
     * themselves and so closed their own exemption. Nothing could clear it: the action it implied
     * was filing the owner of the company under one of their own departments.
     *
     * The pair below is the point. Before activation the gate is unchanged; after activation the
     * founding administrator is not described as unready.
     */
    it('stops asking the founding administrator for one once they are active', () => {
      const gate = {
        userType: 'InternalUser',
        accountState: 'InvitePending',
        employment: null,
        roleCount: 1,
        companyHasReportingRoot: true,
        hasBootstrapRole: true,
      } as const;

      assert.equal(activationReadiness(gate).ready, false);
      assert.equal(activationReadiness({ ...gate, accountState: 'Active' }).ready, true);
    });

    it('still flags an ordinary active employee who has no employment record', () => {
      // The exemption is the bootstrap grant, not being active. Somebody who activated without a
      // record is a real gap and keeps its warning.
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'Active',
        employment: null,
        roleCount: 1,
        companyHasReportingRoot: true,
        hasBootstrapRole: false,
      });
      assert.equal(readiness.ready, false);
      assert.match(readiness.summary, /employment record/);
    });

    it('still requires employment for an ordinary invitee into an empty company', () => {
      const readiness = activationReadiness({
        userType: 'InternalUser',
        accountState: 'InvitePending',
        employment: null,
        roleCount: 1,
        companyHasReportingRoot: false,
        hasBootstrapRole: false,
      });
      assert.equal(readiness.ready, false);
      assert.match(readiness.summary, /employment record/);
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

    it('emails an activation link the person can actually open', async () => {
      /*
       * The invitation used to arrive and be unusable.
       *
       * The only email was the in-app notification, rendered for a bell: *"Activate your account
       * to reach this workspace. The activation link was emailed to you"* — in the email that was
       * supposed to *be* that link — followed by `Open it: /login`, a workspace-relative path no
       * mail client can open. The token was minted, hashed, stored, and discarded by everything
       * downstream: exactly the shape the password reset had.
       *
       * Found by sending one to a real inbox, which is the only place it shows.
       */
      const person = await addHierarchyPerson('Linked Person', 'E-260', '40218837557', adminId);
      const adapter = app.get(EmailAdapter) as LoggingEmailAdapter;
      adapter.sent.length = 0;

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'linked@access.example',
      });

      const activation = adapter.sent.find((mail) => /invited/i.test(mail.subject));
      assert.ok(activation, 'no invitation email was sent');
      assert.equal(activation.to, 'linked@access.example');

      // An absolute link carrying the token, which is the whole point of the message.
      assert.match(
        activation.text,
        /https?:\/\/[^\s]+\/activate\?token=[^\s]+/,
        'the invitation carries no activation link',
      );

      // And it no longer refers the reader to an email they are already reading.
      assert.doesNotMatch(
        activation.text,
        /was emailed to you/i,
        'the invitation still points at some other email for the link',
      );
    });

    /*
     * An invitation is from a person, and says so.
     *
     * It arrived as "UBoss AI" with the body offering "an administrator at <company>" — which is
     * the shape of every phishing attempt a person has been trained to delete, and it was asking
     * them to set a password. The name of a colleague they recognise is the one thing that makes
     * it credible.
     *
     * What this cannot do, and the reason the sender's own address is not in `From:`, is send as
     * somebody else's domain: SPF and DKIM are checked against it, and mail claiming to be from
     * `spmmedicare.com` out of this deployment would be marked spam or refused. Doing the
     * obvious thing would stop invitations arriving. So the name travels in the display name and
     * the address stays ours, with `replyTo` carrying where an answer belongs.
     */
    it('says who invited them, and sends the reply to that person', async () => {
      const person = await addHierarchyPerson('Named Invite', 'E-261', '40218837558', adminId);
      const adapter = app.get(EmailAdapter) as LoggingEmailAdapter;
      adapter.sent.length = 0;

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: person.userId,
        workEmail: 'named@access.example',
      });

      const activation = adapter.sent.find((mail) => /invited/i.test(mail.subject));
      assert.ok(activation, 'no invitation email was sent');

      assert.match(
        activation.fromName ?? '',
        /^Access Admin \(.+\) via Chief Agent$/,
        'the sender name names neither the administrator nor the product',
      );
      assert.equal(
        activation.replyTo,
        'ub-aadm-0001@access.example',
        'a reply would go to the no-reply address instead of the person who invited them',
      );
      assert.match(activation.text, /Access Admin invited you/);
      assert.match(activation.html ?? '', /Access Admin has invited you/);

      /*
       * The safety property, asserted on the message rather than left to a comment: a caller can
       * set who it *looks* like it is from and cannot set the address it is actually from. If a
       * `from` ever appears here, somebody has made it possible to send as a customer's domain,
       * and that is a deliverability failure which shows up as "invitations stopped arriving"
       * rather than as an error.
       */
      assert.equal(
        'from' in activation,
        false,
        'an outbound message can now override the sending address',
      );
    });

    it('withholds a reply-to that would bounce, and still names the sender', async () => {
      /*
       * Somebody in the org chart from before work addresses were required holds
       * `…@person.uboss.invalid`. A reply-to pointing there is worse than none: the recipient
       * believes they have asked their question, and nobody ever receives it. The name is still
       * worth having, so only the reply route is withheld.
       */
      const legacyAdmin = await addHierarchyPerson('Legacy Admin', 'E-262', '40218837559', adminId);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.update({
          where: { id: legacyAdmin.userId },
          data: { email: 'legacy.admin@person.uboss.invalid' },
        }),
      );
      await as(
        agent().post(`/tenants/${tenantId}/access/people/${legacyAdmin.userId}/roles`),
        adminUboss,
      )
        .send({
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          justification: 'Administers the company from before work addresses were required.',
        })
        .expect(201);

      const person = await addHierarchyPerson('Legacy Invite', 'E-263', '40218837560', adminId);
      const adapter = app.get(EmailAdapter) as LoggingEmailAdapter;
      adapter.sent.length = 0;

      await invitations().inviteExistingPerson({
        scope: scope(),
        actorUserId: legacyAdmin.userId,
        subjectUserId: person.userId,
        workEmail: 'legacy.invite@access.example',
      });

      const activation = adapter.sent.find((mail) => /invited/i.test(mail.subject));
      assert.ok(activation, 'no invitation email was sent');
      assert.match(activation.fromName ?? '', /^Legacy Admin \(.+\) via Chief Agent$/);
      assert.equal(
        activation.replyTo,
        undefined,
        'the invitation would send replies to an address that cannot receive them',
      );
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
      /*
       * The placeholder is constructed here rather than arrived at.
       *
       * CR-04 made a work email mandatory when somebody is added to the chart, so
       * `addEmployee` no longer produces a `…@person.uboss.invalid` address — that path is
       * closed. The address still exists for people who reached the company another way, and
       * replacing it is still what an invitation does, so the state is set up directly rather
       * than the test being deleted along with the way it used to occur.
       */
      const person = await addHierarchyPerson('Kavya Reddy', 'E-201', '40218837551', adminId);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.update({
          where: { id: person.userId },
          data: { email: `${person.ubossUniqueId.toLowerCase()}@person.uboss.invalid` },
        }),
      );

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
      // Same reason as above: a person added to the chart now always has a real address, so the
      // "nowhere to send it" state is reached deliberately. The guard is still the thing worth
      // proving — an invitation sent to an invalid domain is one nobody receives and nobody
      // chases.
      const person = await addHierarchyPerson('No Email', 'E-202', '29876543210', adminId);
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.update({
          where: { id: person.userId },
          data: { email: `${person.ubossUniqueId.toLowerCase()}@person.uboss.invalid` },
        }),
      );

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
        workEmail: 'norole-initial@uboss.local',
        workPhone: '+91 90000 00001',
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

    it('serves a notice period instead of ending it today', async () => {
      /*
       * CR-04. Offboarding used to end everything the moment it was recorded, which is right for
       * a dismissal and wrong for a resignation: somebody working a month's notice still has
       * work to finish and somebody to hand it to.
       *
       * So the two halves separate. Today: the successor takes the reporting line, and the
       * person keeps their access. On their last day: the access ends and the employment closes.
       */
      const leaver = await addHierarchyPerson('Leaver', 'E-901', '40218837551', adminId);
      const report = await addHierarchyPerson(
        'Their Report',
        'E-902',
        '29876543210',
        leaver.userId,
      );

      const outcome = await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: leaver.userId,
        successorUserId: adminId,
        reason: 'Resigned, serving thirty days of notice.',
        noticeDays: 30,
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        membership: await ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { accountState: true },
        }),
        employment: await ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { state: true, endedAt: true },
        }),
        roles: await ctx.prisma.client.roleAssignment.findMany({
          where: { tenantId, userId: leaver.userId },
          select: { expiresAt: true },
        }),
        offboarding: await ctx.prisma.client.offboarding.findFirst({
          where: { tenantId, subjectUserId: leaver.userId },
          select: { state: true, effectiveAt: true },
        }),
        movedReport: await ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: report.userId },
          select: { reportingManagerUserId: true },
        }),
      }));

      /*
       * Still here, still working.
       *
       * Not `Active`: somebody added to the chart is `NotInvited` until an invitation goes out,
       * and being invited has nothing to do with serving notice. What matters is that the state
       * did not move to `Offboarded`.
       */
      assert.notEqual(after.membership?.accountState, 'Offboarded');
      assert.equal(after.employment?.state, 'Active');
      assert.equal(after.employment?.endedAt, null);
      assert.equal(after.offboarding?.state, 'Requested');

      // The successor has the reporting line from today, which is the point of a notice period:
      // the two of them can actually hand over.
      assert.equal(after.movedReport?.reportingManagerUserId, adminId);

      /*
       * And their access already has an end date.
       *
       * This is what ends it, not the sweep. `listLiveAssignments` refuses an assignment whose
       * `expiresAt` has passed, and every authorization call goes through it — so the morning
       * after their last day they have no permissions whether or not anybody ran the tick.
       */
      assert.ok(after.roles.length > 0, 'the fixture lost its premise');
      for (const role of after.roles) {
        assert.ok(role.expiresAt !== null, 'a role outlived the notice period');
        assert.ok(role.expiresAt.getTime() > Date.now(), 'the notice ended before it began');
        assert.ok(
          role.expiresAt.getTime() < Date.now() + 31 * 24 * 60 * 60 * 1000,
          'the end date is further away than the notice given',
        );
      }

      assert.ok(outcome.nothingDeleted);
    });

    it('finishes a notice period once the last day has passed, and not before', async () => {
      const leaver = await addHierarchyPerson('Later Leaver', 'E-903', '78901234567', adminId);
      await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: leaver.userId,
        successorUserId: adminId,
        reason: 'Resigned, serving a week of notice.',
        noticeDays: 7,
      });

      // A tick today finds nothing: the last day has not arrived.
      const early = await offboardings().completeDue({ scope: scope(), actorUserId: adminId });
      assert.deepEqual(early.completed, []);

      const stillHere = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { accountState: true },
        }),
      );
      assert.notEqual(stillHere?.accountState, 'Offboarded');

      // A tick on the far side of it finishes the job. The clock is passed in rather than waited
      // for: a test that slept a week would not be a test.
      const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
      const done = await offboardings().completeDue({
        scope: scope(),
        actorUserId: adminId,
        now: later,
      });
      assert.equal(done.completed.length, 1);

      const closed = await ctx.prisma.runAsPlatformOperation(async () => ({
        membership: await ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { accountState: true },
        }),
        employment: await ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { state: true, endedAt: true },
        }),
        roles: await ctx.prisma.client.roleAssignment.count({
          where: { tenantId, userId: leaver.userId },
        }),
      }));

      assert.equal(closed.membership?.accountState, 'Offboarded');
      assert.equal(closed.employment?.state, 'Ended');
      assert.ok(closed.employment?.endedAt !== null, 'an ended employment must say when');
      assert.equal(closed.roles, 0);

      // Ticking again changes nothing. Two schedulers running at once must not offboard somebody
      // twice or write a second audit entry for one departure.
      const again = await offboardings().completeDue({
        scope: scope(),
        actorUserId: adminId,
        now: later,
      });
      assert.deepEqual(again.completed, []);
    });

    it('still ends it today when no notice is given', async () => {
      // The original behaviour, unchanged: a dismissal needs the access gone now.
      const leaver = await addHierarchyPerson('Dismissed', 'E-904', '29876543210', adminId);
      await offboardings().offboard({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: leaver.userId,
        successorUserId: adminId,
        reason: 'Dismissed with immediate effect.',
      });

      const after = await ctx.prisma.runAsPlatformOperation(async () => ({
        membership: await ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: leaver.userId },
          select: { accountState: true },
        }),
        roles: await ctx.prisma.client.roleAssignment.count({
          where: { tenantId, userId: leaver.userId },
        }),
      }));

      assert.equal(after.membership?.accountState, 'Offboarded');
      assert.equal(after.roles, 0);
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
        // These are the template's columns in its own order. All are required except Work Email,
        // which the client asked to be taken when given and not insisted on — a company importing
        // its existing roster often has no work address for everybody. Work Phone stays required,
        // so an imported person is always contactable by something.
        'Employee Name,Employee ID,Designation,Specialization,Department,Reporting Manager,Work Email,Work Phone,Aadhaar Number',
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
          `Kavya Reddy,E-501,Associate,Client Accounts,General,Access Admin,e-501@uboss.local,+91 90000 00001,${aadhaar('40218837551')}`,
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

    /*
     * The template stars Specialization, and a star on it promises the server refuses the row.
     *
     * Asserted on its own rather than left to the multi-error row above, because that row is
     * missing six things and would pass this test while the rule was absent.
     */
    /*
     * Email is taken when given and not insisted on — the client's instruction.
     *
     * It was required from CR-04 until now. A company importing its existing roster often has no
     * work address for everybody, and refusing those rows refuses the import; the person is still
     * reachable by phone, which **is** required. The template carries no star on Email, and this
     * is the half of that promise the server has to keep.
     */
    it('imports a row with no email, because the template no longer stars it', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `No Email,E-521,Associate,Client Accounts,General,Access Admin,,+91 90000 00021,${aadhaar('40218837551')}`,
        ]),
      });

      assert.equal(
        preview.invalidRows,
        0,
        `expected the row to pass, got ${JSON.stringify(preview.rows[0]?.errors)}`,
      );

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });
      assert.equal(result.applied, 1);
    });

    it('still refuses an email that is given and malformed', async () => {
      // Not insisting on one is not the same as not checking it. A typo in a column somebody did
      // fill in is still a typo, and silently storing it is how a person becomes uncontactable.
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Bad Email,E-522,Associate,Client Accounts,General,Access Admin,not-an-address,+91 90000 00022,${aadhaar('40218837551')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]?.errors.some((error) => /does not look like an email/i.test(error)),
        JSON.stringify(preview.rows[0]?.errors),
      );
    });

    /*
     * A company's whole hierarchy, from one file, into an empty company.
     *
     * This could not be done at all. Validation judged every row against the company as it
     * stands while `apply` walks the rows in order, so a manager created by row 3 existed when
     * row 10 was *applied* and did not exist when row 10 was *checked*. On a first import that is
     * every row: a 139-row file previewed as 139 refusals — "Reporting Manager X is not in this
     * company" — for people the file was about to create, and `Add 0 employees` was the only
     * button available.
     */
    it('accepts a manager an earlier row of the same file creates', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Top Person,E-901,Director,Whole Company,General,Access Admin,top@uboss.local,+91 90000 00901,${aadhaar('40218837551')}`,
          `Reports Upward,E-902,Associate,Client Accounts,General,Top Person,up@uboss.local,+91 90000 00902,${aadhaar('29876543210')}`,
        ]),
      });

      assert.equal(
        preview.invalidRows,
        0,
        `expected both rows to pass, got ${JSON.stringify(preview.rows.map((r) => r.errors))}`,
      );

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });
      assert.equal(result.applied, 2, 'and the preview has to be right about it');
    });

    it('refuses a manager the file creates below the person reporting to them', async () => {
      // Rows are applied in order, so this one really would fail. The preview has to say the same
      // thing the apply will: agreeing is the whole job of a preview.
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Reports Upward,E-903,Associate,Client Accounts,General,Later Person,up2@uboss.local,+91 90000 00903,${aadhaar('40218837551')}`,
          `Later Person,E-904,Director,Whole Company,General,Access Admin,later@uboss.local,+91 90000 00904,${aadhaar('29876543210')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]?.errors.some((error) =>
          /no earlier row of this file creates them/i.test(error),
        ),
        JSON.stringify(preview.rows[0]?.errors),
      );
    });

    /*
     * The way out of an ambiguous name, which until now did not exist.
     *
     * Two people can share a name — the client's own roster has two Rahul Singhs and four Rohit
     * Kumars — and the refusal told the operator to use a UBoss Unique ID. Nobody has one until
     * they are imported, so the instruction was impossible to follow on the import that needed
     * it. The Employee ID is the company's own, is already a column in the file, and is unique
     * here by constraint.
     */
    it('resolves a manager by Employee ID, which a name cannot always do', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Boss One,E-905,Manager,Supply Chain,General,Access Admin,b1@uboss.local,+91 90000 00905,${aadhaar('40218837551')}`,
          `Boss One,E-906,Engineer,Moulding,General,Access Admin,b2@uboss.local,+91 90000 00906,${aadhaar('29876543210')}`,
          // By name this is ambiguous — two people above are called Boss One. By Employee ID it
          // is not.
          `Their Report,E-907,Executive,Store,General,E-905,r@uboss.local,+91 90000 00907,${aadhaar('78901234567')}`,
        ]),
      });

      assert.equal(
        preview.invalidRows,
        0,
        `expected the Employee ID to settle it, got ${JSON.stringify(preview.rows.map((r) => r.errors))}`,
      );

      const result = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });
      assert.equal(result.applied, 3);
    });

    it('refuses a manager named ambiguously, and says to use the Employee ID', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Same Name,E-908,Manager,Supply Chain,General,Access Admin,s1@uboss.local,+91 90000 00908,${aadhaar('40218837551')}`,
          `Same Name,E-909,Engineer,Moulding,General,Access Admin,s2@uboss.local,+91 90000 00909,${aadhaar('29876543210')}`,
          `Ambiguous Report,E-910,Executive,Store,General,Same Name,a@uboss.local,+91 90000 00910,${aadhaar('78901234567')}`,
        ]),
      });

      const bad = preview.rows.find((entry) => entry.state === 'Invalid');
      assert.ok(bad);
      assert.ok(
        bad!.errors.some((error) => /matches 2 people .* Use their Employee ID/i.test(error)),
        JSON.stringify(bad!.errors),
      );
    });

    it('refuses a second row claiming the top of the tree', async () => {
      // Both previewed as valid against an empty company and the second failed at apply: a
      // company with two people at the top of its reporting tree has no top.
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `First Root,E-911,Director,Whole Company,General,Access Admin,f@uboss.local,+91 90000 00911,${aadhaar('40218837551')}`,
          `Second Root,E-912,Director,Whole Company,General,Access Admin,s@uboss.local,+91 90000 00912,${aadhaar('29876543210')}`,
        ]),
      });
      assert.equal(preview.invalidRows, 0, 'both name a manager, so both are fine');
    });

    it('refuses the same Employee ID used twice inside one file', async () => {
      // Neither person exists yet, so the company's own records cannot show the clash. The
      // second row would be refused at apply.
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `One Person,E-913,Associate,Client Accounts,General,Access Admin,o1@uboss.local,+91 90000 00913,${aadhaar('40218837551')}`,
          `Another Person,E-913,Associate,Client Accounts,General,Access Admin,o2@uboss.local,+91 90000 00914,${aadhaar('29876543210')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[1]?.errors.some((error) => /already used on row .* of this file/i.test(error)),
        JSON.stringify(preview.rows[1]?.errors),
      );
    });

    it('refuses a row with no specialization, because the template stars it', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `No Specialism,E-511,Associate,,General,Access Admin,e-511@uboss.local,+91 90000 00011,${aadhaar('40218837551')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      const row = preview.rows[0];
      assert.ok(row);
      assert.ok(
        row!.errors.some((error) => /Specialization is required/.test(error)),
        `expected a specialization error, got ${JSON.stringify(row!.errors)}`,
      );
    });

    it('reports errors per row, with every problem in one pass', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Good Row,E-502,Associate,Client Accounts,General,Access Admin,e-502@uboss.local,+91 90000 00002,${aadhaar('40218837551')}`,
          ',,,,Nonexistent Department,Nobody At All,123',
        ]),
      });

      assert.equal(preview.validRows, 1);
      assert.equal(preview.invalidRows, 1);

      const bad = preview.rows.find((row) => row.state === 'Invalid');
      assert.ok(bad);
      assert.equal(bad!.rowNumber, 3);
      // Name, id, designation, specialization, manager, phone and the Aadhaar — all of it, not
      // the first.
      assert.ok(bad!.errors.length >= 5, `expected several errors, got ${bad!.errors.length}`);
      assert.ok(bad!.errors.some((error) => /not in this company/.test(error)));
      // The department it names is not one of them: an unknown department is created by the
      // import rather than refused, and this row is being refused for everything else.
      assert.ok(
        !bad!.errors.some((error) => /department/i.test(error)),
        `expected no department error, got ${JSON.stringify(bad!.errors)}`,
      );
      // Nor is it promised in the note, because this row will be skipped and nothing else asks
      // for it. A department must not come into existence for a row that is never applied.
      assert.ok(!/Nonexistent Department/.test(preview.note));
    });

    it('creates a department the file names and the company does not have', async () => {
      await ensureAdminIsEmployed();
      const departmentName = `Imported Unit ${Date.now()}`;

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Nikhil Rao,E-701,Associate,General,${departmentName},Access Admin,` +
            `e-701@uboss.local,+91 90000 00021,${aadhaar('40218837551')}`,
        ]),
      });

      // Valid, where it used to be refused with "Create it first, or correct the spelling" —
      // which no first import of a company could ever satisfy.
      assert.equal(preview.validRows, 1, JSON.stringify(preview.rows[0]?.errors));
      // And said so before anything was applied, because creating a department is a change the
      // operator did not ask for in so many words.
      assert.ok(
        preview.note.includes(departmentName),
        `expected the note to name the new department, got ${preview.note}`,
      );

      const before = await organization().listDepartments(scope(), false);
      assert.ok(!before.some((department) => department.name === departmentName));

      await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      const after = await organization().listDepartments(scope(), false);
      const created = after.find((department) => department.name === departmentName);
      assert.ok(created, 'the import should have created the department it named');

      // And the person landed in it, rather than in the no-department state the old code fell
      // back to when the lookup missed.
      const roster = await access().roster(scope());
      const imported = roster.find((person) => person.displayName === 'Nikhil Rao');
      assert.ok(imported);
      assert.equal(imported!.departmentName, departmentName);
    });

    it('refuses two rows sharing one work address, naming the row that took it', async () => {
      await ensureAdminIsEmployed();
      const shared = `accounts-${Date.now()}@uboss.local`;

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Meera Joshi,E-731,Associate,General,Client Accounts,Access Admin,` +
            `${shared},+91 90000 00025,${aadhaar('29876543210')}`,
          `Imran Qureshi,E-732,Analyst,General,Client Accounts,Access Admin,` +
            `${shared},+91 90000 00026,${aadhaar('40218837551')}`,
        ]),
      });

      // The first row keeps it; only the second is refused. A departmental mailbox on a factory
      // roster is normal, and the operator's fix is to blank the cell — which the message says.
      assert.equal(preview.validRows, 1);
      assert.equal(preview.invalidRows, 1);
      const refused = preview.rows.find((row) => row.state === 'Invalid');
      assert.ok(refused);
      assert.equal(refused!.rowNumber, 3);
      assert.ok(
        refused!.errors.some((error) => /already used on row 2 of this file/.test(error)),
        `expected the clashing row to be named, got ${JSON.stringify(refused!.errors)}`,
      );
    });

    it('refuses a work address an existing account already holds, before apply', async () => {
      await ensureAdminIsEmployed();
      const taken = `held-${Date.now()}@uboss.local`;

      // Imported once, so the address is genuinely a login handle by the time the second file
      // names it.
      const first = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Priya Nambiar,E-741,Associate,General,Client Accounts,Access Admin,` +
            `${taken},+91 90000 00027,${aadhaar('29876543210')}`,
        ]),
      });
      assert.equal(first.validRows, 1, JSON.stringify(first.rows[0]?.errors));
      await bulk().apply({ scope: scope(), actorUserId: adminId, operationId: first.operationId });

      const second = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Sandeep Rao,E-742,Analyst,General,Client Accounts,Access Admin,` +
            `${taken},+91 90000 00028,${aadhaar('40218837551')}`,
        ]),
      });

      // Refused here, where the operator can act on it. This used to pass validation and then
      // fail inside apply with a unique-constraint stack trace.
      assert.equal(second.invalidRows, 1);
      assert.ok(
        second.rows[0]!.errors.some((error) => /already belongs to Priya Nambiar/.test(error)),
        `expected the holder to be named, got ${JSON.stringify(second.rows[0]!.errors)}`,
      );
    });

    it('refuses when the address is one person’s account and the name is somebody else’s', async () => {
      await ensureAdminIsEmployed();

      /*
       * The typo, and the reason a matching address alone is not enough to employ an account.
       *
       * A row whose address was mistyped into a colleague's would otherwise attach this row's
       * Aadhaar, designation and employee id to that colleague. The name column is the second,
       * independent signal: a slip of the fingers in the address cell does not also put the
       * colleague's name in the name cell. When the two disagree, this is what happens.
       */
      const held = `invited-${Date.now()}@uboss.local`;
      await ctx.prisma.runAsPlatformOperation(async () => {
        const person = await ctx.prisma.client.user.create({
          data: {
            ubossUniqueId: generateUbossUniqueId(),
            email: held,
            displayName: 'Nandita Bose',
          },
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: person.id, accountState: 'Active' },
        });
      });

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Someone Else,E-751,Associate,General,Client Accounts,Access Admin,` +
            `${held},+91 90000 00029,${aadhaar('29876543210')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]!.errors.some((error) =>
          /belongs to Nandita Bose's account .* but this row names Someone Else/.test(error),
        ),
        `expected the name-mismatch message, got ${JSON.stringify(preview.rows[0]!.errors)}`,
      );
      // And it names the two ways out, because the operator has to choose between them.
      assert.ok(preview.rows[0]!.errors.some((error) => /check the address/.test(error)));
      assert.ok(preview.rows[0]!.errors.some((error) => /cell blank/.test(error)));
    });

    /**
     * An administrator invited before the org chart existed, meeting their own row.
     *
     * The client's live company: Pranav was made a Company Admin on day one, when there were no
     * departments and nobody to report to, so no employment record could exist. Their own row in
     * the roster then had nowhere to go — the import refused it, and refused everybody reporting
     * to them as well, because they were never created and so were never there to be a manager.
     *
     * The row is now applied to the account they already have. One human, one UBoss Unique ID.
     */
    const seedUnemployedAccount = async (input: {
      email: string;
      displayName: string;
      guest?: boolean;
    }): Promise<{ userId: string; ubossUniqueId: string }> =>
      ctx.prisma.runAsPlatformOperation(async () => {
        const person = await ctx.prisma.client.user.create({
          data: {
            ubossUniqueId: generateUbossUniqueId(),
            email: input.email,
            displayName: input.displayName,
          },
        });
        await ctx.prisma.client.tenantMembership.create({
          data: {
            tenantId,
            userId: person.id,
            accountState: 'Active',
            ...(input.guest === true
              ? {
                  userType: 'ExternalGuest' as const,
                  // The database requires a guest to have one, and forbids it for anybody else.
                  guestAccessExpiresAt: new Date(Date.now() + 30 * 86_400_000),
                }
              : {}),
          },
        });
        return { userId: person.id, ubossUniqueId: person.ubossUniqueId };
      });

    it('employs the account a row belongs to, rather than making a second person', async () => {
      await ensureAdminIsEmployed();

      const held = `pranav-${Date.now()}@uboss.local`;
      const account = await seedUnemployedAccount({ email: held, displayName: 'Pranav' });

      /*
       * The name in capitals, as a roster writes it, against an account created in title case.
       * The two are the same person and the difference carries no information, so the
       * comparison ignores it — which is the first thing somebody tries.
       */
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `PRANAV,E-IA-1,Assistant General Manager,Internal Assurance,Client Accounts,` +
            `Access Admin,${held},+91 90000 00031,${aadhaar('39876543210')}`,
        ]),
      });

      assert.equal(
        preview.invalidRows,
        0,
        `their own row should be valid, got ${JSON.stringify(preview.rows[0]!.errors)}`,
      );
      // And the preview says so, because "imported" and "employed on the account they already
      // have" are different outcomes and only one of them creates a record.
      assert.match(preview.note, /keeping their existing UBoss Unique ID/);
      assert.match(preview.note, /PRANAV/);

      const applied = await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });
      assert.equal(applied.applied, 1);
      assert.equal(applied.failed, 0);

      // The same human, not a second one: their id and their permanent identifier are unchanged,
      // and exactly one account holds that address.
      const employment = await app
        .get(OrganizationRepository)
        .findEmployment(scope(), account.userId);
      assert.ok(employment, 'the existing account should now have an employment record');
      assert.equal(employment!.employeeId, 'E-IA-1');

      const holders = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.findMany({
          where: { email: held },
          select: { ubossUniqueId: true },
        }),
      );
      assert.equal(holders.length, 1, 'one address, one person');
      assert.equal(holders[0]!.ubossUniqueId, account.ubossUniqueId, 'their ID must not change');
    });

    it('still refuses a guest, because employing one raises what they may do', async () => {
      await ensureAdminIsEmployed();

      const held = `nikhil-${Date.now()}@uboss.local`;
      await seedUnemployedAccount({ email: held, displayName: 'Nikhil', guest: true });

      /*
       * Name and address both agree here — this really is their row. It is refused anyway,
       * because a guest is capped at read, comment and draft and their access carries an end
       * date the database requires. Employing one removes both limits, and a privilege change
       * should not arrive from a row in a spreadsheet.
       */
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `NIKHIL,E-IA-2,Assistant Manager,Internal Assurance,Client Accounts,` +
            `Access Admin,${held},+91 90000 00032,${aadhaar('49876543210')}`,
        ]),
      });

      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]!.errors.some((error) => /is a guest in this company/.test(error)),
        `expected the guest message, got ${JSON.stringify(preview.rows[0]!.errors)}`,
      );
      assert.ok(preview.rows[0]!.errors.some((error) => /Hierarchy screen/.test(error)));
    });

    it('refuses a row naming an archived department, rather than creating a second one', async () => {
      await ensureAdminIsEmployed();
      const departmentName = `Retired Unit ${Date.now()}`;

      const departments = app.get(DepartmentService);
      const created = await departments.create({
        scope: scope(),
        actorUserId: adminId,
        name: departmentName,
      });
      await departments.archive({
        scope: scope(),
        actorUserId: adminId,
        departmentId: created.id,
        reason: 'Archived so the import has something taken but unusable to find.',
      });

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Asha Pillai,E-721,Associate,General,${departmentName},Access Admin,` +
            `e-721@uboss.local,+91 90000 00024,${aadhaar('29876543210')}`,
        ]),
      });

      // Refused in the preview, not discovered at apply. The department service rejects a
      // duplicate name whether or not the other one is archived, so letting this through would
      // have written the person with no department and called the import successful.
      assert.equal(preview.invalidRows, 1);
      assert.ok(
        preview.rows[0]!.errors.some((error) => /archived/i.test(error)),
        `expected an archived-department error, got ${JSON.stringify(preview.rows[0]!.errors)}`,
      );
      assert.ok(!preview.note.includes(departmentName));
    });

    it('creates a department named by several rows exactly once', async () => {
      await ensureAdminIsEmployed();
      const departmentName = `Shared Unit ${Date.now()}`;

      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Riya Sen,E-711,Associate,General,${departmentName},Access Admin,` +
            `e-711@uboss.local,+91 90000 00022,${aadhaar('29876543210')}`,
          `Vikram Nair,E-712,Analyst,General,${departmentName},Access Admin,` +
            `e-712@uboss.local,+91 90000 00023,${aadhaar('40218837551')}`,
        ]),
      });

      assert.equal(preview.validRows, 2, JSON.stringify(preview.rows));
      // Once in the note, not once per row — the operator is told how many departments appear,
      // and two people joining one new team is one department.
      assert.equal(preview.note.split(departmentName).length - 1, 1, preview.note);

      await bulk().apply({
        scope: scope(),
        actorUserId: adminId,
        operationId: preview.operationId,
      });

      const after = await organization().listDepartments(scope(), false);
      const matches = after.filter((department) => department.name === departmentName);
      assert.equal(
        matches.length,
        1,
        'two rows naming one new department must not make two departments',
      );
    });

    it('applies the valid rows and skips the invalid ones', async () => {
      await ensureAdminIsEmployed();
      const preview = await bulk().validate({
        scope: scope(),
        actorUserId: adminId,
        kind: 'ImportEmployees',
        content: csv([
          `Kavya Reddy,E-601,Associate,Client Accounts,General,Access Admin,e-601@uboss.local,+91 90000 00003,${aadhaar('40218837551')}`,
          `Arun Mehta,E-602,Analyst,Client Accounts,General,Access Admin,e-602@uboss.local,+91 90000 00004,${aadhaar('29876543210')}`,
          ',,,,Nonexistent,Nobody,999',
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
          `Kavya Reddy,E-701,Associate,Client Accounts,General,Access Admin,e-701@uboss.local,+91 90000 00005,${aadhaar('40218837551')}`,
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
          `Kavya Reddy,E-801,Associate,Client Accounts,General,Access Admin,e-801@uboss.local,+91 90000 00006,${aadhaar('40218837551')}`,
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
          `Kavya Reddy,E-950,Associate,Client Accounts,General,Access Admin,e-950@uboss.local,+91 90000 00007,${aadhaar('40218837551')}`,
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
          `Kavya Reddy,E-960,Associate,Client Accounts,General,Access Admin,e-960@uboss.local,+91 90000 00008,${aadhaar('40218837551')}`,
        ]),
      });

      const otherOperations = await app
        .get(AccessRepository)
        .listBulkOperations(tenantScopeForPlatformOperation(otherTenantId));
      assert.equal(otherOperations.length, 0);
    });
  });

  // =========================================================================
  describe('roles and permissions, on the company plane', () => {
    /*
     * Role administration lived only on the platform-only `AuthorizationController` — an interim
     * `docs/IMPLEMENTATION_STATE.md` has carried since Prompt 8 ("the six route groups still
     * wait"). In the product that meant a Company Admin could invite, suspend and offboard, and
     * could grant capabilities, but could not give anybody a Role or a Scope without platform
     * staff. These routes run the same `RoleAdministrationService`, inside one company, with a
     * delegation ceiling on top.
     */
    const grant = (userId: string, body: Record<string, unknown>, uboss = adminUboss) =>
      as(agent().post(`/tenants/${tenantId}/access/people/${userId}/roles`), uboss).send(body);

    /*
     * These used to grant `Manager` and `Approver`.
     *
     * A company cannot grant either any more — not merely because the screen stopped offering
     * them, but because the route refuses them, which is what the test below this group asserts.
     * So they grant what a company does hand out.
     *
     * Each one takes a person of its own rather than reusing `employeeId`. Making that particular
     * employee a company administrator would hand them `users:ManageAccess`, and the test further
     * down that asserts an employee is refused outright would then be asserting nothing.
     */
    it('lets a company administrator grant a role and a scope', async () => {
      const subject = await addHierarchyPerson('Granted Admin', 'E-910', '29876543211', adminId);

      const response = await grant(subject.userId, {
        roleKind: 'CompanyAdmin',
        scopeKind: 'WholeCompany',
        justification: 'Taking over administration of the company.',
      }).expect(201);

      const body = response.body as { id: string };
      assert.ok(body.id, 'no assignment was returned');

      const listed = await as(
        agent().get(`/tenants/${tenantId}/access/people/${subject.userId}/roles`),
        adminUboss,
      ).expect(200);
      const assignments = (listed.body as { assignments: { roleKind: string }[] }).assignments;
      assert.ok(assignments.some((row) => row.roleKind === 'CompanyAdmin'));
    });

    it('records the grant as security activity, with who and why', async () => {
      const subject = await addHierarchyPerson('Recorded Grant', 'E-911', '29876543212', adminId);

      await grant(subject.userId, {
        roleKind: 'CompanyAdmin',
        scopeKind: 'WholeCompany',
        justification: 'Covering administration while the founder is away.',
      }).expect(201);

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findMany({
          where: { tenantId, action: 'security.role_assigned' },
        }),
      );
      assert.ok(events.length > 0, 'the grant was not recorded');
      assert.ok(events.every((event) => event.actorUserId === adminId));
    });

    it('refuses a scope wider than the role supports', async () => {
      const response = await grant(employeeId, {
        roleKind: 'Employee',
        scopeKind: 'WholeCompany',
      }).expect(400);

      assert.match((response.body as { message: string }).message, /widest it supports/i);
    });

    it('refuses a grant to a suspended account, and to an offboarded one', async () => {
      const subject = await addHierarchyPerson(
        'Suspended Subject',
        'E-901',
        '29876543210',
        adminId,
      );
      for (const state of ['Suspended', 'Offboarded'] as const) {
        await ctx.prisma.runAsPlatformOperation(() =>
          ctx.prisma.client.tenantMembership.updateMany({
            where: { tenantId, userId: subject.userId },
            data: { accountState: state },
          }),
        );

        const response = await grant(subject.userId, {
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
        }).expect(400);
        assert.match(
          (response.body as { message: string }).message,
          new RegExp(`account is ${state}`, 'i'),
        );
      }
    });

    it('refuses an administrator granting themselves anything', async () => {
      const response = await grant(adminId, {
        roleKind: 'CompanyAdmin',
        scopeKind: 'WholeCompany',
      }).expect(400);

      assert.match(
        (response.body as { message: string }).message,
        /cannot assign a role to yourself/i,
      );
    });

    it('revokes a role, and refuses an assignment id from another company', async () => {
      const subject = await addHierarchyPerson('Revoked Admin', 'E-912', '29876543213', adminId);
      const created = await grant(subject.userId, {
        roleKind: 'CompanyAdmin',
        scopeKind: 'WholeCompany',
      }).expect(201);
      const assignmentId = (created.body as { id: string }).id;

      // An assignment that exists, but in a company this administrator is not in.
      const foreign = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId: otherTenantId,
            userId: ownerId,
            roleKind: 'Employee',
            scopeKind: 'OwnWork',
            bootstrap: true,
          },
        }),
      );

      await as(
        agent().delete(`/tenants/${tenantId}/access/roles/${foreign.id}`),
        adminUboss,
      ).expect(404);

      const stillThere = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({ where: { id: foreign.id } }),
      );
      assert.equal(stillThere, 1, 'another company’s assignment was removed');

      await as(
        agent().delete(`/tenants/${tenantId}/access/roles/${assignmentId}`),
        adminUboss,
      ).expect(200);

      const gone = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({ where: { id: assignmentId } }),
      );
      assert.equal(gone, 0);
    });

    it('refuses somebody without ManageAccess outright', async () => {
      // A grantable role on purpose: a body that the validator would reject anyway would leave
      // this passing on ordering — guards run before pipes — rather than on the permission.
      await as(
        agent().post(`/tenants/${tenantId}/access/people/${employeeId}/roles`),
        employeeUboss,
      )
        .send({ roleKind: 'Employee', scopeKind: 'OwnWork' })
        .expect(403);
    });

    it('refuses a role a company no longer hands out, at the route and not only in the list', async () => {
      /*
       * The list had already narrowed to two roles; this route had not, so `roleKind: "Manager"`
       * posted straight at it still created an assignment. Nothing escalated — every retired role
       * is narrower than `CompanyAdmin`, which the caller already holds — but a company could end
       * up holding roles its own administrator was never shown, and no screen would explain them.
       *
       * All four retired roles, because it would be easy to fix one and leave the rest.
       */
      for (const roleKind of ['Manager', 'Head', 'Approver', 'Auditor'] as const) {
        const response = await grant(employeeId, {
          roleKind,
          scopeKind: 'TeamSubtree',
        }).expect(400);

        assert.match(
          JSON.stringify((response.body as { message: unknown }).message),
          /roleKind must be one of/i,
          `${roleKind} was not refused with a message naming the roles a company may grant`,
        );
      }

      const held = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.count({
          where: {
            tenantId,
            userId: employeeId,
            roleKind: { in: ['Manager', 'Head', 'Approver', 'Auditor'] },
          },
        }),
      );
      assert.equal(held, 0, 'a retired role reached the database');
    });

    /*
     * The delegation ceiling, asserted on the rule itself as well as through the route.
     *
     * Only a Company Admin holds `users:ManageAccess` among the built-in roles, so the interesting
     * case — an administrator who is NOT a company administrator — cannot be built from the
     * templates alone. The rule is what the route calls, and it is asserted directly so the
     * ceiling is defended rather than assumed to be unreachable.
     */
    it('bounds what a non-administrator may delegate by what they hold', () => {
      const roles = app.get(RoleAdministrationService);

      assert.equal(
        roles.delegationCeilingProblem({
          granterRoles: [{ roleKind: 'CompanyAdmin', scopeKind: 'WholeCompany' }],
          roleKind: 'Head',
          scopeKind: 'Department',
        }),
        null,
        'a company administrator may grant within their own company',
      );

      assert.match(
        roles.delegationCeilingProblem({
          granterRoles: [{ roleKind: 'Manager', scopeKind: 'TeamSubtree' }],
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
        }) ?? '',
        /do not hold the Company Admin role yourself/i,
      );

      assert.match(
        roles.delegationCeilingProblem({
          granterRoles: [{ roleKind: 'Head', scopeKind: 'Department' }],
          roleKind: 'Head',
          scopeKind: 'MultipleDepartments',
        }) ?? '',
        /delegated downwards, never widened/i,
      );
    });

    it('offers a company the two roles it hands out, and no others', async () => {
      /*
       * This asserted six or more, back when a company could grant `Manager`, `Head`,
       * `Approver` and `Auditor` as well.
       *
       * Those four existed to carry approvals between the administrator who defines work and the
       * employee who does it, and by the client's decision nothing sits between those two any
       * more. Offering a role whose whole purpose has gone would be offering somewhere for work
       * to stop for ever.
       *
       * The templates are not deleted — people already hold them, and their permissions still
       * have to be read — and the platform console still sees the whole catalogue for companies
       * provisioned before this. Only what a company may newly grant has narrowed.
       */
      const response = await as(
        agent().get(`/tenants/${tenantId}/access/roles`),
        adminUboss,
      ).expect(200);

      const body = response.body as { roles: { kind: string; youMayGrant: boolean }[] };
      const kinds = body.roles.map((role) => role.kind).sort();

      assert.deepEqual(kinds, ['CompanyAdmin', 'Employee']);
      assert.ok(
        body.roles.every((role) => role.youMayGrant),
        'a company administrator was told they may not grant something in their own company',
      );
    });
  });

  /**
   * The reset link an administrator sends on somebody else's behalf.
   *
   * The rule the client gave: an administrator may reset a password, and must never know it. So
   * these hold the two halves of that — the link goes out and the response carries no token, and
   * the case where there is no password yet is a refusal naming the invitation rather than a
   * cheerful success that sent nothing.
   */
  describe('sending a password reset', () => {
    it('refuses somebody who has never set a password, and names what to send instead', async () => {
      const person = await addHierarchyPerson('Never Activated', 'E-801', '40218837551', adminId);

      const response = await as(
        agent().post(`/tenants/${tenantId}/access/people/${person.userId}/password-reset`),
        adminUboss,
      ).expect(409);

      /*
       * The whole reason this is not one button that always says "Reset password". Everybody a
       * spreadsheet import creates is in exactly this state, and the reset service answers them
       * with silence.
       */
      assert.match(response.body.message, /never set a password/);
      assert.match(response.body.message, /invitation/);
    });

    it('refuses when there is nowhere to send it', async () => {
      const person = await addHierarchyPerson('No Address', 'E-802', '29876543210', adminId);

      /*
       * Put back the handle a person with no work address actually carries.
       *
       * `person-registry` synthesises `<uboss-id>@person.uboss.invalid` for somebody who is in
       * the org chart before anybody has an address for them — which is most of a spreadsheet
       * import. The fixture helper always supplies a real one, so this sets the real-world state
       * back deliberately.
       */
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.update({
          where: { id: person.userId },
          data: { email: 'ub-noaddr-0001@person.uboss.invalid' },
        }),
      );

      const response = await as(
        agent().post(`/tenants/${tenantId}/access/people/${person.userId}/password-reset`),
        adminUboss,
      ).expect(400);

      assert.match(response.body.message, /no work address/i);
    });

    it('refuses somebody who is not in this company', async () => {
      await as(
        agent().post(`/tenants/${tenantId}/access/people/${ownerId}/password-reset`),
        adminUboss,
      ).expect(404);
    });

    it('refuses an employee asking for a colleague', async () => {
      const person = await addHierarchyPerson('Somebody Else', 'E-803', '40218837551', adminId);

      await as(
        agent().post(`/tenants/${tenantId}/access/people/${person.userId}/password-reset`),
        employeeUboss,
      ).expect(403);
    });

    it('sends the link, says where it went, and hands back no token', async () => {
      const person = await addHierarchyPerson('Has A Password', 'E-804', '29876543210', adminId);

      // A credential, which is what turns "invite them" into "reset it" — the same thing
      // activation would have created.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.user.update({
          where: { id: person.userId },
          data: { email: 'has.a.password@access.example' },
        }),
      );
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.userCredential.create({
          data: { userId: person.userId, passwordHash: 'argon2id$fixture' },
        }),
      );

      const response = await as(
        agent().post(`/tenants/${tenantId}/access/people/${person.userId}/password-reset`),
        adminUboss,
      ).expect(201);

      assert.equal(response.body.sent, true);
      assert.equal(response.body.email, 'has.a.password@access.example');
      // Nothing resembling a credential comes back to the administrator. This is the property
      // the whole design exists for: they can start a reset, and cannot learn the password.
      assert.equal(response.body.token, undefined);
      assert.equal(JSON.stringify(response.body).includes('token'), false);

      const trail = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'access.password_reset_sent' },
        }),
      );
      assert.ok(trail, 'the reset should be on the audit trail');
      assert.equal((trail!.metadata as { subjectUserId?: string }).subjectUserId, person.userId);
      // The address is recorded so a reviewer can see where it went; the token never is.
      assert.equal(JSON.stringify(trail!.metadata).includes('token'), false);
    });
  });
});
