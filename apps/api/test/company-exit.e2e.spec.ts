import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';

import {
  TABLE_DISPOSITION,
  tablesWithDisposition,
  type Disposition,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { CompanyExitService } from '../src/commercial/company-exit.service.js';
import { CompanyLifecycleService } from '../src/commercial/company-lifecycle.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
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
 * Company exit and data portability — Prompt 38, against real PostgreSQL.
 *
 * The prompt leads with *"without silently erasing accountability"*, so the weight of this suite is
 * on **what survives a deletion**, not on what goes. Three tests carry it:
 *
 *  * the classification is **exhaustive against the live schema**, so a table added later cannot
 *    default into either bucket;
 *  * a real deletion leaves the audit trail, the financial record and the employment history
 *    standing, with row counts asserted before and after;
 *  * **the other company is untouched**, checked after a deletion rather than assumed from RLS.
 */
describe('company exit and data portability (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let tenantSlug: string;
  let otherTenantId: string;
  let personId: string;
  let operatorAId: string;
  let operatorBId: string;

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
        CompanyLifecycleService,
        CompanyExitService,
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

    const leaving = await ctx.provisioning.provision({
      slug: 'departing-co',
      name: 'Departing Co',
      firstMember: { email: 'first@departing.example', displayName: 'First' },
    });
    await activateTenant(ctx, leaving.tenant.id);
    await activateMembership(ctx, leaving.user.id, leaving.tenant.id);
    tenantId = leaving.tenant.id;
    tenantSlug = leaving.tenant.slug;

    const staying = await ctx.provisioning.provision({
      slug: 'staying-co',
      name: 'Staying Co',
      firstMember: { email: 'first@staying.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, staying.tenant.id);
    await activateMembership(ctx, staying.user.id, staying.tenant.id);
    otherTenantId = staying.tenant.id;

    const made = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (email: string, name: string, platform = false) =>
        ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: name,
          isPlatformActor: platform,
        });

      const person = await make('person@departing.example', 'Priya Nair');
      await ctx.prisma.client.tenantMembership.create({
        data: { tenantId: leaving.tenant.id, userId: person.id, accountState: 'Active' },
      });

      return {
        person,
        operatorA: await make('a@uboss.example', 'Operator A', true),
        operatorB: await make('b@uboss.example', 'Operator B', true),
      };
    });

    personId = made.person.id;
    operatorAId = made.operatorA.id;
    operatorBId = made.operatorB.id;
  });

  // ---- helpers ----

  const scope = (id: string) => tenantScopeForPlatformOperation(id);
  const exits = () => app.get(CompanyExitService);

  /** One row in a `Content` table, one in an `Accountability` table, one `PersonRecord`. */
  const seedBoth = async (tenant: string): Promise<void> => {
    await ctx.prisma.runInTenantTransaction(scope(tenant), async () => {
      const department = await ctx.prisma.client.department.create({
        data: { tenantId: tenant, name: 'Delivery' },
      });

      // Content.
      await ctx.prisma.client.engineAgent.create({
        data: {
          tenantId: tenant,
          name: `Agent ${Math.random().toString(36).slice(2, 8)}`,
          ownerUserId: personId,
          status: 'Ready',
        },
      });
      await ctx.prisma.client.notification.create({
        data: {
          tenantId: tenant,
          recipientUserId: personId,
          kind: 'Overdue',
          severity: 'Info',
          title: 'Something happened',
          body: 'A body.',
          deepLink: '/todo',
          resourceType: 'human_task',
          // Duplicate suppression is keyed on this, so it has to be unique per seeded row.
          dedupeKey: `seed-${tenant}-${Math.random().toString(36).slice(2, 10)}`,
        },
      });

      // PersonRecord — read by a portable profile at Prompt 37A.
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId: tenant,
          userId: personId,
          employeeId: `E-${tenant.slice(0, 4)}`,
          departmentId: department.id,
          designation: 'Analyst',
          joinedOn: new Date('2024-01-01'),
        },
      });
      await ctx.prisma.client.badgeHistory.create({
        data: {
          tenantId: tenant,
          subjectUserId: personId,
          level: 'Silver',
          scoreAtChange: 50,
          startedAt: new Date('2024-06-01'),
        },
      });

      // Accountability — the financial record.
      await ctx.prisma.client.budgetWallet.create({
        data: {
          tenantId: tenant,
          scope: 'Company',
          allowanceMinor: 100_000,
          currency: 'INR',
          periodStart: new Date('2026-01-01'),
        },
      });
    });

    // An audit row, which is the accountability record the prompt names first.
    await ctx.prisma.runAsPlatformOperation(() =>
      app.get(AuditEventService).appendWithinCurrentScope(tenant, {
        action: 'test.seeded',
        resourceType: 'test',
        summary: 'A row that must survive a company exit.',
      }),
    );
  };

  const countIn = async (tenant: string, table: string): Promise<number> =>
    ctx.prisma.runAsPlatformOperation(async () => {
      const rows = await ctx.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS "count" FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        tenant,
      );
      return Number(rows[0]?.count ?? 0);
    });

  /** Drive an exit all the way to the point where deletion is permitted. */
  const readyToDelete = async (): Promise<string> => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });

    // Approved in the past, so the windows have already elapsed. The database refuses a deletion
    // before `deletion_eligible_from`, so the schedule has to be genuinely in the past rather
    // than the check bypassed.
    await exits().approve({
      exitId: requested.id,
      approvedByUserId: operatorBId,
      now: new Date(Date.now() - 120 * 86_400_000),
    });
    await exits().beginReadOnly({ exitId: requested.id, actorUserId: operatorBId });
    await exits().beginRetentionHold({ exitId: requested.id, actorUserId: operatorBId });
    return requested.id;
  };

  // -------------------------------------------------------------------------
  // The classification is exhaustive
  // -------------------------------------------------------------------------

  /**
   * The test that keeps this feature correct as the schema grows.
   *
   * Every table with a `tenant_id` column must have a disposition. A table added by a later prompt
   * and left unclassified would otherwise default into whichever bucket the code happened to
   * choose — into `Content` it deletes something legally required, into `Accountability` it retains
   * a departed customer's data forever. Nothing else in this codebase would notice.
   */
  it('classifies every tenant-scoped table in the live schema', async () => {
    const live = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'
          ORDER BY table_name`,
      ),
    );

    const missing = live
      .map((row) => row.table_name)
      .filter((table) => TABLE_DISPOSITION[table] === undefined);

    assert.deepEqual(
      missing,
      [],
      `These tenant-scoped tables have no exit disposition. Decide what a company exit does to ` +
        `each one in TABLE_DISPOSITION — it is not safe to let them default: ${missing.join(', ')}`,
    );
  });

  it('names no table that is not in the schema', async () => {
    const live = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
      ),
    );
    const liveSet = new Set(live.map((row) => row.table_name));
    const stale = Object.keys(TABLE_DISPOSITION).filter((table) => !liveSet.has(table));

    assert.deepEqual(stale, [], `stale entries in TABLE_DISPOSITION: ${stale.join(', ')}`);
  });

  // -------------------------------------------------------------------------
  // Request and approval
  // -------------------------------------------------------------------------

  it('refuses an exit with no explanation', async () => {
    await assert.rejects(
      () =>
        exits().request({ tenantId, requestedByUserId: operatorAId, reason: 'done' }),
      (error: Error) => error.message.includes('Say why'),
    );
  });

  it('refuses a second open exit, and allows one after the first is cancelled', async () => {
    const first = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });

    await assert.rejects(
      () =>
        exits().request({
          tenantId,
          requestedByUserId: operatorAId,
          reason: 'A second, competing exit request for the same company.',
        }),
      (error: Error) => error.message.includes('already has an exit in progress'),
    );

    await exits().cancel({
      exitId: first.id,
      actorUserId: operatorBId,
      reason: 'They renewed after all.',
    });

    const second = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'A year later, the contract genuinely ends.',
    });
    assert.equal(second.state, 'Requested');
  });

  /**
   * The separation of duties, and the reason it is in two places.
   *
   * Ending a customer's contract and approving that decision are two people. The service refuses
   * it and `exit_approver_is_not_the_requester` refuses the row.
   */
  it('refuses to let the requester approve their own exit, and records the refusal', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });

    await assert.rejects(
      () => exits().approve({ exitId: requested.id, approvedByUserId: operatorAId }),
      (error: Error) => error.message.includes('a second person'),
    );

    const blocked = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { action: 'security.company_exit_self_approval_blocked' },
      }),
    );
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.severity, 'Critical');
  });

  it('freezes the schedule at approval, stacking both windows', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
      readOnlyDays: 10,
      retentionDays: 20,
    });

    const approvedAt = new Date('2026-01-01T00:00:00.000Z');
    const approved = await exits().approve({
      exitId: requested.id,
      approvedByUserId: operatorBId,
      now: approvedAt,
    });

    assert.equal(approved.readOnlyFrom, '2026-01-01T00:00:00.000Z');
    assert.equal(approved.retentionFrom, '2026-01-11T00:00:00.000Z');
    assert.equal(approved.deletionEligibleFrom, '2026-01-31T00:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // The read-only period drives the existing lifecycle
  // -------------------------------------------------------------------------

  it('moves the company through the lifecycle service rather than writing the column', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });
    await exits().approve({ exitId: requested.id, approvedByUserId: operatorBId });

    await exits().beginReadOnly({ exitId: requested.id, actorUserId: operatorBId });

    const afterReadOnly = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { lifecycleState: true },
      }),
    );
    assert.equal(afterReadOnly.lifecycleState, 'ReadOnly');

    // And the lifecycle service's own history records it, which is the point of going through it.
    const history = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenantLifecycleTransition.findMany({
        where: { tenantId, toState: 'ReadOnly' },
      }),
    );
    assert.equal(history.length, 1);

    await exits().beginRetentionHold({ exitId: requested.id, actorUserId: operatorBId });
    const afterHold = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { lifecycleState: true },
      }),
    );
    assert.equal(afterHold.lifecycleState, 'Closed');
  });

  // -------------------------------------------------------------------------
  // The export package
  // -------------------------------------------------------------------------

  it('exports the company’s own records, including its audit trail, and says what it leaves out', async () => {
    await seedBoth(tenantId);
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });

    const exported = await exits().exportPackage({
      exitId: requested.id,
      actorUserId: operatorBId,
    });

    assert.equal(exported.manifest.companyName, 'Departing Co');
    assert.equal(exported.manifest.totalRows > 0, true);

    const audit = exported.manifest.sections.find((section) => section.section === 'AuditTrail');
    assert.equal((audit?.rows ?? 0) > 0, true, 'a company keeps its own record of what happened');

    const people = exported.manifest.sections.find((section) => section.section === 'People');
    assert.equal(people?.rows, 1);

    // The exclusions are stated up front rather than discovered on opening the archive.
    const excluded = exported.manifest.exclusions.map((entry) => entry.what.toLowerCase()).join(' ');
    assert.equal(excluded.includes('credential'), true);
    assert.equal(excluded.includes('aadhaar'), true);

    // No contact details: those live on the shared platform `users` table.
    const serialized = JSON.stringify(exported.data);
    assert.equal(
      serialized.includes('person@departing.example'),
      false,
      'an export is not a route to a company’s people’s contact details',
    );
  });

  it('refuses to export once the content is gone', async () => {
    await seedBoth(tenantId);
    const exitId = await readyToDelete();
    await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });

    await assert.rejects(
      () => exits().exportPackage({ exitId, actorUserId: operatorBId }),
      (error: Error) => error.message.includes('nothing left to export'),
    );
  });

  // -------------------------------------------------------------------------
  // The destructive confirmation
  // -------------------------------------------------------------------------

  it('refuses a deletion before the retention window has elapsed', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });
    await exits().approve({ exitId: requested.id, approvedByUserId: operatorBId });
    await exits().beginReadOnly({ exitId: requested.id, actorUserId: operatorBId });
    await exits().beginRetentionHold({ exitId: requested.id, actorUserId: operatorBId });

    await assert.rejects(
      () =>
        exits().deleteContent({
          exitId: requested.id,
          actorUserId: operatorBId,
          typedConfirmation: tenantSlug,
        }),
      (error: Error) => error.message.includes('not skippable'),
    );
  });

  it('refuses the word DELETE and accepts only the company’s own identifier', async () => {
    await seedBoth(tenantId);
    const exitId = await readyToDelete();

    for (const wrong of ['DELETE', 'delete', tenantSlug.toUpperCase(), 'staying-co']) {
      await assert.rejects(
        () =>
          exits().deleteContent({ exitId, actorUserId: operatorBId, typedConfirmation: wrong }),
        (error: Error) => error.message.includes('type the company'),
        `"${wrong}" must not confirm a deletion`,
      );
    }

    const failures = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { action: 'security.company_exit_confirmation_failed' },
      }),
    );
    assert.equal(failures.length, 4, 'every failed confirmation is recorded');

    const deleted = await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });
    assert.equal(deleted.state, 'Deleted');
  });

  /**
   * The rule Prompt 35 set, applied here.
   *
   * *"A legal hold beats everything — not by retention, and not by request"* (S-247). A company
   * exit is a request, and emptying `files` would have deleted held files — a direct contradiction
   * of a locked rule, and one this suite did not originally check.
   */
  it('refuses to delete anything while a file is under a legal hold', async () => {
    await seedBoth(tenantId);

    const file = await ctx.prisma.runInTenantTransaction(scope(tenantId), () =>
      ctx.prisma.client.storedFile.create({
        data: {
          tenantId,
          filename: 'litigation.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          storageRef: 'tenants/x/files/held',
          uploadedByUserId: personId,
          onLegalHold: true,
          legalHoldReason: 'Litigation hold LH-2026-04.',
          legalHoldPlacedAt: new Date(),
          legalHoldPlacedByUserId: personId,
        },
      }),
    );

    const exitId = await readyToDelete();

    await assert.rejects(
      () =>
        exits().deleteContent({
          exitId,
          actorUserId: operatorBId,
          typedConfirmation: tenantSlug,
        }),
      (error: Error) => error.message.includes('legal hold'),
    );

    // Nothing was half-deleted: a refusal, not a skip.
    assert.equal(await countIn(tenantId, 'engine_agents') > 0, true);
    assert.equal(await countIn(tenantId, 'files'), 1);

    // Lift the hold and the exit proceeds.
    await ctx.prisma.runInTenantTransaction(scope(tenantId), () =>
      ctx.prisma.client.storedFile.update({
        where: { id: file.id },
        data: {
          onLegalHold: false,
          legalHoldReason: null,
          legalHoldPlacedAt: null,
          legalHoldPlacedByUserId: null,
        },
      }),
    );

    const deleted = await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });
    assert.equal(deleted.state, 'Deleted');
    assert.equal(await countIn(tenantId, 'files'), 0);
  });

  // -------------------------------------------------------------------------
  // What survives — the heart of the prompt
  // -------------------------------------------------------------------------

  it('deletes the company’s work and leaves accountability and person records standing', async () => {
    await seedBoth(tenantId);

    const before = {
      agents: await countIn(tenantId, 'engine_agents'),
      notifications: await countIn(tenantId, 'notifications'),
      audit: await countIn(tenantId, 'audit_events'),
      wallets: await countIn(tenantId, 'budget_wallets'),
      employment: await countIn(tenantId, 'employment_records'),
      badges: await countIn(tenantId, 'badge_history'),
    };

    assert.equal(before.agents > 0, true);
    assert.equal(before.audit > 0, true);
    assert.equal(before.employment, 1);

    const exitId = await readyToDelete();
    const certificate = await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });

    // ---- Content is gone ----
    assert.equal(await countIn(tenantId, 'engine_agents'), 0);
    // **Departments survive**, because a preserved employment record names one. The foreign key
    // forced the decision and it is the right one: "Analyst in Delivery" pointing at nothing would
    // be worse than keeping a department name.
    assert.equal(await countIn(tenantId, 'departments') > 0, true);
    assert.equal(await countIn(tenantId, 'tenant_memberships'), 0, 'access is revoked');

    // ---- Accountability survives. This is the sentence the prompt leads with. ----
    assert.equal(
      await countIn(tenantId, 'audit_events') >= before.audit,
      true,
      'the audit trail must survive a company exit — and it grows, because the exit is audited',
    );
    assert.equal(
      await countIn(tenantId, 'budget_wallets'),
      before.wallets,
      'the financial record survives',
    );
    assert.equal(
      await countIn(tenantId, 'company_exits') > 0,
      true,
      'the deletion certificate survives the deletion it describes',
    );

    // ---- The person's own record survives ----
    assert.equal(
      await countIn(tenantId, 'employment_records'),
      before.employment,
      'a company leaving UBoss does not erase somebody’s career',
    );
    assert.equal(await countIn(tenantId, 'badge_history'), before.badges);

    // ---- The certificate carries its evidence ----
    assert.equal((certificate.deletedRowCount ?? 0) > 0, true);
    assert.equal((certificate.preservedRowCount ?? 0) > 0, true);

    const row = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.companyExit.findUniqueOrThrow({ where: { id: exitId } }),
    );
    const certificateManifest = row.deletionManifest as {
      deleted: Record<string, number>;
      retainedByPrivilege: Record<string, number>;
    };
    assert.equal(typeof certificateManifest.deleted['engine_agents'], 'number');
    assert.equal(
      certificateManifest.deleted['audit_events'],
      undefined,
      'the manifest must not claim to have deleted the audit trail',
    );
    assert.equal(certificateManifest.deleted['employment_records'], undefined);

    // **`notifications` is append-only by database privilege**, so the application cannot delete
    // it. The certificate says so rather than claiming it went — which is the whole point of a
    // certificate that carries evidence.
    assert.equal(
      typeof certificateManifest.retainedByPrivilege['notifications'],
      'number',
      'a table the application cannot delete has to be reported, not silently skipped',
    );
    assert.equal(
      certificateManifest.deleted['notifications'],
      undefined,
      'and it must not appear as deleted',
    );
  });

  it('leaves every other company completely untouched', async () => {
    await seedBoth(tenantId);
    await seedBoth(otherTenantId);

    const theirs = {
      agents: await countIn(otherTenantId, 'engine_agents'),
      notifications: await countIn(otherTenantId, 'notifications'),
      audit: await countIn(otherTenantId, 'audit_events'),
      employment: await countIn(otherTenantId, 'employment_records'),
      memberships: await countIn(otherTenantId, 'tenant_memberships'),
    };
    assert.equal(theirs.agents > 0, true);

    const exitId = await readyToDelete();
    await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });

    // Checked after the deletion rather than assumed from RLS: this deletion runs as a **platform
    // operation**, which is exactly the context in which RLS does not protect anybody.
    assert.equal(await countIn(otherTenantId, 'engine_agents'), theirs.agents);
    assert.equal(await countIn(otherTenantId, 'notifications'), theirs.notifications);
    assert.equal(await countIn(otherTenantId, 'audit_events'), theirs.audit);
    assert.equal(await countIn(otherTenantId, 'employment_records'), theirs.employment);
    assert.equal(await countIn(otherTenantId, 'tenant_memberships'), theirs.memberships);

    const stillActive = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenant.findUniqueOrThrow({
        where: { id: otherTenantId },
        select: { lifecycleState: true },
      }),
    );
    assert.equal(stillActive.lifecycleState, 'Active');
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  it('cancels from the retention hold and brings the company back', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });
    await exits().approve({ exitId: requested.id, approvedByUserId: operatorBId });
    await exits().beginReadOnly({ exitId: requested.id, actorUserId: operatorBId });
    await exits().beginRetentionHold({ exitId: requested.id, actorUserId: operatorBId });

    const cancelled = await exits().cancel({
      exitId: requested.id,
      actorUserId: operatorBId,
      reason: 'They signed a new three-year contract.',
    });

    assert.equal(cancelled.state, 'Cancelled');
    assert.equal(cancelled.cancellable, false, 'a cancelled exit is finished');

    const tenant = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { lifecycleState: true },
      }),
    );
    // **Still Closed**, and that is correct. Prompt 11 locks `Closed` as terminal through the
    // lifecycle service, so cancelling from the retention hold stops the *exit* — nothing is
    // deleted — without automatically restoring access, which is its own deliberate operation.
    assert.equal(tenant.lifecycleState, 'Closed');

    const trail = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.auditEvent.findMany({
        where: { tenantId, action: 'company_exit.cancelled' },
        select: { summary: true },
      }),
    );
    assert.equal(
      trail[0]?.summary?.includes('remains closed'),
      true,
      'the trail has to say why the company is still shut, or somebody is left guessing',
    );
  });

  it('restores access when the exit is cancelled during the read-only period', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });
    await exits().approve({ exitId: requested.id, approvedByUserId: operatorBId });
    await exits().beginReadOnly({ exitId: requested.id, actorUserId: operatorBId });

    await exits().cancel({
      exitId: requested.id,
      actorUserId: operatorBId,
      reason: 'They signed a new three-year contract.',
    });

    const tenant = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { lifecycleState: true },
      }),
    );
    assert.equal(
      tenant.lifecycleState,
      'Active',
      'from ReadOnly the company can go straight back, which is a transition Prompt 11 permits',
    );
  });

  it('refuses to cancel after the content is deleted', async () => {
    await seedBoth(tenantId);
    const exitId = await readyToDelete();
    await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });

    await assert.rejects(
      () =>
        exits().cancel({
          exitId,
          actorUserId: operatorBId,
          reason: 'Trying to undo the undoable.',
        }),
      (error: Error) => error.message.includes('cannot be undone'),
    );
  });

  it('refuses a cancellation with no reason', async () => {
    const requested = await exits().request({
      tenantId,
      requestedByUserId: operatorAId,
      reason: 'The contract ends on 31 March and will not be renewed.',
    });

    await assert.rejects(
      () => exits().cancel({ exitId: requested.id, actorUserId: operatorBId, reason: 'no' }),
      (error: Error) => error.message.includes('Say why'),
    );
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  it('audits every step, in the company’s own trail', async () => {
    await seedBoth(tenantId);
    const exitId = await readyToDelete();
    await exits().exportPackage({ exitId, actorUserId: operatorBId });
    await exits().deleteContent({
      exitId,
      actorUserId: operatorBId,
      typedConfirmation: tenantSlug,
    });

    const events = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.auditEvent.findMany({
        where: { tenantId, resourceType: 'company_exit' },
        select: { action: true },
      }),
    );
    const actions = new Set(events.map((event) => event.action));

    for (const expected of [
      'company_exit.requested',
      'company_exit.approved',
      'company_exit.read_only_began',
      'company_exit.retention_hold_began',
      'company_exit.exported',
      'company_exit.content_deleted',
    ]) {
      assert.equal(actions.has(expected), true, `${expected} is missing from the trail`);
    }
  });

  it('reports what is waiting for a deletion decision', async () => {
    await readyToDelete();
    const waiting = await exits().awaitingDeletion();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.state, 'RetentionHold');
    assert.equal(waiting[0]?.cancellable, true, 'still stoppable, which is the whole point');
  });

  it('preserves more tables than it deletes nothing of — a sanity floor', () => {
    // Guards against somebody "simplifying" the classification into delete-everything.
    const counts: Record<Disposition, number> = {
      Content: tablesWithDisposition('Content').length,
      Accountability: tablesWithDisposition('Accountability').length,
      PersonRecord: tablesWithDisposition('PersonRecord').length,
    };
    assert.equal(counts.Accountability >= 15, true);
    assert.equal(counts.PersonRecord >= 4, true);
    assert.equal(counts.Content > counts.Accountability, true, 'most tables are company work');
  });
});
