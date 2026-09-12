import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  CONNECTOR_DEFINITIONS,
  connectorDefinition,
  CREDENTIAL_EXPIRY_WARNING_DAYS,
  derivedConnectionState,
  HIGH_RISK_TOOL_CATEGORIES,
  isCredentialExpiringSoon,
  isHighRiskToolCategory,
  TOOL_ACTION_CATEGORIES,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { ConnectionController } from '../src/connections/connection.controller.js';
import { ConnectionService } from '../src/connections/connection.service.js';
import { ConnectorAdapter, MockConnectorAdapter } from '../src/connections/connector-adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
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

/**
 * Prompt 16 — Connections, Secrets and Agent Tool Permission.
 *
 * Seven properties carry this prompt:
 *
 *   1. **A connection stores a reference, never a credential.** No route returns one, and the
 *      database refuses a handle that looks like ciphertext.
 *   2. **Agent Tool Permission is not a human permission.** `settings:Administer` grants none of
 *      it, and `mayAgentUse` cannot be satisfied by passing a person.
 *   3. **A high-risk category needs a reason**, in the service and in the database.
 *   4. **The five states are derived**, so an expired credential is expired the moment it expires.
 *   5. **A User Connection is never transferred** — offboarding disables it.
 *   6. **The check history is append-only**, so "it has been failing since Tuesday" stays true.
 *   7. **Tenant isolation**, including the grant → connection reference.
 */
