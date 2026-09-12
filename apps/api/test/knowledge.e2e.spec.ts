import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { DEFAULT_EXTERNAL_EGRESS_CEILING, DEFAULT_MAX_UPLOAD_BYTES } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { FileController } from '../src/knowledge/file.controller.js';
import { FileService } from '../src/knowledge/file.service.js';
import { KnowledgeController } from '../src/knowledge/knowledge.controller.js';
import { KnowledgeService } from '../src/knowledge/knowledge.service.js';
import {
  EICAR_TEST_STRING,
  MALWARE_SCANNER,
  MockMalwareScanner,
} from '../src/knowledge/malware-scanner.js';
import {
  InMemoryStorageAdapter,
  S3StorageAdapter,
  STORAGE_ADAPTER,
  StorageUnavailableError,
} from '../src/knowledge/storage-adapter.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
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
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Knowledge, files, classification and safe uploads — Prompt 35, against real PostgreSQL.
 *
 * The rules are proved without a database in `packages/types/src/knowledge.test.ts`. What can only
 * be proved here is what the prompt asks for by name:
 *
 *  * **Malware scanning before use** — an infected file exists as a row and is refused by every
 *    read path, including the one that puts it into company knowledge.
 *  * **Upload size and type validation** — refused before the bytes reach storage.
 *  * **Classification-driven export rules** — the two ceilings, and a `Restricted` file that
 *    cannot leave.
 *  * **Legal hold beating retention** — in the service and in the database.
 *  * **Tenant isolation** — one company's files invisible to another, checked through the API and
 *    directly against the tables.
 */
