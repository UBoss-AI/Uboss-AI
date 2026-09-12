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
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
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
import { OrganizationController } from '../src/organization/organization.controller.js';
import { PersonRegistryService } from '../src/organization/person-registry.service.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import {
  maskedAadhaar,
  normaliseAadhaar,
  verhoeffCheckDigit,
  verhoeffIsValid,
} from '../src/organization/aadhaar.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
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

/** Build a checksum-valid twelve-digit number from an eleven-digit body. */
function aadhaar(body: string): string {
  return `${body}${verhoeffCheckDigit(body)}`;
}

const AADHAAR = {
  top: aadhaar('40218837551'),
  middle: aadhaar('29876543210'),
  bottom: aadhaar('78901234567'),
  fresh: aadhaar('55512345678'),
  second: aadhaar('66678901234'),
};

/**
 * Hierarchy, departments, reporting relationships and the global person registry.
 *
 * Five properties carry this prompt:
 *
 *   1. **The reporting tree is separate from department membership**, and both are visible.
 *   2. **A cycle is impossible** — refused by the service with an explanation, and by a database
 *      trigger regardless of the code path.
 *   3. **`TeamSubtree` authorization now resolves**, closing the limitation that stood from
 *      Prompt 7 to Prompt 11.
 *   4. **Aadhaar is a match input and nothing else**: never stored, never verified, never the
 *      UBoss Unique ID, and never visible to somebody who should not see it.
 *   5. **Exactly six mandatory Add Employee fields**, and adding somebody **does not invite** them.
 */