describe('connections, secrets and tool permission (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let peerId: string;
  let peerUboss: string;
  let ownerId: string;

  /**
   * Two Engine Agent ids. Real RFC-shaped uuids, not `5555-...-5555`: the variant nibble in a
   * repeated-digit string is invalid, so `@IsUUID()` refuses it — which is correct, and cost this
   * suite a failing HTTP test until the fixture was fixed rather than the validator relaxed.
   */
  const AGENT = 'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6';
  const OTHER_AGENT = 'a1b2c3d4-2222-4222-9222-a1b2c3d4e5f6';

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const connections = () => app.get(ConnectionService);
  const vault = () => app.get(SecretsVault);

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
      controllers: [ConnectionController],
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
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        ConnectionService,
        // The real bindings, not stubs: the local sealed vault and the mock connector are what a
        // deployment without an external provider actually runs.
        { provide: SecretsVault, useClass: LocalSealedSecretsVault },
        { provide: ConnectorAdapter, useClass: MockConnectorAdapter },
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
      slug: 'connect-co',
      name: 'Connect Co',
      firstMember: { email: 'first@connect.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-connect-co',
      name: 'Other Connect Co',
      firstMember: { email: 'first@other-connect.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@connect.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-CADM-0001', 'Connect Admin'),
        employee: await member('UB-CEMP-0001', 'Connect Employee'),
        peer: await member('UB-CPER-0001', 'Connect Peer'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-COWN-0001',
          email: 'owner@connect-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    peerId = people.peer.id;
    peerUboss = people.peer.ubossUniqueId;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
        [peerId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** A working company ERP connection. */
  const createErp = (secret = 'mock:ok', label = 'Mock ERP (Test)') =>
    connections().create({
      scope: scope(),
      actorUserId: adminId,
      scopeKind: 'Company',
      connectorKind: 'mock-erp',
      label,
      environment: 'Test',
      secret,
    });

  // =========================================================================
  describe('the catalogue and the vocabulary', () => {
    it('lists only connectors that have an adapter behind them', () => {
      // The pack: build a mock adapter, do not integrate every vendor. A catalogue naming
      // Salesforce with nothing behind it would fail like a credential problem.
      assert.equal(CONNECTOR_DEFINITIONS.length, 2);
      assert.equal(
        CONNECTOR_DEFINITIONS.every((definition) => definition.isMock),
        true,
      );
    });

    it('keeps the tool vocabulary separate from the human action vocabulary', () => {
      // The client's rule, and the most dangerous shortcut available in this codebase: a person
      // with `Administer` on Integrations must not thereby be able to make an agent delete.
      assert.equal(TOOL_ACTION_CATEGORIES.includes('Read' as never), true);
      for (const humanAction of ['View', 'Approve', 'Publish', 'Administer', 'ManageAccess']) {
        assert.equal(
          (TOOL_ACTION_CATEGORIES as readonly string[]).includes(humanAction),
          false,
          `${humanAction} must not be a tool category`,
        );
      }
    });

    it('marks the client’s four high-risk categories, plus Delete', () => {
      assert.deepEqual([...HIGH_RISK_TOOL_CATEGORIES].sort(), [
        'Delete',
        'ExternalBulkSend',
        'FinancialChange',
        'ProductionChange',
        'SensitiveExport',
      ]);
      assert.equal(isHighRiskToolCategory('Read'), false);
      assert.equal(isHighRiskToolCategory('Write'), false);
    });

    it('derives the five states in the order that matters', () => {
      const base = {
        disabledAt: null,
        credentialExpiresAt: null,
        needsReauthorization: false,
        lastError: null,
      };

      assert.equal(derivedConnectionState(base), 'Connected');
      // Disabled wins: a disabled connection must not report Error and invite a fix.
      assert.equal(
        derivedConnectionState({
          ...base,
          disabledAt: new Date(),
          lastError: 'boom',
          needsReauthorization: true,
        }),
        'Disabled',
      );
      // Expired before NeedsReauthorization: re-consenting cannot fix an expired key.
      assert.equal(
        derivedConnectionState({
          ...base,
          credentialExpiresAt: new Date(Date.now() - 1000),
          needsReauthorization: true,
        }),
        'Expired',
      );
      assert.equal(
        derivedConnectionState({ ...base, needsReauthorization: true, lastError: 'boom' }),
        'NeedsReauthorization',
      );
      assert.equal(derivedConnectionState({ ...base, lastError: 'boom' }), 'Error');
    });

    it('warns two weeks ahead rather than on the day', () => {
      const soon = new Date(Date.now() + 3 * 86_400_000);
      const distant = new Date(Date.now() + (CREDENTIAL_EXPIRY_WARNING_DAYS + 10) * 86_400_000);
      const past = new Date(Date.now() - 86_400_000);

      assert.equal(isCredentialExpiringSoon(soon), true);
      assert.equal(isCredentialExpiringSoon(distant), false);
      // Already expired is not "expiring soon" — it is a different piece of news.
      assert.equal(isCredentialExpiringSoon(past), false);
      assert.equal(isCredentialExpiringSoon(null), false);
    });

    it('refuses a connector kind nobody implements', async () => {
      await assert.rejects(
        () =>
          connections().create({
            scope: scope(),
            actorUserId: adminId,
            scopeKind: 'Company',
            connectorKind: 'salesforce',
            label: 'Salesforce',
            secret: 'mock:ok',
          }),
        /no connector called/i,
      );
    });

    it('refuses a scope the connector does not support', async () => {
      // A mailbox is one person's account; it is never company infrastructure.
      await assert.rejects(
        () =>
          connections().create({
            scope: scope(),
            actorUserId: adminId,
            scopeKind: 'Company',
            connectorKind: 'mock-mailbox',
            label: 'Shared mailbox',
            secret: 'mock:ok',
          }),
        /cannot be a Company connection/i,
      );
    });

    it('insists on an environment where the connector has two, and refuses one where it has one', async () => {
      await assert.rejects(
        () =>
          connections().create({
            scope: scope(),
            actorUserId: adminId,
            scopeKind: 'Company',
            connectorKind: 'mock-erp',
            label: 'Ambiguous ERP',
            secret: 'mock:ok',
          }),
        /must say which/i,
      );

      await assert.rejects(
        () =>
          connections().create({
            scope: scope(),
            actorUserId: employeeId,
            scopeKind: 'User',
            connectorKind: 'mock-mailbox',
            label: 'My mailbox',
            environment: 'Production',
            secret: 'mock:ok',
          }),
        /only one environment/i,
      );
    });
  });

  // =========================================================================
  describe('secrets are references', () => {
    it('stores a handle on the connection and the sealed value elsewhere', async () => {
      const created = await createErp();

      assert.ok(created.secretRef?.startsWith('cs_'));
      assert.equal(created.hasSecret, true);
      // The view type has no field for a credential, and this proves the row does not carry one.
      assert.equal((created as unknown as Record<string, unknown>)['secret'], undefined);

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connection.findFirst({ where: { tenantId } }),
      );
      // The handle is not the value, and not derived from it.
      assert.notEqual(row?.secretRef, 'mock:ok');

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connectionSecret.findFirst({ where: { tenantId } }),
      );
      // Sealed, not plaintext, at rest.
      assert.match(stored?.sealedValue ?? '', /^v1\./);
      assert.equal(stored?.sealedValue.includes('mock:ok'), false);
      assert.ok((stored?.keyId ?? '').length > 0);
    });

    it('gives two connections with the same credential different handles', async () => {
      // A deterministic handle would make the reference a probe: anybody who could guess a
      // credential could confirm it by looking for its handle.
      const first = await createErp('mock:ok', 'ERP one');
      const second = await createErp('mock:ok', 'ERP two');
      assert.notEqual(first.secretRef, second.secretRef);
    });

    it('reveals the value only through the vault, and only by handle', async () => {
      const created = await createErp('mock:ok');
      const revealed = await vault().reveal(scope(), created.secretRef!);
      assert.equal(revealed, 'mock:ok');

      // A handle from one company does not resolve in another.
      await assert.rejects(
        () => vault().reveal(otherScope(), created.secretRef!),
        /No secret is stored/i,
      );
    });

    it('never returns a credential over HTTP', async () => {
      await createErp('mock:ok');

      const response = await as(agent().get(`/tenants/${tenantId}/connections`), adminUboss).expect(
        200,
      );

      const body = JSON.stringify(response.body);
      assert.equal(body.includes('mock:ok'), false);
      assert.match(response.body.note, /never the credential/i);
      assert.equal(response.body.vault.isExternalProvider, false);
    });

    it('lets the database refuse a handle that is really a sealed value', async () => {
      const created = await createErp();

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connection.update({
              where: { id: created.id },
              data: { secretRef: 'v1.key.aa.bb.cc' },
            }),
          ),
        /connection_secret_ref_is_not_a_secret/i,
      );
    });

    it('lets the database refuse an unsealed secret value', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connectionSecret.create({
              data: {
                tenantId,
                secretRef: 'cs_plaintext',
                sealedValue: 'hunter2',
                keyId: 'test',
              },
            }),
          ),
        /connection_secret_is_sealed/i,
      );
    });

    it('keeps the handle when the credential is rotated, so grants survive', async () => {
      const created = await createErp('mock:ok');
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      const rotated = await connections().rotateSecret({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        secret: 'mock:ok',
      });

      // A new handle would silently detach every agent that holds a grant.
      assert.equal(rotated.secretRef, created.secretRef);
      assert.equal(rotated.grants.length, 1);
    });
  });

  // =========================================================================
  describe('Test Connection and the five states', () => {
    it('records a success, the check history and the last successful time', async () => {
      const created = await createErp('mock:ok');
      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });

      assert.equal(result.succeeded, true);
      assert.equal(result.state, 'Connected');

      const view = await connections().view({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });
      assert.notEqual(view.lastSuccessfulCheckAt, null);
      assert.equal(view.lastError, null);

      const checks = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connectionCheck.findMany({ where: { tenantId } }),
      );
      assert.equal(checks.length, 1);
      assert.equal(checks[0]?.succeeded, true);
      assert.ok((checks[0]?.durationMs ?? -1) >= 0);
    });

    it('turns a provider failure into Error, and keeps the message', async () => {
      const created = await createErp('mock:fail:the endpoint returned 500');
      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });

      assert.equal(result.succeeded, false);
      assert.equal(result.state, 'Error');
      assert.match(result.detail, /returned 500/);
    });

    it('distinguishes withdrawn consent from a wrong key', async () => {
      const created = await createErp('mock:reauthorize');
      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });

      // The two look the same on a dashboard and have different fixes. Collapsing them would
      // send somebody to re-consent when all they needed was a new key.
      assert.equal(result.state, 'NeedsReauthorization');
    });

    it('records an expiry the provider reports, and derives Expired from it', async () => {
      const past = new Date(Date.now() - 86_400_000).toISOString();
      const created = await createErp(`mock:expires:${past}`);

      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });

      // The check itself succeeded; the credential is nonetheless expired, and the state says so
      // because it is derived rather than set by whoever ran the check.
      assert.equal(result.succeeded, true);
      assert.equal(result.state, 'Expired');
    });

    it('reports a missing stored credential as a check failure, not a crash', async () => {
      const created = await createErp('mock:ok');
      await vault().forget(scope(), created.secretRef!);

      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });

      assert.equal(result.succeeded, false);
      assert.equal(result.state, 'NeedsReauthorization');
      assert.match(result.detail, /could not be found/i);
    });

    it('refuses an unrecognised credential rather than succeeding by default', async () => {
      // A mock that succeeded for any input would make every failure test meaningless.
      const created = await createErp('not-an-instruction');
      const result = await connections().check({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });
      assert.equal(result.succeeded, false);
    });

    it('lets the database refuse a rewritten or deleted check history', async () => {
      const created = await createErp('mock:ok');
      await connections().check({ scope: scope(), actorUserId: adminId, connectionId: created.id });

      // "It has been failing since Tuesday" is the only question this history exists to answer.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE connection_checks SET detail = 'rewritten' WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `DELETE FROM connection_checks WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('Agent Tool Permission is not a human permission', () => {
    it('refuses an agent with no grant, however privileged the humans are', async () => {
      const created = await createErp('mock:ok');
      await connections().check({ scope: scope(), actorUserId: adminId, connectionId: created.id });

      const decision = await connections().mayAgentUse({
        scope: scope(),
        agentId: AGENT,
        connectionId: created.id,
        category: 'Read',
      });

      // The admin holds `settings:Administer` and created this connection. That grants the agent
      // nothing — the client's rule, and the whole reason for two vocabularies.
      assert.equal(decision.allowed, false);
      assert.match(decision.reason, /separate from any human permission/i);
    });

    it('allows it once a grant exists, and only for the granted category', async () => {
      const created = await createErp('mock:ok');
      await connections().check({ scope: scope(), actorUserId: adminId, connectionId: created.id });
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: created.id,
            category: 'Read',
          })
        ).allowed,
        true,
      );

      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: created.id,
            category: 'Delete',
          })
        ).allowed,
        false,
      );

      // And not for a different agent.
      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: OTHER_AGENT,
            connectionId: created.id,
            category: 'Read',
          })
        ).allowed,
        false,
      );
    });

    it('refuses a granted category while the connection is not usable', async () => {
      const created = await createErp('mock:ok');
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      await connections().disable({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        reason: 'Suspended pending a security review.',
      });

      const decision = await connections().mayAgentUse({
        scope: scope(),
        agentId: AGENT,
        connectionId: created.id,
        category: 'Read',
      });

      // A grant on an unusable connection is permission that would fail. Failing at the boundary
      // rather than at the provider is what prevents a half-completed external action.
      assert.equal(decision.allowed, false);
      assert.equal(decision.state, 'Disabled');
      assert.match(decision.reason, /half-completed external action/i);
    });

    it('respects the allowed-department restriction, and treats empty as the whole company', async () => {
      const department = 'd1d1d1d1-1111-4111-8111-d1d1d1d1d1d1';
      const other = 'd2d2d2d2-2222-4222-9222-d2d2d2d2d2d2';

      const restricted = await connections().create({
        scope: scope(),
        actorUserId: adminId,
        scopeKind: 'Company',
        connectorKind: 'mock-erp',
        label: 'Restricted ERP',
        environment: 'Production',
        secret: 'mock:ok',
        allowedDepartmentIds: [department],
      });
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: restricted.id,
        agentId: AGENT,
        category: 'Read',
      });

      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: restricted.id,
            category: 'Read',
            departmentId: department,
          })
        ).allowed,
        true,
      );
      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: restricted.id,
            category: 'Read',
            departmentId: other,
          })
        ).allowed,
        false,
      );

      // Empty means the whole company. Read as "nobody" it would have broken every existing
      // connection the day departments were introduced.
      const open = await createErp('mock:ok', 'Open ERP');
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: open.id,
        agentId: AGENT,
        category: 'Read',
      });
      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: open.id,
            category: 'Read',
            departmentId: other,
          })
        ).allowed,
        true,
      );
    });

    it('needs a reason for a high-risk category and not for a safe one', async () => {
      const created = await createErp('mock:ok');

      await assert.rejects(
        () =>
          connections().grantToolPermission({
            scope: scope(),
            actorUserId: adminId,
            connectionId: created.id,
            agentId: AGENT,
            category: 'Delete',
          }),
        /high-risk category and needs a reason/i,
      );

      const safe = await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });
      assert.ok(safe.id);

      const risky = await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'FinancialChange',
        reason: 'Approved by the finance director for the reconciliation agent.',
      });
      assert.match(risky.note, /high-risk/i);
    });

    it('lets the database refuse a high-risk grant with no reason', async () => {
      const created = await createErp('mock:ok');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connectionToolGrant.create({
              data: {
                tenantId,
                connectionId: created.id,
                agentId: AGENT,
                category: 'ProductionChange',
                grantedByUserId: adminId,
              },
            }),
          ),
        /high_risk_tool_grant_has_a_reason/i,
      );
    });

    it('refuses a category the connector cannot perform', async () => {
      const created = await createErp('mock:ok');

      // mock-erp has no ExternalBulkSend. A permission that reads as capability and is not would
      // be worse than no permission.
      await assert.rejects(
        () =>
          connections().grantToolPermission({
            scope: scope(),
            actorUserId: adminId,
            connectionId: created.id,
            agentId: AGENT,
            category: 'ExternalBulkSend',
            reason: 'Wanted for a newsletter agent.',
          }),
        /does not support/i,
      );
    });

    it('revokes as a row, keeping the history, and allows re-granting', async () => {
      const created = await createErp('mock:ok');
      const grant = await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      await connections().revokeToolPermission({
        scope: scope(),
        actorUserId: adminId,
        grantId: grant.id,
        reason: 'The agent no longer needs it.',
      });

      assert.equal(
        (
          await connections().mayAgentUse({
            scope: scope(),
            agentId: AGENT,
            connectionId: created.id,
            category: 'Read',
          })
        ).allowed,
        false,
      );

      // The row survives: "who could do this in March" must stay answerable.
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.connectionToolGrant.findMany({ where: { tenantId } }),
      );
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0]?.revokedAt, null);
      assert.equal(rows[0]?.revokedReason, 'The agent no longer needs it.');

      // And the partial unique index does not block re-granting.
      const again = await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });
      assert.notEqual(again.id, grant.id);
    });

    it('lets the database refuse a second live grant and an unattributed revocation', async () => {
      const created = await createErp('mock:ok');
      const grant = await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connectionToolGrant.create({
              data: {
                tenantId,
                connectionId: created.id,
                agentId: AGENT,
                category: 'Read',
                grantedByUserId: adminId,
              },
            }),
          ),
        /one_live_tool_grant_per_agent_category/i,
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connectionToolGrant.update({
              where: { id: grant.id },
              data: { revokedAt: new Date() },
            }),
          ),
        /tool_grant_revocation_is_attributed/i,
      );
    });

    it('counts affected agents, not grants', async () => {
      const created = await createErp('mock:ok');
      for (const category of ['Read', 'Write'] as const) {
        await connections().grantToolPermission({
          scope: scope(),
          actorUserId: adminId,
          connectionId: created.id,
          agentId: AGENT,
          category,
        });
      }
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: OTHER_AGENT,
        category: 'Read',
      });

      const view = await connections().view({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });
      // Three grants, two agents. "12 agents affected" meaning four is a number nobody trusts
      // twice.
      assert.equal(view.grants.length, 3);
      assert.equal(view.affectedAgentCount, 2);
    });

    it('records the grant in the audit trail as an agent permission', async () => {
      const created = await createErp('mock:ok');
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Delete',
        reason: 'The reconciliation agent removes superseded draft rows.',
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'connection.tool_permission_granted' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['permissionKind'], 'AgentToolPermission');
      assert.equal(metadata?.['highRisk'], true);
      assert.equal(event?.reason, 'The reconciliation agent removes superseded draft rows.');
    });
  });

  // =========================================================================
  describe('ownership, disabling and personal connections', () => {
    it('transfers a company connection to an active member, with a reason', async () => {
      const created = await createErp('mock:ok');

      const moved = await connections().transferOwner({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        newOwnerUserId: employeeId,
        reason: 'The original owner changed team.',
      });
      assert.equal(moved.ownerUserId, employeeId);

      await assert.rejects(
        () =>
          connections().transferOwner({
            scope: scope(),
            actorUserId: adminId,
            connectionId: created.id,
            newOwnerUserId: 'f9f9f9f9-9999-4999-8999-f9f9f9f9f9f9',
            reason: 'To a stranger.',
          }),
        /active account in this company/i,
      );
    });

    it('refuses to transfer a User Connection at all', async () => {
      const mine = await connections().create({
        scope: scope(),
        actorUserId: employeeId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });

      await assert.rejects(
        () =>
          connections().transferOwner({
            scope: scope(),
            actorUserId: adminId,
            connectionId: mine.id,
            newOwnerUserId: peerId,
            reason: 'The owner left.',
          }),
        /cannot be transferred/i,
      );
    });

    it('refuses to create a User Connection on somebody else’s behalf', async () => {
      await assert.rejects(
        () =>
          connections().create({
            scope: scope(),
            actorUserId: adminId,
            scopeKind: 'User',
            connectorKind: 'mock-mailbox',
            label: 'Their mailbox',
            ownerUserId: employeeId,
            secret: 'mock:ok',
          }),
        /only be created for yourself/i,
      );
    });

    it('lets an administrator disable somebody’s personal connection but not rotate it', async () => {
      const mine = await connections().create({
        scope: scope(),
        actorUserId: employeeId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });

      // Disabling is the security action a company needs.
      const disabled = await connections().disable({
        scope: scope(),
        actorUserId: adminId,
        connectionId: mine.id,
        reason: 'Suspended during an investigation.',
      });
      assert.equal(disabled.state, 'Disabled');

      await connections().enable({
        scope: scope(),
        actorUserId: adminId,
        connectionId: mine.id,
      });

      // Rotating it would mean holding their credential.
      await assert.rejects(
        () =>
          connections().rotateSecret({
            scope: scope(),
            actorUserId: adminId,
            connectionId: mine.id,
            secret: 'mock:ok',
          }),
        /theirs alone/i,
      );
    });

    it('requires a reason to disable, and keeps grants standing', async () => {
      const created = await createErp('mock:ok');
      await connections().grantToolPermission({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        agentId: AGENT,
        category: 'Read',
      });

      await assert.rejects(
        () =>
          connections().disable({
            scope: scope(),
            actorUserId: adminId,
            connectionId: created.id,
            reason: '  ',
          }),
        /needs a reason/i,
      );

      const disabled = await connections().disable({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        reason: 'The provider contract ended.',
      });

      // Revoking every grant would destroy a configuration somebody has to rebuild to re-enable,
      // for no security gain — the state already refuses use.
      assert.equal(disabled.grants.length, 1);
      assert.equal(disabled.affectedAgentCount, 1);

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'connection.disabled' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['grantsRevoked'], false);
      assert.equal(metadata?.['affectedAgentCount'], 1);
    });

    it('clears both failure states when the credential is replaced', async () => {
      const created = await createErp('mock:reauthorize');
      await connections().check({ scope: scope(), actorUserId: adminId, connectionId: created.id });

      const rotated = await connections().rotateSecret({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
        secret: 'mock:ok',
      });

      // Whatever was wrong, this is a different credential and the next check decides.
      assert.equal(rotated.state, 'Connected');
      assert.equal(rotated.lastError, null);
    });

    it('reauthorizes without a new credential', async () => {
      const created = await createErp('mock:reauthorize');
      await connections().check({ scope: scope(), actorUserId: adminId, connectionId: created.id });

      const after = await connections().reauthorize({
        scope: scope(),
        actorUserId: adminId,
        connectionId: created.id,
      });
      // A provider can withdraw consent for a credential that is still valid.
      assert.equal(after.state, 'Connected');
    });

    it('lets the database refuse disabling with no reason', async () => {
      const created = await createErp('mock:ok');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.connection.update({
              where: { id: created.id },
              data: { disabledAt: new Date() },
            }),
          ),
        /disabled_connection_has_a_reason/i,
      );
    });
  });

  // =========================================================================
  describe('the credential expiry sweep', () => {
    it('reports expiring and expired credentials to their owners', async () => {
      const soon = new Date(Date.now() + 3 * 86_400_000);
      const gone = new Date(Date.now() - 86_400_000);

      const expiring = await createErp('mock:ok', 'Expiring ERP');
      const expired = await createErp('mock:ok', 'Expired ERP');
      await ctx.prisma.runAsPlatformOperation(async () => {
        await ctx.prisma.client.connection.update({
          where: { id: expiring.id },
          data: { credentialExpiresAt: soon },
        });
        await ctx.prisma.client.connection.update({
          where: { id: expired.id },
          data: { credentialExpiresAt: gone },
        });
      });

      const raised: { state: string; recipientUserId: string }[] = [];
      const outcome = await connections().sweepExpiringCredentials(async (event) => {
        raised.push({ state: event.state, recipientUserId: event.recipientUserId });
      });

      assert.deepEqual(outcome, { expiring: 1, expired: 1 });
      assert.equal(
        raised.every((event) => event.recipientUserId === adminId),
        true,
      );
      assert.deepEqual(raised.map((event) => event.state).sort(), ['Expired', 'Expiring']);
    });

    it('says nothing about a credential that is not near expiry, or a disabled connection', async () => {
      const distant = await createErp('mock:ok', 'Distant ERP');
      const off = await createErp('mock:ok', 'Disabled ERP');
      await ctx.prisma.runAsPlatformOperation(async () => {
        await ctx.prisma.client.connection.update({
          where: { id: distant.id },
          data: { credentialExpiresAt: new Date(Date.now() + 200 * 86_400_000) },
        });
        await ctx.prisma.client.connection.update({
          where: { id: off.id },
          data: {
            credentialExpiresAt: new Date(Date.now() - 86_400_000),
            disabledAt: new Date(),
            disabledReason: 'Not in use.',
          },
        });
      });

      const outcome = await connections().sweepExpiringCredentials(async () => undefined);
      // Nagging about a disabled connection's expired credential is noise: nothing is using it.
      assert.deepEqual(outcome, { expiring: 0, expired: 0 });
    });
  });

  // =========================================================================
  describe('tenant isolation and the API', () => {
    it('never shows one company’s connections in another', async () => {
      await createErp('mock:ok');

      const visible = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.connection.count({}),
      );
      assert.equal(visible, 0);

      const secrets = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.connectionSecret.count({}),
      );
      assert.equal(secrets, 0);
    });

    it('refuses an agent in one company using another’s connection', async () => {
      const created = await createErp('mock:ok');

      const decision = await connections().mayAgentUse({
        scope: otherScope(),
        agentId: AGENT,
        connectionId: created.id,
        category: 'Read',
      });
      assert.equal(decision.allowed, false);
      assert.match(decision.reason, /no such connection in this company/i);
    });

    it('shows an employee their own personal connection and not a colleague’s', async () => {
      await connections().create({
        scope: scope(),
        actorUserId: employeeId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });
      await connections().create({
        scope: scope(),
        actorUserId: peerId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });

      const mine = await connections().list({ scope: scope(), actorUserId: employeeId });
      assert.equal(mine.connections.length, 1);
      assert.equal(mine.connections[0]?.ownerUserId, employeeId);

      // An administrator sees both, as rows — never a credential.
      const all = await connections().list({ scope: scope(), actorUserId: adminId });
      assert.equal(all.connections.length, 2);
    });

    it('does not show a colleague’s personal connection over HTTP', async () => {
      await connections().create({
        scope: scope(),
        actorUserId: employeeId,
        scopeKind: 'User',
        connectorKind: 'mock-mailbox',
        label: 'My mailbox',
        secret: 'mock:ok',
      });

      const asPeer = await as(agent().get(`/tenants/${tenantId}/connections`), peerUboss).expect(
        200,
      );
      // Scoped in the `where` clause, so a colleague's personal connection is not a row that is
      // then filtered — it never arrives.
      assert.equal(asPeer.body.connections.length, 0);
    });

    it('lets an employee create and test their own personal connection', async () => {
      // The permission split this prompt's own tests corrected: an ordinary employee must be able
      // to connect their own account, or the client's User Connection type is unreachable by the
      // people it exists for.
      const created = await as(agent().post(`/tenants/${tenantId}/connections`), peerUboss)
        .send({
          scopeKind: 'User',
          connectorKind: 'mock-mailbox',
          label: 'My mailbox',
          secret: 'mock:ok',
        })
        .expect(201);

      const checked = await as(
        agent().post(`/tenants/${tenantId}/connections/${created.body.id}/check`),
        peerUboss,
      ).expect(201);
      assert.equal(checked.body.succeeded, true);
    });

    it('needs settings:Administer to configure, and settings:View to look', async () => {
      const created = await createErp('mock:ok');

      await as(agent().get(`/tenants/${tenantId}/connections`), employeeUboss).expect(200);

      await as(
        agent().post(`/tenants/${tenantId}/connections/${created.id}/check`),
        employeeUboss,
      ).expect(403);

      await as(
        agent().post(`/tenants/${tenantId}/connections/${created.id}/tool-permissions`),
        employeeUboss,
      )
        .send({ agentId: AGENT, category: 'Read' })
        .expect(403);
    });

    it('serves the catalogue and the full lifecycle over HTTP', async () => {
      const catalogue = await as(
        agent().get(`/tenants/${tenantId}/connections/catalogue`),
        adminUboss,
      ).expect(200);
      assert.equal(catalogue.body.connectors.length, 2);
      assert.equal(catalogue.body.toolCategories.length, TOOL_ACTION_CATEGORIES.length);
      assert.equal(
        catalogue.body.toolCategories.filter((row: { highRisk: boolean }) => row.highRisk).length,
        HIGH_RISK_TOOL_CATEGORIES.length,
      );

      const created = await as(agent().post(`/tenants/${tenantId}/connections`), adminUboss)
        .send({
          scopeKind: 'Company',
          connectorKind: 'mock-erp',
          label: 'ERP over HTTP',
          environment: 'Production',
          secret: 'mock:ok',
        })
        .expect(201);
      assert.equal(created.body.hasSecret, true);
      assert.equal(JSON.stringify(created.body).includes('mock:ok'), false);

      const checked = await as(
        agent().post(`/tenants/${tenantId}/connections/${created.body.id}/check`),
        adminUboss,
      ).expect(201);
      assert.equal(checked.body.succeeded, true);

      await as(
        agent().post(`/tenants/${tenantId}/connections/${created.body.id}/tool-permissions`),
        adminUboss,
      )
        .send({ agentId: AGENT, category: 'Delete', reason: 'Removes superseded draft rows.' })
        .expect(201);

      await as(
        agent().post(`/tenants/${tenantId}/connections/${created.body.id}/disable`),
        adminUboss,
      )
        .send({ reason: 'No longer required.' })
        .expect(201);

      const view = await as(
        agent().get(`/tenants/${tenantId}/connections/${created.body.id}`),
        adminUboss,
      ).expect(200);
      assert.equal(view.body.state, 'Disabled');
      assert.equal(view.body.affectedAgentCount, 1);
    });

    it('refuses an unknown tool category at the boundary', async () => {
      const created = await createErp('mock:ok');

      await as(
        agent().post(`/tenants/${tenantId}/connections/${created.id}/tool-permissions`),
        adminUboss,
      )
        .send({ agentId: AGENT, category: 'Everything', reason: 'Because.' })
        .expect(400);
    });

    it('reports what the vault actually is', async () => {
      const description = vault().describe();
      // Encrypted at rest in our own database is a real guarantee, and a different one from
      // being held in a managed secrets service. Nothing claims the latter.
      assert.equal(description.isExternalProvider, false);
      assert.match(description.note, /no external provider is configured/i);
    });

    it('keeps the connector catalogue and the adapter in agreement', () => {
      const adapter = new MockConnectorAdapter();
      const capabilities = new Set(adapter.describeCapabilities());
      for (const definition of CONNECTOR_DEFINITIONS) {
        for (const category of definition.supportedCategories) {
          assert.equal(
            capabilities.has(category),
            true,
            `${definition.kind} claims ${category} but the adapter does not offer it`,
          );
        }
      }
      assert.ok(connectorDefinition('mock-erp'));
      assert.equal(connectorDefinition('salesforce'), undefined);
    });
  });
});
