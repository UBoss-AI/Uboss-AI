import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ALWAYS_MANDATORY_KINDS,
  isMandatoryNotification,
  NOTIFICATION_KIND_DEFINITIONS,
  NOTIFICATION_KINDS,
  notificationDedupeKey,
  notificationKind,
  utcDay,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { BudgetAlertService } from '../src/commercial/budget-alert.service.js';
import { ConnectionService } from '../src/connections/connection.service.js';
import { ConnectorAdapter, MockConnectorAdapter } from '../src/connections/connector-adapter.js';
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';

import { EmailAdapter, LoggingEmailAdapter } from '../src/notifications/email-adapter.js';
import { NotificationDispatcherService } from '../src/notifications/notification-dispatcher.service.js';
import { NotificationOperationsController } from '../src/notifications/notification-operations.controller.js';
import { NotificationController } from '../src/notifications/notification.controller.js';
import { NotificationService } from '../src/notifications/notification.service.js';
import { SecurityNotificationBridge } from '../src/notifications/security-notification.bridge.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { NotificationRepository } from '../src/persistence/notification.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
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
 * Prompt 15 — Notification and Escalation Center.
 *
 * Eight properties carry this prompt:
 *
 *   1. **A mandatory alert cannot be muted** — by preference, by digest, or at the database.
 *   2. **Duplicate suppression is a constraint**, and the dedupe key's shape is what decides
 *      what "duplicate" means.
 *   3. **Severity, read and acknowledgement are three different states.** Reading a critical
 *      alert does not clear it.
 *   4. **Every notification carries a deep link to the exact resource**, and the database
 *      refuses one that does not.
 *   5. **Email goes through the Prompt 10 outbox** — one queue, with its retry and
 *      dead-lettering — and the adapter never claims delivery it did not perform.
 *   6. **Escalation creates a new notification** for the reporting manager and leaves the
 *      original visible.
 *   7. **Assigned-to-me is a real distinction**, not a synonym for "addressed to me".
 *   8. **Tenant isolation**, including the escalation chain.
 */
