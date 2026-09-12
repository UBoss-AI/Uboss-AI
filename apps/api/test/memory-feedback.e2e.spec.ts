import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AGENT_MEMORY_MODES, DEFAULT_MEMORY_POLICIES, type AgentMemoryMode } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { FeedbackController } from '../src/agents/feedback.controller.js';
import { FeedbackService } from '../src/agents/feedback.service.js';
import { MemoryController } from '../src/agents/memory.controller.js';
import { MemoryService } from '../src/agents/memory.service.js';
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
 * Engine Agent memory and AI output feedback — Prompt 33, against real PostgreSQL.
 *
 * The rules are proved without a database in `packages/types/src/memory.test.ts` and
 * `feedback.test.ts`. What can only be proved here is what the prompt asks for by name: **memory
 * scope leaks and feedback permissions**. So the weight of this suite is on the four scopes
 * actually confining what they claim to, on one company being unable to see another's memory at
 * all, and on the two grants that separate rating an output from changing what UBoss tests.
 */
describe('engine agent memory and output feedback (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let managerId: string;
  let managerUboss: string;
  let employeeId: string;
  let employeeUboss: string;
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
      controllers: [MemoryController, FeedbackController],
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
        MemoryService,
        FeedbackService,
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
      slug: 'memory-co',
      name: 'Memory Co',
      firstMember: { email: 'first@memory.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-memory-co',
      name: 'Other Memory Co',
      firstMember: { email: 'first@other-memory.example', displayName: 'Other First' },
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
        admin: await make('UB-MMAD-0001', 'admin@memory.example', 'Memory Admin'),
        manager: await make('UB-MMMG-0001', 'manager@memory.example', 'Memory Manager'),
        employee: await make('UB-MMEM-0001', 'employee@memory.example', 'Memory Employee'),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    managerId = people.manager.id;
    managerUboss = people.manager.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;

    const platform = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-MMPL-0001',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformId = platform.id;

    await ctx.prisma.runInTenantTransaction(scope(), async () => {
      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [managerId, 'Manager', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: platformId },
        });
      }
    });
  });

  // ---- helpers ----

  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);

  const asPerson = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /**
   * The validation messages from a thrown `BadRequestException`.
   *
   * `new BadRequestException(string[])` leaves `error.message` as the literal string "Bad Request
   * Exception" — the list lives on `response.message`, which is what a client receives. Asserting
   * on `error.message` would pass for any bad request at all.
   */
  const problemsFrom = (error: unknown): string[] => {
    const response = (error as { response?: { message?: unknown } }).response;
    const message = response?.message;
    if (Array.isArray(message)) return message.map((entry) => String(entry));
    return [String(message ?? (error as Error).message)];
  };

  const memory = () => app.get(MemoryService);
  const feedback = () => app.get(FeedbackService);

  /**
   * An agent and a completed run, seeded directly.
   *
   * Built the way the product builds one — a draft version published and attributed, the agent
   * activated with that version in force, the run reserved before it ran — because four check
   * constraints refuse the shortcuts.
   */
  const seedRun = async (
    options: {
      mode?: AgentMemoryMode;
      objectiveId?: string | null;
      tenant?: string;
      skillVersionIds?: string[];
      output?: Record<string, unknown> | null;
      producedByRealModel?: boolean;
    } = {},
  ) => {
    const tenant = options.tenant ?? tenantId;
    const suffix = Math.random().toString(36).slice(2, 8);

    return ctx.prisma.runAsPlatformOperation(async () => {
      const agentRow = await ctx.prisma.client.engineAgent.create({
        data: {
          tenantId: tenant,
          name: `Agent ${suffix}`,
          ownerUserId: adminId,
          status: 'DraftSetup',
          memoryMode: options.mode ?? 'AgentMemory',
        },
      });

      const versionRow = await ctx.prisma.client.engineAgentVersion.create({
        data: {
          tenantId: tenant,
          engineAgentId: agentRow.id,
          versionNumber: 1,
          status: 'Published',
          config: { skillVersionIds: options.skillVersionIds ?? [] },
          publishedAt: new Date(),
          publishedByUserId: adminId,
          createdByUserId: adminId,
        },
      });

      await ctx.prisma.client.engineAgent.update({
        where: { id: agentRow.id },
        data: {
          status: 'Active',
          currentVersionId: versionRow.id,
          activatedAt: new Date(),
          activatedByUserId: adminId,
        },
      });

      const run = await ctx.prisma.client.agentRun.create({
        data: {
          tenantId: tenant,
          engineAgentId: agentRow.id,
          engineAgentVersionId: versionRow.id,
          ...(options.objectiveId == null ? {} : { objectiveId: options.objectiveId }),
          state: 'Completed',
          trigger: 'Manual',
          attempt: 1,
          correlationId: `corr-${suffix}`,
          idempotencyKey: `idem-${suffix}`,
          reservedAt: new Date(),
          startedAt: new Date(),
          finishedAt: new Date(),
          producedByRealModel: options.producedByRealModel ?? false,
          // A run that produced nothing omits the column rather than writing a null into it:
          // `output` is a nullable Json, and `undefined` is not a value Prisma will accept.
          ...(options.output === null
            ? {}
            : { output: (options.output ?? { text: 'The answer.' }) as never }),
        },
      });

      return { agentId: agentRow.id, versionId: versionRow.id, runId: run.id };
    });
  };

  const rememberOn = async (
    runId: string,
    options: {
      label?: string;
      classification?: 'Public' | 'Internal' | 'Confidential' | 'Restricted';
      ownerUserId?: string | null;
      tenant?: string;
    } = {},
  ) =>
    memory().remember({
      scope: scope(options.tenant ?? tenantId),
      runId,
      label: options.label ?? 'A remembered fact',
      content: { fact: 'The supplier is Acme.' },
      classification: options.classification ?? 'Internal',
      ownerUserId: options.ownerUserId === undefined ? employeeId : options.ownerUserId,
    });

  // -------------------------------------------------------------------------
  // 1. The policy
  // -------------------------------------------------------------------------

  describe('the memory policy', () => {
    it('creates all four from the documented defaults on first read', async () => {
      const policies = await memory().policies(scope());

      assert.equal(policies.length, 4);
      assert.deepEqual(
        policies.map((policy) => policy.mode),
        [...AGENT_MEMORY_MODES],
      );

      for (const mode of AGENT_MEMORY_MODES) {
        const actual = policies.find((policy) => policy.mode === mode);
        assert.ok(actual);
        assert.deepEqual(actual, DEFAULT_MEMORY_POLICIES[mode], mode);
      }
    });

    it('is idempotent: reading twice creates one set', async () => {
      await memory().policies(scope());
      await memory().policies(scope());

      const count = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryPolicyRow.count({ where: { tenantId } }),
      );
      assert.equal(count, 4);
    });

    it('lets a Company Admin narrow a mode', async () => {
      const updated = await memory().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'We keep less than the default.',
        policy: { ...DEFAULT_MEMORY_POLICIES.AgentMemory, retentionDays: 30 },
      });
      assert.equal(updated.retentionDays, 30);
    });

    it('refuses a Manager', async () => {
      // Memory governance is a company-wide data decision. A manager who owns an agent must not
      // be able to widen what it remembers, or the ceiling is set by whoever wants it loosest.
      await assert.rejects(
        () =>
          memory().setPolicy({
            scope: scope(),
            actorUserId: managerId,
            reason: 'Let us keep more.',
            policy: { ...DEFAULT_MEMORY_POLICIES.AgentMemory, retentionDays: 3_000 },
          }),
        /permission|not permitted|Administer/i,
      );
    });

    it('refuses a Manager at the route as well as in the service', async () => {
      // The service test proves the rule; this proves the decorator. They are different layers
      // and a route whose guard was wrong would still pass a service-level test.
      await asPerson(
        agent().put(`/tenants/${tenantId}/memory/policies/AgentMemory`).send({
          retentionDays: 3000,
          visibility: 'SameAgent',
          maxClassification: 'Internal',
          allowCrossUser: false,
          allowCrossObjective: false,
          offboardingBehaviour: 'RetainAnonymised',
          requiresApproval: false,
          reason: 'Let us keep more.',
        }),
        managerUboss,
      ).expect(403);
    });

    it('lets a Company Admin read the policies over the route', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/memory/policies`),
        adminUboss,
      ).expect(200);
      assert.equal(response.body.policies.length, 4);
    });

    it('refuses widening a mode past what the architecture sets for it', async () => {
      await assert.rejects(
        () =>
          memory().setPolicy({
            scope: scope(),
            actorUserId: adminId,
            reason: 'Everybody should see it.',
            policy: {
              ...DEFAULT_MEMORY_POLICIES.ObjectiveMemory,
              visibility: 'CompanyWide',
            },
          }),
        (error: unknown) => {
          assert.ok(
            problemsFrom(error).some((problem) => /widest permitted visibility/.test(problem)),
            `unexpected problems: ${problemsFrom(error).join(' | ')}`,
          );
          return true;
        },
      );
    });

    it('refuses cross-user memory on a narrowly scoped mode, at the database too', async () => {
      // The architecture's "never unrestricted cross-user memory". Asserted against the database
      // rather than only the service, because a rule enforced in one layer is a rule a future bug
      // walks around.
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), async () => {
            await memory().policies(scope());
            return ctx.prisma.client.memoryPolicyRow.update({
              where: { tenantId_mode: { tenantId, mode: 'AgentMemory' } },
              data: { allowCrossUser: true },
            });
          }),
        /cross_user_memory_needs_company_wide_visibility/,
      );
    });

    it('audits a policy change with both sides of it', async () => {
      await memory().setPolicy({
        scope: scope(),
        actorUserId: adminId,
        reason: 'Tighter retention agreed with legal.',
        policy: { ...DEFAULT_MEMORY_POLICIES.AgentMemory, retentionDays: 30 },
      });

      const event = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'memory.policy_changed' },
        }),
      );

      assert.ok(event);
      const metadata = event.metadata as Record<string, unknown>;
      assert.equal(metadata['beforeRetentionDays'], 180);
      assert.equal(metadata['afterRetentionDays'], 30);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Remembering
  // -------------------------------------------------------------------------

  describe('remembering', () => {
    it('keeps a record under the run’s own agent mode', async () => {
      const { runId, agentId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);

      assert.equal(result.remembered, true);
      if (!result.remembered) return;
      assert.equal(result.record.mode, 'AgentMemory');
      assert.equal(result.record.visibility, 'SameAgent');
      assert.equal(result.record.engineAgentId, agentId);
      assert.ok(result.record.expiresAt !== null);
    });

    it('takes the mode from the agent, not from the caller', async () => {
      // An agent whose published version declares the ephemeral mode cannot be persuaded to
      // write agent-wide memory by a parameter, because there is no parameter.
      const { runId } = await seedRun({ mode: 'CurrentRunOnly' });
      const result = await rememberOn(runId);

      assert.equal(result.remembered, true);
      if (!result.remembered) return;
      assert.equal(result.record.mode, 'CurrentRunOnly');
      assert.equal(result.record.visibility, 'SameRun');
    });

    it('refuses data more sensitive than the mode permits', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId, { classification: 'Restricted' });

      assert.equal(result.remembered, false);
      if (result.remembered) return;
      assert.match(result.reason, /refuses to \*remember\* it/);
    });

    it('audits a refusal, because an agent trying to keep what it may not is a governance event', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(runId, { classification: 'Restricted' });

      const event = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'memory.write_refused' },
        }),
      );
      assert.ok(event, 'the refusal left no trace');
    });

    it('refuses Objective memory on a run with no Objective', async () => {
      const { runId } = await seedRun({ mode: 'ObjectiveMemory', objectiveId: null });
      const result = await rememberOn(runId);

      assert.equal(result.remembered, false);
      if (result.remembered) return;
      assert.match(result.reason, /no Objective/);
    });

    it('refuses approved long-term memory with no approval', async () => {
      const { runId } = await seedRun({ mode: 'ApprovedLongTermMemory' });
      const result = await rememberOn(runId);

      assert.equal(result.remembered, false);
      if (result.remembered) return;
      assert.match(result.reason, /needs an approval/);
    });

    it('refuses a run from another company', async () => {
      const foreign = await seedRun({ tenant: otherTenantId });
      await assert.rejects(() => rememberOn(foreign.runId), /does not exist in this company/);
    });

    it('offers no route that writes a memory record', async () => {
      // Remembering is an agent's act during a run. A person writing one directly would be
      // memory with no provenance, and every scope rule here is expressed in terms of the run
      // that wrote it.
      await asPerson(agent().post(`/tenants/${tenantId}/memory/records`), adminUboss).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Scope leaks — what the prompt asks for by name
  // -------------------------------------------------------------------------

  describe('memory scope leaks', () => {
    it('does not let one run read another run’s ephemeral memory', async () => {
      const first = await seedRun({ mode: 'CurrentRunOnly' });
      const second = await seedRun({ mode: 'CurrentRunOnly' });
      await rememberOn(first.runId, { label: 'Only for the first run' });

      const recalled = await memory().recall({ scope: scope(), runId: second.runId });
      assert.equal(recalled.length, 0);
    });

    it('lets the same run read its own ephemeral memory', async () => {
      const { runId } = await seedRun({ mode: 'CurrentRunOnly' });
      await rememberOn(runId, { label: 'Mine' });

      const recalled = await memory().recall({ scope: scope(), runId });
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0]?.label, 'Mine');
    });

    it('does not let one agent read another agent’s memory', async () => {
      const first = await seedRun({ mode: 'AgentMemory' });
      const second = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(first.runId, { label: 'First agent only' });

      const recalled = await memory().recall({ scope: scope(), runId: second.runId });
      assert.equal(recalled.length, 0);
    });

    it('lets the same agent read its own memory across its runs', async () => {
      const first = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(first.runId, { label: 'Remembered once' });

      // A second run of the *same* agent and version.
      const secondRunId = await ctx.prisma.runAsPlatformOperation(async () => {
        const run = await ctx.prisma.client.agentRun.create({
          data: {
            tenantId,
            engineAgentId: first.agentId,
            engineAgentVersionId: first.versionId,
            state: 'Completed',
            trigger: 'Manual',
            attempt: 1,
            correlationId: 'corr-second',
            idempotencyKey: 'idem-second',
            reservedAt: new Date(),
            startedAt: new Date(),
            finishedAt: new Date(),
            producedByRealModel: false,
            output: { text: 'Again.' } as never,
          },
        });
        return run.id;
      });

      const recalled = await memory().recall({ scope: scope(), runId: secondRunId });
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0]?.label, 'Remembered once');
    });

    it('does not let one person read another person’s memory', async () => {
      // The architecture's "never unrestricted cross-user memory", at the read.
      const first = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(first.runId, { ownerUserId: employeeId, label: 'The employee’s' });

      const asEmployee = await memory().recall({
        scope: scope(),
        runId: first.runId,
        onBehalfOfUserId: employeeId,
      });
      assert.equal(asEmployee.length, 1);

      const asManager = await memory().recall({
        scope: scope(),
        runId: first.runId,
        onBehalfOfUserId: managerId,
      });
      assert.equal(asManager.length, 0);
    });

    it('does not let one company read another company’s memory', async () => {
      const ours = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(ours.runId, { label: 'Ours' });

      const theirs = await seedRun({ mode: 'AgentMemory', tenant: otherTenantId });
      await rememberOn(theirs.runId, { label: 'Theirs', tenant: otherTenantId, ownerUserId: null });

      const ourList = await memory().list({ scope: scope(), actorUserId: adminId });
      assert.equal(ourList.length, 1);
      assert.equal(ourList[0]?.label, 'Ours');
    });

    it('cannot even write a record against another company’s run', async () => {
      // The composite foreign key including `tenant_id`, which is what makes cross-tenant memory
      // structurally impossible rather than merely forbidden.
      const foreign = await seedRun({ tenant: otherTenantId });

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.memoryRecord.create({
              data: {
                tenantId,
                mode: 'AgentMemory',
                visibility: 'SameAgent',
                runId: foreign.runId,
                engineAgentId: foreign.agentId,
                label: 'Stolen',
                classification: 'Internal',
                expiresAt: new Date(Date.now() + 86_400_000),
              },
            }),
          ),
        /foreign key|memory_records_tenant_id_run_id_fkey/,
      );
    });

    it('does not return an expired record', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.update({
          where: { id: result.record.id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      );

      const recalled = await memory().recall({ scope: scope(), runId });
      assert.equal(recalled.length, 0);
    });

    it('does not return a deleted record', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      await memory().forget({
        scope: scope(),
        actorUserId: adminId,
        recordId: result.record.id,
        reason: 'Asked for by the customer.',
      });

      const recalled = await memory().recall({ scope: scope(), runId });
      assert.equal(recalled.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Forgetting
  // -------------------------------------------------------------------------

  describe('forgetting', () => {
    it('clears the content and keeps the record of the deletion', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      const forgotten = await memory().forget({
        scope: scope(),
        actorUserId: adminId,
        recordId: result.record.id,
        reason: 'Customer asked for it to go.',
      });

      assert.equal(forgotten.hasContent, false);
      assert.notEqual(forgotten.deletedAt, null);
      assert.equal(forgotten.deletedReason, 'Customer asked for it to go.');

      // The row survives, because "was our data deleted?" has to be answerable.
      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.findUniqueOrThrow({ where: { id: result.record.id } }),
      );
      assert.equal(row.content, null);
      assert.equal(row.label, 'A remembered fact');
    });

    it('refuses a Manager', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      await assert.rejects(
        () =>
          memory().forget({
            scope: scope(),
            actorUserId: managerId,
            recordId: result.record.id,
            reason: 'Tidying up.',
          }),
        /permission|not permitted|Administer/i,
      );
    });

    it('refuses a second deletion', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      await memory().forget({
        scope: scope(),
        actorUserId: adminId,
        recordId: result.record.id,
        reason: 'First time.',
      });

      await assert.rejects(
        () =>
          memory().forget({
            scope: scope(),
            actorUserId: adminId,
            recordId: result.record.id,
            reason: 'Again.',
          }),
        /already been deleted/,
      );
    });

    it('sweeps what has expired, and clears its content too', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      const result = await rememberOn(runId);
      assert.equal(result.remembered, true);
      if (!result.remembered) return;

      await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.update({
          where: { id: result.record.id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        }),
      );

      const swept = await memory().sweepExpired({ scope: scope() });
      assert.equal(swept.expired, 1);

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.findUniqueOrThrow({ where: { id: result.record.id } }),
      );
      // A record past its retention window that still held its content would not have expired in
      // any sense a customer would accept.
      assert.equal(row.content, null);
      assert.notEqual(row.deletedAt, null);
    });

    it('sweeps nothing that has not expired', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(runId);

      const swept = await memory().sweepExpired({ scope: scope() });
      assert.equal(swept.expired, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Offboarding
  // -------------------------------------------------------------------------

  describe('offboarding', () => {
    it('deletes a leaver’s ephemeral memory', async () => {
      const { runId } = await seedRun({ mode: 'CurrentRunOnly' });
      await rememberOn(runId, { ownerUserId: employeeId });

      const outcome = await memory().applyOffboarding({
        scope: scope(),
        subjectUserId: employeeId,
        successorUserId: managerId,
        actorUserId: adminId,
      });

      assert.equal(outcome.deleted, 1);
    });

    it('transfers Objective memory to the successor', async () => {
      // Work knowledge that belongs to the role rather than the person.
      const objectiveId = await seedObjective();
      const { runId } = await seedRun({ mode: 'ObjectiveMemory', objectiveId });
      await rememberOn(runId, { ownerUserId: employeeId });

      const outcome = await memory().applyOffboarding({
        scope: scope(),
        subjectUserId: employeeId,
        successorUserId: managerId,
        actorUserId: adminId,
      });

      assert.equal(outcome.transferred, 1);

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.findFirstOrThrow({ where: { tenantId } }),
      );
      assert.equal(row.ownerUserId, managerId);
    });

    it('deletes rather than leaving a record owned by somebody who has left', async () => {
      // `TransferToSuccessor` with no successor. Access nobody reviews is worse than a deletion.
      const objectiveId = await seedObjective();
      const { runId } = await seedRun({ mode: 'ObjectiveMemory', objectiveId });
      await rememberOn(runId, { ownerUserId: employeeId });

      const outcome = await memory().applyOffboarding({
        scope: scope(),
        subjectUserId: employeeId,
        successorUserId: null,
        actorUserId: adminId,
      });

      assert.equal(outcome.deleted, 1);
      assert.equal(outcome.transferred, 0);
    });

    it('anonymises agent memory rather than deleting it', async () => {
      const { runId } = await seedRun({ mode: 'AgentMemory' });
      await rememberOn(runId, { ownerUserId: employeeId });

      const outcome = await memory().applyOffboarding({
        scope: scope(),
        subjectUserId: employeeId,
        successorUserId: managerId,
        actorUserId: adminId,
      });

      assert.equal(outcome.anonymised, 1);

      const row = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.memoryRecord.findFirstOrThrow({ where: { tenantId } }),
      );
      assert.equal(row.ownerUserId, null);
      // The knowledge survives; whose it was does not.
      assert.notEqual(row.content, null);
    });

    it('leaves other people’s memory alone', async () => {
      const { runId } = await seedRun({ mode: 'CurrentRunOnly' });
      await rememberOn(runId, { ownerUserId: managerId });

      const outcome = await memory().applyOffboarding({
        scope: scope(),
        subjectUserId: employeeId,
        successorUserId: null,
        actorUserId: adminId,
      });

      assert.equal(outcome.deleted, 0);
      assert.equal(outcome.transferred, 0);
      assert.equal(outcome.anonymised, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Feedback permissions — the prompt's other named requirement
  // -------------------------------------------------------------------------

  describe('feedback permissions', () => {
    it('lets an Employee rate an output', async () => {
      // The person who did the work is usually the one who can tell whether the AI got it right.
      const { runId } = await seedRun();
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });
      assert.equal(given.rating, 'Correct');
    });

    it('refuses somebody with no role in the company', async () => {
      // Deliberately **not** "refuses a guest": under the client's model an External Guest holds
      // read, comment and draft, and a rating is a comment — so a guest who has been given a role
      // may legitimately judge an output they can see. What is refused is somebody with no role
      // at all, which is the state a guest is created in.
      const guestId = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-MMGU-0001',
          email: 'guest@partner.example',
          displayName: 'Partner Guest',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: {
            tenantId,
            userId: user.id,
            accountState: 'Active',
            userType: 'ExternalGuest',
            guestAccessExpiresAt: new Date(Date.now() + 86_400_000),
          },
        });
        return user.id;
      });

      const { runId } = await seedRun();
      await assert.rejects(
        () =>
          feedback().submit({
            scope: scope(),
            actorUserId: guestId,
            runId,
            rating: 'Correct',
          }),
        /no role in this company/,
      );
    });

    it('refuses an Employee the promote route', async () => {
      // A regression case is a permanent assertion about how a Skill must behave. An employee's
      // rating is welcome; an employee silently creating a release gate is not.
      const { runId } = await seedRun({
        skillVersionIds: ['00000000-0000-7000-8000-000000000001'],
      });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It quoted the draft contract instead of the signed one.',
      });

      // An Employee holds `agents:Comment` and not `settings:Administer`, which is the whole
      // point of using two grants.
      await asPerson(
        agent().post(`/tenants/${tenantId}/feedback/${given.id}/promote`).send({
          skillVersionId: '00000000-0000-7000-8000-000000000001',
          name: 'Cites the signed contract',
        }),
        employeeUboss,
      ).expect(403);
    });

    it('refuses a second rating from the same reviewer', async () => {
      const { runId } = await seedRun();
      await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });

      await assert.rejects(
        () =>
          feedback().submit({
            scope: scope(),
            actorUserId: employeeId,
            runId,
            rating: 'Incorrect',
            correction: 'Changed my mind about this output entirely.',
          }),
        /Amend your existing feedback/,
      );
    });

    it('refuses a second rating at the database too', async () => {
      const { runId } = await seedRun();
      await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.aiOutputFeedback.create({
              data: {
                tenantId,
                runId,
                rating: 'Incorrect',
                correction: 'A'.repeat(30),
                reviewerUserId: employeeId,
              },
            }),
          ),
        /duplicate key|ai_output_feedback_tenant_id_run_id_reviewer_user_id_key/,
      );
    });

    it('lets two different reviewers rate the same output', async () => {
      const { runId } = await seedRun();
      await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });
      await feedback().submit({ scope: scope(), actorUserId: managerId, runId, rating: 'Correct' });

      const all = await feedback().listForRun({ scope: scope(), actorUserId: adminId, runId });
      assert.equal(all.length, 2);
    });

    it('lets a reviewer amend only their own rating', async () => {
      const { runId } = await seedRun();
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });

      await assert.rejects(
        () =>
          feedback().amend({
            scope: scope(),
            actorUserId: managerId,
            feedbackId: given.id,
            rating: 'Incorrect',
            correction: 'The manager disagrees with the employee’s judgement here.',
          }),
        /only amend your own/,
      );

      const amended = await feedback().amend({
        scope: scope(),
        actorUserId: employeeId,
        feedbackId: given.id,
        rating: 'Incomplete',
        correction: 'It left out the delivery schedule entirely.',
      });
      assert.equal(amended.rating, 'Incomplete');
    });

    it('refuses feedback on another company’s output', async () => {
      const foreign = await seedRun({ tenant: otherTenantId });
      await assert.rejects(
        () =>
          feedback().submit({
            scope: scope(),
            actorUserId: employeeId,
            runId: foreign.runId,
            rating: 'Correct',
          }),
        /does not exist in this company/,
      );
    });

    it('refuses feedback on a run that produced nothing', async () => {
      const { runId } = await seedRun({ output: null });
      await assert.rejects(
        () =>
          feedback().submit({
            scope: scope(),
            actorUserId: employeeId,
            runId,
            rating: 'Correct',
          }),
        /nothing to judge/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. What feedback does
  // -------------------------------------------------------------------------

  describe('feedback and quality', () => {
    it('insists on a correction for a negative rating, and says why', async () => {
      const { runId } = await seedRun();
      await assert.rejects(
        () =>
          feedback().submit({
            scope: scope(),
            actorUserId: employeeId,
            runId,
            rating: 'Incorrect',
          }),
        (error: unknown) => {
          assert.ok(
            problemsFrom(error).some((problem) => /needs to say what is wrong/.test(problem)),
            `unexpected problems: ${problemsFrom(error).join(' | ')}`,
          );
          return true;
        },
      );
    });

    it('refuses a one-word correction at the database too', async () => {
      const { runId } = await seedRun();
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.aiOutputFeedback.create({
              data: {
                tenantId,
                runId,
                rating: 'Incorrect',
                correction: 'wrong',
                reviewerUserId: employeeId,
              },
            }),
          ),
        /negative_feedback_says_what_is_wrong/,
      );
    });

    it('records whether a real model produced the output', async () => {
      const { runId } = await seedRun({ producedByRealModel: false });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });
      // Copied onto the row, so a quality figure computed from this table alone can never
      // present mock output as a provider's.
      assert.equal(given.producedByRealModel, false);
    });

    it('reports quality with how much of it was real', async () => {
      const first = await seedRun({ producedByRealModel: false });
      const second = await seedRun({ producedByRealModel: false });
      await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId: first.runId,
        rating: 'Correct',
      });
      await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId: second.runId,
        rating: 'Incorrect',
        correction: 'It invented a supplier that does not exist.',
      });

      const quality = await feedback().quality({ scope: scope(), actorUserId: adminId });
      assert.equal(quality.total, 2);
      assert.equal(quality.correct, 1);
      assert.equal(quality.correctPercent, 50);
      // Nothing real has run, so the figure says so.
      assert.equal(quality.onRealModelOutput, 0);
    });

    it('marks a corrected negative rating eligible for the evaluation dataset', async () => {
      const { runId } = await seedRun({
        skillVersionIds: ['00000000-0000-7000-8000-000000000001'],
      });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It quoted the draft contract instead of the signed one.',
      });
      assert.equal(given.evaluationEligible, true);
    });

    it('marks a correct rating ineligible, and says why', async () => {
      const { runId } = await seedRun({
        skillVersionIds: ['00000000-0000-7000-8000-000000000001'],
      });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });
      assert.equal(given.evaluationEligible, false);
      assert.match(given.evaluationReason ?? '', /passes by construction/);
    });

    it('marks a rating on a run with no Skill ineligible', async () => {
      const { runId } = await seedRun({ skillVersionIds: [] });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It invented a supplier that does not exist anywhere.',
      });
      assert.equal(given.evaluationEligible, false);
      assert.match(given.evaluationReason ?? '', /nothing for a case to test/);
    });

    it('refuses to promote an ineligible rating, at the database too', async () => {
      const { runId } = await seedRun();
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Correct',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.aiOutputFeedback.update({
              where: { id: given.id },
              data: {
                promotedAt: new Date(),
                promotedByUserId: adminId,
                promotedCaseId: '00000000-0000-7000-8000-0000000000cc',
              },
            }),
          ),
        /only_eligible_feedback_is_promoted/,
      );
    });

    it('states that feedback never becomes provider training data', async () => {
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/feedback/meta`),
        employeeUboss,
      ).expect(200);

      assert.match(response.body.stance, /never sent to a model provider as training data/);
      assert.match(response.body.stance, /because none exists/);
    });

    it('exposes no route or field that could enable provider training', async () => {
      // Prompt 33: "do NOT assume or automatically enable external provider model training on
      // company data". Asserted as an absence, so a later prompt adding a consent toggle fails
      // here rather than shipping.
      const response = await asPerson(
        agent().get(`/tenants/${tenantId}/feedback/meta`),
        employeeUboss,
      ).expect(200);

      const serialised = JSON.stringify(response.body).toLowerCase();
      assert.ok(!serialised.includes('trainingenabled'));
      assert.ok(!serialised.includes('trainingconsent'));
      assert.ok(!serialised.includes('allowtraining'));
    });
  });

  // -------------------------------------------------------------------------
  // 8. Promotion into the Prompt 18 evaluation dataset
  // -------------------------------------------------------------------------

  describe('promotion into the evaluation dataset', () => {
    const seedSkill = async () =>
      ctx.prisma.runAsPlatformOperation(async () => {
        const suffix = Math.random().toString(36).slice(2, 8);
        const skill = await ctx.prisma.client.skill.create({
          data: {
            tenantId,
            layer: 'CompanyCustom',
            key: `contract-summariser-${suffix}`,
            name: 'Contract summariser',
            ownerUserId: adminId,
            createdByUserId: adminId,
          },
        });
        const version = await ctx.prisma.client.skillVersion.create({
          data: {
            tenantId,
            skillId: skill.id,
            versionNumber: 1,
            status: 'Published',
            purpose: 'Summarise a supplier contract.',
            category: 'Research',
            whenToUse: 'When a signed contract needs a summary.',
            whenNotToUse: 'When the contract is still a draft.',
            inputs: [],
            rules: [],
            steps: [{ order: 1, instruction: 'Read the signed contract.' }],
            // Nothing high-risk, so the autonomy constraint from Prompt 17 is satisfied.
            allowedToolCategories: ['Read'],
            outputSchema: '{}',
            validation: 'A person checks the summary against the contract.',
            failureHandling: 'Raise an exception for a human.',
            autonomy: 'FullyAutonomous',
            evidenceRequirement: 'The contract reference.',
            createdByUserId: adminId,
          },
        });
        return { skillId: skill.id, versionId: version.id };
      });

    it('creates a HumanJudged evaluation case from a correction', async () => {
      const skill = await seedSkill();
      const { runId } = await seedRun({ skillVersionIds: [skill.versionId] });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It quoted the draft contract instead of the signed one.',
      });

      const promoted = await feedback().promote({
        scope: scope(),
        actorUserId: adminId,
        feedbackId: given.id,
        skillVersionId: skill.versionId,
        name: 'Cites the signed contract',
      });

      const evaluationCase = await ctx.prisma.runInTenantTransaction(scope(), () =>
        ctx.prisma.client.skillEvaluationCase.findUniqueOrThrow({
          where: { id: promoted.caseId },
        }),
      );

      assert.equal(evaluationCase.skillId, skill.skillId);
      // A reviewer's prose cannot be asserted mechanically. `ExactMatch` would fail on a better
      // answer and `ContainsAll` treats a sentence as a list of required fragments.
      assert.equal(evaluationCase.assertion, 'HumanJudged');
      assert.match(evaluationCase.expected, /signed one/);
    });

    it('refuses a second promotion of the same feedback', async () => {
      const skill = await seedSkill();
      const { runId } = await seedRun({ skillVersionIds: [skill.versionId] });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It quoted the draft contract instead of the signed one.',
      });

      await feedback().promote({
        scope: scope(),
        actorUserId: adminId,
        feedbackId: given.id,
        skillVersionId: skill.versionId,
        name: 'Cites the signed contract',
      });

      await assert.rejects(
        () =>
          feedback().promote({
            scope: scope(),
            actorUserId: adminId,
            feedbackId: given.id,
            skillVersionId: skill.versionId,
            name: 'Again',
          }),
        /already an evaluation case/,
      );
    });

    it('refuses amending feedback that has become a case', async () => {
      // Its correction is now an assertion other work depends on.
      const skill = await seedSkill();
      const { runId } = await seedRun({ skillVersionIds: [skill.versionId] });
      const given = await feedback().submit({
        scope: scope(),
        actorUserId: employeeId,
        runId,
        rating: 'Incorrect',
        correction: 'It quoted the draft contract instead of the signed one.',
      });
      await feedback().promote({
        scope: scope(),
        actorUserId: adminId,
        feedbackId: given.id,
        skillVersionId: skill.versionId,
        name: 'Cites the signed contract',
      });

      await assert.rejects(
        () =>
          feedback().amend({
            scope: scope(),
            actorUserId: employeeId,
            feedbackId: given.id,
            rating: 'Correct',
          }),
        /Retire the case first/,
      );
    });
  });

  /**
   * An Objective id, as a scope key rather than as a row.
   *
   * Neither `agent_runs.objective_id` nor `memory_records.objective_id` carries a foreign key, and
   * what these tests are about is whether two records with the same or different Objective scope
   * are visible to each other. Building a real Objective would mean a department, an owner and a
   * code — none of which the memory rule reads — and would test the Objective tables instead of
   * the thing under test.
   */
  function seedObjective(): Promise<string> {
    return Promise.resolve('33000000-0000-7000-8000-0000000000e1');
  }
});