describe('organization hierarchy (e2e)', () => {
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
  let secondDepartmentId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const departments = () => app.get(DepartmentService);
  const employment = () => app.get(EmploymentService);
  const hierarchy = () => app.get(HierarchyService);
  const organization = () => app.get(OrganizationRepository);
  const authorization = () => app.get(AuthorizationService);

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
      controllers: [OrganizationController],
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
        // The whole point of Prompt 12 for the authorization engine: the resolver it declared
        // and deliberately left unprovided is now registered.
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
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
      slug: 'org-co',
      name: 'Org Co',
      firstMember: { email: 'first@org.example', displayName: 'First Person' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-org-co',
      name: 'Other Org Co',
      firstMember: { email: 'first@other-org.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@org.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-OADM-0001', 'Org Admin'),
        manager: await member('UB-OMGR-0001', 'Org Manager'),
        employee: await member('UB-OEMP-0001', 'Org Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OOWN-0001',
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

      // Two departments, created by hand.
      //
      // `TenantProvisioningService` is the *narrow* primitive — it creates a tenant, a person
      // and a membership and nothing else, which is why the Prompt 10 suite asserts it creates
      // no setup checklist either. The `General` department comes from the Create Company
      // *wizard*, and a fixture that leaned on it would be testing the wizard by accident.
      const general = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'General', code: 'GEN' },
      });
      departmentId = general.id;

      const second = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Regulatory Affairs', code: 'REG', sortOrder: 10 },
      });
      secondDepartmentId = second.id;

      // The other company needs one too, for the cross-company tests.
      await ctx.prisma.client.department.create({
        data: { tenantId: otherTenantId, name: 'General', code: 'GEN' },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** Add the three-level chain the subtree tests need: admin → manager → employee. */
  const buildChain = async () => {
    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: adminId,
          employeeId: 'E-001',
          designation: 'Managing Director',
          departmentId,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: managerId,
          employeeId: 'E-002',
          designation: 'Head, Regulatory Affairs',
          departmentId: secondDepartmentId,
          reportingManagerUserId: adminId,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: employeeId,
          employeeId: 'E-003',
          designation: 'Regulatory Associate',
          departmentId: secondDepartmentId,
          reportingManagerUserId: managerId,
        },
      });
    });
  };

  // =========================================================================
  describe('Aadhaar is normalised and format-checked, never verified', () => {
    it('accepts twelve digits with or without separators, and normalises them', () => {
      const spaced = normaliseAadhaar(
        `${AADHAAR.top.slice(0, 4)} ${AADHAAR.top.slice(4, 8)} ${AADHAAR.top.slice(8)}`,
      );
      const plain = normaliseAadhaar(AADHAAR.top);

      assert.ok(spaced.ok && plain.ok);
      // Both must produce the same normalised value, or the same person entered twice with
      // different spacing becomes two people.
      assert.equal(spaced.value.normalised, plain.value.normalised);
      assert.equal(spaced.value.lastFour, AADHAAR.top.slice(-4));
    });

    it('rejects the wrong length, a bad leading digit, a repeated digit and a bad checksum', () => {
      for (const [input, reason] of [
        ['12345', 'not-twelve-digits'],
        ['012345678901', 'invalid-leading-digit'],
        ['999999999999', 'repeated-digit'],
        // A valid number with its last digit changed.
        [
          `${AADHAAR.top.slice(0, 11)}${(Number(AADHAAR.top.slice(11)) + 1) % 10}`,
          'checksum-failed',
        ],
      ] as const) {
        const result = normaliseAadhaar(input);
        assert.equal(result.ok, false, `"${input}" must be rejected`);
        assert.equal(result.ok === false && result.reason, reason);
      }
    });

    it('catches every single-digit error and adjacent transposition', () => {
      // The property Verhoeff is chosen for, and the reason a plain modulus check would not do.
      const valid = AADHAAR.middle;
      assert.ok(verhoeffIsValid(valid));

      for (let position = 0; position < 12; position += 1) {
        const digits = valid.split('');
        digits[position] = String((Number(digits[position]) + 5) % 10);
        assert.equal(verhoeffIsValid(digits.join('')), false, `digit ${position} must be caught`);
      }

      for (let position = 0; position < 11; position += 1) {
        const digits = valid.split('');
        if (digits[position] === digits[position + 1]) {
          continue;
        }
        [digits[position], digits[position + 1]] = [digits[position + 1]!, digits[position]!];
        assert.equal(
          verhoeffIsValid(digits.join('')),
          false,
          `transposition at ${position} must be caught`,
        );
      }
    });

    it('masks to exactly the reference format', () => {
      assert.equal(maskedAadhaar('5510'), 'XXXX XXXX 5510');
      assert.equal(maskedAadhaar(null), null);
    });
  });

  // =========================================================================
  describe('departments', () => {
    it('lists this company’s departments', async () => {
      const list = await departments().list(scope(), adminId);
      assert.deepEqual(
        list.map((department) => department.name),
        // Sorted by `sortOrder` then name, which is what puts Regulatory Affairs first.
        ['Regulatory Affairs', 'General'],
      );
    });

    it('creates a department tree', async () => {
      const child = await departments().create({
        scope: scope(),
        actorUserId: adminId,
        name: 'Regulatory Submissions',
        parentDepartmentId: secondDepartmentId,
      });
      assert.equal(child.parentDepartmentId, secondDepartmentId);
    });

    it('refuses a duplicate name', async () => {
      await assert.rejects(
        () =>
          departments().create({
            scope: scope(),
            actorUserId: adminId,
            name: 'regulatory affairs',
          }),
        /already has a department called/i,
      );
    });

    it('refuses a parent from another company', async () => {
      const foreign = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.department.create({
          data: { tenantId: otherTenantId, name: 'Foreign Department' },
        }),
      );

      await assert.rejects(
        () =>
          departments().create({
            scope: scope(),
            actorUserId: adminId,
            name: 'Should Not Exist',
            parentDepartmentId: foreign.id,
          }),
        /does not exist in this company/i,
      );
    });

    it('refuses to re-parent a department under its own descendant', async () => {
      const child = await departments().create({
        scope: scope(),
        actorUserId: adminId,
        name: 'Submissions',
        parentDepartmentId: secondDepartmentId,
      });

      await assert.rejects(
        () =>
          departments().update({
            scope: scope(),
            actorUserId: adminId,
            departmentId: secondDepartmentId,
            parentDepartmentId: child.id,
          }),
        /detach the branch/i,
      );
    });

    it('refuses to archive a department that still has people in it', async () => {
      await buildChain();

      await assert.rejects(
        () =>
          departments().archive({
            scope: scope(),
            actorUserId: adminId,
            departmentId: secondDepartmentId,
            reason: 'Reorganising the company.',
          }),
        /still employed/i,
      );
    });

    it('archives an empty department without deleting it', async () => {
      const spare = await departments().create({
        scope: scope(),
        actorUserId: adminId,
        name: 'Spare',
      });

      await departments().archive({
        scope: scope(),
        actorUserId: adminId,
        departmentId: spare.id,
        reason: 'Never used.',
      });

      const live = await departments().list(scope(), adminId, false);
      const all = await departments().list(scope(), adminId, true);
      assert.ok(!live.some((department) => department.id === spare.id));
      // Archived, not deleted — historical employment must keep resolving to a named department.
      assert.ok(all.some((department) => department.id === spare.id));

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'hierarchy.department_archived',
          take: 5,
        }),
      );
      assert.equal((events[0]?.metadata as { nothingDeleted: boolean }).nothingDeleted, true);
    });

    it('needs hierarchy:Administer to create one', async () => {
      await as(agent().post(`/tenants/${tenantId}/organization/departments`), employeeUboss)
        .send({ name: 'Employee Made This' })
        .expect(403);
    });

    it('never shows one company another’s departments', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.department.create({
          data: { tenantId: otherTenantId, name: 'Secret Department' },
        }),
      );

      const list = await departments().list(scope(), adminId, true);
      assert.ok(!list.some((department) => department.name === 'Secret Department'));
    });
  });

  // =========================================================================
  describe('Add Employee — six mandatory fields, no invitation', () => {
    it('serves exactly the six mandatory field keys', async () => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/organization/employee-fields`),
        adminUboss,
      ).expect(200);

      const body = response.body as { mandatory: { key: string }[]; note: string };
      assert.deepEqual(
        body.mandatory.map((field) => field.key),
        [
          'employeeName',
          'employeeId',
          'designation',
          'departmentId',
          'reportingManagerUserId',
          'aadhaarNumber',
        ],
      );
      assert.match(body.note, /no OTP, no verification/i);
    });

    it('adds the first employee with no reporting manager, and creates a permanent UBoss ID', async () => {
      const result = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      assert.match(result.ubossUniqueId, /^UB-/);
      assert.equal(result.matchedExistingPerson, false);
      assert.equal(result.aadhaarMasked, `XXXX XXXX ${AADHAAR.top.slice(-4)}`);
      assert.equal(result.aadhaarAssurance, 'EnteredOnly');
      // The client's rule: adding somebody to the hierarchy does not invite them.
      assert.equal(result.invitationSent, false);
    });

    it('leaves the new person unable to sign in', async () => {
      const result = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({
          where: { tenantId, userId: result.userId },
        }),
      );
      const credential = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.userCredential.findFirst({ where: { userId: result.userId } }),
      );
      const invitation = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.findFirst({ where: { tenantId, userId: result.userId } }),
      );

      // Known to the company, no account, no invitation, no password.
      assert.equal(membership?.accountState, 'NotInvited');
      assert.equal(credential, null);
      assert.equal(invitation, null);
    });

    it('never stores the Aadhaar number anywhere', async () => {
      await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      // Search every text-ish column of every table that could plausibly hold it. The number
      // must not appear anywhere — not in an identifier row, not in an audit event's metadata,
      // not in a security event's reason.
      const hits = await ctx.admin.unsafeRootClient.$queryRawUnsafe<{ hits: bigint }[]>(
        `SELECT (
           (SELECT count(*) FROM person_identifiers
             WHERE match_hash LIKE $1 OR match_key_id LIKE $1 OR COALESCE(last_four,'') = $1)
           + (SELECT count(*) FROM audit_events WHERE COALESCE(metadata::text,'') LIKE $2
                OR COALESCE(summary,'') LIKE $2 OR COALESCE(reason,'') LIKE $2)
           + (SELECT count(*) FROM security_events WHERE COALESCE(metadata::text,'') LIKE $2
                OR COALESCE(reason,'') LIKE $2)
           + (SELECT count(*) FROM users WHERE display_name LIKE $2 OR email LIKE $2)
           + (SELECT count(*) FROM employment_records WHERE employee_id LIKE $2
                OR designation LIKE $2 OR COALESCE(work_phone,'') LIKE $2)
         ) AS hits`,
        AADHAAR.top,
        `%${AADHAAR.top}%`,
      );

      assert.equal(Number(hits[0]?.hits ?? 0), 0, 'The Aadhaar number must appear nowhere.');
    });

    it('stores a keyed digest and only the last four digits', async () => {
      const result = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      const identifier = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.personIdentifier.findFirst({ where: { userId: result.userId } }),
      );

      assert.match(identifier!.matchHash, /^[0-9a-f]{64}$/);
      assert.equal(identifier!.lastFour, AADHAAR.top.slice(-4));
      // There is no `Verified` value in the enum, so this can only be one of two things.
      assert.ok(['EnteredOnly', 'NotVerified'].includes(identifier!.assurance));
      assert.ok(identifier!.matchKeyId.length > 0);
    });

    it('links the same person to one UBoss Unique ID across two companies', async () => {
      const first = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      // The same human, entered by a different company, with a different Employee ID.
      const otherScope = tenantScopeForPlatformOperation(otherTenantId);
      const otherDepartment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.department.findFirst({ where: { tenantId: otherTenantId } }),
      );
      await ctx.prisma.runAsPlatformOperation(async () => {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId: otherTenantId,
            userId: adminId,
            roleKind: 'CompanyAdmin',
            scopeKind: 'WholeCompany',
            grantedByUserId: ownerId,
          },
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: otherTenantId, userId: adminId, accountState: 'Active' },
        });
      });

      const second = await employment().addEmployee({
        scope: otherScope,
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'OTHER-77',
        designation: 'Consultant',
        departmentId: otherDepartment!.id,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      // One permanent identity, two employment records, two company Employee IDs.
      assert.equal(second.matchedExistingPerson, true);
      assert.equal(second.ubossUniqueId, first.ubossUniqueId);
      assert.equal(second.userId, first.userId);
      assert.notEqual(second.employeeId, first.employeeId);
    });

    it('does not tell a matching company where else that person works', async () => {
      await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      const match = await app.get(PersonRegistryService);
      const result = await ctx.prisma.runAsPlatformOperation(() =>
        match.matchOrCreateWithinCurrentScope({
          tenantId: otherTenantId,
          actorUserId: adminId,
          employeeName: 'Priya Nair',
          aadhaarNumber: AADHAAR.top,
        }),
      );

      // The response is a decision plus a permanent id. Nothing about employers.
      const serialised = JSON.stringify(result);
      assert.equal(result.matched, true);
      assert.doesNotMatch(serialised, /Org Co|employment|tenant/i);
      assert.deepEqual(Object.keys(result).sort(), [
        'aadhaarMasked',
        'matched',
        'matchedOn',
        'ubossUniqueId',
        'userId',
      ]);
    });

    it('refuses a second person with no reporting manager', async () => {
      await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      await assert.rejects(
        () =>
          employment().addEmployee({
            scope: scope(),
            actorUserId: adminId,
            employeeName: 'Second Root',
            employeeId: 'E-1102',
            designation: 'Consultant',
            departmentId: secondDepartmentId,
            reportingManagerUserId: null,
            aadhaarNumber: AADHAAR.middle,
          }),
        /Reporting Manager is required/i,
      );
    });

    it('refuses a duplicate company Employee ID', async () => {
      await buildChain();

      await assert.rejects(
        () =>
          employment().addEmployee({
            scope: scope(),
            actorUserId: adminId,
            employeeName: 'Clash',
            employeeId: 'E-002',
            designation: 'Associate',
            departmentId: secondDepartmentId,
            reportingManagerUserId: managerId,
            aadhaarNumber: AADHAAR.fresh,
          }),
        /already used in this company/i,
      );
    });

    it('refuses a reporting manager who is not employed here', async () => {
      await buildChain();
      const outsider = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.createForPlatform({
          ubossUniqueId: 'UB-OUTS-0001',
          email: 'outsider@elsewhere.example',
          displayName: 'Outsider',
        }),
      );

      await assert.rejects(
        () =>
          employment().addEmployee({
            scope: scope(),
            actorUserId: adminId,
            employeeName: 'Reports To Nobody Here',
            employeeId: 'E-999',
            designation: 'Associate',
            departmentId: secondDepartmentId,
            reportingManagerUserId: outsider.id,
            aadhaarNumber: AADHAAR.fresh,
          }),
        /must already be employed by this company/i,
      );
    });

    it('rejects a malformed Aadhaar at the request layer', async () => {
      await as(agent().post(`/tenants/${tenantId}/organization/employees`), adminUboss)
        .send({
          employeeName: 'Bad Number',
          employeeId: 'E-500',
          designation: 'Associate',
          departmentId: secondDepartmentId,
          aadhaarNumber: 'not-a-number',
        })
        .expect(400);
    });

    it('rejects a checksum-invalid Aadhaar with an explanation that does not claim verification', async () => {
      const broken = `${AADHAAR.top.slice(0, 11)}${(Number(AADHAAR.top.slice(11)) + 3) % 10}`;
      const response = await as(
        agent().post(`/tenants/${tenantId}/organization/employees`),
        adminUboss,
      )
        .send({
          employeeName: 'Typo',
          employeeId: 'E-501',
          designation: 'Associate',
          departmentId: secondDepartmentId,
          aadhaarNumber: broken,
        })
        .expect(400);

      assert.match(JSON.stringify(response.body), /does not verify Aadhaar/i);
    });

    it('needs hierarchy:Administer', async () => {
      await as(agent().post(`/tenants/${tenantId}/organization/employees`), employeeUboss)
        .send({
          employeeName: 'Sneaky',
          employeeId: 'E-666',
          designation: 'Associate',
          departmentId: secondDepartmentId,
          aadhaarNumber: AADHAAR.fresh,
        })
        .expect(403);
    });

    it('has no invite route at all', async () => {
      // The client's rule: the invitation source is Settings → Users & Access, and a hierarchy
      // node must not carry the primary Invite button. Asserted as the absence of a route.
      for (const path of [
        `/tenants/${tenantId}/organization/employees/${employeeId}/invite`,
        `/tenants/${tenantId}/organization/invite`,
      ]) {
        const response = await as(agent().post(path), adminUboss).send({});
        assert.notEqual(response.status, 200, `${path} must not exist`);
        assert.notEqual(response.status, 201, `${path} must not exist`);
      }
    });
  });

  // =========================================================================
  describe('the reporting tree', () => {
    it('groups people by department and nests them by manager', async () => {
      await buildChain();
      const view = await hierarchy().viewFor(scope(), adminId);

      assert.equal(view.tree.kind, 'company');
      assert.equal(view.tree.name, 'Org Co');

      const regulatory = view.tree.children.find((node) => node.name === 'Regulatory Affairs');
      assert.ok(regulatory);
      // The manager's own manager is in another department, so the manager is a root *here* —
      // which is what shows a cross-department reporting line instead of hiding the person.
      assert.equal(regulatory!.children.length, 1);
      assert.equal(regulatory!.children[0]?.person?.employeeId, 'E-002');
      assert.equal(regulatory!.children[0]?.children[0]?.person?.employeeId, 'E-003');
    });

    it('serves the list view with the reference’s columns', async () => {
      await buildChain();
      const view = await hierarchy().viewFor(scope(), adminId);

      const row = view.list.find((candidate) => candidate.employeeId === 'E-003');
      assert.ok(row);
      assert.equal(row!.designation, 'Regulatory Associate');
      assert.equal(row!.departmentName, 'Regulatory Affairs');
      assert.equal(row!.reportingManagerName, 'Org Manager');
      assert.match(row!.ubossUniqueId, /^UB-/);
    });

    it('displays the company Vision and Mission above the structure', async () => {
      await hierarchy().updateCompanyIdentity({
        scope: scope(),
        actorUserId: adminId,
        vision: 'Make regulated manufacturing effortless.',
        mission: 'Ship every submission on time, first time.',
      });

      const view = await hierarchy().viewFor(scope(), adminId);
      assert.equal(view.company.vision, 'Make regulated manufacturing effortless.');
      assert.equal(view.company.mission, 'Ship every submission on time, first time.');
    });

    it('needs settings:Administer to change the Vision', async () => {
      await assert.rejects(
        () =>
          hierarchy().updateCompanyIdentity({
            scope: scope(),
            actorUserId: employeeId,
            vision: 'My own vision.',
          }),
        /(forbidden|not allowed|cannot)/i,
      );
    });

    it('moves somebody to a new manager', async () => {
      await buildChain();

      await hierarchy().changeReportingManager({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        newManagerUserId: adminId,
        reason: 'Interim reporting while the head is on leave.',
      });

      const record = await organization().findEmployment(scope(), employeeId);
      assert.equal(record?.reportingManagerUserId, adminId);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'hierarchy.reporting_manager_changed',
          take: 5,
        }),
      );
      assert.equal(events[0]?.reason, 'Interim reporting while the head is on leave.');
    });

    it('refuses a move that would close a loop, and records the refusal', async () => {
      await buildChain();

      // admin → manager → employee. Making the admin report to the employee closes the loop.
      await assert.rejects(
        () =>
          hierarchy().changeReportingManager({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: adminId,
            newManagerUserId: employeeId,
          }),
        /circular/i,
      );

      const blocked = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.reporting_cycle_blocked',
          take: 5,
        }),
      );
      // The refusal must survive the exception that caused it — the Prompt 8 and 11 lesson.
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]?.outcome, 'Blocked');
    });

    it('refuses self-management', async () => {
      await buildChain();
      await assert.rejects(
        () =>
          hierarchy().changeReportingManager({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
            newManagerUserId: employeeId,
          }),
        /cannot report to themselves/i,
      );
    });

    it('refuses a cycle in the database even when the service is bypassed', async () => {
      await buildChain();

      // Straight at the table as the owner role, with no service in the way. The trigger is the
      // guarantee; the service message is the courtesy.
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `UPDATE employment_records SET reporting_manager_user_id = $1
              WHERE tenant_id = $2 AND user_id = $3`,
            employeeId,
            tenantId,
            adminId,
          ),
        /cycle in the reporting tree/i,
      );
    });

    it('supports many levels', async () => {
      await buildChain();

      // Twenty more levels beneath the employee. "Practical unlimited levels" tested rather than
      // asserted, and well past any real organisation's depth.
      let manager = employeeId;
      for (let level = 0; level < 20; level += 1) {
        const person = await employment().addEmployee({
          scope: scope(),
          actorUserId: adminId,
          employeeName: `Level ${level}`,
          employeeId: `E-L${level}`,
          designation: 'Associate',
          departmentId: secondDepartmentId,
          reportingManagerUserId: manager,
          // An eleven-digit body plus a computed check digit, distinct per level. Built rather
          // than hard-coded so the numbers are guaranteed checksum-valid and unique.
          aadhaarNumber: aadhaar(`3${String(level).padStart(2, '0')}00000000`),
        });
        manager = person.userId;
      }

      const subtree = await organization().reportingSubtreeUserIds({
        tenantId,
        managerUserId: adminId,
      });
      // Three from the chain plus twenty more.
      assert.equal(subtree.length, 23);
    });

    it('detaches somebody from their manager', async () => {
      await buildChain();
      await hierarchy().changeReportingManager({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        newManagerUserId: null,
        reason: 'Awaiting a new reporting line after the reorganisation.',
      });

      const record = await organization().findEmployment(scope(), employeeId);
      assert.equal(record?.reportingManagerUserId, null);
    });

    it('needs hierarchy:Administer to move anybody', async () => {
      await buildChain();
      await as(
        agent().post(`/tenants/${tenantId}/organization/employees/${employeeId}/reporting-manager`),
        employeeUboss,
      )
        .send({ newManagerUserId: adminId })
        .expect(403);
    });
  });

  // =========================================================================
  describe('TeamSubtree authorization, which this prompt makes work', () => {
    it('resolves the subtree instead of refusing to evaluate it', async () => {
      await buildChain();

      const context = await authorization().contextFor(scope(), managerId);
      const decision = await authorization().authorize(context, {
        module: 'todo',
        action: 'View',
        resource: { id: 'task-1', ownerUserId: employeeId },
      });

      // Before Prompt 12 this was `scope-unevaluable` — limitation 6, open since Prompt 7.
      assert.equal(decision.allowed, true);
      assert.notEqual(decision.reason, 'scope-unevaluable');
    });

    it('refuses a resource owned by somebody outside the manager’s team', async () => {
      await buildChain();
      // The admin is *above* the manager, so the admin's own work is not in the manager's team.
      const context = await authorization().contextFor(scope(), managerId);
      const decision = await authorization().authorize(context, {
        module: 'todo',
        action: 'View',
        resource: { id: 'task-2', ownerUserId: adminId },
      });

      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, 'out-of-scope');
    });

    it('includes the manager’s own work in their subtree', async () => {
      await buildChain();
      const context = await authorization().contextFor(scope(), managerId);
      const decision = await authorization().authorize(context, {
        module: 'todo',
        action: 'View',
        resource: { id: 'task-3', ownerUserId: managerId },
      });
      assert.equal(decision.allowed, true);
    });

    it('does not reach across companies', async () => {
      await buildChain();
      // The same person id, asked about in the other company where no reporting tree links them.
      const inScope = await organization().isInReportingSubtree({
        tenantId: otherTenantId,
        managerUserId: managerId,
        subjectUserId: employeeId,
      });
      assert.equal(inScope, false);
    });

    it('answers false when the tree has no employment records at all', async () => {
      // Fail-closed: an authorization question about a company with no hierarchy is "no",
      // never "yes by default".
      const inScope = await organization().isInReportingSubtree({
        tenantId,
        managerUserId: managerId,
        subjectUserId: employeeId,
      });
      assert.equal(inScope, false);
    });
  });

  // =========================================================================
  describe('who may see what', () => {
    it('lets an ordinary employee see the structure', async () => {
      await buildChain();
      const response = await as(
        agent().get(`/tenants/${tenantId}/organization/hierarchy`),
        employeeUboss,
      ).expect(200);

      const body = response.body as { list: unknown[]; employeeCount: number };
      assert.equal(body.employeeCount, 3);
    });

    it('withholds the masked identifier from an ordinary employee', async () => {
      await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });
      await buildChain();

      const employeeView = await hierarchy().viewFor(scope(), employeeId);
      const adminView = await hierarchy().viewFor(scope(), adminId);

      assert.equal(employeeView.identifiersVisible, false);
      assert.equal(adminView.identifiersVisible, true);

      // Withheld by omission, so a screen cannot render a blank as "no identifier on record".
      const asEmployee = employeeView.list.find((row) => row.employeeId === 'E-1101');
      const asAdmin = adminView.list.find((row) => row.employeeId === 'E-1101');
      assert.ok(!('aadhaarMasked' in (asEmployee as object)));
      assert.equal(asAdmin?.aadhaarMasked, `XXXX XXXX ${AADHAAR.top.slice(-4)}`);
    });

    it('shows a person their own masked identifier', async () => {
      await buildChain();
      const own = await employment().profileFor({
        scope: scope(),
        actorUserId: employeeId,
        subjectUserId: employeeId,
      });
      assert.equal(own['identifierVisible'], true);
    });

    it('never returns an Aadhaar assurance of Verified', async () => {
      await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      const rows = await organization().listHierarchy(scope());
      const profile = await employment().profileFor({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: rows.find((row) => row.employeeId === 'E-1101')!.userId,
      });

      assert.equal(profile['aadhaarAssurance'], 'EnteredOnly');

      // Narrowly: no field may carry `Verified` as a *value*, and no text may claim verified
      // status. The deliberate reassurance "is not verified" must survive — banning the word
      // outright would forbid the sentence that makes the position clear, which is the same
      // over-broad assertion that had to be narrowed at Prompt 10 for "password".
      const serialised = JSON.stringify(profile);
      assert.doesNotMatch(serialised, /"[Vv]erified"/);
      assert.doesNotMatch(serialised, /(?<!not )verified (aadhaar|identity)/i);
      assert.doesNotMatch(serialised, /aadhaar (is )?verified/i);
      assert.match(String(profile['identityNote']), /not verified/i);
    });

    it('keeps the Company Employee ID and the UBoss Unique ID distinct', async () => {
      const result = await employment().addEmployee({
        scope: scope(),
        actorUserId: adminId,
        employeeName: 'Priya Nair',
        employeeId: 'E-1101',
        designation: 'Head, Regulatory Affairs',
        departmentId: secondDepartmentId,
        reportingManagerUserId: null,
        aadhaarNumber: AADHAAR.top,
      });

      assert.notEqual(result.employeeId, result.ubossUniqueId);
      // And the permanent ID is not derived from the entered identifier in any way.
      assert.ok(!result.ubossUniqueId.includes(AADHAAR.top.slice(-4)));
    });

    it('never shows one company another’s employment records', async () => {
      await buildChain();
      const rows = await organization().listHierarchy(
        tenantScopeForPlatformOperation(otherTenantId),
      );
      assert.equal(rows.length, 0);
    });
  });

  // =========================================================================
  describe('editing employment', () => {
    it('updates this company’s fields', async () => {
      await buildChain();
      await employment().updateEmployment({
        scope: scope(),
        actorUserId: adminId,
        subjectUserId: employeeId,
        designation: 'Senior Regulatory Associate',
        departmentId,
      });

      const record = await organization().findEmployment(scope(), employeeId);
      assert.equal(record?.designation, 'Senior Regulatory Associate');
      assert.equal(record?.departmentId, departmentId);
    });

    it('cannot change the person’s portable identity', async () => {
      await buildChain();
      // There is no field for it in the DTO, so the request layer rejects an attempt outright.
      await as(agent().put(`/tenants/${tenantId}/organization/employees/${employeeId}`), adminUboss)
        .send({ ubossUniqueId: 'UB-HACK-0001', displayName: 'Renamed' })
        .expect(400);
    });

    it('refuses a duplicate Employee ID on edit', async () => {
      await buildChain();
      await assert.rejects(
        () =>
          employment().updateEmployment({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
            employeeId: 'E-001',
          }),
        /already used in this company/i,
      );
    });

    it('refuses moving somebody into an archived department', async () => {
      await buildChain();
      const spare = await departments().create({
        scope: scope(),
        actorUserId: adminId,
        name: 'Closing Down',
      });
      await departments().archive({
        scope: scope(),
        actorUserId: adminId,
        departmentId: spare.id,
        reason: 'No longer used.',
      });

      await assert.rejects(
        () =>
          employment().updateEmployment({
            scope: scope(),
            actorUserId: adminId,
            subjectUserId: employeeId,
            departmentId: spare.id,
          }),
        /archived/i,
      );
    });
  });
});