describe('knowledge, files and safe uploads (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let approverId: string;
  let approverUboss: string;
  let employeeUboss: string;
  let otherAdminId: string;
  let otherAdminUboss: string;
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
      controllers: [FileController, KnowledgeController],
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
        FileService,
        KnowledgeService,
        // The same bindings the module makes. Bound as values rather than classes so the suite can
        // reach into the in-memory store and prove a deletion actually removed bytes.
        { provide: STORAGE_ADAPTER, useValue: new InMemoryStorageAdapter() },
        { provide: MALWARE_SCANNER, useValue: new MockMalwareScanner() },
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
      slug: 'knowledge-co',
      name: 'Knowledge Co',
      firstMember: { email: 'first@knowledge.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-knowledge-co',
      name: 'Other Knowledge Co',
      firstMember: { email: 'first@other-knowledge.example', displayName: 'Other First' },
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
        admin: await make(
          'UB-KNAD-0001',
          'admin@knowledge.example',
          'Admin',
          provisioned.tenant.id,
        ),
        approver: await make(
          'UB-KNAP-0001',
          'approver@knowledge.example',
          'Approver',
          provisioned.tenant.id,
        ),
        employee: await make(
          'UB-KNEM-0001',
          'employee@knowledge.example',
          'Employee',
          provisioned.tenant.id,
        ),
        otherAdmin: await make(
          'UB-KNOA-0001',
          'admin@other-knowledge.example',
          'Other Admin',
          other.tenant.id,
        ),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    approverId = people.approver.id;
    approverUboss = people.approver.ubossUniqueId;
    employeeUboss = people.employee.ubossUniqueId;
    otherAdminId = people.otherAdmin.id;
    otherAdminUboss = people.otherAdmin.ubossUniqueId;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-KNPL-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [people.approver.id, 'Approver', 'WholeCompany'],
        [people.employee.id, 'Employee', 'OwnWork'],
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

  const files = () => app.get(FileService);
  const knowledge = () => app.get(KnowledgeService);
  const storage = () => app.get<InMemoryStorageAdapter>(STORAGE_ADAPTER);

  const upload = async (
    options: {
      filename?: string;
      contentType?: string;
      body?: string;
      classification?: 'Public' | 'Internal' | 'Confidential' | 'Restricted';
      tenant?: string;
      actor?: string;
    } = {},
  ) =>
    files().upload({
      scope: scope(options.tenant ?? tenantId),
      actorUserId: options.actor ?? adminId,
      filename: options.filename ?? 'handbook.txt',
      contentType: options.contentType ?? 'text/plain',
      bytes: Buffer.from(options.body ?? 'The company handbook.', 'utf8'),
      ...(options.classification === undefined ? {} : { classification: options.classification }),
    });

  // -------------------------------------------------------------------------
  // Upload validation
  // -------------------------------------------------------------------------

  it('accepts a permitted file, stores the bytes outside the database and scans it clean', async () => {
    const before = storage().size;
    const file = await upload();

    assert.equal(file.scanState, 'Clean');
    assert.equal(file.usable, true);
    assert.equal(
      file.scannedByRealScanner,
      false,
      'the mock scanner must never present itself as a real antivirus product',
    );
    assert.equal(file.hasContent, true);
    assert.equal(storage().size, before + 1, 'the bytes belong in the adapter, not in a column');

    const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.storedFile.findUniqueOrThrow({ where: { id: file.id } }),
    );
    assert.equal(row.storageRef !== null, true);
    assert.equal(row.contentHash?.length, 64, 'a sha-256 hex digest');
  });

  it('refuses an executable whatever content type it claims, before anything is stored', async () => {
    const before = storage().size;

    await assert.rejects(
      () => upload({ filename: 'invoice.exe', contentType: 'text/plain' }),
      (error: unknown) => {
        const problems = problemsFrom(error);
        assert.equal(
          problems.some((problem) => problem.includes('.exe')),
          true,
          `expected the extension refusal, got ${JSON.stringify(problems)}`,
        );
        return true;
      },
    );

    assert.equal(storage().size, before, 'a refused upload must not reach storage');
  });

  it('refuses a filename containing a path', async () => {
    await assert.rejects(
      () => upload({ filename: '../../etc/passwd' }),
      (error: unknown) =>
        problemsFrom(error).some((problem) => problem.includes('cannot contain a path')),
    );
  });

  it('refuses a content type outside the allowlist', async () => {
    await assert.rejects(
      () => upload({ filename: 'archive.zip', contentType: 'application/zip' }),
      (error: unknown) =>
        problemsFrom(error).some((problem) => problem.includes('not an accepted file type')),
    );
  });

  it('refuses a file over the company limit and records the refusal in the security trail', async () => {
    await files().setPolicy({
      scope: scope(),
      actorUserId: adminId,
      reason: 'Tightening the limit for this test.',
      policy: {
        maxUploadBytes: 32,
        allowedContentTypes: ['text/plain'],
        defaultRetentionDays: null,
        defaultRetentionAction: 'DeleteContent',
        exportCeiling: 'Confidential',
        externalEgressCeiling: 'Internal',
      },
    });

    await assert.rejects(
      () => upload({ body: 'x'.repeat(200) }),
      (error: unknown) => problemsFrom(error).some((problem) => problem.includes('The limit is')),
    );

    const events = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { tenantId, action: 'security.file_upload_refused' },
      }),
    );
    assert.equal(events.length, 1, 'a refused upload is a security event, not only a 400');
  });

  // -------------------------------------------------------------------------
  // Scanning — the "before use" rule
  // -------------------------------------------------------------------------

  it('quarantines nothing and flags the EICAR test file as infected', async () => {
    const file = await upload({ filename: 'eicar.txt', body: EICAR_TEST_STRING });

    assert.equal(file.scanState, 'Infected');
    assert.equal(file.usable, false);
    assert.equal(file.scannedByRealScanner, false);

    const events = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { tenantId, action: 'security.file_scan_found_malware' },
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.severity, 'Critical');
  });

  it('refuses to download an infected file', async () => {
    const file = await upload({ filename: 'eicar.txt', body: EICAR_TEST_STRING });

    await assert.rejects(
      () => files().download({ scope: scope(), actorUserId: adminId, fileId: file.id }),
      (error: Error) => error.message.includes('infected'),
    );
  });

  it('refuses to put an unscanned file into a knowledge source', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Policies',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
    });

    // A file that exists but was never scanned. Written directly, because the upload path always
    // scans — which is the point: this is the state a queued scanner would leave behind.
    const pending = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.storedFile.create({
        data: {
          tenantId,
          filename: 'unscanned.txt',
          contentType: 'text/plain',
          sizeBytes: 10,
          storageRef: 'tenants/x/files/unscanned',
          uploadedByUserId: adminId,
        },
      }),
    );
    assert.equal(pending.scanState, 'Pending');

    await assert.rejects(
      () =>
        knowledge().addFile({
          scope: scope(),
          actorUserId: adminId,
          sourceId: source.id,
          fileId: pending.id,
        }),
      (error: Error) => error.message.includes('scanned clean'),
    );
  });

  it('will not scan a clean file again, and will scan a quarantined one', async () => {
    const file = await upload();

    await assert.rejects(
      () => files().scan({ scope: scope(), fileId: file.id }),
      (error: Error) => error.message.includes('already been scanned'),
    );

    await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.storedFile.update({
        where: { id: file.id },
        data: { scanState: 'Quarantined' },
      }),
    );

    const rescanned = await files().scan({ scope: scope(), fileId: file.id });
    assert.equal(rescanned.scanState, 'Clean');
  });

  // -------------------------------------------------------------------------
  // Classification, export and egress
  // -------------------------------------------------------------------------

  it('permits a Confidential download and refuses a Restricted one under the default ceiling', async () => {
    const confidential = await upload({
      filename: 'contract.pdf',
      contentType: 'application/pdf',
      classification: 'Confidential',
    });
    const restricted = await upload({
      filename: 'payroll.csv',
      contentType: 'text/csv',
      classification: 'Restricted',
    });

    const ok = await files().download({
      scope: scope(),
      actorUserId: adminId,
      fileId: confidential.id,
    });
    assert.equal(ok.bytes.length > 0, true);

    await assert.rejects(
      () => files().download({ scope: scope(), actorUserId: adminId, fileId: restricted.id }),
      (error: Error) => error.message.includes('cannot be exported'),
    );
  });

  it('records a download in the security trail so Data Exports can show it', async () => {
    const file = await upload();
    await files().download({ scope: scope(), actorUserId: adminId, fileId: file.id });

    const events = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.securityEvent.findMany({
        where: { tenantId, action: 'security.file_downloaded' },
      }),
    );
    assert.equal(events.length, 1);
  });

  it('refuses sensitive content leaving the company, and refuses it again when redaction would be needed', async () => {
    // The default egress ceiling is `Internal`, so `Confidential` cannot leave at all.
    assert.equal(DEFAULT_EXTERNAL_EGRESS_CEILING, 'Internal');
    const blocked = await files().mayLeaveTheCompany({
      scope: scope(),
      classification: 'Confidential',
    });
    assert.equal(blocked.permitted, false);

    // Raise the ceiling and it is still refused — because it would need redaction and nothing
    // redacts. A product that answered "permitted" here would send it intact.
    await files().setPolicy({
      scope: scope(),
      actorUserId: adminId,
      reason: 'Permitting confidential egress for this test.',
      policy: {
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        allowedContentTypes: ['text/plain'],
        defaultRetentionDays: null,
        defaultRetentionAction: 'DeleteContent',
        exportCeiling: 'Restricted',
        externalEgressCeiling: 'Confidential',
      },
    });

    const stillBlocked = await files().mayLeaveTheCompany({
      scope: scope(),
      classification: 'Confidential',
    });
    assert.equal(stillBlocked.redactionRequired, true);
    assert.equal(
      stillBlocked.permitted,
      false,
      'UBoss has no redaction engine, so a transfer needing redaction is refused',
    );

    // `Internal` is not sensitive, so it goes.
    const allowed = await files().mayLeaveTheCompany({
      scope: scope(),
      classification: 'Internal',
    });
    assert.equal(allowed.permitted, true);
    assert.equal(allowed.redactionRequired, false);
  });

  it('refuses a policy whose egress ceiling is looser than its export ceiling', async () => {
    await assert.rejects(() =>
      files().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'Attempting an incoherent policy.',
        policy: {
          maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
          allowedContentTypes: ['text/plain'],
          defaultRetentionDays: null,
          defaultRetentionAction: 'DeleteContent',
          exportCeiling: 'Internal',
          externalEgressCeiling: 'Restricted',
        },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Knowledge sources
  // -------------------------------------------------------------------------

  it('refuses to let an agent consult a source nobody approved, and permits it once approved', async () => {
    const agentId = '01930000-0000-7000-8000-00000000ab01';
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Supplier agreements',
      kind: 'UploadedFiles',
      accessScope: 'NamedAgentsOnly',
      namedAgentIds: [agentId],
    });

    const beforeApproval = await knowledge().canRead({
      scope: scope(),
      sourceId: source.id,
      engineAgentId: agentId,
    });
    assert.equal(beforeApproval.decision.permitted, false);

    await knowledge().approve({
      scope: scope(),
      actorUserId: approverId,
      sourceId: source.id,
    });

    const afterApproval = await knowledge().canRead({
      scope: scope(),
      sourceId: source.id,
      engineAgentId: agentId,
    });
    assert.equal(afterApproval.decision.permitted, true);

    const otherAgent = await knowledge().canRead({
      scope: scope(),
      sourceId: source.id,
      engineAgentId: '01930000-0000-7000-8000-00000000ab02',
    });
    assert.equal(otherAgent.decision.permitted, false, 'an agent not named on it may not read it');
  });

  it('sends an approved source back to draft when it is changed', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Handbook',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
    });
    await knowledge().approve({ scope: scope(), actorUserId: approverId, sourceId: source.id });

    const changed = await knowledge().update({
      scope: scope(),
      actorUserId: adminId,
      sourceId: source.id,
      classification: 'Confidential',
    });

    assert.equal(changed.state, 'Draft');
    assert.equal(changed.approvedByUserId, null);
    assert.equal(changed.approvedAt, null);
  });

  it('refuses a file more sensitive than the source that would hold it', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Internal notes',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
      classification: 'Internal',
    });
    const restricted = await upload({
      filename: 'payroll.csv',
      contentType: 'text/csv',
      classification: 'Restricted',
    });

    await assert.rejects(
      () =>
        knowledge().addFile({
          scope: scope(),
          actorUserId: adminId,
          sourceId: source.id,
          fileId: restricted.id,
        }),
      (error: Error) => /approved to hold|Restricted/.test(error.message),
    );
  });

  it('refuses to reclassify a source below what its files already hold', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Contracts',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
      classification: 'Confidential',
    });
    const confidential = await upload({
      filename: 'contract.pdf',
      contentType: 'application/pdf',
      classification: 'Confidential',
    });
    await knowledge().addFile({
      scope: scope(),
      actorUserId: adminId,
      sourceId: source.id,
      fileId: confidential.id,
    });

    await assert.rejects(
      () =>
        knowledge().update({
          scope: scope(),
          actorUserId: adminId,
          sourceId: source.id,
          classification: 'Internal',
        }),
      (error: Error) => error.message.includes('already holds Confidential material'),
    );
  });

  it('keeps an unscanned file out of the list an agent would read', async () => {
    const agentId = '01930000-0000-7000-8000-00000000ab03';
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Mixed',
      kind: 'UploadedFiles',
      accessScope: 'NamedAgentsOnly',
      namedAgentIds: [agentId],
    });
    const clean = await upload();
    await knowledge().addFile({
      scope: scope(),
      actorUserId: adminId,
      sourceId: source.id,
      fileId: clean.id,
    });
    await knowledge().approve({ scope: scope(), actorUserId: approverId, sourceId: source.id });

    // The file becomes unusable *after* it was added — exactly what a later re-scan would do.
    await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.storedFile.update({
        where: { id: clean.id },
        data: { scanState: 'Quarantined' },
      }),
    );

    const outcome = await knowledge().readForAgent({
      scope: scope(),
      sourceId: source.id,
      engineAgentId: agentId,
    });
    assert.deepEqual(
      outcome.fileIds,
      [],
      'a quarantined file is not readable, source or no source',
    );
    assert.equal(outcome.unusableFileCount, 1);
  });

  // -------------------------------------------------------------------------
  // Retention, legal hold and deletion
  // -------------------------------------------------------------------------

  it('deletes the content and keeps the record, and removes the bytes from storage', async () => {
    const file = await upload();
    const held = storage().size;

    const deleted = await files().delete({
      scope: scope(),
      actorUserId: adminId,
      fileId: file.id,
      reason: 'The customer asked for it.',
    });

    assert.equal(deleted.deletedAt !== null, true);
    assert.equal(deleted.hasContent, false);
    assert.equal(deleted.usable, false);
    assert.equal(deleted.filename, 'handbook.txt', 'the record of what was deleted survives');
    assert.equal(storage().size, held - 1, 'the bytes are gone from the adapter too');
  });

  it('refuses to delete a file under a legal hold, in the service and in the database', async () => {
    const file = await upload();
    await files().setLegalHold({
      scope: scope(),
      actorUserId: adminId,
      fileId: file.id,
      onHold: true,
      reason: 'Litigation hold LH-2026-11.',
    });

    await assert.rejects(
      () =>
        files().delete({
          scope: scope(),
          actorUserId: adminId,
          fileId: file.id,
          reason: 'Trying anyway.',
        }),
      (error: Error) => error.message.includes('legal hold'),
    );

    // And the database refuses it too, so a future code path cannot get around the service.
    await assert.rejects(
      () =>
        ctx.prisma.runInTenantTransaction(scope(), () =>
          ctx.prisma.client.storedFile.update({
            where: { id: file.id },
            data: {
              deletedAt: new Date(),
              deletedReason: 'Bypassing the service.',
              storageRef: null,
            },
          }),
        ),
      (error: Error) => /held_file_is_not_deleted/.test(error.message),
    );
  });

  it('sweeps expired files and skips the held ones', async () => {
    const ordinary = await upload({ filename: 'old.txt' });
    const held = await upload({ filename: 'held.txt' });
    const review = await upload({ filename: 'decide.txt' });

    await files().setLegalHold({
      scope: scope(),
      actorUserId: adminId,
      fileId: held.id,
      onHold: true,
      reason: 'Litigation hold LH-2026-12.',
    });

    const yesterday = new Date(Date.now() - 86_400_000);
    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      await ctx.prisma.client.storedFile.updateMany({
        where: { id: { in: [ordinary.id, held.id, review.id] } },
        data: { retentionExpiresAt: yesterday },
      });
      await ctx.prisma.client.storedFile.update({
        where: { id: review.id },
        data: { retentionAction: 'Review' },
      });
    });

    const result = await files().sweepRetention({ scope: scope() });
    assert.equal(result.deleted, 1);
    assert.equal(result.heldBack, 2, 'the held file and the one asking for a decision both stay');

    const rows = await ctx.prisma.runInTenantTransaction(scope(), () =>
      ctx.prisma.client.storedFile.findMany({ where: { tenantId }, orderBy: { filename: 'asc' } }),
    );
    const byName = new Map(rows.map((row) => [row.filename, row]));
    assert.equal(byName.get('old.txt')?.deletedAt !== null, true);
    assert.equal(byName.get('held.txt')?.deletedAt, null);
    assert.equal(byName.get('decide.txt')?.deletedAt, null);
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  it('refuses an Employee the upload, the download and the policy', async () => {
    const file = await upload();

    await asPerson(agent().get(`/tenants/${tenantId}/files`), employeeUboss).expect(403);
    await asPerson(agent().post(`/tenants/${tenantId}/files`), employeeUboss)
      .send({
        filename: 'notes.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('hello').toString('base64'),
      })
      .expect(403);
    await asPerson(
      agent().get(`/tenants/${tenantId}/files/${file.id}/content`),
      employeeUboss,
    ).expect(403);

    // And the knowledge sources too. An Employee holds `settings:View` — it is what lets them
    // open Settings at all — and that must not be the grant that lists every document the
    // company holds.
    await asPerson(agent().get(`/tenants/${tenantId}/knowledge-sources`), employeeUboss).expect(
      403,
    );
  });

  it('refuses an Employee the access preview, which lists a source’s file ids', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Peekable',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
    });

    // `/access` returns the decision *and the usable file ids*. Under `settings:View` an Employee
    // could have enumerated what every knowledge source holds, which is why it now goes through the
    // same rule as the inventory itself.
    await asPerson(
      agent().get(`/tenants/${tenantId}/knowledge-sources/${source.id}/access`),
      employeeUboss,
    ).expect(403);

    await asPerson(
      agent().get(`/tenants/${tenantId}/knowledge-sources/${source.id}/access`),
      approverUboss,
    ).expect(200);
  });

  it('lets an Approver see the inventory they are asked to approve', async () => {
    await upload();
    await asPerson(agent().get(`/tenants/${tenantId}/files`), approverUboss).expect(200);
    await asPerson(agent().get(`/tenants/${tenantId}/knowledge-sources`), approverUboss).expect(
      200,
    );
  });

  it('lets an Approver approve a source but not download its files', async () => {
    const source = await knowledge().create({
      scope: scope(),
      actorUserId: adminId,
      name: 'Approvable',
      kind: 'UploadedFiles',
      accessScope: 'WholeCompany',
    });
    const file = await upload();

    await asPerson(
      agent().post(`/tenants/${tenantId}/knowledge-sources/${source.id}/approve`),
      approverUboss,
    )
      .send({})
      .expect(201);

    // `Export` is a CompanyAdmin grant. An Approver approving what a source holds is not the same
    // authority as taking its contents away, and the role templates already say so.
    await asPerson(
      agent().get(`/tenants/${tenantId}/files/${file.id}/content`),
      approverUboss,
    ).expect(403);
  });

  it('refuses an Approver the authoring routes', async () => {
    await asPerson(agent().post(`/tenants/${tenantId}/knowledge-sources`), approverUboss)
      .send({ name: 'Approver made this', kind: 'UploadedFiles', accessScope: 'WholeCompany' })
      .expect(403);
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('shows one company nothing of another, through the API and in the tables', async () => {
    const mine = await upload({ filename: 'ours.txt' });
    await upload({ filename: 'theirs.txt', tenant: otherTenantId, actor: otherAdminId });

    const listed = await asPerson(
      agent().get(`/tenants/${otherTenantId}/files`),
      otherAdminUboss,
      otherTenantId,
    ).expect(200);

    const names = (listed.body as { files: { filename: string }[] }).files.map(
      (file) => file.filename,
    );
    assert.deepEqual(names, ['theirs.txt']);

    // And the other company's admin cannot reach ours by id, even knowing it.
    await asPerson(
      agent().get(`/tenants/${otherTenantId}/files/${mine.id}/content`),
      otherAdminUboss,
      otherTenantId,
    ).expect(404);

    // Under RLS the row is not merely filtered by a WHERE clause — it is invisible.
    const visible = await ctx.prisma.runInTenantTransaction(scope(otherTenantId), () =>
      ctx.prisma.client.storedFile.findMany({ where: { id: mine.id } }),
    );
    assert.deepEqual(visible, []);
  });

  it('refuses to reach another company by putting its id in the path', async () => {
    await asPerson(
      agent().get(`/tenants/${otherTenantId}/files`),
      adminUboss,
      otherTenantId,
    ).expect(403);
  });

  // -------------------------------------------------------------------------
  // The adapter seam
  // -------------------------------------------------------------------------

  it('refuses every call on the unconfigured S3 adapter rather than appearing to store anything', async () => {
    const s3 = new S3StorageAdapter();
    assert.equal(s3.canStore, false);

    await assert.rejects(
      () =>
        s3.put({
          tenantId,
          filename: 'x.txt',
          contentType: 'text/plain',
          bytes: Buffer.from('x'),
        }),
      StorageUnavailableError,
    );
    await assert.rejects(() => s3.get('anything'), StorageUnavailableError);
    await assert.rejects(() => s3.delete('anything'), StorageUnavailableError);
  });

  it('reports which adapters are in use and that neither is a real product', async () => {
    const adapters = files().adapters();
    assert.equal(adapters.storage, 'in-memory');
    assert.equal(adapters.storageCanStore, true);
    assert.equal(adapters.scanner, 'mock');
  });

  /**
   * The validation messages from a thrown `BadRequestException`.
   *
   * `new BadRequestException(string[])` leaves `error.message` as the class name — the list is on
   * `response.message`, which is what a client receives.
   */
  function problemsFrom(error: unknown): string[] {
    const response = (error as { response?: { message?: unknown } }).response;
    const message = response?.message;
    if (Array.isArray(message)) return message.map((entry) => String(entry));
    return [String(message ?? (error as Error).message)];
  }
});
