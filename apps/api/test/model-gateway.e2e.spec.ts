import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { LOGICAL_MODEL_PROFILES, PROVIDER_KINDS, type LogicalModelProfile } from '@uboss/types';

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
import { LocalSealedSecretsVault, SecretsVault } from '../src/connections/secrets-vault.js';
import { ModelGateway } from '../src/model-gateway/model-gateway.js';
import {
  AnthropicProviderAdapter,
  CustomProviderAdapter,
  MockProviderAdapter,
  OpenAiProviderAdapter,
  PROVIDER_ADAPTERS,
  ProviderAdapter,
  ProviderNotConfiguredError,
} from '../src/model-gateway/provider-adapter.js';
import { ProviderController } from '../src/model-gateway/provider.controller.js';
import { ProviderService } from '../src/model-gateway/provider.service.js';
import { RoutingModelGateway } from '../src/model-gateway/routing-model-gateway.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { OrganizationRepository } from '../src/persistence/organization.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { ReportingHierarchyResolver } from '../src/organization/reporting-hierarchy.resolver.js';
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
 * Prompt 29 — AI Provider Profiles and the Model Gateway.
 *
 * What this suite defends, above everything else:
 *
 *   **Provider names are configuration, not business object identity** (Technical Architecture
 *   §18). A business object names one of five logical model profiles; which provider answers is
 *   resolved inside the gateway and never travels back out. Several tests exist only to prove that
 *   a provider name cannot reach a caller — they would still pass if the routing were wrong, and
 *   that is deliberate: they are about the shape of the seam rather than about its behaviour.
 *
 * Also defended:
 *
 *   * **Nothing is claimed about a real provider.** The Anthropic and OpenAI adapters are
 *     implemented and refuse without a credential; every call recorded today says
 *     `producedByRealModel = false`, and the database refuses a provider request id on such a row.
 *   * **`MigrationRequired` actually stops new work**, which is the entire purpose of that state.
 *   * **A published price is immutable**, so a price change cannot restate what a Run cost.
 *   * **Usage is measured, never estimated.** A call whose adapter reports nothing is recorded
 *     with zeros and no cost rather than with a guess.
 */
