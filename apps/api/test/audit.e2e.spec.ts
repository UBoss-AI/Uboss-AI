import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AuditChainService } from '../src/audit/audit-chain.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { AuditQueryService } from '../src/audit/audit-query.service.js';
import { AuditController, PlatformSecurityController } from '../src/audit/audit.controller.js';
import { BreakGlassController } from '../src/audit/break-glass.controller.js';
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
 * Audit and security foundations, against real PostgreSQL.
 *
 * The chain arithmetic is proved without a database in `audit-chain.spec.ts`. What can only be
 * tested here is the part that makes the guarantee real: that PostgreSQL itself refuses to alter
 * a trail row, that a chain written by concurrent appends is still a chain, and that break-glass
 * cannot be walked through by one person.
 */
describe('audit and security foundations (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let auditorId: string;
  let auditorUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let platformId: string;
  let platformUboss: string;
  let supportId: string;
  let supportUboss: string;

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
      controllers: [AuditController, PlatformSecurityController, BreakGlassController],
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
      slug: 'audit-co',
      name: 'Audit Co',
      firstMember: { email: 'first@audit.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-audit-co',
      name: 'Other Audit Co',
      firstMember: { email: 'first@other.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const make = async (unique: string, email: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };
      return {
        admin: await make('UB-ADM1-0001', 'admin@audit.example', 'Company Admin'),
        auditor: await make('UB-AUD1-0001', 'auditor@audit.example', 'Auditor'),
        employee: await make('UB-EMP1-0001', 'employee@audit.example', 'Employee'),
      };
    });
    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    auditorId = people.auditor.id;
    auditorUboss = people.auditor.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;

    const platformPeople = await ctx.prisma.runAsPlatformOperation(async () => ({
      platform: await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-PLAT-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
      support: await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-SUPP-0001',
        email: 'support@uboss.example',
        displayName: 'Support Engineer',
        isPlatformActor: true,
      }),
    }));
    platformId = platformPeople.platform.id;
    platformUboss = platformPeople.platform.ubossUniqueId;
    supportId = platformPeople.support.id;
    supportUboss = platformPeople.support.ubossUniqueId;

    // Roles, granted directly so this suite does not depend on the Prompt 7 admin endpoints.
    await ctx.prisma.runInTenantTransaction(tenantScopeForPlatformOperation(tenantId), async () => {
      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [auditorId, 'Auditor', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: platformId },
        });
      }
    });
  });

  // ---- helpers ----

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const asPlatform = <T extends request.Test>(test: T, uboss = platformUboss): T =>
    test.set('x-uboss-dev-actor', uboss) as T;

  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);

  const auditService = () => app.get(AuditEventService);
  const securityService = () => app.get(SecurityEventService);
  const breakGlass = () => app.get(BreakGlassService);
  const chains = () => app.get(AuditChainService);

  const seedTrail = async (count: number, id = tenantId) => {
    for (let index = 0; index < count; index += 1) {
      await auditService().recordForTenantOrThrow(scope(id), {
        action: 'objective.published',
        resourceType: 'objective',
        resourceId: `obj-${index + 1}`,
        summary: `Published objective ${index + 1}.`,
        reason: 'Approved at the weekly review.',
        resourceVersion: index + 1,
        resourceRef: `V${index + 1}`,
        actorUserId: adminId,
      });
    }
  };

  /**
   * Assert the property that actually matters: positions are **contiguous and linked**, whatever
   * number they start at.
   *
   * These tests used to assert the chain started at 1, which worked only because provisioning
   * wrote through the old unchained path. Now that every write is chained, the company's chain
   * already has provisioning's rows in it — and asserting an absolute starting position would
   * mean any change to how many events provisioning writes breaks an unrelated test. Contiguity
   * is the real invariant.
   */
  const assertContiguousChain = (
    rows: { sequence: bigint; row_hash: string; prev_hash: string | null }[],
    expectedNewRows?: number,
  ) => {
    assert.ok(rows.length > 0, 'The chain should not be empty.');
    if (expectedNewRows !== undefined) {
      assert.ok(
        rows.length >= expectedNewRows,
        `Expected at least ${expectedNewRows} row(s), found ${rows.length}.`,
      );
    }
    for (let index = 1; index < rows.length; index += 1) {
      assert.equal(
        Number(rows[index]?.sequence),
        Number(rows[index - 1]?.sequence) + 1,
        'Positions must be contiguous: a gap is itself evidence of a missing row.',
      );
      assert.equal(
        rows[index]?.prev_hash,
        rows[index - 1]?.row_hash,
        'Each row must link to the one before it.',
      );
    }
  };

  const rawRows = async (table: 'audit_events' | 'security_events', id = tenantId) =>
    ctx.admin.unsafeRootClient.$queryRawUnsafe<
      { id: string; sequence: bigint; row_hash: string; prev_hash: string | null }[]
    >(
      `SELECT id, sequence, row_hash, prev_hash FROM "${table}" WHERE chain_key = $1 ` +
        `ORDER BY sequence ASC`,
      id,
    );

  // =========================================================================
  describe('append-only, enforced by the database', () => {
    it('chains every appended row', async () => {
      await seedTrail(4);
      const rows = await rawRows('audit_events');

      assertContiguousChain(rows, 4);
      // Position 1 is provisioning's own audit row, and it is the genuine start of this
      // company's chain, so it is the one row with no predecessor.
      assert.equal(Number(rows[0]?.sequence), 1);
      assert.equal(rows[0]?.prev_hash, null, 'The first row of a chain has no predecessor.');
    });

    it('refuses UPDATE from the application role — by privilege, before any trigger', async () => {
      await seedTrail(1);
      const [row] = await rawRows('audit_events');
      assert.ok(row);

      // `ctx.prisma` connects as `uboss_app`, which is the role the API uses. This is the
      // control that matters most: a compromised application cannot rewrite history at all.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE audit_events SET summary = 'tampered' WHERE id = $1`,
              row.id,
            ),
          ),
        /permission denied/i,
      );
    });

    it('refuses DELETE from the application role', async () => {
      await seedTrail(1);
      const [row] = await rawRows('audit_events');
      assert.ok(row);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = $1`, row.id),
          ),
        /permission denied/i,
      );
    });

    it('refuses UPDATE and DELETE even from the owner role, via the trigger', async () => {
      await seedTrail(1);
      const [row] = await rawRows('audit_events');
      assert.ok(row);

      // `ctx.admin.unsafeRootClient` connects as `uboss`, the table owner — the role a migration
      // or a seed runs as, and the one a REVOKE cannot bind. Without the trigger, a mistaken
      // `UPDATE audit_events` in a future migration would succeed silently.
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `UPDATE audit_events SET summary = 'tampered' WHERE id = $1`,
            row.id,
          ),
        /append-only/i,
      );
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `DELETE FROM audit_events WHERE id = $1`,
            row.id,
          ),
        /append-only/i,
      );
    });

    it('refuses TRUNCATE, which row-level triggers do not see', async () => {
      await seedTrail(1);
      await assert.rejects(
        () => ctx.admin.unsafeRootClient.$executeRawUnsafe(`TRUNCATE audit_events`),
        /append-only/i,
      );
      await assert.rejects(
        () => ctx.admin.unsafeRootClient.$executeRawUnsafe(`TRUNCATE security_events`),
        /append-only/i,
      );
    });

    it('applies the same protection to the security trail and the checkpoints', async () => {
      await securityService().record({
        action: 'security.login_failed',
        category: 'Login',
        tenantId,
      });
      const rows = await rawRows('security_events');
      assert.equal(rows.length, 1);

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE security_events SET outcome = 'Succeeded' WHERE id = $1`,
              rows[0]?.id,
            ),
          ),
        /permission denied/i,
      );
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(`DELETE FROM audit_chain_checkpoints`),
          ),
        /permission denied/i,
      );
    });

    it('does not let the application escape via the truncate flag', () => {
      // The escape hatch exists for the test harness only. If a call to it ever appears in
      // `src/`, the append-only guarantee is decorative — so its absence is asserted, not
      // assumed.
      const files = [
        'src/audit/audit-event.service.ts',
        'src/audit/security-event.service.ts',
        'src/audit/audit-chain.service.ts',
        'src/audit/break-glass.service.ts',
        'src/persistence/audit-trail.repository.ts',
        'src/persistence/audit-event.repository.ts',
      ];
      // Resolved from the working directory (`apps/api`) rather than from `import.meta.url`:
      // this suite runs compiled, so a module-relative path would look inside `dist-test/`.
      for (const file of files) {
        assert.doesNotMatch(
          readFileSync(resolve(process.cwd(), file), 'utf8'),
          /allow_history_truncate/,
          `${file} must not reference the test-only truncate escape hatch.`,
        );
      }
    });

    it('leaves no unchained rows behind, so the unchained count keeps its meaning', async () => {
      // Provisioning and the seed used to write through the old unchained repository, which
      // would have turned `unchainedCount` from "rows written before the chain existed" into
      // "...plus whatever still uses the old path". A number that means two things means nothing,
      // and this is the count an operator reads to know how much of the trail is unverifiable.
      //
      // The write methods were deleted from `AuditEventRepository` rather than deprecated, so
      // this asserts the outcome of that: on a database whose only rows come from provisioning,
      // there are none without a chain position.
      const orphans = await ctx.admin.unsafeRootClient.auditEvent.count({
        where: { chainKey: null },
      });
      assert.equal(
        orphans,
        0,
        'Every audit row must be chained. Writing through AuditEventRepository is no longer ' +
          'possible; write through AuditEventService.',
      );

      const verified = await chains().verifyForTenant(scope(), auditorId);
      assert.equal(verified.audit.unchainedCount, 0);
      assert.ok(verified.audit.verifiedCount > 0, 'Provisioning should have written chained rows.');
    });

    it('keeps the chain contiguous under concurrent appends', async () => {
      // Two appends racing for the same chain position. Without the advisory lock both would
      // read the same head; the unique index would fail one of them, turning an internal race
      // into a user-visible error.
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          auditService().recordForTenantOrThrow(scope(), {
            action: 'concurrent.append',
            resourceType: 'probe',
            resourceId: `p-${index}`,
            actorUserId: adminId,
          }),
        ),
      );

      const rows = await rawRows('audit_events');
      // 12 concurrent appends plus provisioning's rows. Contiguity is what proves the advisory
      // lock worked: without it two appends would claim one position, and the unique index would
      // have failed one of them rather than corrupting the chain.
      assertContiguousChain(rows, 12);
      assert.equal(
        new Set(rows.map((row) => String(row.sequence))).size,
        rows.length,
        'No two rows may share a position.',
      );

      const verified = await chains().verifyForTenant(scope(), auditorId);
      assert.equal(verified.audit.intact, true);
    });

    it('gives each company its own chain, starting at 1', async () => {
      await seedTrail(2, tenantId);
      await seedTrail(3, otherTenantId);

      const mine = await rawRows('audit_events', tenantId);
      const theirs = await rawRows('audit_events', otherTenantId);

      // Each company's chain starts at 1 and is contiguous **within itself**. That independence
      // is what lets one company's export verify on its own without revealing anything about
      // another's.
      assert.equal(Number(mine[0]?.sequence), 1);
      assert.equal(Number(theirs[0]?.sequence), 1);
      assertContiguousChain(mine, 2);
      assertContiguousChain(theirs, 3);
      assert.ok(theirs.length > mine.length, 'The other company seeded more events.');
      // Two companies' chains must be independent, so one company's export verifies on its own.
      assert.notEqual(mine[0]?.row_hash, theirs[0]?.row_hash);
    });

    it('records the fields the client named', async () => {
      await auditService().recordForTenantOrThrow(scope(), {
        action: 'retention.changed',
        resourceType: 'settings',
        resourceId: 'retention',
        reason: 'Legal asked for 7 years after the audit finding in Q2.',
        resourceVersion: 4,
        resourceRef: 'policy-v4',
        actorUserId: adminId,
        correlationId: 'corr-abc',
      });

      const [row] = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({ tenantId, take: 1 }),
      );

      assert.ok(row);
      assert.equal(row.actorUserId, adminId);
      assert.equal(row.tenantId, tenantId);
      assert.equal(row.action, 'retention.changed');
      assert.equal(row.reason, 'Legal asked for 7 years after the audit finding in Q2.');
      assert.equal(row.resourceVersion, 4);
      assert.equal(row.resourceRef, 'policy-v4');
      assert.equal(row.correlationId, 'corr-abc');
      assert.ok(row.occurredAt instanceof Date);
    });

    it('redacts a secret written into metadata by mistake', async () => {
      await auditService().recordForTenantOrThrow(scope(), {
        action: 'probe.metadata',
        resourceType: 'probe',
        actorUserId: adminId,
        metadata: { apiToken: 'shhh', setPassword: true, attempts: 3 },
      });

      const [row] = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app
          .get(AuditTrailRepository)
          .findAuditEvents({ tenantId, action: 'probe.metadata', take: 1 }),
      );
      const metadata = row?.metadata as Record<string, unknown>;

      assert.equal(metadata['apiToken'], '[redacted]');
      // Non-strings survive: `{ setPassword: "[redacted]" }` would tell an investigator nothing.
      assert.equal(metadata['setPassword'], true);
      assert.equal(metadata['attempts'], 3);
    });
  });

  // =========================================================================
  describe('chain verification', () => {
    it('reports an intact chain, with the guarantee it actually provides', async () => {
      await seedTrail(3);
      const result = await chains().verifyForTenant(scope(), auditorId);

      assert.equal(result.audit.intact, true);
      // The three seeded events plus provisioning's own. Asserted as a floor rather than an exact
      // figure so a change to what provisioning records does not break this test.
      assert.ok(result.audit.verifiedCount >= 3);
      assert.equal(result.audit.unchainedCount, 0);
      assert.match(result.guarantee, /cannot UPDATE or DELETE/);
      // With no external anchor the honest answer includes what is NOT guaranteed.
      assert.match(result.guarantee, /NOT guaranteed/);
      assert.match(result.guarantee, /superuser/);
    });

    it('detects a row rewritten by a superuser with the trigger disabled', async () => {
      await seedTrail(4);
      const rows = await rawRows('audit_events');

      // The attack ADR-046 names: superuser access, trigger off, row rewritten. The chain
      // catches it because the hash was not recomputed.
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      );
      try {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `UPDATE audit_events SET summary = 'quietly rewritten' WHERE id = $1`,
          rows[1]?.id,
        );
      } finally {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`,
        );
      }

      const result = await chains().verifyForTenant(scope(), auditorId);
      assert.equal(result.audit.intact, false);
      assert.ok(result.audit.breaks.some((b) => b.kind === 'content-altered'));
    });

    it('detects a deleted row', async () => {
      await seedTrail(4);
      const rows = await rawRows('audit_events');

      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      );
      try {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `DELETE FROM audit_events WHERE id = $1`,
          rows[1]?.id,
        );
      } finally {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`,
        );
      }

      const result = await chains().verifyForTenant(scope(), auditorId);
      assert.equal(result.audit.intact, false);
      assert.ok(result.audit.breaks.some((b) => b.kind === 'sequence-gap'));
    });

    it('records a Critical security event when a chain is broken', async () => {
      await seedTrail(3);
      const rows = await rawRows('audit_events');

      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      );
      try {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `UPDATE audit_events SET action = 'nothing.happened' WHERE id = $1`,
          rows[0]?.id,
        );
      } finally {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`,
        );
      }

      await chains().verifyForTenant(scope(), auditorId);

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.audit_chain_broken',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('seals a checkpoint at the head, and refuses to seal a broken chain', async () => {
      await seedTrail(3);

      // Sealed at whatever the head actually is, which is the point of a checkpoint.
      const head = await rawRows('audit_events');
      const checkpoint = await chains().sealCheckpoint({
        chainKey: tenantId,
        trail: 'audit',
        scope: scope(),
        sealedByUserId: adminId,
      });
      assert.equal(checkpoint.sequence, head[head.length - 1]?.sequence);
      assert.equal(checkpoint.rowHash, head[head.length - 1]?.row_hash);
      assert.equal(
        checkpoint.externalAnchorRef,
        null,
        'Unanchored, and honestly recorded as such.',
      );

      const rows = await rawRows('audit_events');
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      );
      try {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `UPDATE audit_events SET summary = 'x' WHERE id = $1`,
          rows[0]?.id,
        );
      } finally {
        await ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only`,
        );
      }

      // Sealing over a broken chain would make the tampered state the verified baseline —
      // strictly worse than having no checkpoint.
      await assert.rejects(
        () =>
          chains().sealCheckpoint({
            chainKey: tenantId,
            trail: 'audit',
            scope: scope(),
            sealedByUserId: adminId,
          }),
        /unresolved break/i,
      );
    });

    it('upgrades the stated guarantee once a checkpoint is externally anchored', async () => {
      await seedTrail(2);
      await chains().sealCheckpoint({
        chainKey: tenantId,
        trail: 'audit',
        scope: scope(),
        sealedByUserId: adminId,
        externalAnchorRef: 's3://uboss-audit-anchors/audit-co/2026-09-08.json',
      });

      const result = await chains().verifyForTenant(scope(), auditorId);
      assert.match(result.guarantee, /anchored outside this database/);
      assert.doesNotMatch(result.guarantee, /NOT guaranteed/);
    });

    it('refuses to seal an empty chain', async () => {
      await assert.rejects(
        () =>
          chains().sealCheckpoint({
            chainKey: tenantId,
            trail: 'security',
            scope: scope(),
            sealedByUserId: adminId,
          }),
        /no.*position to record/i,
      );
    });
  });

  // =========================================================================
  describe('export and filter authorization', () => {
    it('lets an Auditor read the trail', async () => {
      await seedTrail(2);
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`),
        auditorUboss,
      ).expect(200);

      const body = response.body as {
        rows: { action: string }[];
        total: number;
        chainVersion: string;
      };
      assert.equal(
        body.rows.filter((row) => row.action === 'objective.published').length,
        2,
        'Both seeded events should be readable.',
      );
      assert.equal(
        body.total,
        body.rows.length,
        'The total should match a single unfiltered page.',
      );
      assert.equal(body.chainVersion, 'uboss-audit-chain-v1');
    });

    it('lets a Company Admin read the trail', async () => {
      await seedTrail(1);
      await asPerson(agent().get(`/tenants/${tenantId}/audit/events`), adminUboss).expect(200);
    });

    it('refuses an Employee — Audit is not part of that role', async () => {
      await seedTrail(1);
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`),
        employeeUboss,
      ).expect(403);
      assert.match((response.body as { message: string }).message, /Audit/);
    });

    it('refuses an audit read from a department-scoped grant rather than over-returning', async () => {
      // A custom role can carry `Audit` at any scope. `audit_events` has no department, so a
      // department-scoped grant cannot be honoured — and returning everything would silently
      // turn it into a company-wide one.
      await ctx.prisma.runInTenantTransaction(scope(), async () => {
        const role = await ctx.prisma.client.customRole.create({
          data: {
            tenantId,
            displayName: 'Department Auditor',
            description: 'Audit within one department.',
            permissions: { settings: ['View', 'Audit', 'Export'] },
            maxScope: 'Department',
            createdByUserId: platformId,
          },
        });
        // A **real** department. This fixture used the placeholder `'dept-1'` while
        // `department_ids` was an unvalidated `text[]`; the Prompt 12 trigger refuses a
        // department id that does not exist in the company, which is the point of adding it —
        // a dangling id silently matches no resource and reads as an ordinary grant.
        const department = await ctx.prisma.client.department.create({
          data: { tenantId, name: 'Audited Department', code: 'AUD' },
        });
        await ctx.prisma.client.roleAssignment.deleteMany({
          where: { tenantId, userId: employeeId },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: employeeId,
            roleKind: 'Custom',
            customRoleId: role.id,
            scopeKind: 'Department',
            departmentIds: [department.id],
            grantedByUserId: platformId,
          },
        });
      });

      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`),
        employeeUboss,
      ).expect(403);
      assert.match(
        (response.body as { message: string }).message,
        /whole-company scope|not department-scoped/i,
      );
    });

    it('requires both Audit and Export to export, and records who exported', async () => {
      await seedTrail(3);

      await asPerson(agent().post(`/tenants/${tenantId}/audit/events/export`), auditorUboss).expect(
        201,
      );

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.audit_trail_exported',
          take: 5,
        }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.actorUserId, auditorId);
      assert.equal(events[0]?.category, 'Support');
    });

    it('refuses an export to a role that has Audit but not Export', async () => {
      await seedTrail(1);
      await ctx.prisma.runInTenantTransaction(scope(), async () => {
        const role = await ctx.prisma.client.customRole.create({
          data: {
            tenantId,
            displayName: 'Read-only Auditor',
            description: 'May read the trail, may not take a copy.',
            permissions: { settings: ['View', 'Audit'] },
            maxScope: 'WholeCompany',
            createdByUserId: platformId,
          },
        });
        await ctx.prisma.client.roleAssignment.deleteMany({
          where: { tenantId, userId: employeeId },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId: employeeId,
            roleKind: 'Custom',
            customRoleId: role.id,
            scopeKind: 'WholeCompany',
            grantedByUserId: platformId,
          },
        });
      });

      await asPerson(agent().get(`/tenants/${tenantId}/audit/events`), employeeUboss).expect(200);
      await asPerson(
        agent().post(`/tenants/${tenantId}/audit/events/export`),
        employeeUboss,
      ).expect(403);
    });

    it('never returns another company rows, whatever the filter asks for', async () => {
      await seedTrail(2, tenantId);
      await seedTrail(5, otherTenantId);

      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ limit: 200 }),
        auditorUboss,
      ).expect(200);

      const body = response.body as { rows: { tenantId: string; action: string }[]; total: number };
      // The other company has 5 seeded events plus its own provisioning rows. None of them may
      // appear here, whatever the filter says — the tenant id comes from the verified scope, not
      // from the request.
      assert.equal(body.rows.filter((row) => row.action === 'objective.published').length, 2);
      assert.ok(body.rows.every((row) => row.tenantId === tenantId));
      assert.equal(body.total, body.rows.length);
    });

    it('refuses a workspace the caller does not belong to', async () => {
      await seedTrail(1, otherTenantId);
      await asPerson(
        agent().get(`/tenants/${otherTenantId}/audit/events`),
        auditorUboss,
        otherTenantId,
      ).expect(403);
    });

    it('filters by action, actor, resource and time window', async () => {
      await seedTrail(2);
      await auditService().recordForTenantOrThrow(scope(), {
        action: 'agent.paused',
        resourceType: 'agent',
        resourceId: 'agent-9',
        actorUserId: employeeId,
      });

      const byAction = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ action: 'agent.paused' }),
        auditorUboss,
      ).expect(200);
      assert.equal((byAction.body as { rows: unknown[] }).rows.length, 1);

      const byActor = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ actorUserId: employeeId }),
        auditorUboss,
      ).expect(200);
      assert.equal((byActor.body as { rows: unknown[] }).rows.length, 1);

      const byResource = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ resourceType: 'objective' }),
        auditorUboss,
      ).expect(200);
      assert.equal((byResource.body as { rows: unknown[] }).rows.length, 2);

      const future = await asPerson(
        agent()
          .get(`/tenants/${tenantId}/audit/events`)
          .query({ from: new Date(Date.now() + 86_400_000).toISOString() }),
        auditorUboss,
      ).expect(200);
      assert.equal((future.body as { rows: unknown[] }).rows.length, 0);
    });

    it('rejects action and actionPrefix together instead of silently ignoring one', async () => {
      await asPerson(
        agent()
          .get(`/tenants/${tenantId}/audit/events`)
          .query({ action: 'a.b', actionPrefix: 'a.' }),
        auditorUboss,
      ).expect(400);
    });

    it('rejects an undeclared filter field', async () => {
      await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ tenantIdOverride: otherTenantId }),
        auditorUboss,
      ).expect(400);
    });

    it('pages with a cursor and stops without an extra empty request', async () => {
      await seedTrail(5);

      const first = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ limit: 2 }),
        auditorUboss,
      ).expect(200);
      const firstBody = first.body as { rows: unknown[]; nextCursor?: string };
      assert.equal(firstBody.rows.length, 2);
      assert.ok(firstBody.nextCursor);

      const last = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/events`).query({ limit: 10 }),
        auditorUboss,
      ).expect(200);
      assert.equal((last.body as { nextCursor?: string }).nextCursor, undefined);
    });
  });

  // =========================================================================
  describe('the security trail', () => {
    it('writes security events to security_events, not to the audit trail', async () => {
      await securityService().record({
        action: 'security.login_failed',
        category: 'Login',
        severity: 'Notice',
        outcome: 'Failed',
        tenantId,
        reason: 'Wrong password.',
      });

      const security = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({ tenantId, take: 10 }),
      );
      const audit = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({ tenantId, take: 10 }),
      );

      assert.equal(security.length, 1);
      assert.equal(security[0]?.outcome, 'Failed');
      // ADR-045: the two trails are separate. A `security.*` action in the audit trail is the
      // Prompt 5 behaviour this reverses. The audit trail is not *empty* — provisioning writes
      // to it — so the assertion is about which actions land where, not about a count.
      assert.equal(
        audit.filter((row) => row.action.startsWith('security.')).length,
        0,
        'A security event must not also land in the audit trail.',
      );
    });

    it('classifies from the action key, so a call site does not have to', async () => {
      const publisher = app.get(SecurityEventPublisher);
      await publisher.record({
        action: 'security.sod_policy_deleted',
        tenantId,
        summary: 'Removed the no-self-approval control.',
      });
      await publisher.record({ action: 'security.login_succeeded', tenantId });

      const rows = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({ tenantId, take: 10 }),
      );

      const sod = rows.find((row) => row.action === 'security.sod_policy_deleted');
      const login = rows.find((row) => row.action === 'security.login_succeeded');
      assert.equal(sod?.severity, 'Critical', 'Deleting an SoD policy should page somebody.');
      assert.equal(sod?.category, 'Access');
      assert.equal(login?.severity, 'Info');
      assert.equal(login?.category, 'Login');
      // `summary` at the call site maps onto `reason` in the table.
      assert.equal(sod?.reason, 'Removed the no-self-approval control.');
    });

    it('keeps tenant-less events out of a company trail entirely', async () => {
      await securityService().record({ action: 'security.login_failed', category: 'Login' });

      const companyRows = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({ tenantId, take: 10 }),
      );
      assert.equal(companyRows.length, 0);

      const platformRows = await app.get(AuditQueryService).listPlatformSecurityEvents({});
      assert.equal(platformRows.length, 1);
      assert.equal(platformRows[0]?.tenantId, null);
    });

    it('exposes the platform plane only to a platform actor', async () => {
      await securityService().record({ action: 'security.login_failed', category: 'Login' });

      await asPlatform(agent().get('/platform/security/events')).expect(200);
      await asPerson(agent().get('/platform/security/events'), auditorUboss).expect(403);
    });

    it('filters the security trail by category, severity and outcome', async () => {
      await securityService().record({
        action: 'security.login_failed',
        category: 'Login',
        severity: 'Notice',
        outcome: 'Failed',
        tenantId,
      });
      await securityService().record({
        action: 'security.mfa_replay_rejected',
        category: 'Risk',
        severity: 'Warning',
        outcome: 'Blocked',
        tenantId,
      });

      const risky = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/security-events`).query({ category: 'Risk' }),
        auditorUboss,
      ).expect(200);
      assert.equal((risky.body as { rows: unknown[] }).rows.length, 1);

      const blocked = await asPerson(
        agent().get(`/tenants/${tenantId}/audit/security-events`).query({ outcome: 'Blocked' }),
        auditorUboss,
      ).expect(200);
      assert.equal((blocked.body as { rows: unknown[] }).rows.length, 1);

      await asPerson(
        agent().get(`/tenants/${tenantId}/audit/security-events`).query({ severity: 'Loud' }),
        auditorUboss,
      ).expect(400);
    });
  });

  // =========================================================================
  describe('break-glass recovery', () => {
    const validRequest = {
      reason: 'Customer reports every admin is locked out after an SSO misconfiguration.',
      externalReference: 'INC-4821',
      allowedModules: ['settings', 'users'],
      allowedActions: ['View', 'EditDraft'],
    };

    const raise = async () =>
      breakGlass().request({
        tenantId,
        requesterUserId: supportId,
        ...validRequest,
      });

    it('walks the full lifecycle and audits every step into the customer trail', async () => {
      const created = await raise();
      assert.equal(created.state, 'Requested');
      assert.equal(created.identityVerificationState, 'Unverified');
      assert.equal(created.customerNotificationState, 'Pending');
      assert.equal(created.expiresAt, null, 'A request grants nothing and expires nothing.');

      const verified = await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'VerifiedByHuman',
        note: 'Called the number on the signed contract.',
      });
      assert.equal(verified.state, 'IdentityVerified');

      const approved = await breakGlass().approve({
        requestId: created.id,
        approverUserId: platformId,
        minutes: 30,
        note: 'Approved on the incident call.',
      });
      assert.equal(approved.state, 'Approved');
      assert.ok(approved.expiresAt);

      const active = await breakGlass().activate({
        requestId: created.id,
        actorUserId: supportId,
      });
      assert.equal(active.state, 'Active');

      const grant = await breakGlass().activeGrantFor(created.id);
      assert.ok(grant);
      assert.deepEqual([...grant.modules], ['settings', 'users']);
      assert.deepEqual([...grant.actions], ['View', 'EditDraft']);

      const notified = await breakGlass().recordCustomerNotification({
        requestId: created.id,
        actorUserId: platformId,
        outcome: 'Sent',
      });
      assert.equal(notified.customerNotificationState, 'Sent');
      assert.ok(notified.customerNotifiedAt);

      const revoked = await breakGlass().revoke({
        requestId: created.id,
        revokedByUserId: platformId,
        reason: 'Incident closed.',
      });
      assert.equal(revoked.state, 'Revoked');
      assert.equal(await breakGlass().activeGrantFor(created.id), null);

      // The audit rows land in the CUSTOMER's trail, so the company can see that somebody broke
      // glass into it. Platform-only recording would make transparency optional.
      const trail = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          actionPrefix: 'break_glass.',
          take: 50,
        }),
      );
      const actions = trail.map((row) => row.action).sort();
      assert.deepEqual(actions, [
        'break_glass.activated',
        'break_glass.approved',
        'break_glass.identity_verified',
        'break_glass.notification_sent',
        'break_glass.requested',
        'break_glass.revoked',
        'break_glass.used',
      ]);
      assert.ok(
        trail.every((row) => row.resourceRef === 'INC-4821'),
        'Every step should carry the incident reference.',
      );
    });

    it('refuses self-approval, and records the attempt', async () => {
      const created = await raise();
      await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'VerifiedByHuman',
      });

      await assert.rejects(
        () => breakGlass().approve({ requestId: created.id, approverUserId: supportId }),
        /cannot be self-approved/i,
      );

      const blocked = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.break_glass_self_approval_blocked',
          take: 5,
        }),
      );
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]?.severity, 'Critical');
      assert.equal(blocked[0]?.outcome, 'Blocked');
    });

    it('refuses self-verification of identity', async () => {
      const created = await raise();
      await assert.rejects(
        () =>
          breakGlass().verifyIdentity({
            requestId: created.id,
            verifierUserId: supportId,
            result: 'VerifiedByHuman',
          }),
        /cannot verify their own identity/i,
      );
    });

    it('cannot be approved before identity is verified', async () => {
      const created = await raise();
      await assert.rejects(
        () => breakGlass().approve({ requestId: created.id, approverUserId: platformId }),
        /requires "IdentityVerified"/,
      );
    });

    it('cannot be activated before it is approved', async () => {
      const created = await raise();
      await assert.rejects(
        () => breakGlass().activate({ requestId: created.id, actorUserId: supportId }),
        /requires "Approved"/,
      );
    });

    it('denies the request when identity verification fails, terminally', async () => {
      const created = await raise();
      const failed = await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'Failed',
        note: 'The caller could not confirm the contract details.',
      });
      assert.equal(failed.state, 'Denied');

      // No second attempt on the same record: raise a new request, and leave the failure visible.
      await assert.rejects(
        () =>
          breakGlass().verifyIdentity({
            requestId: created.id,
            verifierUserId: platformId,
            result: 'VerifiedByHuman',
          }),
        /requires "Requested"/,
      );
    });

    it('refuses an unbounded scope', async () => {
      await assert.rejects(
        () =>
          breakGlass().request({
            tenantId,
            requesterUserId: supportId,
            reason: validRequest.reason,
            allowedModules: [],
            allowedActions: ['View'],
          }),
        /must name the modules/i,
      );
      await assert.rejects(
        () =>
          breakGlass().request({
            tenantId,
            requesterUserId: supportId,
            reason: validRequest.reason,
            allowedModules: ['settings'],
            allowedActions: [],
          }),
        /must name the actions/i,
      );
    });

    it('refuses Administer and ManageAccess, which would outlive the window', async () => {
      for (const action of ['Administer', 'ManageAccess']) {
        await assert.rejects(
          () =>
            breakGlass().request({
              tenantId,
              requesterUserId: supportId,
              reason: validRequest.reason,
              allowedModules: ['users'],
              allowedActions: [action],
            }),
          /make the expiry decorative/i,
          `${action} must be refused.`,
        );
      }
    });

    it('refuses a platform module — break-glass is access into a customer company', async () => {
      await assert.rejects(
        () =>
          breakGlass().request({
            tenantId,
            requesterUserId: supportId,
            reason: validRequest.reason,
            allowedModules: ['platform-settings'],
            allowedActions: ['View'],
          }),
        /only company modules/i,
      );
    });

    it('refuses a reason with no substance', async () => {
      await assert.rejects(
        () =>
          breakGlass().request({
            tenantId,
            requesterUserId: supportId,
            reason: 'urgent',
            allowedModules: ['settings'],
            allowedActions: ['View'],
          }),
        /at least 20 characters/,
      );
    });

    it('caps the window', async () => {
      const created = await raise();
      await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'VerifiedBySecondFactor',
      });
      await assert.rejects(
        () =>
          breakGlass().approve({
            requestId: created.id,
            approverUserId: platformId,
            minutes: 60 * 24 * 30,
          }),
        /between 1 and 480 minutes/,
      );
    });

    it('stops granting the moment the window passes, without waiting for a sweep', async () => {
      const created = await raise();
      await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'VerifiedByHuman',
      });
      await breakGlass().approve({
        requestId: created.id,
        approverUserId: platformId,
        minutes: 1,
      });
      await breakGlass().activate({ requestId: created.id, actorUserId: supportId });

      // Rewind the expiry rather than waiting a minute. `break_glass_requests` is not
      // append-only, so this is an ordinary update — the trails are what cannot be edited.
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `UPDATE break_glass_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        created.id,
      );

      assert.equal(await breakGlass().activeGrantFor(created.id), null);
      assert.equal((await breakGlass().findById(created.id)).state, 'Expired');
    });

    it('counts uses, so "granted but never used" is provable', async () => {
      const created = await raise();
      await breakGlass().verifyIdentity({
        requestId: created.id,
        verifierUserId: platformId,
        result: 'VerifiedByHuman',
      });
      await breakGlass().approve({ requestId: created.id, approverUserId: platformId });
      await breakGlass().activate({ requestId: created.id, actorUserId: supportId });

      assert.equal((await breakGlass().findById(created.id)).usageCount, 0);
      await breakGlass().activeGrantFor(created.id);
      await breakGlass().activeGrantFor(created.id);
      const used = await breakGlass().findById(created.id);
      assert.equal(used.usageCount, 2);
      assert.ok(used.lastUsedAt);
    });

    it('requires a written reason to suppress the customer notification', async () => {
      const created = await raise();
      await assert.rejects(
        () =>
          breakGlass().recordCustomerNotification({
            requestId: created.id,
            actorUserId: platformId,
            outcome: 'Suppressed',
          }),
        /requires a written reason/i,
      );

      const suppressed = await breakGlass().recordCustomerNotification({
        requestId: created.id,
        actorUserId: platformId,
        outcome: 'Suppressed',
        suppressionReason: 'Active investigation in which the customer contact is the subject.',
      });
      assert.equal(suppressed.customerNotificationState, 'Suppressed');

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findSecurityEvents({
          tenantId,
          action: 'security.break_glass_notification_suppressed',
          take: 5,
        }),
      );
      assert.equal(events[0]?.severity, 'Critical');
    });

    it('surfaces outstanding notification obligations', async () => {
      await raise();
      const pending = await breakGlass().list({ notificationPending: true });
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.customerNotificationState, 'Pending');
    });

    it('is refused by the database even if the service is bypassed', async () => {
      // The same three rules again, at the row level. A future code path that skipped the
      // service would still be unable to store a self-approved, unverified or endless grant.
      const insert = (columns: string, values: string) =>
        ctx.admin.unsafeRootClient.$executeRawUnsafe(
          `INSERT INTO break_glass_requests
             (id, tenant_id, requester_user_id, reason, created_at, updated_at, ${columns})
           VALUES (gen_random_uuid(), '${tenantId}', '${supportId}', 'a reason long enough to pass',
                   NOW(), NOW(), ${values})`,
        );

      await assert.rejects(
        () =>
          insert(
            'state, identity_verification_state, approver_user_id, expires_at',
            `'Approved', 'VerifiedByHuman', '${supportId}', NOW() + INTERVAL '1 hour'`,
          ),
        /break_glass_approver_is_not_requester/,
      );
      await assert.rejects(
        () =>
          insert(
            'state, identity_verification_state, approver_user_id',
            `'Approved', 'VerifiedByHuman', '${platformId}'`,
          ),
        /break_glass_approved_needs_approver_and_expiry/,
      );
      await assert.rejects(
        () =>
          insert(
            'state, identity_verification_state, approver_user_id, expires_at',
            `'Active', 'Unverified', '${platformId}', NOW() + INTERVAL '1 hour'`,
          ),
        /break_glass_approved_needs_verified_identity/,
      );
    });

    it('is platform-only at the request layer', async () => {
      await asPerson(agent().get('/platform/break-glass'), adminUboss).expect(403);
      await asPlatform(agent().get('/platform/break-glass'), supportUboss).expect(200);
    });

    it('takes the requester from the authenticated actor, not the body', async () => {
      const response = await asPlatform(agent().post('/platform/break-glass'), supportUboss)
        .send({ tenantId, ...validRequest })
        .expect(201);

      assert.equal((response.body as { requesterUserId: string }).requesterUserId, supportId);
    });

    it('rejects a body that tries to name its own requester', async () => {
      await asPlatform(agent().post('/platform/break-glass'), supportUboss)
        .send({ tenantId, ...validRequest, requesterUserId: platformId })
        .expect(400);
    });
  });
});
