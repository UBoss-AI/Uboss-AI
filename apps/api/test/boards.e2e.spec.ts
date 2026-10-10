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
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import {
  AuthorizationService,
  HIERARCHY_RESOLVER,
} from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { BoardController } from '../src/boards/board.controller.js';
import { BoardService } from '../src/boards/board.service.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { BoardRepository } from '../src/persistence/board.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
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
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Task & Tracker — the board model.
 *
 * These hold the properties that make a board model a board model rather than a set of tables,
 * and each one is a thing that would be easy to get wrong and hard to notice:
 *
 *   1. **A new board is usable the moment it exists** — groups and columns, not an empty grid.
 *   2. **Board kind decides reach before membership does**, and a private board somebody is not
 *      on is *absent* rather than forbidden.
 *   3. **A viewer reads and does not write**, whatever module grants they hold.
 *   4. **Creating a board needs `todo:Create`**, which a standard Employee does not have.
 *   5. **Nesting stops at four levels**, and says so rather than growing a tree nobody bounded.
 *   6. **A board cannot be left without an owner.**
 *   7. **Cells are sparse**, and clearing one removes it rather than storing nothing.
 *   8. **One company never sees another's board**, enforced below the service.
 */
describe('Task & Tracker boards (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let ownerId: string;

  const agent = () => request(app.getHttpServer());

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

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
      controllers: [BoardController],
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
        BoardRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
        BoardService,
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
      slug: 'board-co',
      name: 'Board Co',
      firstMember: { email: 'first@board.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-board-co',
      name: 'Other Board Co',
      firstMember: { email: 'first@other-board.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@board.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-BADM-0001', 'Board Admin'),
        manager: await member('UB-BMGR-0001', 'Board Manager'),
        employee: await member('UB-BEMP-0001', 'Board Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-BOWN-0001',
          email: 'owner@board-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [people.manager.id, 'Manager', 'TeamSubtree'],
        [employeeId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }
    });
  });

  /** A board owned by the administrator, with its id. */
  const makeBoard = async (name: string, kind?: string): Promise<string> => {
    const response = await as(agent().post(`/tenants/${tenantId}/boards`), adminUboss)
      .send({ name, ...(kind === undefined ? {} : { kind }) })
      .expect(201);
    return response.body.id as string;
  };

  describe('making one', () => {
    it('ships a board that can be used the moment it exists', async () => {
      const boardId = await makeBoard('Delivery');

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      /*
       * An empty board is a dead end: somebody has to invent groups, columns and a first row
       * before anything on screen does anything. Three of each, all renameable.
       */
      assert.equal(open.body.groups.length, 3);
      assert.deepEqual(
        (open.body.groups as { title: string }[]).map((group) => group.title),
        ['To do', 'In progress', 'Done'],
      );
      assert.deepEqual(
        (open.body.columns as { title: string; kind: string }[]).map((column) => column.kind),
        ['Status', 'People', 'Date'],
      );

      // And the status column arrives with labels, not an empty list somebody has to fill in
      // before the column means anything.
      const status = (open.body.columns as { kind: string; settings: unknown }[]).find(
        (column) => column.kind === 'Status',
      );
      assert.equal((status!.settings as { labels: unknown[] }).labels.length, 4);
    });

    it('makes the person who made it an owner', async () => {
      const boardId = await makeBoard('Mine');
      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      assert.equal(open.body.board.myRole, 'Owner');
      assert.equal(open.body.board.mayEdit, true);
    });

    it('refuses a standard employee, who has no todo:Create', async () => {
      // monday.com gates board creation at the account level for the same reason: a company of
      // four hundred where everybody makes boards has four hundred boards and no map. An
      // administrator can still grant `todo:Create` to somebody deliberately.
      await as(agent().post(`/tenants/${tenantId}/boards`), employeeUboss)
        .send({ name: 'Not allowed' })
        .expect(403);
    });

    it('lets a manager make one', async () => {
      await as(agent().post(`/tenants/${tenantId}/boards`), managerUboss)
        .send({ name: 'Manager board' })
        .expect(201);
    });
  });

  describe('who can reach one', () => {
    it('shows a main board to somebody who was never added to it', async () => {
      const boardId = await makeBoard('Company wide', 'Main');

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        employeeUboss,
      ).expect(200);

      assert.equal(open.body.board.myRole, null);
      // Main means the company's: open it and work on it. That is what the word means on
      // monday.com and what people expect from it.
      assert.equal(open.body.board.mayEdit, true);
    });

    it('hides a private board from somebody who is not on it, rather than forbidding it', async () => {
      const boardId = await makeBoard('Pay review', 'Private');

      /*
       * 404, not 403. A 403 confirms the board exists, which is the one thing a private board
       * is for — "there is a board called Pay review and you may not see it" is most of what
       * somebody wanted to know.
       */
      await as(agent().get(`/tenants/${tenantId}/boards/${boardId}`), employeeUboss).expect(404);

      const list = await as(agent().get(`/tenants/${tenantId}/boards`), employeeUboss).expect(200);
      assert.equal(
        (list.body.boards as { id: string }[]).some((board) => board.id === boardId),
        false,
      );
    });

    it('shows a private board once somebody is added to it', async () => {
      const boardId = await makeBoard('Pay review', 'Private');

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/members`), adminUboss)
        .send({ userId: employeeId, role: 'Member' })
        .expect(201);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        employeeUboss,
      ).expect(200);
      assert.equal(open.body.board.myRole, 'Member');
      assert.equal(open.body.board.mayEdit, true);
    });

    it('lets a viewer read and refuses to let them write', async () => {
      const boardId = await makeBoard('Watch only', 'Private');
      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/members`), adminUboss)
        .send({ userId: employeeId, role: 'Viewer' })
        .expect(201);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        employeeUboss,
      ).expect(200);
      assert.equal(open.body.board.mayEdit, false);

      // Whatever module grants they hold. That is the whole point of the role.
      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/items`), employeeUboss)
        .send({ name: 'Nope' })
        .expect(403);
    });

    it('never shows one company another company’s board', async () => {
      const boardId = await makeBoard('Ours');

      await as(
        agent().get(`/tenants/${otherTenantId}/boards/${boardId}`),
        adminUboss,
        otherTenantId,
      ).expect((response) => {
        assert.ok(
          response.status === 403 || response.status === 404,
          `expected a refusal, got ${response.status}`,
        );
      });
    });
  });

  describe('items', () => {
    it('drops a row into the first group when nobody said where', async () => {
      const boardId = await makeBoard('Work');
      const item = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'First task' })
        .expect(201);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      const toDo = (open.body.groups as { id: string; title: string }[]).find(
        (group) => group.title === 'To do',
      );
      assert.equal(item.body.groupId, toDo!.id);
      assert.equal(item.body.depth, 0);
    });

    it('stops nesting at four levels, and says so', async () => {
      const boardId = await makeBoard('Deep');

      let parentId: string | undefined;
      for (let level = 0; level < 4; level += 1) {
        const response = await as(
          agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
          adminUboss,
        )
          .send({ name: `Level ${level}`, ...(parentId ? { parentItemId: parentId } : {}) })
          .expect(level < 4 ? 201 : 409);
        parentId = response.body.id as string;
        assert.equal(response.body.depth, level);
      }

      // The fifth would be level four, which is one more than four levels of hierarchy.
      const refused = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'Too deep', parentItemId: parentId })
        .expect(409);
      assert.match(refused.body.message, /four levels|4 levels/i);
    });

    it('writes a cell, and clears it by removing the row rather than storing nothing', async () => {
      const boardId = await makeBoard('Cells');
      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);
      const statusColumn = (open.body.columns as { id: string; kind: string }[]).find(
        (column) => column.kind === 'Status',
      )!;

      const item = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'Has a status' })
        .expect(201);

      await as(agent().patch(`/tenants/${tenantId}/boards/items/${item.body.id}/cells`), adminUboss)
        .send({ columnId: statusColumn.id, value: { labelId: '2' } })
        .expect(200);

      const filled = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);
      assert.equal(filled.body.cells.length, 1);

      // Sparse: an empty cell is the absence of a row, not a row holding null. Two ways to say
      // nothing would mean every reader had to handle both.
      await as(agent().patch(`/tenants/${tenantId}/boards/items/${item.body.id}/cells`), adminUboss)
        .send({ columnId: statusColumn.id })
        .expect(200);

      const cleared = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);
      assert.equal(cleared.body.cells.length, 0);
    });

    it('refuses a cell whose column is on another board', async () => {
      const first = await makeBoard('One');
      const second = await makeBoard('Two');

      const theirs = await as(
        agent().get(`/tenants/${tenantId}/boards/${second}`),
        adminUboss,
      ).expect(200);
      const column = (theirs.body.columns as { id: string }[])[0]!;

      const item = await as(agent().post(`/tenants/${tenantId}/boards/${first}/items`), adminUboss)
        .send({ name: 'Mine' })
        .expect(201);

      await as(agent().patch(`/tenants/${tenantId}/boards/items/${item.body.id}/cells`), adminUboss)
        .send({ columnId: column.id, value: { labelId: '1' } })
        .expect(400);
    });
  });

  describe('the thread', () => {
    it('takes a post and a reply to it, and refuses a reply to a reply', async () => {
      const boardId = await makeBoard('Talking');
      const item = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'Discussed' })
        .expect(201);

      const post = await as(
        agent().post(`/tenants/${tenantId}/boards/items/${item.body.id}/updates`),
        adminUboss,
      )
        .send({ body: 'Why is this stuck?' })
        .expect(201);

      await as(
        agent().post(`/tenants/${tenantId}/boards/items/${item.body.id}/updates`),
        employeeUboss,
      )
        .send({ body: 'Waiting on the supplier.', parentUpdateId: post.body.id })
        .expect(201);

      // A thread of threads is a forum, and nobody reads those.
      const reply = await as(
        agent().get(`/tenants/${tenantId}/boards/items/${item.body.id}/updates`),
        adminUboss,
      ).expect(200);
      const nested = (reply.body.updates as { id: string; parentUpdateId: string | null }[]).find(
        (update) => update.parentUpdateId !== null,
      )!;

      await as(
        agent().post(`/tenants/${tenantId}/boards/items/${item.body.id}/updates`),
        adminUboss,
      )
        .send({ body: 'And again', parentUpdateId: nested.id })
        .expect(400);
    });
  });

  describe('membership', () => {
    it('refuses to leave a board without an owner', async () => {
      const boardId = await makeBoard('Orphan risk', 'Private');

      /*
       * Not tidiness: membership is what makes a private board reachable, so the last owner
       * removing themselves leaves a board nobody can open, administer or archive — a row only
       * a database client can reach.
       */
      const refused = await as(
        agent().delete(`/tenants/${tenantId}/boards/${boardId}/members/${adminId}`),
        adminUboss,
      ).expect(409);
      assert.match(refused.body.message, /last owner/i);
    });

    it('lets an owner hand ownership over and then step off', async () => {
      const boardId = await makeBoard('Handover', 'Private');

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/members`), adminUboss)
        .send({ userId: employeeId, role: 'Owner' })
        .expect(201);

      await as(
        agent().delete(`/tenants/${tenantId}/boards/${boardId}/members/${adminId}`),
        adminUboss,
      ).expect(200);

      // And the board is still reachable — by its remaining owner.
      await as(agent().get(`/tenants/${tenantId}/boards/${boardId}`), employeeUboss).expect(200);
    });

    it('refuses somebody who is not an owner changing who is on it', async () => {
      const boardId = await makeBoard('Not yours', 'Main');

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/members`), managerUboss)
        .send({ userId: employeeId, role: 'Member' })
        .expect(403);
    });
  });

  describe('archiving', () => {
    it('archives a board without deleting anything, and takes it out of the list', async () => {
      const boardId = await makeBoard('Done with');

      const response = await as(
        agent().delete(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);
      assert.equal(response.body.nothingDeleted, true);

      const list = await as(agent().get(`/tenants/${tenantId}/boards`), adminUboss).expect(200);
      assert.equal(
        (list.body.boards as { id: string }[]).some((board) => board.id === boardId),
        false,
      );

      // The row is still there. A board is a record of what people did, and tidying a sidebar is
      // not a reason to lose it.
      const still = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.board.findUnique({ where: { id: boardId } }),
      );
      assert.ok(still);
      assert.ok(still!.archivedAt);
    });

    it('records every write on the company’s own audit trail', async () => {
      const boardId = await makeBoard('Audited');
      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/items`), adminUboss)
        .send({ name: 'An item' })
        .expect(201);

      const trail = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { tenantId, action: { startsWith: 'board.' } },
          select: { action: true },
        }),
      );

      const actions = trail.map((row) => row.action);
      assert.ok(actions.includes('board.created'));
      assert.ok(actions.includes('board.item_created'));
    });
  });

  describe('spaces', () => {
    it('makes the default space on first use rather than at provisioning', async () => {
      const before = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.space.count({ where: { tenantId } }),
      );
      assert.equal(before, 0);

      await makeBoard('First ever');

      const spaces = await as(agent().get(`/tenants/${tenantId}/boards/spaces`), adminUboss).expect(
        200,
      );
      assert.equal(spaces.body.spaces.length, 1);
      assert.equal(spaces.body.spaces[0].isDefault, true);
    });

    it('keeps one default space however many boards are made', async () => {
      await makeBoard('One');
      await makeBoard('Two');
      await makeBoard('Three');

      // `one_default_space_per_company` is a database constraint, not a check in the service:
      // "exactly one" is a claim about the whole table, and a read-then-write has a gap.
      const defaults = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.space.count({ where: { tenantId, isDefault: true, archivedAt: null } }),
      );
      assert.equal(defaults, 1);
    });
  });

  describe('columns and groups', () => {
    it('adds a column, which is what decides what a board is for', async () => {
      const boardId = await makeBoard('Shapeable');

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/columns`), adminUboss)
        .send({ title: 'Priority', kind: 'Dropdown', settings: { options: [], multiple: false } })
        .expect(201);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      assert.deepEqual(
        (open.body.columns as { title: string }[]).map((column) => column.title),
        ['Status', 'Owner', 'Due date', 'Priority'],
      );
    });

    it('gives a status column labels when none were supplied', async () => {
      const boardId = await makeBoard('Statuses');

      const column = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/columns`),
        adminUboss,
      )
        .send({ title: 'Review', kind: 'Status' })
        .expect(201);

      // A status column with no labels is a column nobody can fill. The caller may still send
      // their own; this is what happens when they do not.
      assert.equal((column.body.settings as { labels: unknown[] }).labels.length, 4);
    });

    it('refuses a column kind this release cannot render', async () => {
      const boardId = await makeBoard('Unknown kind');

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/columns`), adminUboss)
        .send({ title: 'Mystery', kind: 'Formula' })
        .expect(400);
    });

    it('needs todo:Create, because a column changes everybody’s board', async () => {
      const boardId = await makeBoard('Main one', 'Main');

      // The employee can put rows on this board — it is Main — and still cannot decide that
      // every row now has a Priority.
      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/items`), employeeUboss)
        .send({ name: 'A row' })
        .expect(201);

      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/columns`), employeeUboss)
        .send({ title: 'Priority', kind: 'Text' })
        .expect(403);
    });

    it('adds a group, and a new item can be put in it', async () => {
      const boardId = await makeBoard('Grouped');

      const group = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/groups`),
        adminUboss,
      )
        .send({ title: 'Blocked', tone: 'danger' })
        .expect(201);

      const item = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'Waiting on a part', groupId: group.body.id })
        .expect(201);

      assert.equal(item.body.groupId, group.body.id);
    });
  });

  describe('a document on a row', () => {
    it('takes a Doc column and stores what was written on the cell', async () => {
      const boardId = await makeBoard('With docs');

      const column = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/columns`),
        adminUboss,
      )
        .send({ title: 'Handover note', kind: 'Doc' })
        .expect(201);

      const item = await as(
        agent().post(`/tenants/${tenantId}/boards/${boardId}/items`),
        adminUboss,
      )
        .send({ name: 'Night shift' })
        .expect(201);

      /*
       * On the cell, not in a table of its own. A document that lives somewhere else has to be
       * kept in step with the row it belongs to; this one moves, archives and comes back with it.
       */
      await as(agent().patch(`/tenants/${tenantId}/boards/items/${item.body.id}/cells`), adminUboss)
        .send({ columnId: column.body.id, value: { html: '<p>Line 3 needs a new seal.</p>' } })
        .expect(200);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      const cell = (open.body.cells as { columnId: string; value: { html: string } }[]).find(
        (entry) => entry.columnId === column.body.id,
      );
      assert.ok(cell);
      assert.match(cell!.value.html, /new seal/);
    });
  });

  describe('what a board hands the screen', () => {
    it('names its members, so a People cell can offer a person and not a UUID', async () => {
      const boardId = await makeBoard('Assigned', 'Private');
      await as(agent().post(`/tenants/${tenantId}/boards/${boardId}/members`), adminUboss)
        .send({ userId: employeeId, role: 'Member' })
        .expect(201);

      const open = await as(
        agent().get(`/tenants/${tenantId}/boards/${boardId}`),
        adminUboss,
      ).expect(200);

      const member = (open.body.members as { userId: string; name: string }[]).find(
        (entry) => entry.userId === employeeId,
      );
      assert.ok(member);
      assert.equal(member!.name, 'Board Employee');
    });
  });

  /**
   * Folders — the level between a space and a board.
   *
   * The one that carries real risk is the move. A folder put inside one of its own descendants
   * is a loop, and nothing that walks the tree afterwards ever stops. Nesting deeply is fine;
   * nesting into yourself is not.
   */
  describe('folders', () => {
    const makeFolder = async (name: string, parentFolderId?: string): Promise<string> => {
      const response = await as(agent().post(`/tenants/${tenantId}/boards/folders`), adminUboss)
        .send({ name, ...(parentFolderId === undefined ? {} : { parentFolderId }) })
        .expect(201);
      return response.body.id as string;
    };

    const allFolders = async (): Promise<
      { id: string; name: string; depth: number; parentFolderId: string | null }[]
    > => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/boards/folders`),
        adminUboss,
      ).expect(200);
      return response.body.folders;
    };

    it('nests a folder inside another, and keeps its depth', async () => {
      const top = await makeFolder('PRODUCTION');
      const inner = await makeFolder('IV Cannula', top);

      const rows = await allFolders();
      assert.equal(rows.find((row) => row.id === top)!.depth, 0);
      assert.equal(rows.find((row) => row.id === inner)!.depth, 1);
      assert.equal(rows.find((row) => row.id === inner)!.parentFolderId, top);
    });

    it('nests several levels deep, because the client asked for more than one', async () => {
      let parent: string | undefined;
      for (let level = 0; level < 6; level += 1) {
        parent = await makeFolder(`Level ${level}`, parent);
      }

      const deepest = (await allFolders()).reduce((worst, row) => Math.max(worst, row.depth), 0);
      assert.equal(deepest, 5);
    });

    it('refuses a folder deeper than the ceiling', async () => {
      let parent: string | undefined;
      for (let level = 0; level < 10; level += 1) {
        parent = await makeFolder(`Deep ${level}`, parent);
      }

      /*
       * Ten is not a product limit - four or five is as deep as anybody navigates. It is the
       * stop for the day an import or a bug builds a tree nine hundred levels deep, because the
       * sidebar's own render walks it and the screen hangs with no error to read.
       */
      const refused = await as(agent().post(`/tenants/${tenantId}/boards/folders`), adminUboss)
        .send({ name: 'One too far', parentFolderId: parent })
        .expect(409);
      assert.match(refused.body.message, /nested 10 deep/i);
    });

    it('refuses putting a folder inside itself', async () => {
      const folder = await makeFolder('Itself');

      const refused = await as(
        agent().patch(`/tenants/${tenantId}/boards/folders/${folder}`),
        adminUboss,
      )
        .send({ parentFolderId: folder })
        .expect(409);
      assert.match(refused.body.message, /inside itself/i);
    });

    it('refuses putting a folder inside its own descendant - the loop', async () => {
      const top = await makeFolder('SCM');
      const middle = await makeFolder('Purchase', top);
      const bottom = await makeFolder('Imports', middle);

      /*
       * SCM then Purchase then Imports. Moving SCM under Imports makes the chain close on
       * itself, and nothing complains at the moment of the move: the damage shows up later,
       * when a sidebar, a breadcrumb or a scope check walks the tree and never comes back.
       */
      const refused = await as(
        agent().patch(`/tenants/${tenantId}/boards/folders/${top}`),
        adminUboss,
      )
        .send({ parentFolderId: bottom })
        .expect(409);
      assert.match(refused.body.message, /loop/i);

      // And the tree is untouched. A refused move must not have half happened.
      const scm = (await allFolders()).find((row) => row.id === top);
      assert.equal(scm!.parentFolderId, null);
    });

    it('moves a folder to the top of its space, and back under another', async () => {
      const top = await makeFolder('QUALITY');
      const inner = await makeFolder('Incoming', top);

      await as(agent().patch(`/tenants/${tenantId}/boards/folders/${inner}`), adminUboss)
        .send({})
        .expect(200);
      assert.equal((await allFolders()).find((row) => row.id === inner)!.depth, 0);

      await as(agent().patch(`/tenants/${tenantId}/boards/folders/${inner}`), adminUboss)
        .send({ parentFolderId: top })
        .expect(200);
      assert.equal((await allFolders()).find((row) => row.id === inner)!.depth, 1);
    });

    it('needs todo:Create, like a board', async () => {
      await as(agent().post(`/tenants/${tenantId}/boards/folders`), employeeUboss)
        .send({ name: 'Not allowed' })
        .expect(403);
    });
  });

  /**
   * The one button that reads outside this feature.
   *
   * Seventeen departments is seventeen folder names typed by hand, so the button exists. It
   * creates rows in somebody's company, though, so it says what it would do before it does it,
   * and a second press adds nothing.
   */
  describe('folders from departments', () => {
    const seedDepartments = async (names: readonly string[]) => {
      await ctx.prisma.runAsPlatformOperation(async () => {
        for (const name of names) {
          await ctx.prisma.client.department.create({ data: { tenantId, name } });
        }
      });
    };

    const fromDepartments = (preview: boolean, uboss = adminUboss) =>
      as(agent().post(`/tenants/${tenantId}/boards/folders/from-departments`), uboss).send({
        preview,
      });

    const folderNames = async (): Promise<string[]> => {
      const response = await as(
        agent().get(`/tenants/${tenantId}/boards/folders`),
        adminUboss,
      ).expect(200);
      return (response.body.folders as { name: string }[]).map((row) => row.name).sort();
    };

    it('says what it would create, and creates nothing', async () => {
      await seedDepartments(['PRODUCTION', 'QUALITY CONTROL', 'SCM']);

      const preview = await fromDepartments(true).expect(201);
      assert.deepEqual([...preview.body.willCreate].sort(), [
        'PRODUCTION',
        'QUALITY CONTROL',
        'SCM',
      ]);
      assert.equal(preview.body.created, 0);
      assert.deepEqual(await folderNames(), []);
    });

    it('creates one folder per department when asked', async () => {
      await seedDepartments(['PRODUCTION', 'FINANCE']);

      const applied = await fromDepartments(false).expect(201);
      assert.equal(applied.body.created, 2);
      assert.deepEqual(await folderNames(), ['FINANCE', 'PRODUCTION']);
    });

    it('adds nothing on a second press', async () => {
      await seedDepartments(['PRODUCTION', 'FINANCE']);
      await fromDepartments(false).expect(201);

      // The second press is almost always somebody who did not see the first one work.
      const again = await fromDepartments(false).expect(201);
      assert.equal(again.body.created, 0);
      assert.equal(again.body.skipped, 2);
      assert.deepEqual(await folderNames(), ['FINANCE', 'PRODUCTION']);
    });

    it('leaves a department alone when a folder of that name is already there', async () => {
      await seedDepartments(['PRODUCTION', 'FINANCE']);
      await as(agent().post(`/tenants/${tenantId}/boards/folders`), adminUboss)
        .send({ name: 'production' })
        .expect(201);

      // Case is how people type, not how they mean it: "production" is the PRODUCTION folder.
      const applied = await fromDepartments(false).expect(201);
      assert.equal(applied.body.created, 1);
      assert.equal(applied.body.skipped, 1);
      assert.deepEqual(await folderNames(), ['FINANCE', 'production']);
    });

    it('needs todo:Create, like every other way of making a folder', async () => {
      await seedDepartments(['PRODUCTION']);
      await fromDepartments(true, employeeUboss).expect(403);
    });
  });

  /**
   * Where a board sits.
   *
   * A folder decides the space, and a board does not cross spaces by being dropped in the wrong
   * folder: a board that changed space without anybody asking is how a company loses one.
   */
  describe('a board in a folder', () => {
    it('is made inside the folder it was asked for', async () => {
      const folder = await as(agent().post(`/tenants/${tenantId}/boards/folders`), adminUboss)
        .send({ name: 'PRODUCTION' })
        .expect(201);

      const board = await as(agent().post(`/tenants/${tenantId}/boards`), adminUboss)
        .send({ name: 'IV Cannula line', folderId: folder.body.id })
        .expect(201);

      assert.equal(board.body.folderId, folder.body.id);
      assert.equal(board.body.spaceId, folder.body.spaceId);
    });

    it('moves into a folder and back out to the top of its space', async () => {
      const folder = await as(agent().post(`/tenants/${tenantId}/boards/folders`), adminUboss)
        .send({ name: 'QUALITY' })
        .expect(201);
      const board = await as(agent().post(`/tenants/${tenantId}/boards`), adminUboss)
        .send({ name: 'Loose board' })
        .expect(201);

      await as(agent().patch(`/tenants/${tenantId}/boards/${board.body.id}`), adminUboss)
        .send({ folderId: folder.body.id })
        .expect(200);

      const inFolder = await as(agent().get(`/tenants/${tenantId}/boards`), adminUboss).expect(200);
      assert.equal(
        (inFolder.body.boards as { id: string; folderId: string | null }[]).find(
          (row) => row.id === board.body.id,
        )!.folderId,
        folder.body.id,
      );

      await as(agent().patch(`/tenants/${tenantId}/boards/${board.body.id}`), adminUboss)
        .send({})
        .expect(200);

      const loose = await as(agent().get(`/tenants/${tenantId}/boards`), adminUboss).expect(200);
      assert.equal(
        (loose.body.boards as { id: string; folderId: string | null }[]).find(
          (row) => row.id === board.body.id,
        )!.folderId,
        null,
      );
    });

    it('is not moved by somebody who does not own it', async () => {
      const board = await as(agent().post(`/tenants/${tenantId}/boards`), adminUboss)
        .send({ name: 'Not yours' })
        .expect(201);

      await as(agent().patch(`/tenants/${tenantId}/boards/${board.body.id}`), managerUboss)
        .send({})
        .expect(403);
    });
  });
});