describe('notifications and escalation (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let departmentId: string;
  let adminId: string;
  let adminUboss: string;
  let managerId: string;
  let employeeId: string;
  let employeeUboss: string;
  let peerId: string;
  let peerUboss: string;
  let ownerId: string;
  let ownerUboss: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const notifications = () => app.get(NotificationService);
  const dispatcher = () => app.get(NotificationDispatcherService);
  const budgets = () => app.get(BudgetAlertService);
  const email = () => app.get(EmailAdapter) as LoggingEmailAdapter;
  const securityEvents = () => app.get(SecurityEventService);

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
      controllers: [NotificationController, NotificationOperationsController],
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
        NotificationRepository,
        OutboxRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        NotificationService,
        NotificationDispatcherService,
        // The real adapter, not a stub: it records what it was asked to send, which is exactly
        // what these tests need to assert, and it is what a deployment without a mail provider
        // actually runs.
        { provide: EmailAdapter, useClass: LoggingEmailAdapter },
        SecurityNotificationBridge,
        BudgetAlertService,
        ConnectionService,
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
    email().sent.length = 0;

    const provisioned = await ctx.provisioning.provision({
      slug: 'notify-co',
      name: 'Notify Co',
      firstMember: { email: 'first@notify.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-notify-co',
      name: 'Other Notify Co',
      firstMember: { email: 'first@other-notify.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@notify.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-NADM-0001', 'Notify Admin'),
        manager: await member('UB-NMGR-0001', 'Notify Manager'),
        employee: await member('UB-NEMP-0001', 'Notify Employee'),
        peer: await member('UB-NPER-0001', 'Notify Peer'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-NOWN-0001',
          email: 'owner@notify-platform.example',
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
    peerId = people.peer.id;
    peerUboss = people.peer.ubossUniqueId;
    ownerId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      const department = await ctx.prisma.client.department.create({
        data: { tenantId, name: 'Operations', code: 'OPS' },
      });
      departmentId = department.id;

      // The reporting line the escalation sweeper walks: employee → manager → admin.
      await ctx.prisma.client.employmentRecord.create({
        data: { tenantId, userId: adminId, employeeId: 'N-001', designation: 'MD', departmentId },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: managerId,
          employeeId: 'N-002',
          designation: 'Head of Operations',
          departmentId,
          reportingManagerUserId: adminId,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: employeeId,
          employeeId: 'N-003',
          designation: 'Executive',
          departmentId,
          reportingManagerUserId: managerId,
        },
      });
      // The peer deliberately has **no** reporting manager, so the "nobody to escalate to" path
      // is exercised by a real person rather than a contrived one.
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId,
          userId: peerId,
          employeeId: 'N-004',
          designation: 'Executive',
          departmentId,
        },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [managerId, 'Manager', 'TeamSubtree'],
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

  /** A plain approval-waiting notification for the employee. */
  const raiseApproval = (approvalId = 'A-1', recipientUserId = employeeId) =>
    notifications().raise({
      tenantId,
      recipientUserId,
      kind: 'ApprovalWaiting',
      severity: 'Info',
      title: 'An objective needs your approval',
      body: 'A department objective is waiting on your decision.',
      deepLink: `/approvals/${approvalId}`,
      resourceType: 'approval',
      resourceId: approvalId,
      isAssignedToRecipient: true,
      dedupeKey: notificationDedupeKey.approvalWaiting(approvalId),
    });

  // =========================================================================
  describe('the catalogue', () => {
    it('declares exactly the client’s six initial sources', () => {
      assert.equal(NOTIFICATION_KINDS.length, 6);
      for (const kind of [
        'Invitation',
        'ApprovalWaiting',
        'Overdue',
        'ConnectionExpiry',
        'BudgetThreshold',
        'SecurityEvent',
      ]) {
        assert.ok((NOTIFICATION_KINDS as readonly string[]).includes(kind), kind);
      }
    });

    it('gives every kind a label, a description and a stated producer', () => {
      for (const definition of NOTIFICATION_KIND_DEFINITIONS) {
        assert.ok(definition.label.length > 0, definition.kind);
        assert.ok(definition.description.length > 0, definition.kind);
        // Three of the six cannot fire yet. Saying which is the difference between an honest
        // preference screen and one offering a control for something nothing produces.
        assert.ok(definition.producedBy.length > 0, definition.kind);
      }
    });

    it('makes security alerts mandatory at every severity, and criticals mandatory of any kind', () => {
      assert.deepEqual([...ALWAYS_MANDATORY_KINDS], ['SecurityEvent']);

      assert.equal(isMandatoryNotification({ kind: 'SecurityEvent', severity: 'Info' }), true);
      assert.equal(isMandatoryNotification({ kind: 'SecurityEvent', severity: 'Warning' }), true);
      assert.equal(isMandatoryNotification({ kind: 'Overdue', severity: 'Critical' }), true);
      assert.equal(isMandatoryNotification({ kind: 'Overdue', severity: 'Warning' }), false);
    });

    it('keys an approval without time and an overdue item per day', () => {
      // The distinction the whole dedupe design turns on. An approval keyed per day would nag;
      // an overdue item keyed without a day would go silent after the first notice.
      assert.equal(notificationDedupeKey.approvalWaiting('A-1'), 'approval:A-1');
      assert.equal(
        notificationDedupeKey.overdue('T-1', utcDay(new Date('2026-09-09T13:00:00Z'))),
        'overdue:T-1:2026-09-09',
      );
    });

    it('returns undefined for an unknown kind rather than a guess', () => {
      assert.equal(notificationKind('Invented'), undefined);
    });
  });

  // =========================================================================
  describe('raising', () => {
    it('stores the notification with its deep link and assignment', async () => {
      const result = await raiseApproval();

      assert.equal(result.suppressedAsDuplicate, false);
      assert.equal(result.deliveredInApp, true);
      assert.equal(result.notification?.deepLink, '/approvals/A-1');
      assert.equal(result.notification?.isAssignedToRecipient, true);
      assert.equal(result.notification?.isMandatory, false);
      assert.equal(result.notification?.requiresAcknowledgement, false);
      assert.equal(result.notification?.readAt, null);
    });

    it('marks a critical item mandatory and acknowledgement-requiring', async () => {
      const result = await notifications().raise({
        tenantId,
        recipientUserId: adminId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'The AI allowance is exhausted',
        body: 'AI work will be refused until more allowance is added.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:test:100',
      });

      assert.equal(result.notification?.isMandatory, true);
      assert.equal(result.notification?.requiresAcknowledgement, true);
    });

    it('lets the database refuse a deep link that is not a workspace path', async () => {
      await assert.rejects(
        () =>
          notifications().raise({
            tenantId,
            recipientUserId: employeeId,
            kind: 'ApprovalWaiting',
            title: 'Look at this',
            body: 'Somewhere else entirely.',
            deepLink: 'https://elsewhere.example/steal',
            resourceType: 'approval',
            dedupeKey: 'k-absolute',
          }),
        /notification_deep_link_is_a_relative_path/i,
      );
    });

    it('lets the database refuse a critical notification that is not marked mandatory', async () => {
      // The engine cannot produce this, which is the point: the constraint guards against a
      // future caller that writes the row directly.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.notification.create({
              data: {
                tenantId,
                recipientUserId: employeeId,
                kind: 'Overdue',
                severity: 'Critical',
                title: 'Overdue',
                body: 'Work is overdue.',
                deepLink: '/todo',
                resourceType: 'todo',
                dedupeKey: 'k-critical-optional',
                isMandatory: false,
              },
            }),
          ),
        /mandatory_notification_is_marked_mandatory/i,
      );
    });

    it('lets the database refuse a security notification that is not mandatory', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.notification.create({
              data: {
                tenantId,
                recipientUserId: employeeId,
                kind: 'SecurityEvent',
                severity: 'Warning',
                title: 'New device',
                body: 'A new device signed in.',
                deepLink: '/settings/security',
                resourceType: 'security_event',
                dedupeKey: 'k-security-optional',
                isMandatory: false,
              },
            }),
          ),
        /security_notification_is_mandatory/i,
      );
    });
  });

  // =========================================================================
  describe('duplicate suppression', () => {
    it('suppresses a repeat of the same key and says so', async () => {
      const first = await raiseApproval('A-1');
      const again = await raiseApproval('A-1');

      assert.equal(first.suppressedAsDuplicate, false);
      assert.equal(again.suppressedAsDuplicate, true);
      assert.equal(again.notification, null);

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({ where: { tenantId } }),
      );
      assert.equal(count, 1);
    });

    it('does not suppress the same key for a different person', async () => {
      // Two approvers waiting on the same thing have two answers to "have you seen this". The
      // key is scoped per recipient precisely so this works.
      await raiseApproval('A-1', employeeId);
      const second = await raiseApproval('A-1', managerId);
      assert.equal(second.suppressedAsDuplicate, false);
    });

    it('enforces it at the database, not only in the service', async () => {
      await raiseApproval('A-1');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.notification.create({
              data: {
                tenantId,
                recipientUserId: employeeId,
                kind: 'ApprovalWaiting',
                title: 'Duplicate',
                body: 'A second copy.',
                deepLink: '/approvals/A-1',
                resourceType: 'approval',
                dedupeKey: notificationDedupeKey.approvalWaiting('A-1'),
              },
            }),
          ),
        /unique|duplicate/i,
      );
    });
  });

  // =========================================================================
  describe('preferences', () => {
    it('reports the documented default for a kind nobody has configured', async () => {
      const view = await notifications().preferencesFor({ scope: scope(), userId: employeeId });

      assert.equal(view.preferences.length, 6);
      const approvals = view.preferences.find((row) => row.kind === 'ApprovalWaiting');
      assert.deepEqual(
        {
          inApp: approvals?.inAppEnabled,
          email: approvals?.emailEnabled,
          digest: approvals?.digest,
          source: approvals?.source,
          mutable: approvals?.mutable,
        },
        { inApp: true, email: true, digest: 'Off', source: 'default', mutable: true },
      );
    });

    it('marks security alerts immutable and refuses to change one', async () => {
      const view = await notifications().preferencesFor({ scope: scope(), userId: employeeId });
      const security = view.preferences.find((row) => row.kind === 'SecurityEvent');
      assert.equal(security?.mutable, false);

      await assert.rejects(
        () =>
          notifications().setPreference({
            scope: scope(),
            userId: employeeId,
            kind: 'SecurityEvent',
            inAppEnabled: false,
            emailEnabled: false,
            digest: 'Off',
          }),
        /cannot be changed/i,
      );
    });

    it('lets the database refuse a muted or digested security preference', async () => {
      for (const data of [
        { inAppEnabled: false, emailEnabled: false, digest: 'Off' as const },
        { inAppEnabled: true, emailEnabled: true, digest: 'Weekly' as const },
      ]) {
        await assert.rejects(
          () =>
            ctx.prisma.runAsPlatformOperation(() =>
              ctx.prisma.client.notificationPreference.create({
                data: { tenantId, userId: employeeId, kind: 'SecurityEvent', ...data },
              }),
            ),
          /security_notifications_cannot_be_muted/i,
        );
      }
    });

    it('suppresses an optional kind that has been muted, storing nothing', async () => {
      await notifications().setPreference({
        scope: scope(),
        userId: employeeId,
        kind: 'ApprovalWaiting',
        inAppEnabled: false,
        emailEnabled: false,
        digest: 'Off',
      });

      const result = await raiseApproval('A-1');
      assert.equal(result.deliveredInApp, false);
      assert.equal(result.notification, null);

      // Nothing is stored: a row nobody will ever be shown is a row that makes the unread count
      // wrong.
      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({ where: { tenantId } }),
      );
      assert.equal(count, 0);
    });

    it('cannot mute a critical alert, even of a kind that was muted', async () => {
      await notifications().setPreference({
        scope: scope(),
        userId: employeeId,
        kind: 'Overdue',
        inAppEnabled: false,
        emailEnabled: false,
        digest: 'Off',
      });

      const result = await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'Overdue',
        severity: 'Critical',
        title: 'Overdue and blocking others',
        body: 'This has stopped somebody else working.',
        deepLink: '/todo/T-9',
        resourceType: 'todo',
        resourceId: 'T-9',
        dedupeKey: 'overdue:T-9:critical',
      });

      assert.equal(result.deliveredInApp, true);
      assert.equal(result.preferenceOverridden, true);
      assert.equal(result.emailQueued, true);
      assert.equal(result.notification?.requiresAcknowledgement, true);
    });

    it('holds back an immediate email when a digest is asked for, but keeps the in-app item', async () => {
      await notifications().setPreference({
        scope: scope(),
        userId: employeeId,
        kind: 'ApprovalWaiting',
        inAppEnabled: true,
        emailEnabled: true,
        digest: 'Daily',
      });

      const result = await raiseApproval('A-1');
      assert.equal(result.deliveredInApp, true);
      // A bell that updates once a day is a bell nobody trusts, so the digest is email-only.
      assert.equal(result.emailQueued, false);
      assert.equal(result.notification?.emailQueuedAt, null);
    });

    it('ignores a digest for a mandatory alert', async () => {
      // "Your account was accessed from a new country, in Friday's summary" is not a reasonable
      // reading of a digest preference.
      await notifications().setPreference({
        scope: scope(),
        userId: employeeId,
        kind: 'BudgetThreshold',
        inAppEnabled: true,
        emailEnabled: true,
        digest: 'Weekly',
      });

      const result = await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:x:100',
      });

      assert.equal(result.emailQueued, true);
    });
  });

  // =========================================================================
  describe('read, acknowledge and the bell', () => {
    it('counts unread, assigned-to-me and awaiting-acknowledgement separately', async () => {
      await raiseApproval('A-1', employeeId);
      await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        // Informational: they are being told, not assigned the work.
        isAssignedToRecipient: false,
        dedupeKey: 'budget:y:100',
      });

      const view = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: {},
      });

      assert.deepEqual(view.counts, {
        unread: 2,
        awaitingAcknowledgement: 1,
        assignedToMeUnread: 1,
      });
    });

    it('does not clear an acknowledgement by marking everything read', async () => {
      await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:z:100',
      });

      await notifications().markAllRead({ scope: scope(), userId: employeeId });

      const view = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: {},
      });
      assert.equal(view.counts.unread, 0);
      // Reading a critical alert is not saying you have seen it.
      assert.equal(view.counts.awaitingAcknowledgement, 1);
    });

    it('acknowledging marks it read too, satisfying the database rule', async () => {
      const raised = await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:ack:100',
      });

      const after = await notifications().acknowledge({
        scope: scope(),
        userId: employeeId,
        id: raised.notification!.id,
      });

      assert.notEqual(after.acknowledgedAt, null);
      assert.notEqual(after.readAt, null);
    });

    it('audits an acknowledgement, and does not audit merely reading', async () => {
      const raised = await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:audit:100',
      });

      await notifications().markAllRead({ scope: scope(), userId: employeeId });
      await notifications().acknowledge({
        scope: scope(),
        userId: employeeId,
        id: raised.notification!.id,
      });

      const actions = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: { startsWith: 'notification.' } },
          select: { action: true },
        }),
      );
      const kinds = new Set(actions.map((row) => row.action));
      assert.ok(kinds.has('notification.acknowledged'));
      // Read state is housekeeping; an acknowledgement is an assertion somebody made.
      assert.equal(kinds.has('notification.read'), false);
    });

    it('cannot acknowledge somebody else’s notification', async () => {
      const raised = await notifications().raise({
        tenantId,
        recipientUserId: peerId,
        kind: 'BudgetThreshold',
        severity: 'Critical',
        title: 'Allowance exhausted',
        body: 'AI work will be refused.',
        deepLink: '/settings/billing',
        resourceType: 'tenant_subscription',
        dedupeKey: 'budget:peer:100',
      });

      await assert.rejects(
        () =>
          notifications().acknowledge({
            scope: scope(),
            userId: employeeId,
            id: raised.notification!.id,
          }),
        /no such notification addressed to you/i,
      );
    });

    it('filters by unread, by assigned-to-me and by kind', async () => {
      await raiseApproval('A-1', employeeId);
      await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'Invitation',
        title: 'You have been invited',
        body: 'Activate your account.',
        deepLink: '/login',
        resourceType: 'invitation',
        isAssignedToRecipient: false,
        dedupeKey: 'invitation:sent:I-1',
      });

      const assigned = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: { assignedToMeOnly: true },
      });
      assert.equal(assigned.items.length, 1);
      assert.equal(assigned.items[0]?.kind, 'ApprovalWaiting');

      const byKind = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: { kind: 'Invitation' },
      });
      assert.equal(byKind.items.length, 1);

      await notifications().markAllRead({ scope: scope(), userId: employeeId });
      const unread = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: { unreadOnly: true },
      });
      assert.equal(unread.items.length, 0);
    });

    it('lets the database refuse a delete, so a delivered alert cannot vanish', async () => {
      await raiseApproval('A-1');

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `DELETE FROM notifications WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('email through the Prompt 10 outbox', () => {
    it('enqueues one outbox row carrying no address and no content', async () => {
      const raised = await raiseApproval('A-1');

      const messages = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.findMany({ where: { topic: 'notification.email' } }),
      );
      assert.equal(messages.length, 1);

      const payload = messages[0]?.payload as Record<string, unknown>;
      assert.equal(payload['notificationId'], raised.notification?.id);
      // The Prompt 10 rule, extended: an outbox row is long-lived, widely readable working
      // state, so the address and the body are read at dispatch time instead.
      assert.equal(payload['to'], undefined);
      assert.equal(payload['body'], undefined);
      assert.equal(payload['email'], undefined);

      assert.notEqual(raised.notification?.emailQueuedAt, null);
    });

    it('does not enqueue twice for the same notification', async () => {
      await raiseApproval('A-1');
      await raiseApproval('A-1');

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.count({ where: { topic: 'notification.email' } }),
      );
      assert.equal(count, 1);
    });

    it('dispatches it, and reports that nothing was actually sent', async () => {
      await raiseApproval('A-1');

      const outcome = await dispatcher().runOnce();
      assert.equal(outcome.delivered, 1);
      assert.equal(outcome.failed, 0);
      // The distinction the adapter design exists to preserve.
      assert.equal(outcome.adapter.deliversRealMail, false);

      assert.equal(email().sent.length, 1);
      assert.match(email().sent[0]?.subject ?? '', /needs your approval/i);
      assert.match(email().sent[0]?.text ?? '', /\/approvals\/A-1/);

      const delivered = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.findFirst({ where: { topic: 'notification.email' } }),
      );
      assert.equal(delivered?.state, 'Delivered');
    });

    it('marks a critical email as needing action, and says why it could not be muted', async () => {
      await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'SecurityEvent',
        severity: 'Critical',
        title: 'Your password was changed',
        body: 'If you did not change it, contact your administrator.',
        deepLink: '/settings/security',
        resourceType: 'security_event',
        dedupeKey: 'security:pwd:1',
      });

      await dispatcher().runOnce();
      const sent = email().sent[0];
      assert.match(sent?.subject ?? '', /^\[Action required]/);
      assert.match(sent?.text ?? '', /needs your acknowledgement/i);
      assert.match(sent?.text ?? '', /cannot be turned off/i);
    });

    it('records the channel in the audit trail rather than claiming delivery', async () => {
      await raiseApproval('A-1');
      await dispatcher().runOnce();

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'notification.email_dispatched' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['channel'], 'logged');
      assert.equal(metadata?.['deliversRealMail'], false);
    });

    it('fails rather than sending to a placeholder address, and retries with backoff', async () => {
      // Prompt 12's placeholder is deliberately undeliverable. A mail to an invalid domain is a
      // bounce nobody sees; a dead-lettered row saying "no address" is findable.
      const placeholder = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-NPLH-0001',
          email: 'ub-nplh-0001@person.uboss.invalid',
          displayName: 'No Address',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user;
      });

      await raiseApproval('A-2', placeholder.id);
      const outcome = await dispatcher().runOnce();

      assert.equal(outcome.delivered, 0);
      assert.equal(outcome.failed, 1);
      assert.equal(email().sent.length, 0);

      const message = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.findFirst({ where: { topic: 'notification.email' } }),
      );
      assert.equal(message?.state, 'Failed');
      assert.match(message?.lastError ?? '', /no real email address/i);
      // Backoff: it is not due again immediately.
      assert.ok((message?.availableAt.getTime() ?? 0) > Date.now());
    });

    it('reports rows for a topic it does not handle rather than swallowing them', async () => {
      // `user.invitation` has a producer and no consumer. A growing skipped count is how anybody
      // finds that out.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.outboxMessage.create({
          data: {
            topic: 'user.invitation',
            tenantId,
            idempotencyKey: 'unhandled-1',
            payload: { invitationId: 'I-1' },
          },
        }),
      );

      const outcome = await dispatcher().runOnce();
      assert.equal(outcome.skipped, 1);
      assert.equal(outcome.delivered, 0);
    });
  });

  // =========================================================================
  describe('escalation', () => {
    /** Something that was due to escalate an hour ago. */
    const raiseEscalating = (recipientUserId: string, id = 'A-9') =>
      notifications().raise({
        tenantId,
        recipientUserId,
        kind: 'ApprovalWaiting',
        severity: 'Warning',
        title: 'An objective needs your approval',
        body: 'A department objective is waiting on your decision.',
        deepLink: `/approvals/${id}`,
        resourceType: 'approval',
        resourceId: id,
        isAssignedToRecipient: true,
        dedupeKey: notificationDedupeKey.approvalWaiting(id),
        escalatesAt: new Date(Date.now() - 3_600_000),
      });

    const resolveManager = async ({
      tenantId: tid,
      recipientUserId,
    }: {
      tenantId: string;
      recipientUserId: string;
    }) => {
      const employment = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.findFirst({
          where: { tenantId: tid, userId: recipientUserId },
        }),
      );
      return employment?.reportingManagerUserId ?? null;
    };

    it('raises a new notification for the reporting manager and keeps the original', async () => {
      const original = await raiseEscalating(employeeId);

      const outcome = await notifications().escalateDue(resolveManager);
      assert.equal(outcome.escalated, 1);

      const managerView = await notifications().centerFor({
        scope: scope(),
        userId: managerId,
        filter: {},
      });
      const escalated = managerView.items.find((item) => item.title.startsWith('Escalated:'));
      assert.ok(escalated, 'the manager should have been notified');
      assert.equal(escalated?.escalatedFromId, original.notification?.id);
      // The manager is being told, not given the work. That is what the filter distinguishes.
      assert.equal(escalated?.isAssignedToRecipient, false);
      assert.equal(escalated?.deepLink, '/approvals/A-9');

      // The original is still there, and still theirs.
      const employeeView = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: {},
      });
      assert.equal(employeeView.items.length, 1);
      assert.equal(employeeView.items[0]?.escalated, true);
    });

    it('does not escalate twice', async () => {
      await raiseEscalating(employeeId);
      await notifications().escalateDue(resolveManager);
      const second = await notifications().escalateDue(resolveManager);
      assert.equal(second.escalated, 0);
    });

    it('does not escalate something already acknowledged', async () => {
      const original = await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'Overdue',
        severity: 'Critical',
        title: 'Overdue',
        body: 'Work is overdue.',
        deepLink: '/todo/T-1',
        resourceType: 'todo',
        resourceId: 'T-1',
        dedupeKey: 'overdue:T-1:critical',
        escalatesAt: new Date(Date.now() - 3_600_000),
      });

      await notifications().acknowledge({
        scope: scope(),
        userId: employeeId,
        id: original.notification!.id,
      });

      const outcome = await notifications().escalateDue(resolveManager);
      assert.equal(outcome.escalated, 0);
    });

    it('leaves something un-escalated when there is nobody above them', async () => {
      // The peer has no reporting manager. Marking it escalated would lose the escalation
      // permanently the moment somebody at the top of a hierarchy is asked for a decision.
      await raiseEscalating(peerId, 'A-8');

      const outcome = await notifications().escalateDue(resolveManager);
      assert.equal(outcome.escalated, 0);
      assert.equal(outcome.noManager, 1);

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.findFirst({
          where: { tenantId, recipientUserId: peerId },
        }),
      );
      assert.equal(row?.escalatedAt, null);
    });

    it('escalates again once that person is given a manager', async () => {
      await raiseEscalating(peerId, 'A-8');
      await notifications().escalateDue(resolveManager);

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.employmentRecord.updateMany({
          where: { tenantId, userId: peerId },
          data: { reportingManagerUserId: adminId },
        }),
      );

      const outcome = await notifications().escalateDue(resolveManager);
      assert.equal(outcome.escalated, 1);
    });

    it('raises the severity of an escalation to at least a warning', async () => {
      await notifications().raise({
        tenantId,
        recipientUserId: employeeId,
        kind: 'ApprovalWaiting',
        severity: 'Info',
        title: 'A minor approval',
        body: 'Waiting on you.',
        deepLink: '/approvals/A-7',
        resourceType: 'approval',
        resourceId: 'A-7',
        dedupeKey: notificationDedupeKey.approvalWaiting('A-7'),
        escalatesAt: new Date(Date.now() - 3_600_000),
      });

      await notifications().escalateDue(resolveManager);

      const managerView = await notifications().centerFor({
        scope: scope(),
        userId: managerId,
        filter: {},
      });
      // An escalation that arrived looking like information would be ignored exactly as the
      // original was.
      assert.equal(managerView.items[0]?.severity, 'Warning');
    });

    it('audits the escalation with both people', async () => {
      await raiseEscalating(employeeId);
      await notifications().escalateDue(resolveManager);

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'notification.escalated' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['fromUserId'], employeeId);
      assert.equal(metadata?.['toUserId'], managerId);
    });

    it('lets the database refuse an escalation chain that crosses companies', async () => {
      const other = await notifications().raise({
        tenantId: otherTenantId,
        recipientUserId: employeeId,
        kind: 'ApprovalWaiting',
        title: 'In the other company',
        body: 'Waiting there.',
        deepLink: '/approvals/X-1',
        resourceType: 'approval',
        dedupeKey: 'approval:X-1',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.notification.create({
              data: {
                tenantId,
                recipientUserId: managerId,
                kind: 'ApprovalWaiting',
                title: 'Escalated across a boundary',
                body: 'This must not be possible.',
                deepLink: '/approvals/X-1',
                resourceType: 'approval',
                dedupeKey: 'approval:X-1:escalation',
                escalatesAt: new Date(),
                escalatedFromId: other.notification!.id,
              },
            }),
          ),
        /foreign key|notifications_tenant_id_escalated_from_id_fkey/i,
      );
    });
  });

  // =========================================================================
  describe('the security event source', () => {
    it('turns a suspicious security event into a mandatory notification', async () => {
      await securityEvents().recordSuspicious({
        action: 'security.new_device_sign_in',
        category: 'Session',
        severity: 'Warning',
        tenantId,
        subjectUserId: employeeId,
        actorUserId: employeeId,
      });

      // The seam is synchronous and must not block, so the bridge starts the work and does not
      // await it. One tick is enough for a promise that only touches the database.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const view = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: {},
      });

      assert.equal(view.items.length, 1);
      assert.equal(view.items[0]?.kind, 'SecurityEvent');
      assert.equal(view.items[0]?.isMandatory, true);
      // Real wording, not the machine action key — the same defect as showing `svgDashboard`.
      assert.match(view.items[0]?.title ?? '', /new device/i);
      assert.equal(view.items[0]?.deepLink, '/settings/security');
    });

    it('collapses a storm into one notification per minute', async () => {
      const at = new Date();
      for (let index = 0; index < 5; index += 1) {
        await securityEvents().recordSuspicious({
          action: 'security.login_blocked_lockout',
          category: 'Session',
          severity: 'Warning',
          outcome: 'Blocked',
          tenantId,
          subjectUserId: employeeId,
          occurredAt: at,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 400));

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({
          where: { tenantId, recipientUserId: employeeId, kind: 'SecurityEvent' },
        }),
      );
      // A message per attempt during a password-guessing run trains people to ignore exactly the
      // alerts that matter.
      assert.equal(count, 1);
    });

    it('does not notify for a platform-plane event that belongs to no company', async () => {
      await securityEvents().recordSuspicious({
        action: 'security.login_failed',
        category: 'Session',
        severity: 'Warning',
        outcome: 'Failed',
        subjectUserId: employeeId,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({ where: { kind: 'SecurityEvent' } }),
      );
      // It is on the security trail, which is where a cross-tenant event belongs (ADR-045).
      // Putting one in a tenant's list would leak the fact that somebody tried.
      assert.equal(count, 0);
    });
  });

  // =========================================================================
  describe('budget threshold alerts', () => {
    const subscribe = async (input: {
      allowance: number;
      consumed: number;
      seats?: number | undefined;
      tenant?: string | undefined;
    }) => {
      const growth = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.plan.findUnique({ where: { code: 'growth' } }),
      );
      return ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.create({
          data: {
            tenantId: input.tenant ?? tenantId,
            planId: growth!.id,
            state: 'Active',
            billingState: 'Current',
            billingCycle: 'Annual',
            seatsLicensed: input.seats ?? 50,
            renewsAt: new Date(Date.now() + 200 * 86_400_000),
            aiAllowanceMinor: input.allowance,
            aiConsumedMinor: input.consumed,
          },
        }),
      );
    };

    it('warns the Company Admin at four fifths, and nobody else', async () => {
      await subscribe({ allowance: 100_000, consumed: 82_000 });

      const outcome = await budgets().raiseDueAlerts();
      assert.equal(outcome.raised, 1);

      const adminView = await notifications().centerFor({
        scope: scope(),
        userId: adminId,
        filter: {},
      });
      assert.equal(adminView.items.length, 1);
      assert.equal(adminView.items[0]?.severity, 'Warning');
      assert.match(adminView.items[0]?.title ?? '', /82% consumed/);
      // An administrator is being told; buying more allowance is a decision, not a task in a
      // queue.
      assert.equal(adminView.items[0]?.isAssignedToRecipient, false);

      const employeeView = await notifications().centerFor({
        scope: scope(),
        userId: employeeId,
        filter: {},
      });
      assert.equal(employeeView.items.length, 0);
    });

    it('raises a critical alert when the allowance is gone', async () => {
      await subscribe({ allowance: 100_000, consumed: 100_000 });
      await budgets().raiseDueAlerts();

      const view = await notifications().centerFor({
        scope: scope(),
        userId: adminId,
        filter: {},
      });
      assert.equal(view.items[0]?.severity, 'Critical');
      assert.equal(view.items[0]?.requiresAcknowledgement, true);
      assert.match(view.items[0]?.body ?? '', /refused/i);
    });

    it('raises only the highest threshold crossed', async () => {
      await subscribe({ allowance: 100_000, consumed: 100_000 });
      await budgets().raiseDueAlerts();

      const budgetItems = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.notification.count({
          where: { tenantId, kind: 'BudgetThreshold' },
        }),
      );
      // Two notifications saying different things about the same fact is worse than one.
      assert.equal(budgetItems, 1);
    });

    it('is idempotent: running the sweep again raises nothing', async () => {
      await subscribe({ allowance: 100_000, consumed: 82_000 });
      await budgets().raiseDueAlerts();
      const second = await budgets().raiseDueAlerts();

      assert.equal(second.raised, 0);
      assert.equal(second.alreadyNotified, 1);
    });

    it('notifies again at the next threshold', async () => {
      const subscription = await subscribe({ allowance: 100_000, consumed: 82_000 });
      await budgets().raiseDueAlerts();

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: { aiConsumedMinor: 100_000 },
        }),
      );
      const second = await budgets().raiseDueAlerts();
      assert.equal(second.raised, 1);
    });

    it('warns when seats are nearly exhausted', async () => {
      // Four members were created in the fixture plus the provisioned first member: five.
      await subscribe({ allowance: 0, consumed: 0, seats: 5 });
      await budgets().raiseDueAlerts();

      const view = await notifications().centerFor({
        scope: scope(),
        userId: adminId,
        filter: {},
      });
      assert.match(view.items[0]?.title ?? '', /seat/i);
    });

    it('counts a company with no Company Admin rather than skipping it silently', async () => {
      await subscribe({ allowance: 100_000, consumed: 100_000, tenant: otherTenantId });
      // The other company has a provisioned first member but no CompanyAdmin role assignment.
      const outcome = await budgets().raiseDueAlerts();
      assert.equal(outcome.noRecipients, 1);
    });
  });

  // =========================================================================
  describe('tenant isolation and the API', () => {
    it('never shows one company’s notifications in another', async () => {
      await raiseApproval('A-1', employeeId);

      const visible = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.notification.count({}),
      );
      assert.equal(visible, 0);

      const otherView = await notifications().centerFor({
        scope: otherScope(),
        userId: employeeId,
        filter: {},
      });
      assert.equal(otherView.items.length, 0);
      assert.equal(otherView.counts.unread, 0);
    });

    it('serves the center and the counts over HTTP', async () => {
      await raiseApproval('A-1', employeeId);

      const center = await as(
        agent().get(`/tenants/${tenantId}/notifications`),
        employeeUboss,
      ).expect(200);
      assert.equal(center.body.items.length, 1);
      assert.equal(center.body.items[0].deepLink, '/approvals/A-1');

      const counts = await as(
        agent().get(`/tenants/${tenantId}/notifications/counts`),
        employeeUboss,
      ).expect(200);
      assert.equal(counts.body.unread, 1);
    });

    it('shows nothing to somebody the notifications were not addressed to', async () => {
      await raiseApproval('A-1', employeeId);

      const view = await as(agent().get(`/tenants/${tenantId}/notifications`), peerUboss).expect(
        200,
      );
      // Recipient scoping is in the `where` clause, not a check afterwards, so a valid id
      // belonging to somebody else simply matches nothing.
      assert.equal(view.body.items.length, 0);
    });

    it('marks read and marks all read over HTTP', async () => {
      const raised = await raiseApproval('A-1', employeeId);

      const marked = await as(
        agent().post(`/tenants/${tenantId}/notifications/read`),
        employeeUboss,
      )
        .send({ ids: [raised.notification!.id] })
        .expect(201);
      assert.equal(marked.body.marked, 1);

      const all = await as(
        agent().post(`/tenants/${tenantId}/notifications/read-all`),
        employeeUboss,
      ).expect(201);
      assert.match(all.body.note, /acknowledgement/i);
    });

    it('serves preferences and refuses to change a mandatory one over HTTP', async () => {
      const view = await as(
        agent().get(`/tenants/${tenantId}/notifications/preferences`),
        employeeUboss,
      ).expect(200);
      assert.equal(view.body.preferences.length, 6);
      assert.match(view.body.note, /cannot be turned off/i);

      await as(agent().put(`/tenants/${tenantId}/notifications/preferences`), employeeUboss)
        .send({
          kind: 'SecurityEvent',
          inAppEnabled: false,
          emailEnabled: false,
          digest: 'Off',
        })
        .expect(400);

      await as(agent().put(`/tenants/${tenantId}/notifications/preferences`), employeeUboss)
        .send({
          kind: 'ApprovalWaiting',
          inAppEnabled: false,
          emailEnabled: true,
          digest: 'Daily',
        })
        .expect(200);
    });

    it('refuses an unknown kind at the boundary', async () => {
      await as(agent().put(`/tenants/${tenantId}/notifications/preferences`), employeeUboss)
        .send({ kind: 'Invented', inAppEnabled: true, emailEnabled: true, digest: 'Off' })
        .expect(400);
    });

    it('keeps the operational jobs on the platform plane', async () => {
      // A company administrator running the platform's mail queue would be a strange thing to
      // permit.
      await as(agent().post(`/platform/notifications/dispatch`), adminUboss).expect(403);

      await agent()
        .post(`/platform/notifications/dispatch`)
        .set('x-uboss-dev-actor', ownerUboss)
        .expect(201);
    });
  });
});
