import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { CONTEXT_PERMISSION, RESTRICTED_PREVIEW_REASON } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { RoleAdministrationService } from '../src/authorization/role-administration.service.js';
import { TcsionMappingService } from '../src/authorization/tcsion-mapping.service.js';
import { ChatContextService } from '../src/chat/chat-context.service.js';
import { ChatController } from '../src/chat/chat.controller.js';
import { ChatService } from '../src/chat/chat.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
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
 * Workspace Chat — Prompt 40A (CR-03) §6, against real PostgreSQL.
 *
 * **The weight of this suite is on one rule**: chat membership grants no access to the resource a
 * conversation refers to. Everything else here is ordinary product behaviour; that one is the
 * difference between a chat feature and the easiest privilege escalation in the product.
 *
 * So the tests that matter most are:
 *
 *  * a person in a conversation about an Objective they cannot see gets a **stated refusal with no
 *    title in it**, while the colleague beside them in the same conversation sees the name;
 *  * you cannot link something you cannot see yourself — otherwise you could use a colleague's
 *    permissions as an oracle;
 *  * losing access removes the preview, with nobody editing the conversation;
 *  * search never reaches a conversation you are not in;
 *  * one company's conversations are invisible to another.
 */
describe('workspace chat (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let departmentId: string;

  let headId: string;
  let employeeId: string;
  let employeeUboss: string;
  let colleagueId: string;
  let strangerUboss: string;
  let ownerId: string;

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
      controllers: [ChatController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        RoleAdministrationService,
        TcsionMappingService,
        TenantContextService,
        ChatService,
        ChatContextService,
        // The real resolver: `OwnWork` scoping is what makes a restricted preview restricted, and
        // a stub would prove only that the stub works.
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
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
      slug: 'chat-co',
      name: 'Chat Co',
      firstMember: { email: 'first@chat.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-chat-co',
      name: 'Other Chat Co',
      firstMember: { email: 'first@other-chat.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const made = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (email: string, name: string, tenant: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: tenant, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      const department = await ctx.prisma.client.department.create({
        data: { tenantId: provisioned.tenant.id, name: 'Operations', code: 'OPS' },
      });

      return {
        department,
        head: await member('head@chat.example', 'Head', provisioned.tenant.id),
        employee: await member('emp@chat.example', 'Employee', provisioned.tenant.id),
        colleague: await member('col@chat.example', 'Colleague', provisioned.tenant.id),
        stranger: await member('str@other-chat.example', 'Stranger', other.tenant.id),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email: 'owner@chat-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    departmentId = made.department.id;
    headId = made.head.id;
    employeeId = made.employee.id;
    employeeUboss = made.employee.ubossUniqueId;
    colleagueId = made.colleague.id;
    strangerUboss = made.stranger.ubossUniqueId;
    ownerId = made.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      // A Head who can read Objectives in the department, and two Employees who — since CR-03 —
      // cannot read Objectives at all. That asymmetry is what makes the preview test meaningful.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId,
          userId: headId,
          roleKind: 'Head',
          scopeKind: 'Department',
          departmentIds: [departmentId],
          grantedByUserId: ownerId,
        },
      });
      for (const userId of [employeeId, colleagueId]) {
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId,
            userId,
            roleKind: 'Employee',
            scopeKind: 'OwnWork',
            grantedByUserId: ownerId,
          },
        });
      }
    });
  });

  // ---- helpers ----

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  const chat = () => app.get(ChatService);
  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);

  /** An Objective a Head can see and an Employee cannot. */
  const seedObjective = async (name: string): Promise<string> =>
    ctx.prisma.runAsPlatformOperation(async () => {
      const objective = await ctx.prisma.client.objective.create({
        data: {
          tenantId,
          code: `OBJ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          departmentId,
          objectiveOwnerUserId: headId,
          createdByUserId: headId,
        },
      });
      const approvedAt = new Date();
      const version = await ctx.prisma.client.objectiveVersion.create({
        data: {
          tenantId,
          objectiveId: objective.id,
          versionNumber: 1,
          origin: 'Initial',
          status: 'Active',
          // Prompt 20's provenance and approval constraints apply to this row too: a live version
          // records when it was approved, by whom, and when it was published. The fixture
          // satisfies them rather than working around them — a row refused for the wrong reason
          // would prove nothing about chat.
          approvedAt,
          approvedByUserId: headId,
          publishedAt: new Date(approvedAt.getTime() + 1),
          objectiveName: name,
          departmentId,
          objectiveOwnerUserId: headId,
          expectedFinalResult: 'A filing accepted on the first submission.',
          createdByUserId: headId,
        },
      });
      await ctx.prisma.client.objective.update({
        where: { id: objective.id },
        data: { activeVersionId: version.id },
      });
      return objective.id;
    });

  const startGroup = async (
    actorUserId: string,
    participantUserIds: string[],
    title = 'Month end',
  ) =>
    chat().startConversation({
      scope: scope(),
      actorUserId,
      kind: 'Group',
      participantUserIds,
      title,
    });

  // =========================================================================
  describe('a context reference grants nothing — the rule this feature turns on', () => {
    it('shows the name to somebody with access and refuses it to somebody without, in the same conversation', async () => {
      const objectiveId = await seedObjective('Regulatory filing Q3');
      const conversation = await startGroup(headId, [headId, employeeId]);

      await chat().addContext({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        ref: { type: 'Objective', id: objectiveId },
      });

      const headView = (await chat().readConversation({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
      })) as { context: { accessible: boolean; title?: string }[] };

      const employeeView = (await chat().readConversation({
        scope: scope(),
        actorUserId: employeeId,
        conversationId: conversation.id,
      })) as { context: { accessible: boolean; reason?: string }[] };

      // The Head can read Objectives in this department.
      assert.equal(headView.context[0]?.accessible, true);
      assert.equal(headView.context[0]?.title, 'Regulatory filing Q3');

      // The Employee is in the same conversation and cannot. **This is the escalation test.**
      assert.equal(employeeView.context[0]?.accessible, false);
      assert.equal(employeeView.context[0]?.reason, RESTRICTED_PREVIEW_REASON);

      // And the name appears nowhere in what the Employee was served.
      assert.equal(
        JSON.stringify(employeeView).includes('Regulatory filing Q3'),
        false,
        'the objective name leaked to somebody who cannot see the objective',
      );
    });

    it('refuses to link something the linker cannot see themselves', async () => {
      // Otherwise anybody could attach an arbitrary id and wait for a colleague with access to
      // open the conversation and render the preview for them — using somebody else's
      // permissions as an oracle.
      const objectiveId = await seedObjective('Confidential restructure');
      const conversation = await startGroup(employeeId, [employeeId, colleagueId]);

      await assert.rejects(
        chat().addContext({
          scope: scope(),
          actorUserId: employeeId,
          conversationId: conversation.id,
          ref: { type: 'Objective', id: objectiveId },
        }),
        (error: Error) => /do not have access/i.test(error.message),
      );

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.chatContextRefRow.count({ where: { tenantId } }),
      );
      assert.equal(stored, 0, 'a reference was stored despite the refusal');
    });

    it('stops previewing when access is lost, with nobody editing the conversation', async () => {
      const objectiveId = await seedObjective('Seasonal hiring');
      const conversation = await startGroup(headId, [headId, employeeId]);
      await chat().addContext({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        ref: { type: 'Objective', id: objectiveId },
      });

      const before = (await chat().readConversation({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
      })) as { context: { accessible: boolean }[] };
      assert.equal(before.context[0]?.accessible, true);

      // The Head's role goes away. Nothing about the conversation changes.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.roleAssignment.deleteMany({ where: { tenantId, userId: headId } }),
      );

      const after = (await chat().readConversation({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
      })) as { context: { accessible: boolean }[] };

      // The property a cached title could not have.
      assert.equal(after.context[0]?.accessible, false);
    });

    it('stores a reference with no copy of the resource in it', async () => {
      const objectiveId = await seedObjective('Nothing cached here');
      const conversation = await startGroup(headId, [headId, employeeId]);
      await chat().addContext({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        ref: { type: 'Objective', id: objectiveId },
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.chatContextRefRow.findFirstOrThrow({ where: { tenantId } }),
      );

      // A type and an id. If a title ever gets cached here, this fails — which is the point:
      // a cached title is a copy of the resource's content outside its own authorization.
      assert.equal(JSON.stringify(row).includes('Nothing cached here'), false);
      assert.equal(row.contextType, 'Objective');
      assert.equal(row.resourceId, objectiveId);
    });

    it('resolves every context type against that resource’s own module, never against chat', () => {
      // A `chat:View` grant would make chat an authority of its own. Asserted on the table rather
      // than through six round trips, because the table is what the resolver reads.
      for (const [type, required] of Object.entries(CONTEXT_PERMISSION)) {
        assert.notEqual(required.module, 'chat', `${type} resolves against chat`);
        assert.equal(required.action, 'View', `${type} should need only View`);
      }
    });
  });

  // =========================================================================
  describe('membership is the only gate', () => {
    it('hides a conversation from somebody who is not in it', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);

      // Not "Forbidden": that would confirm the conversation exists and that these two people are
      // talking, which the participants have not shared either.
      await assert.rejects(
        chat().readConversation({
          scope: scope(),
          actorUserId: colleagueId,
          conversationId: conversation.id,
        }),
        (error: Error) => /no such conversation/i.test(error.message),
      );
    });

    it('refuses a message from somebody who is not in it', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      await assert.rejects(
        chat().sendMessage({
          scope: scope(),
          actorUserId: colleagueId,
          conversationId: conversation.id,
          body: 'Let me in',
        }),
      );
    });

    it('refuses a conversation you are not part of yourself', async () => {
      await assert.rejects(
        chat().startConversation({
          scope: scope(),
          actorUserId: headId,
          kind: 'Group',
          participantUserIds: [employeeId, colleagueId],
          title: 'About you two',
        }),
        (error: Error) => /cannot start a conversation you are not part of/i.test(error.message),
      );
    });

    it('refuses somebody from another company as a participant', async () => {
      const outsider = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirstOrThrow({
          where: { tenantId: otherTenantId },
          select: { userId: true },
        }),
      );

      await assert.rejects(
        chat().startConversation({
          scope: scope(),
          actorUserId: headId,
          kind: 'Direct',
          participantUserIds: [headId, outsider.userId],
        }),
        (error: Error) => /not an active member of this company/i.test(error.message),
      );
    });

    it('keeps one company’s conversations invisible to another', async () => {
      await startGroup(headId, [headId, employeeId], 'Ours');

      const visible = await ctx.prisma.runInTenantTransaction(scope(otherTenantId), () =>
        ctx.prisma.client.chatConversation.findMany({}),
      );
      assert.deepEqual(visible, []);
    });

    it('refuses a stranger over HTTP', async () => {
      await asPerson(agent().get(`/tenants/${tenantId}/chat/conversations`), strangerUboss).expect(
        403,
      );
    });
  });

  // =========================================================================
  describe('conversations', () => {
    it('gives two people one direct conversation however they start it', async () => {
      const first = await chat().startConversation({
        scope: scope(),
        actorUserId: headId,
        kind: 'Direct',
        participantUserIds: [headId, employeeId],
      });
      const second = await chat().startConversation({
        scope: scope(),
        actorUserId: employeeId,
        kind: 'Direct',
        participantUserIds: [employeeId, headId],
      });

      // Reversed order, other person starting it. Without the sorted key this would be two
      // conversations, each holding half the history — which presents as lost messages.
      assert.equal(second.id, first.id);
      assert.equal(first.created, true);
      assert.equal(second.created, false);
    });

    it('refuses a direct message with a name, or a group without one', async () => {
      await assert.rejects(
        chat().startConversation({
          scope: scope(),
          actorUserId: headId,
          kind: 'Direct',
          participantUserIds: [headId, employeeId],
          title: 'Named DM',
        }),
      );
      await assert.rejects(
        chat().startConversation({
          scope: scope(),
          actorUserId: headId,
          kind: 'Group',
          participantUserIds: [headId, employeeId],
          title: '   ',
        }),
      );
    });

    it('audits starting a conversation without recording who is in it', async () => {
      await startGroup(headId, [headId, employeeId], 'Quarter close');

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: 'chat.conversation_started' },
        }),
      );
      assert.equal(events.length, 1);
      // The count, not the list. Who is in a conversation is the conversation's business, and an
      // audit trail is read by people who are not in it.
      const serialised = JSON.stringify(events[0]?.metadata);
      assert.equal(serialised.includes(employeeId), false);
      assert.match(serialised, /"participants":2/);
    });
  });

  // =========================================================================
  describe('messages', () => {
    it('does not audit an ordinary message', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'Morning',
      });

      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.count({ where: { tenantId, action: 'chat.message_sent' } }),
      );
      // CR-03 says not to. An audit trail holding every message would be a second copy of every
      // conversation, in the one table designed never to be deleted.
      assert.equal(events, 0);
    });

    it('drops a mention of somebody outside the conversation and says it did', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      const sent = await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'Can @emp and @col look at this?',
        mentionResolutions: { emp: employeeId, col: colleagueId },
      });

      // Resolving the second would notify somebody about a conversation they cannot open — which
      // leaks that it exists and sends them somewhere they are refused.
      assert.deepEqual(sent.mentionedUserIds, [employeeId]);
      assert.deepEqual(sent.ignoredMentions, [colleagueId]);
    });

    it('keeps a deleted message’s place and none of its words', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      const sent = await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'Please ignore that',
      });

      await chat().deleteMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        messageId: sent.id,
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.chatMessage.findFirstOrThrow({ where: { id: sent.id } }),
      );
      // The constraint `deleted_message_keeps_no_text` makes the blanking a guarantee rather than
      // a habit of whoever wrote the service.
      assert.equal(row.body, '');
      assert.notEqual(row.deletedAt, null);

      const read = (await chat().readConversation({
        scope: scope(),
        actorUserId: employeeId,
        conversationId: conversation.id,
      })) as { messages: { deleted: boolean; body: string | null }[] };
      assert.equal(read.messages[0]?.deleted, true);
      assert.equal(read.messages[0]?.body, null);
    });

    it('lets only the author delete their message', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      const sent = await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'Mine',
      });

      await assert.rejects(
        chat().deleteMessage({
          scope: scope(),
          actorUserId: employeeId,
          conversationId: conversation.id,
          messageId: sent.id,
        }),
        (error: Error) => /only delete your own/i.test(error.message),
      );
    });

    it('refuses an empty message with nothing attached', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      await assert.rejects(
        chat().sendMessage({
          scope: scope(),
          actorUserId: headId,
          conversationId: conversation.id,
          body: '   ',
        }),
      );
    });

    it('counts unread without counting your own messages', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'One',
      });
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'Two',
      });

      const forEmployee = await chat().listConversations({
        scope: scope(),
        actorUserId: employeeId,
      });
      assert.equal(forEmployee[0]?.unread, 2);

      // A badge that counted your own messages would make sending one look like receiving one.
      const forHead = await chat().listConversations({ scope: scope(), actorUserId: headId });
      assert.equal(forHead[0]?.unread, 0);

      await chat().markRead({
        scope: scope(),
        actorUserId: employeeId,
        conversationId: conversation.id,
      });
      const afterReading = await chat().listConversations({
        scope: scope(),
        actorUserId: employeeId,
      });
      assert.equal(afterReading[0]?.unread, 0);
    });
  });

  // =========================================================================
  describe('search', () => {
    it('never reaches a conversation you are not in', async () => {
      const theirs = await startGroup(headId, [headId, colleagueId], 'Not yours');
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: theirs.id,
        body: 'The secret word is pineapple',
      });

      const mine = await startGroup(headId, [headId, employeeId], 'Yours');
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: mine.id,
        body: 'Nothing interesting here',
      });

      const found = await chat().search({
        scope: scope(),
        actorUserId: employeeId,
        term: 'pineapple',
      });

      // A search across every message would be a read of every conversation — the same
      // escalation as an unchecked preview, and far easier to run.
      assert.deepEqual(found.messages, []);
    });

    it('finds a message in a conversation you are in', async () => {
      const conversation = await startGroup(headId, [headId, employeeId]);
      await chat().sendMessage({
        scope: scope(),
        actorUserId: headId,
        conversationId: conversation.id,
        body: 'The reconciliation is due Friday',
      });

      const found = await chat().search({
        scope: scope(),
        actorUserId: employeeId,
        term: 'reconciliation',
      });
      assert.equal(found.messages.length, 1);
    });

    it('refuses a search term too short to mean anything', async () => {
      await assert.rejects(chat().search({ scope: scope(), actorUserId: employeeId, term: 'a' }));
    });
  });

  // =========================================================================
  describe('what it says about itself', () => {
    it('publishes the boundary rather than leaving it in a prompt', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/chat/meta`),
        employeeUboss,
      ).expect(200);

      const body = response.body as {
        excludedByDesign: { feature: string; why: string }[];
        contextStance: string;
        realtimeStance: string;
      };

      // Each exclusion carries its reason, so the next person to be asked for reactions has the
      // argument rather than only the refusal.
      assert.ok(body.excludedByDesign.length >= 5);
      for (const entry of body.excludedByDesign) {
        assert.ok(entry.why.length > 30, `${entry.feature} has no reason`);
      }
      assert.match(body.contextStance, /resolved against your own permissions/i);
      // The honest one: no socket transport is bound, and the API says so rather than letting
      // somebody demonstrate chat and call it realtime.
      assert.match(body.realtimeStance, /no socket transport is bound/i);
    });
  });
});