describe('provider profiles and the model gateway (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let platformOwnerId: string;
  let platformUboss: string;
  let companyUserUboss: string;

  const agent = () => request(app.getHttpServer());
  const providers = () => app.get(ProviderService);
  const gateway = () => app.get<ModelGateway>(ModelGateway);

  /** The platform mock profile the migration seeds, and its two models. */
  const MOCK_PROFILE = '00000000-0000-4000-8000-00000000e001';
  const REASONING_MODEL = '00000000-0000-4000-8000-00000000e101';
  const FAST_MODEL = '00000000-0000-4000-8000-00000000e102';

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
      controllers: [ProviderController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        { provide: SecretsVault, useClass: LocalSealedSecretsVault },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        OrganizationRepository,
        OutboxRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        MockProviderAdapter,
        AnthropicProviderAdapter,
        OpenAiProviderAdapter,
        CustomProviderAdapter,
        {
          provide: PROVIDER_ADAPTERS,
          inject: [
            MockProviderAdapter,
            AnthropicProviderAdapter,
            OpenAiProviderAdapter,
            CustomProviderAdapter,
          ],
          useFactory: (...adapters: ProviderAdapter[]): readonly ProviderAdapter[] => adapters,
        },
        // The real routing gateway, not the mock one. This suite exists to test the routing.
        {
          provide: ModelGateway,
          inject: [PrismaService, SecretsVault, PROVIDER_ADAPTERS],
          useFactory: (
            prisma: PrismaService,
            vault: SecretsVault,
            adapters: readonly ProviderAdapter[],
          ) => new RoutingModelGateway(prisma, vault, adapters),
        },
        ProviderService,
        TenantContextService,
        Reflector,
        ReportingHierarchyResolver,
        { provide: HIERARCHY_RESOLVER, useExisting: ReportingHierarchyResolver },
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
      slug: 'mg-co',
      name: 'Gateway Co',
      firstMember: { email: 'first@mg.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;
    companyUserUboss = provisioned.user.ubossUniqueId;

    const other = await ctx.provisioning.provision({
      slug: 'mg-other',
      name: 'Other Co',
      firstMember: { email: 'first@mgother.example', displayName: 'Other' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const platform = await ctx.users.createForPlatform({
      ubossUniqueId: 'UB-MGPL-0001',
      email: 'owner@mg-platform.example',
      displayName: 'Platform Owner',
      isPlatformActor: true,
    });
    platformOwnerId = platform.id;
    platformUboss = platform.ubossUniqueId;

    // No `grantedByUserId`: `platform_role_not_self_granted` refuses a self-grant, which is the
    // right constraint and the reason the fixture states a justification instead.
    await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: platformOwnerId, role: 'PlatformOwner', justification: 'Fixture.' },
      }),
    );
  });

  const asPlatform = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', platformUboss) as T;

  const callGateway = (profile: LogicalModelProfile, purpose = 'probe') =>
    gateway().complete({
      profile,
      purpose,
      instruction: 'Do the thing.',
      context: 'Some material.',
      maxTokens: 200,
      tenantId,
    });

  const callsFor = async () =>
    ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.modelGatewayCall.findMany({
        where: { tenantId },
        orderBy: { occurredAt: 'asc' },
      }),
    );

  // -------------------------------------------------------------------------
  // 1. The locked rule
  // -------------------------------------------------------------------------

  describe('provider names stay behind the gateway', () => {
    it('answers a call without telling the caller which provider answered', async () => {
      const response = await callGateway('AGENT_STANDARD');

      // The capability is an opaque label the company may read.
      assert.equal(response.capability, 'high-reasoning-v1');

      // And nothing in the response is a provider name.
      const serialised = JSON.stringify(response);
      for (const kind of PROVIDER_KINDS) {
        if (kind === 'Mock' || kind === 'Custom') continue;
        assert.ok(!serialised.includes(kind), `the response named ${kind}`);
      }
    });

    it('records the call against the logical profile, not a provider name', async () => {
      await callGateway('EXECUTOR', 'executor.validation');

      const calls = await callsFor();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.profile, 'EXECUTOR');
      assert.equal(calls[0]?.purpose, 'executor.validation');
      // The provider is a foreign key into platform configuration, not a string on the row.
      assert.equal(calls[0]?.providerModelId, REASONING_MODEL);
    });

    it('exposes no company-facing provider endpoint at all', async () => {
      // Section 19: "employees do not manage provider keys". Not even a read-only route, because
      // enumerating profiles would tell a company which vendor answers its work.
      await agent()
        .get('/platform/providers/profiles')
        .set(WORKSPACE_HEADER, tenantId)
        .set('x-uboss-dev-actor', companyUserUboss)
        .expect(403);
    });

    it('refuses an unauthenticated platform request', async () => {
      await agent().get('/platform/providers/profiles').expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Honesty about what is real
  // -------------------------------------------------------------------------

  describe('nothing claims a real provider', () => {
    it('reports that no adapter can reach a provider', async () => {
      assert.equal(gateway().usesRealModel, false);
    });

    it('stamps every recorded call as not produced by a real model', async () => {
      for (const profile of ['AGENT_STANDARD', 'AGENT_FAST', 'EXECUTOR'] as const) {
        await callGateway(profile);
      }

      const calls = await callsFor();
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.equal(call.producedByRealModel, false);
        // And therefore no provider request id — the database refuses that combination.
        assert.equal(call.providerRequestId, null);
      }
    });

    it('refuses an Anthropic call with no credential, rather than answering plausibly', async () => {
      const adapter = app.get(AnthropicProviderAdapter);
      assert.equal(adapter.canReachProvider, false);

      await assert.rejects(
        () =>
          adapter.complete({
            providerModelRef: 'claude-something',
            instruction: 'x',
            context: 'y',
            maxTokens: 10,
            timeoutMs: 1000,
            custom: null,
            credential: null,
          }),
        (error: unknown) =>
          error instanceof ProviderNotConfiguredError &&
          /never been run against the provider/.test(error.message),
      );
    });

    it('refuses an OpenAI call with no credential too', async () => {
      const adapter = app.get(OpenAiProviderAdapter);
      assert.equal(adapter.canReachProvider, false);
      await assert.rejects(
        () =>
          adapter.complete({
            providerModelRef: 'gpt-something',
            instruction: 'x',
            context: 'y',
            maxTokens: 10,
            timeoutMs: 1000,
            custom: null,
            credential: null,
          }),
        ProviderNotConfiguredError,
      );
    });

    it('says in meta which adapters are registered and which can reach a provider', async () => {
      const meta = await asPlatform(agent().get('/platform/providers/meta')).expect(200);

      const byKind = new Map<string, { adapterRegistered: boolean; canReachProvider: boolean }>(
        meta.body.kinds.map(
          (entry: { kind: string; adapterRegistered: boolean; canReachProvider: boolean }) => [
            entry.kind,
            entry,
          ],
        ),
      );

      // All four registered — including the two that cannot run, which is what makes "no
      // provider is configured" a reported fact rather than an inference from an absence.
      assert.equal(byKind.get('Anthropic')?.adapterRegistered, true);
      assert.equal(byKind.get('Anthropic')?.canReachProvider, false);
      assert.equal(byKind.get('OpenAI')?.adapterRegistered, true);
      assert.equal(byKind.get('OpenAI')?.canReachProvider, false);
      assert.equal(byKind.get('Mock')?.adapterRegistered, true);
    });

    it('reports a Test Connection that reached nothing as exactly that', async () => {
      const result = await providers().testConnection({
        actorUserId: platformOwnerId,
        providerProfileId: MOCK_PROFILE,
      });

      // `ok` and `reachedProvider` are different claims, and this is the pair that matters.
      assert.equal(result.ok, true);
      assert.equal(result.reachedProvider, false);
      assert.match(result.detail, /nothing has been verified against a real provider/);
    });

    it('stores the test result with all three fields or none', async () => {
      await providers().testConnection({
        actorUserId: platformOwnerId,
        providerProfileId: MOCK_PROFILE,
      });

      const profile = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.providerProfile.findUniqueOrThrow({ where: { id: MOCK_PROFILE } }),
      );
      assert.notEqual(profile.lastTestedAt, null);
      assert.equal(profile.lastTestOk, true);
      assert.equal(profile.lastTestReachedProvider, false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Routing
  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('routes each of the five profiles the migration configured', async () => {
      const routing = await asPlatform(agent().get('/platform/providers/routing')).expect(200);
      assert.equal(routing.body.length, LOGICAL_MODEL_PROFILES.length);

      for (const view of routing.body) {
        assert.equal(view.unroutableReason, null, `${view.profile} is unroutable`);
        assert.ok(view.routes.some((route: { wouldAnswer: boolean }) => route.wouldAnswer));
        // The transcribed sentence travels to the screen, so a platform operator reads the
        // requirement rather than somebody's paraphrase of it.
        assert.ok(view.gatewayBehaviour.endsWith('.'));
      }
    });

    it('sends AGENT_FAST to the fast model and the planner to the reasoning one', async () => {
      await callGateway('AGENT_FAST');
      await callGateway('OBJECTIVE_PLANNER');

      const calls = await callsFor();
      assert.equal(calls[0]?.providerModelId, FAST_MODEL);
      assert.equal(calls[0]?.capability, 'fast-v1');
      assert.equal(calls[1]?.providerModelId, REASONING_MODEL);
    });

    it('never routes new work to a model requiring migration', async () => {
      // The whole purpose of that state: it stops selection while there is still time to move,
      // rather than on the day the provider removes the model.
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        lifecycle: 'MigrationRequired',
        note: 'The provider announced removal in 30 days.',
      });

      await assert.rejects(() => callGateway('AGENT_FAST'), ProviderNotConfiguredError);

      const calls = await callsFor();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.outcome, 'Unroutable');
      // A database CHECK requires an unroutable call to name no model, so a routing failure can
      // never be counted against a provider.
      assert.equal(calls[0]?.providerModelId, null);
    });

    it('falls back for AGENT_STANDARD, and records that it did', async () => {
      // AGENT_STANDARD is `AnyApproved`, and the migration gives it both models.
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: REASONING_MODEL,
        lifecycle: 'Deprecated',
        note: 'Superseded.',
      });

      const response = await callGateway('AGENT_STANDARD');
      assert.equal(response.capability, 'fast-v1');
      assert.equal(response.usedFallback, true);

      const calls = await callsFor();
      assert.equal(calls[0]?.usedFallback, true);
      assert.equal(calls[0]?.providerModelId, FAST_MODEL);
    });

    it('refuses to substitute a model for HIGH_REASONING', async () => {
      // Section 18: "explicit budget/approval guardrail". A silent substitution would mean the
      // guardrail measured a call that never happened.
      await providers().setRoute({
        actorUserId: platformOwnerId,
        tenantId: null,
        profile: 'HIGH_REASONING',
        providerModelId: FAST_MODEL,
        preference: 1,
      });
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: REASONING_MODEL,
        lifecycle: 'Deprecated',
        note: 'Superseded.',
      });

      await assert.rejects(() => callGateway('HIGH_REASONING'), ProviderNotConfiguredError);

      const calls = await callsFor();
      assert.equal(calls[0]?.outcome, 'Unroutable');
    });

    it('will not route the planner to a different capability', async () => {
      // Section 18: "conservative fallback". A plan produced by a weaker model is a plan a
      // manager then approves.
      await providers().setRoute({
        actorUserId: platformOwnerId,
        tenantId: null,
        profile: 'OBJECTIVE_PLANNER',
        providerModelId: FAST_MODEL,
        preference: 1,
      });
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: REASONING_MODEL,
        lifecycle: 'Deprecated',
        note: 'Superseded.',
      });

      await assert.rejects(() => callGateway('OBJECTIVE_PLANNER'), ProviderNotConfiguredError);
    });

    it('records an unroutable call so the gap is visible rather than silent', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.logicalModelRoute.deleteMany({ where: { profile: 'EXECUTOR' } }),
      );

      await assert.rejects(() => callGateway('EXECUTOR'), ProviderNotConfiguredError);

      const calls = await callsFor();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.outcome, 'Unroutable');
      assert.match(calls[0]?.detail ?? '', /No model is configured/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Company BYOK
  // -------------------------------------------------------------------------

  describe('company modes', () => {
    it('lets a company BYOK profile override the platform default outright', async () => {
      const profile = await providers().createProfile({
        actorUserId: platformOwnerId,
        tenantId,
        kind: 'Mock',
        mode: 'CompanyBYOK',
        label: 'Their own account',
      });
      const model = await providers().addModel({
        actorUserId: platformOwnerId,
        providerProfileId: profile.id,
        providerModelRef: 'their-model',
        capability: 'byok-v1',
      });
      await providers().setRoute({
        actorUserId: platformOwnerId,
        tenantId,
        profile: 'AGENT_STANDARD',
        providerModelId: model.id,
        preference: 0,
      });

      const response = await callGateway('AGENT_STANDARD');
      // Their own model answered, not the platform one. Overriding rather than merging is the
      // point: choosing BYOK should not silently keep the platform model as a fallback.
      assert.equal(response.capability, 'byok-v1');
    });

    it('refuses a platform profile in a company-owned mode', async () => {
      await assert.rejects(
        () =>
          providers().createProfile({
            actorUserId: platformOwnerId,
            tenantId: null,
            kind: 'Anthropic',
            mode: 'CompanyBYOK',
            label: 'Wrong',
          }),
        /platform profile is UBoss Managed by definition/,
      );
    });

    it('refuses a company profile claiming UBoss Managed', async () => {
      await assert.rejects(
        () =>
          providers().createProfile({
            actorUserId: platformOwnerId,
            tenantId,
            kind: 'Anthropic',
            mode: 'UBossManaged',
            label: 'Wrong',
          }),
        /cannot be UBoss Managed/,
      );
    });

    it('will not let a company route point at another company model', async () => {
      const profile = await providers().createProfile({
        actorUserId: platformOwnerId,
        tenantId: otherTenantId,
        kind: 'Mock',
        mode: 'CompanyBYOK',
        label: 'Someone else',
      });
      const model = await providers().addModel({
        actorUserId: platformOwnerId,
        providerProfileId: profile.id,
        providerModelRef: 'theirs',
        capability: 'other-v1',
      });

      await assert.rejects(
        () =>
          providers().setRoute({
            actorUserId: platformOwnerId,
            tenantId,
            profile: 'AGENT_FAST',
            providerModelId: model.id,
            preference: 0,
          }),
        /must point at that company's own model/,
      );
    });

    it('will not let a platform route point at a company model', async () => {
      const profile = await providers().createProfile({
        actorUserId: platformOwnerId,
        tenantId,
        kind: 'Mock',
        mode: 'CompanyBYOK',
        label: 'Theirs',
      });
      const model = await providers().addModel({
        actorUserId: platformOwnerId,
        providerProfileId: profile.id,
        providerModelRef: 'theirs',
        capability: 'byok-v1',
      });

      await assert.rejects(
        () =>
          providers().setRoute({
            actorUserId: platformOwnerId,
            tenantId: null,
            profile: 'AGENT_FAST',
            providerModelId: model.id,
            preference: 9,
          }),
        /routable for every other company/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Custom Enterprise Provider
  // -------------------------------------------------------------------------

  describe('custom enterprise provider', () => {
    const custom = {
      baseUrl: 'https://ai.internal.example/v1/chat',
      authType: 'BearerToken' as const,
      authHeaderName: null,
      timeoutMs: 30_000,
      usageMapping: {
        inputPath: 'usage.input_tokens',
        outputPath: 'usage.output_tokens',
        cachedInputPath: null,
      },
      requestIdPath: 'id',
    };

    it('stores the endpoint and the secret as a handle, never the credential', async () => {
      const profile = await providers().createProfile({
        actorUserId: platformOwnerId,
        tenantId,
        kind: 'Custom',
        mode: 'CustomEnterprise',
        label: 'Internal endpoint',
        custom: { ...custom, secret: 'super-secret-token' },
      });

      assert.equal(profile.custom?.baseUrl, custom.baseUrl);
      // Whether one is stored, never the value.
      assert.equal(profile.custom?.hasSecret, true);
      assert.ok(!JSON.stringify(profile).includes('super-secret-token'));

      // Nor does the list endpoint leak it.
      const listed = await asPlatform(agent().get('/platform/providers/profiles')).expect(200);
      assert.ok(!JSON.stringify(listed.body).includes('super-secret-token'));
    });

    it('refuses a plain-http endpoint', async () => {
      await assert.rejects(
        () =>
          providers().createProfile({
            actorUserId: platformOwnerId,
            tenantId,
            kind: 'Custom',
            mode: 'CustomEnterprise',
            label: 'Insecure',
            custom: { ...custom, baseUrl: 'http://ai.internal.example/v1', secret: 'x' },
          }),
        /must be https/,
      );
    });

    it('refuses a custom endpoint with no usage mapping', async () => {
      // Without it the gateway would estimate what it spent and record the estimate as measured.
      await assert.rejects(
        () =>
          providers().createProfile({
            actorUserId: platformOwnerId,
            tenantId,
            kind: 'Custom',
            mode: 'CustomEnterprise',
            label: 'No mapping',
            custom: {
              ...custom,
              usageMapping: { inputPath: '', outputPath: '', cachedInputPath: null },
              secret: 'x',
            },
          }),
        /usage mapping is required/,
      );
    });

    it('refuses an endpoint on a first-party profile', async () => {
      await assert.rejects(
        () =>
          providers().createProfile({
            actorUserId: platformOwnerId,
            tenantId,
            kind: 'Anthropic',
            mode: 'CompanyBYOK',
            label: 'Stale URL',
            custom: { ...custom, secret: 'x' },
          }),
        /has its own endpoint/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. Pricing
  // -------------------------------------------------------------------------

  describe('pricing', () => {
    it('prices a call from the current version and cites it', async () => {
      await providers().publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 300_000,
        outputPerMillionMinorUnits: 1_500_000,
        cachedInputPerMillionMinorUnits: null,
      });

      const response = await callGateway('AGENT_FAST');
      assert.notEqual(response.costMinorUnits, null);
      assert.equal(response.currency, 'INR');

      const calls = await callsFor();
      // A cost with no cited pricing version is refused by a database CHECK, so this is not
      // merely present — it is the version that priced it.
      assert.notEqual(calls[0]?.pricingVersionId, null);
      assert.equal(calls[0]?.currency, 'INR');
    });

    it('supersedes rather than editing, so an old call keeps its price', async () => {
      await providers().publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 1_000_000,
        outputPerMillionMinorUnits: 1_000_000,
        cachedInputPerMillionMinorUnits: null,
      });
      const first = await callGateway('AGENT_FAST');

      await providers().publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 2_000_000,
        outputPerMillionMinorUnits: 2_000_000,
        cachedInputPerMillionMinorUnits: null,
      });
      const second = await callGateway('AGENT_FAST');

      // The same usage priced at twice the rate.
      assert.ok(
        (second.costMinorUnits ?? 0) > (first.costMinorUnits ?? 0),
        'the new price did not apply',
      );

      const calls = await callsFor();
      // Two different pricing versions cited — the first call's price was not restated.
      assert.notEqual(calls[0]?.pricingVersionId, calls[1]?.pricingVersionId);
      assert.notEqual(calls[0]?.costMinorUnits, calls[1]?.costMinorUnits);
    });

    it('refuses to edit a published price in the database', async () => {
      const version = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.pricingVersionRow.findFirstOrThrow({
          where: { providerModelId: FAST_MODEL, supersededAt: null },
        }),
      );

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.pricingVersionRow.update({
              where: { id: version.id },
              data: { inputPerMillionMinorUnits: 999 },
            }),
          ),
        /immutable/,
      );
    });

    it('keeps exactly one current price per model', async () => {
      await providers().publishPricing({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        currency: 'INR',
        inputPerMillionMinorUnits: 5,
        outputPerMillionMinorUnits: 5,
        cachedInputPerMillionMinorUnits: null,
      });

      const current = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.pricingVersionRow.findMany({
          where: { providerModelId: FAST_MODEL, supersededAt: null },
        }),
      );
      assert.equal(current.length, 1);
      assert.equal(current[0]?.versionNumber, 2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('refuses a move back to Active', async () => {
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        lifecycle: 'Deprecated',
        note: 'Superseded.',
      });

      await assert.rejects(
        () =>
          providers().setModelLifecycle({
            actorUserId: platformOwnerId,
            providerModelId: FAST_MODEL,
            lifecycle: 'Active',
            note: 'Never mind.',
          }),
        /re-approved deliberately, not by relaxing a state/,
      );
    });

    it('allows a withdrawn removal notice to step back to Deprecated', async () => {
      await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        lifecycle: 'MigrationRequired',
        note: 'Removal announced.',
      });
      const back = await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        lifecycle: 'Deprecated',
        note: 'The provider withdrew the notice.',
      });
      assert.equal(back.lifecycle, 'Deprecated');
    });

    it('records when the lifecycle changed and why', async () => {
      const changed = await providers().setModelLifecycle({
        actorUserId: platformOwnerId,
        providerModelId: FAST_MODEL,
        lifecycle: 'Deprecated',
        note: 'Superseded by a cheaper model.',
      });
      assert.notEqual(changed.lifecycleChangedAt, null);
      assert.match(changed.lifecycleNote ?? '', /Superseded by a cheaper model/);
    });
  });

  // -------------------------------------------------------------------------
  // 8. The call record
  // -------------------------------------------------------------------------

  describe('the call record', () => {
    it('is append-only', async () => {
      await callGateway('AGENT_FAST');
      const calls = await callsFor();

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.modelGatewayCall.update({
              where: { id: calls[0]!.id },
              data: { outputTokens: 9_999 },
            }),
          ),
        /append-only/,
      );
    });

    it('records exactly what the adapter reported, and nothing it did not', async () => {
      const response = await callGateway('AGENT_FAST');
      const calls = await callsFor();

      assert.equal(calls[0]?.inputTokens, response.promptTokens);
      assert.equal(calls[0]?.outputTokens, response.completionTokens);
      // The mock reports no cached tokens, so zero — not an estimate, and not omitted.
      assert.equal(calls[0]?.cachedInputTokens, 0);
    });

    it('stays inside its own tenant', async () => {
      await callGateway('AGENT_FAST');

      const theirs = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.modelGatewayCall.findMany({ where: { tenantId: otherTenantId } }),
      );
      assert.equal(theirs.length, 0);
    });
  });
});
