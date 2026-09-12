import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthenticationPolicyService } from '../src/auth/authentication-policy.service.js';
import {
  DNS_TXT_RESOLVER,
  DomainVerificationService,
  type DnsTxtResolver,
} from '../src/auth/domain-verification.service.js';
import { EnterpriseIdentityController } from '../src/auth/enterprise-identity.controller.js';
import { InvitationController } from '../src/auth/invitation.controller.js';
import { InvitationService } from '../src/auth/invitation.service.js';
import { LoginService } from '../src/auth/login.service.js';
import { MfaLoginService } from '../src/auth/mfa-login.service.js';
import { MfaService } from '../src/auth/mfa.service.js';
import { PasswordResetService } from '../src/auth/password-reset.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { ScimController } from '../src/auth/scim/scim.controller.js';
import { ScimService } from '../src/auth/scim/scim.service.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { SessionActorResolver } from '../src/auth/session-actor.resolver.js';
import { SessionService } from '../src/auth/session.service.js';
import { OidcProvider } from '../src/auth/sso/oidc.provider.js';
import { SamlProvider } from '../src/auth/sso/saml.provider.js';
import { SsoService } from '../src/auth/sso/sso.service.js';
import { totpCode } from '../src/auth/totp.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { EnterpriseIdentityRepository } from '../src/persistence/enterprise-identity.repository.js';
import { InvitationRepository } from '../src/persistence/invitation.repository.js';
import { MfaRepository } from '../src/persistence/mfa.repository.js';
import { PasswordResetRepository } from '../src/persistence/password-reset.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { ProvisioningRepository } from '../src/persistence/provisioning.repository.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';
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
import { TestIdentityProvider } from './support/test-identity-provider.js';

const PASSWORD = 'a sufficiently long password';

/**
 * A TOTP code for the *next* time step.
 *
 * Enrolment spends the current step — proving the factor works is what confirms it — and the
 * replay guard then refuses that step permanently. A sign-in immediately afterwards therefore
 * has to present the next code. That is real behaviour rather than a test artefact: someone who
 * enrols and is challenged within the same 30 seconds waits for their app to tick over. The
 * server's ±1-step drift window accepts it.
 */
const nextCode = (secret: string): string => totpCode(secret, { now: Date.now() + 30_000 });

/**
 * A DNS resolver whose answers the test controls.
 *
 * Domain verification is meaningless to test against real DNS: the record would have to exist on
 * a domain we own, and the suite would fail without a network. This exercises exactly the same
 * code path with the lookup as the only substituted part.
 */
class StubDnsResolver implements DnsTxtResolver {
  readonly records = new Map<string, string[][]>();
  /** Set to make the next lookup fail the way a missing record does. */
  failWith: string | undefined;

  async resolveTxt(hostname: string): Promise<string[][]> {
    if (this.failWith !== undefined) {
      const error = Object.assign(new Error('lookup failed'), { code: this.failWith });
      throw error;
    }
    const found = this.records.get(hostname);
    if (!found) {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    }
    return found;
  }
}

/**
 * Enterprise identity integration tests: MFA policy and enrolment, recovery codes, OIDC SSO
 * against a real identity provider, domain verification and SCIM.
 *
 * Run against real PostgreSQL, real Argon2id, real AES-256-GCM and a real RSA-signed OIDC
 * provider (`TestIdentityProvider`). Nothing security-relevant is mocked — the only substituted
 * component is the DNS lookup, because a test that needs a live TXT record is a test that fails
 * on a train.
 */
describe('enterprise identity (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dns: StubDnsResolver;
  let idp: TestIdentityProvider;

  let tenantId: string;
  let otherTenantId: string;
  let memberUserId: string;
  let platformAdminUboss: string;

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
    // A real key, generated per run. Nothing here is a fixture secret that could be mistaken for
    // a production value.
    process.env['AUTH_ENCRYPTION_KEYS'] =
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
    process.env['AUTH_PUBLIC_API_BASE_URL'] = 'http://127.0.0.1:4999';
    process.env['AUTH_WEB_BASE_URL'] = 'http://127.0.0.1:3999';

    dns = new StubDnsResolver();

    const moduleRef = await Test.createTestingModule({
      controllers: [
        AuthController,
        InvitationController,
        EnterpriseIdentityController,
        ScimController,
      ],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        { provide: DNS_TXT_RESOLVER, useValue: dns },
        UserRepository,
        UserCredentialRepository,
        InvitationRepository,
        PasswordResetRepository,
        SessionRepository,
        AuditEventRepository,
        MfaRepository,
        EnterpriseIdentityRepository,
        ProvisioningRepository,
        TenantMembershipRepository,
        PasswordService,
        AuditTrailRepository,
        SecurityEventService,
        SecurityEventPublisher,
        SessionService,
        SessionActorResolver,
        LoginService,
        InvitationService,
        PasswordResetService,
        MfaService,
        MfaLoginService,
        AuthenticationPolicyService,
        DomainVerificationService,
        OidcProvider,
        SamlProvider,
        SsoService,
        ScimService,
        TenantContextService,
        Reflector,
        {
          provide: ActorResolver,
          inject: [SessionActorResolver, PrismaService],
          useFactory: async (session: SessionActorResolver, prisma: PrismaService) => {
            const { CompositeActorResolver } =
              await import('../src/auth/session-actor.resolver.js');
            const { DevHeaderActorResolver } =
              await import('../src/request-context/actor-resolver.js');
            return new CompositeActorResolver(
              session,
              new DevHeaderActorResolver(async (ubossUniqueId) =>
                prisma.runAsPlatformOperation(() =>
                  prisma.client.user.findUnique({
                    where: { ubossUniqueId },
                    select: { id: true, ubossUniqueId: true, isPlatformActor: true },
                  }),
                ),
              ),
            );
          },
        },
        { provide: APP_GUARD, useClass: TenantGuard },
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

    idp = new TestIdentityProvider();
    await idp.start();

    dns.records.clear();
    dns.failWith = undefined;

    const provisioned = await ctx.provisioning.provision({
      slug: 'sso-co',
      name: 'SSO Co',
      firstMember: { email: 'member@sso.example', displayName: 'Member' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;
    memberUserId = provisioned.user.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-co',
      name: 'Other Co',
      firstMember: { email: 'member@other.example', displayName: 'Other Member' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;

    const platformAdmin = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-PLAT-0006',
        email: 'platform@uboss.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformAdminUboss = platformAdmin.ubossUniqueId;

    // Give the member a password, so password sign-in is a real path in these tests.
    await ctx.prisma.runAsPlatformOperation(async () => {
      const passwords = new PasswordService(loadAuthConfig());
      await ctx.prisma.client.userCredential.create({
        data: { userId: memberUserId, passwordHash: await passwords.hash(PASSWORD) },
      });
    });
  });

  afterEach(async () => {
    await idp.stop();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const asPlatform = <T extends request.Test>(test: T): T =>
    test.set('x-uboss-dev-actor', platformAdminUboss) as T;

  const setPolicy = async (
    id: string,
    body: { requireMfa: boolean; requireSso: boolean; mfaGraceUntil?: string },
    expected = 200,
  ) =>
    asPlatform(agent().put(`/tenants/${id}/identity/policy`))
      .send(body)
      .expect(expected);

  const verifyDomain = async (id: string, domain: string) => {
    const claim = await asPlatform(agent().post(`/tenants/${id}/identity/domains`))
      .send({ domain })
      .expect(201);

    const view = claim.body as { id: string; recordName: string; recordValue: string };
    dns.records.set(view.recordName, [[view.recordValue]]);

    const verified = await asPlatform(
      agent().post(`/tenants/${id}/identity/domains/${view.id}/verify`),
    ).expect(200);

    assert.equal((verified.body as { state: string }).state, 'Verified');
    return view;
  };

  const createOidcConnection = async (id: string, enabled = true) => {
    const created = await asPlatform(agent().post(`/tenants/${id}/identity/sso-connections`))
      .send({
        protocol: 'Oidc',
        displayName: 'Test IdP',
        issuer: idp.issuer,
        discoveryUrl: idp.discoveryUrl,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
      })
      .expect(201);

    const connection = created.body as { id: string; enabled: boolean; hasClientSecret: boolean };

    if (enabled) {
      await asPlatform(agent().patch(`/tenants/${id}/identity/sso-connections/${connection.id}`))
        .send({ enabled: true })
        .expect(200);
    }

    return connection;
  };

  /**
   * Start a password sign-in.
   *
   * Deliberately NOT async: it returns supertest's chainable request so each caller can assert
   * its own expected status, which differs by policy (200 with a session, 200 with a challenge,
   * 200 with an SSO refusal, 401).
   */
  const signIn = (email = 'member@sso.example', password = PASSWORD) =>
    agent().post('/auth/login').send({ email, password });

  const cookiesFrom = (response: request.Response): string[] =>
    (response.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  const cookieValue = (response: request.Response, name: string): string | undefined => {
    const found = cookiesFrom(response).find((cookie) => cookie.startsWith(`${name}=`));
    return found?.split(';')[0]?.split('=')[1];
  };

  /** Enrol a TOTP factor for the member using an authenticated session, and return the secret. */
  const enrolTotp = async (): Promise<{ secret: string }> => {
    const started = await asPlatform(agent().post('/auth/mfa/enroll/start')).send({}).expect(200);
    // The dev-header actor is the platform admin, so enrol against the *member* instead by
    // signing in as them first.
    void started;
    throw new Error('unused');
  };
  void enrolTotp;

  /** Enrol a factor for a signed-in member. Returns the shared secret and the session cookie. */
  const enrolForMember = async (): Promise<{ secret: string; session: string }> => {
    const login = await signIn().expect(200);
    const session = cookieValue(login, 'uboss_session') as string;
    assert.ok(session, 'expected a session cookie');

    const start = await agent()
      .post('/auth/mfa/enroll/start')
      .set('Cookie', `uboss_session=${session}`)
      .send({})
      .expect(200);

    const { factorId, secret } = start.body as { factorId: string; secret: string };

    await agent()
      .post('/auth/mfa/enroll/confirm')
      .set('Cookie', `uboss_session=${session}`)
      .send({ factorId, code: totpCode(secret) })
      .expect(200);

    return { secret, session };
  };

  // =========================================================================
  describe('company policy: MFA required', () => {
    it('refuses to issue a session on a correct password alone', async () => {
      const { secret } = await enrolForMember();
      void secret;
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const response = await signIn().expect(200);
      const body = response.body as { mfaRequired?: boolean; user?: unknown };

      assert.equal(body.mfaRequired, true);
      assert.equal(body.user, undefined, 'no identity is returned before the second factor');
      assert.equal(
        cookieValue(response, 'uboss_session'),
        undefined,
        'a session cookie must NOT be set before the second factor',
      );
      assert.ok(cookieValue(response, 'uboss_mfa'), 'a challenge cookie is set instead');
    });

    it('sets the challenge cookie HttpOnly and SameSite=Strict', async () => {
      await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const response = await signIn().expect(200);
      const cookie = cookiesFrom(response).find((value) => value.startsWith('uboss_mfa='));

      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/i);
      // Stricter than the session cookie's Lax: nothing legitimately navigates to the
      // second-factor step from another site.
      assert.match(cookie, /SameSite=Strict/i);
      assert.match(cookie, /Path=\//i);
    });

    it('completes the sign-in with a correct code', async () => {
      const { secret } = await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const challenge = cookieValue(login, 'uboss_mfa') as string;

      const verified = await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .send({ code: nextCode(secret) })
        .expect(200);

      const body = verified.body as { user: { displayName: string }; secondFactor: string };
      assert.equal(body.user.displayName, 'Member');
      assert.equal(body.secondFactor, 'Totp');
      assert.ok(cookieValue(verified, 'uboss_session'), 'now a session cookie is set');
    });

    it('records that the session satisfied a second factor', async () => {
      const { secret } = await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(login, 'uboss_mfa')}`)
        .send({ code: nextCode(secret) })
        .expect(200);

      const session = await ctx.admin.unsafeRootClient.session.findFirst({
        where: { userId: memberUserId, revokedAt: null, mfaSatisfiedAt: { not: null } },
      });
      assert.ok(session, 'the session records when MFA was satisfied');
      assert.equal(session?.primaryAuthMethod, 'Password');
    });

    it('refuses a wrong code and does not issue a session', async () => {
      await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const response = await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(login, 'uboss_mfa')}`)
        .send({ code: '000000' })
        .expect(401);

      assert.equal(cookieValue(response, 'uboss_session'), undefined);
    });

    it('refuses a replayed code, inside its own validity window', async () => {
      const { secret } = await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });
      const code = nextCode(secret);

      const first = await signIn().expect(200);
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(first, 'uboss_mfa')}`)
        .send({ code })
        .expect(200);

      // Same code, still arithmetically valid, presented again on a fresh challenge.
      const second = await signIn().expect(200);
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(second, 'uboss_mfa')}`)
        .send({ code })
        .expect(401);
    });

    it('counts a failed second factor against the password lockout', async () => {
      await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const challenge = cookieValue(login, 'uboss_mfa') as string;

      // Five wrong codes: six digits is a million guesses, so the second factor must not be the
      // cheap thing to brute-force.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await agent()
          .post('/auth/mfa/verify')
          .set('Cookie', `uboss_mfa=${challenge}`)
          .send({ code: '000000' })
          .expect(401);
      }

      const credential = await ctx.admin.unsafeRootClient.userCredential.findUnique({
        where: { userId: memberUserId },
      });
      assert.ok((credential?.failedAttempts ?? 0) >= 5, 'failures reached the credential counter');
    });

    it('destroys the challenge after too many attempts', async () => {
      const { secret } = await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const challenge = cookieValue(login, 'uboss_mfa') as string;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        await agent()
          .post('/auth/mfa/verify')
          .set('Cookie', `uboss_mfa=${challenge}`)
          .send({ code: '000000' })
          .expect(401);
      }

      // Even the right code cannot rescue an abandoned challenge.
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .send({ code: nextCode(secret) })
        .expect(401);
    });

    it('answers identically whether a TOTP code or a recovery code was wrong', async () => {
      await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const challenge = cookieValue(login, 'uboss_mfa') as string;

      const badTotp = await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .send({ code: '123456' })
        .expect(401);

      const badRecovery = await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .send({ code: 'ABCDE-FGHJK-MNPQR-STVWX' })
        .expect(401);

      assert.deepEqual(
        badTotp.body,
        badRecovery.body,
        'the response must not reveal which kind of credential was presented',
      );
    });
  });

  // =========================================================================
  describe('MFA enrolment', () => {
    it('lets someone with no factor enrol during a forced sign-in, rather than locking them out', async () => {
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      const body = login.body as { mfaRequired: boolean; enrolmentRequired: boolean };
      assert.equal(body.mfaRequired, true);
      assert.equal(body.enrolmentRequired, true);

      const challenge = cookieValue(login, 'uboss_mfa') as string;

      const start = await agent()
        .post('/auth/mfa/challenge/enroll/start')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .expect(200);

      const { factorId, secret } = start.body as { factorId: string; secret: string };

      const confirmed = await agent()
        .post('/auth/mfa/challenge/enroll/confirm')
        .set('Cookie', `uboss_mfa=${challenge}`)
        .send({ factorId, code: totpCode(secret) })
        .expect(200);

      const result = confirmed.body as { recoveryCodes: string[]; user: { displayName: string } };
      assert.equal(result.user.displayName, 'Member');
      assert.equal(result.recoveryCodes.length, 10);
      assert.ok(cookieValue(confirmed, 'uboss_session'), 'enrolment completed the sign-in');
    });

    it('issues recovery codes only for the first factor', async () => {
      const { session } = await enrolForMember();

      const second = await agent()
        .post('/auth/mfa/enroll/start')
        .set('Cookie', `uboss_session=${session}`)
        .send({ label: 'Backup phone' })
        .expect(200);

      const { factorId, secret } = second.body as { factorId: string; secret: string };
      const confirmed = await agent()
        .post('/auth/mfa/enroll/confirm')
        .set('Cookie', `uboss_session=${session}`)
        .send({ factorId, code: totpCode(secret) })
        .expect(200);

      // Regenerating on every enrolment would silently invalidate codes already printed.
      assert.equal((confirmed.body as { recoveryCodes: unknown }).recoveryCodes, null);
    });

    it('never returns the shared secret again after enrolment', async () => {
      const { session, secret } = await enrolForMember();

      const factors = await agent()
        .get('/auth/mfa/factors')
        .set('Cookie', `uboss_session=${session}`)
        .expect(200);

      const serialised = JSON.stringify(factors.body);
      assert.ok(!serialised.includes(secret), 'the TOTP secret must never be returned again');
      assert.ok(!serialised.includes('secretCiphertext'), 'not even the sealed form');
    });

    it('stores the TOTP secret encrypted, not in plaintext', async () => {
      const { secret } = await enrolForMember();

      const factor = await ctx.admin.unsafeRootClient.mfaFactor.findFirst({
        where: { userId: memberUserId, state: 'Active' },
      });

      assert.ok(factor?.secretCiphertext);
      assert.ok(
        !(factor?.secretCiphertext ?? '').includes(secret),
        'the plaintext secret must not appear in the stored value',
      );
      // The envelope format, so a change of scheme is a visible test failure.
      assert.match(factor?.secretCiphertext ?? '', /^v1\.test\./);
    });

    it('refuses an enrolment code that does not match', async () => {
      const login = await signIn().expect(200);
      const session = cookieValue(login, 'uboss_session') as string;

      const start = await agent()
        .post('/auth/mfa/enroll/start')
        .set('Cookie', `uboss_session=${session}`)
        .send({})
        .expect(200);

      await agent()
        .post('/auth/mfa/enroll/confirm')
        .set('Cookie', `uboss_session=${session}`)
        .send({ factorId: (start.body as { factorId: string }).factorId, code: '000000' })
        .expect(400);

      // The pending factor survives, so a typo does not force a re-scan of the QR code.
      const pending = await ctx.admin.unsafeRootClient.mfaFactor.count({
        where: { userId: memberUserId, state: 'Pending' },
      });
      assert.equal(pending, 1);
    });

    it('refuses to remove the last factor while a company requires MFA', async () => {
      const { session } = await enrolForMember();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const factors = await agent()
        .get('/auth/mfa/factors')
        .set('Cookie', `uboss_session=${session}`)
        .expect(200);

      const factorId = (factors.body as { factors: { id: string }[] }).factors[0]?.id as string;

      const refused = await agent()
        .delete(`/auth/mfa/factors/${factorId}`)
        .set('Cookie', `uboss_session=${session}`)
        .expect(400);

      assert.match((refused.body as { message: string }).message, /only second factor/i);
    });

    it('allows removing a factor when the company does not require MFA', async () => {
      const { session } = await enrolForMember();

      const factors = await agent()
        .get('/auth/mfa/factors')
        .set('Cookie', `uboss_session=${session}`)
        .expect(200);

      const factorId = (factors.body as { factors: { id: string }[] }).factors[0]?.id as string;

      await agent()
        .delete(`/auth/mfa/factors/${factorId}`)
        .set('Cookie', `uboss_session=${session}`)
        .expect(204);

      // Recovery codes go with the last factor: they would otherwise be a standing bypass of a
      // factor that no longer exists.
      const codes = await ctx.admin.unsafeRootClient.mfaRecoveryCode.count({
        where: { userId: memberUserId },
      });
      assert.equal(codes, 0);
    });

    it('honours an MFA grace period, so imposing the policy is not an instant lockout', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await setPolicy(tenantId, {
        requireMfa: true,
        requireSso: false,
        mfaGraceUntil: future,
      });

      // No enrolled factor, but inside the grace period: signed in, and free to enrol.
      const response = await signIn().expect(200);
      assert.ok(cookieValue(response, 'uboss_session'), 'grace period permits the sign-in');
    });

    it('stops honouring a grace period once it has passed', async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      await setPolicy(tenantId, { requireMfa: true, requireSso: false, mfaGraceUntil: past });

      const response = await signIn().expect(200);
      assert.equal((response.body as { enrolmentRequired: boolean }).enrolmentRequired, true);
      assert.equal(cookieValue(response, 'uboss_session'), undefined);
    });
  });

  // =========================================================================
  describe('recovery codes', () => {
    it('sign in once, and only once', async () => {
      const login = await signIn().expect(200);
      const session = cookieValue(login, 'uboss_session') as string;

      const start = await agent()
        .post('/auth/mfa/enroll/start')
        .set('Cookie', `uboss_session=${session}`)
        .send({})
        .expect(200);
      const { factorId, secret } = start.body as { factorId: string; secret: string };

      const confirmed = await agent()
        .post('/auth/mfa/enroll/confirm')
        .set('Cookie', `uboss_session=${session}`)
        .send({ factorId, code: totpCode(secret) })
        .expect(200);

      const codes = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes;
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const first = await signIn().expect(200);
      const used = await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(first, 'uboss_mfa')}`)
        .send({ code: codes[0] })
        .expect(200);

      assert.equal((used.body as { secondFactor: string }).secondFactor, 'RecoveryCode');
      assert.equal((used.body as { remainingRecoveryCodes: number }).remainingRecoveryCodes, 9);

      const second = await signIn().expect(200);
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(second, 'uboss_mfa')}`)
        .send({ code: codes[0] })
        .expect(401);
    });

    it('are stored only as hashes', async () => {
      const login = await signIn().expect(200);
      const session = cookieValue(login, 'uboss_session') as string;

      const start = await agent()
        .post('/auth/mfa/enroll/start')
        .set('Cookie', `uboss_session=${session}`)
        .send({})
        .expect(200);
      const { factorId, secret } = start.body as { factorId: string; secret: string };
      const confirmed = await agent()
        .post('/auth/mfa/enroll/confirm')
        .set('Cookie', `uboss_session=${session}`)
        .send({ factorId, code: totpCode(secret) })
        .expect(200);

      const codes = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes;
      const stored = await ctx.admin.unsafeRootClient.mfaRecoveryCode.findMany({
        where: { userId: memberUserId },
      });

      assert.equal(stored.length, 10);
      for (const row of stored) {
        assert.match(row.codeHash, /^[0-9a-f]{64}$/);
      }
      const serialised = JSON.stringify(stored);
      for (const code of codes) {
        assert.ok(!serialised.includes(code.replace(/-/g, '')), 'no code appears in the database');
      }
    });

    it('are replaced as a whole batch, invalidating every earlier code', async () => {
      const { session } = await enrolForMember();

      const firstBatch = await agent()
        .post('/auth/mfa/recovery-codes')
        .set('Cookie', `uboss_session=${session}`)
        .expect(200);

      const secondBatch = await agent()
        .post('/auth/mfa/recovery-codes')
        .set('Cookie', `uboss_session=${session}`)
        .expect(200);

      const older = (firstBatch.body as { codes: string[] }).codes;
      await setPolicy(tenantId, { requireMfa: true, requireSso: false });

      const login = await signIn().expect(200);
      await agent()
        .post('/auth/mfa/verify')
        .set('Cookie', `uboss_mfa=${cookieValue(login, 'uboss_mfa')}`)
        .send({ code: older[0] })
        .expect(401);

      assert.equal((secondBatch.body as { codes: string[] }).codes.length, 10);
      const live = await ctx.admin.unsafeRootClient.mfaRecoveryCode.count({
        where: { userId: memberUserId, usedAt: null },
      });
      assert.equal(live, 10, 'only the newest batch survives');
    });
  });

  // =========================================================================
  describe('company policy: SSO required', () => {
    it('cannot be set without an enabled connection', async () => {
      const refused = await setPolicy(tenantId, { requireMfa: false, requireSso: true }, 400);
      assert.match((refused.body as { message: string }).message, /before requiring SSO/i);
    });

    it('can be set once a connection is enabled, and disables password sign-in', async () => {
      await createOidcConnection(tenantId);
      const response = await setPolicy(tenantId, { requireMfa: false, requireSso: true });

      const policy = response.body as { requireSso: boolean; allowPasswordSignIn: boolean };
      assert.equal(policy.requireSso, true);
      // Requiring SSO *means* passwords are no longer accepted; leaving them on would make the
      // requirement decorative.
      assert.equal(policy.allowPasswordSignIn, false);
    });

    it('refuses a correct password and offers the connection instead', async () => {
      const connection = await createOidcConnection(tenantId);
      await setPolicy(tenantId, { requireMfa: false, requireSso: true });

      const response = await signIn().expect(200);
      const body = response.body as {
        ssoRequired: boolean;
        tenantName: string;
        ssoConnections: { id: string; displayName: string }[];
      };

      assert.equal(body.ssoRequired, true);
      assert.equal(body.tenantName, 'SSO Co');
      assert.equal(body.ssoConnections[0]?.id, connection.id);
      assert.equal(
        cookieValue(response, 'uboss_session'),
        undefined,
        'a correct password must not produce a session at an SSO-only company',
      );
    });

    it('advertises the company methods by domain, not by whether the address exists', async () => {
      await verifyDomain(tenantId, 'sso.example');
      await createOidcConnection(tenantId);
      await setPolicy(tenantId, { requireMfa: false, requireSso: true });

      const known = await agent().get('/auth/sign-in-methods?email=member@sso.example').expect(200);
      const strangerSameDomain = await agent()
        .get('/auth/sign-in-methods?email=nobody-at-all@sso.example')
        .expect(200);
      const unclaimedDomain = await agent()
        .get('/auth/sign-in-methods?email=someone@unclaimed.example')
        .expect(200);

      // An address that exists and one that does not, at the same domain, answer identically.
      assert.deepEqual(known.body, strangerSameDomain.body);
      assert.equal((known.body as { requireSso: boolean }).requireSso, true);

      // An unclaimed domain looks exactly like an ordinary password-only company.
      assert.deepEqual(unclaimedDomain.body, {
        allowPassword: true,
        requireSso: false,
        ssoConnections: [],
        mfaExpected: false,
      });
    });
  });

  // =========================================================================
  describe('OIDC single sign-on, against a real identity provider', () => {
    /**
     * Drive the whole browser flow: start, authorize at the identity provider, hit the callback.
     *
     * The callback always answers 302 — success and failure differ by *where* it sends the
     * browser and whether a session cookie came with it, which is what each test asserts.
     */
    const completeSsoFlow = async (connectionId: string) => {
      const start = await agent().post('/auth/sso/start').send({ connectionId }).expect(200);

      const { authorizationUrl } = start.body as { authorizationUrl: string };
      const { code, state } = idp.authorize(authorizationUrl);

      return agent().get(`/auth/sso/callback?code=${code}&state=${state}`).expect(302);
    };

    it('signs in a member whose domain the company has verified', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);

      const callback = await completeSsoFlow(connection.id);

      assert.ok(cookieValue(callback, 'uboss_session'), 'a session cookie is set');
      assert.match(callback.headers['location'] as string, /^http:\/\/127\.0\.0\.1:3999\//);

      const session = await ctx.admin.unsafeRootClient.session.findFirst({
        where: { userId: memberUserId, revokedAt: null },
      });
      assert.equal(session?.primaryAuthMethod, 'Oidc');
      assert.equal(session?.ssoConnectionId, connection.id);
      assert.equal(session?.providerSessionId, 'idp-session-1');
    });

    it('satisfies an SSO-required policy', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      await setPolicy(tenantId, { requireMfa: false, requireSso: true });

      const callback = await completeSsoFlow(connection.id);
      assert.ok(cookieValue(callback, 'uboss_session'));
    });

    it('refuses a replayed callback', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);

      const start = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: connection.id })
        .expect(200);
      const { authorizationUrl } = start.body as { authorizationUrl: string };
      const { code, state } = idp.authorize(authorizationUrl);

      await agent().get(`/auth/sso/callback?code=${code}&state=${state}`).expect(302);

      // The state was consumed atomically with the lookup, so the second attempt finds nothing.
      const replay = await agent()
        .get(`/auth/sso/callback?code=${code}&state=${state}`)
        .expect(302);
      assert.match(replay.headers['location'] as string, /ssoError=/);
      assert.equal(cookieValue(replay, 'uboss_session'), undefined);
    });

    it('refuses an unknown state', async () => {
      const connection = await createOidcConnection(tenantId);
      void connection;

      const response = await agent()
        .get('/auth/sso/callback?code=whatever&state=not-a-real-state')
        .expect(302);

      assert.match(response.headers['location'] as string, /ssoError=/);
      assert.equal(cookieValue(response, 'uboss_session'), undefined);
    });

    it('refuses an ID token signed with alg:none', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { algorithm: 'none' };

      const callback = await completeSsoFlow(connection.id);

      assert.match(callback.headers['location'] as string, /ssoError=/);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an ID token for a different audience', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { audience: 'some-other-client' };

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an ID token whose nonce does not match the request', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { nonce: 'a-nonce-we-never-sent' };

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an ID token with no nonce at all', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { nonce: null };

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an expired ID token', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { expiresInSeconds: -3600 };

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an ID token signed with an unpublished key id', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      idp.tokenOverrides = { keyId: 'a-key-that-was-never-published' };

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an assertion for a domain the company has not verified', async () => {
      // No domain claim at all.
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);

      const callback = await completeSsoFlow(connection.id);

      assert.match(callback.headers['location'] as string, /ssoError=/);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses an assertion for someone who is not a member — federation is not signup', async () => {
      await verifyDomain(tenantId, 'sso.example');
      // A real address at a verified domain, but nobody has invited this person.
      idp.setProfile({ email: 'stranger@sso.example' });
      const connection = await createOidcConnection(tenantId);

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);

      // Nothing was created. Just-in-time provisioning would have made the identity provider's
      // directory into a signup form.
      const created = await ctx.admin.unsafeRootClient.user.count({
        where: { email: 'stranger@sso.example' },
      });
      assert.equal(created, 0);
    });

    it('refuses a suspended member', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);

      await ctx.admin.unsafeRootClient.tenantMembership.updateMany({
        where: { userId: memberUserId, tenantId },
        data: { accountState: 'Suspended' },
      });

      const callback = await completeSsoFlow(connection.id);
      assert.equal(cookieValue(callback, 'uboss_session'), undefined);
    });

    it('refuses a disabled connection, indistinguishably from one that does not exist', async () => {
      const connection = await createOidcConnection(tenantId, false);

      const disabled = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: connection.id })
        .expect(401);

      const missing = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: '01a00000-0000-7000-8000-000000000000' })
        .expect(401);

      assert.deepEqual(disabled.body, missing.body);
    });

    it('requests the authorization-code flow with S256 PKCE', async () => {
      const connection = await createOidcConnection(tenantId);

      const start = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: connection.id })
        .expect(200);

      const url = new URL((start.body as { authorizationUrl: string }).authorizationUrl);
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('code_challenge'));
      assert.ok(url.searchParams.get('state'));
      assert.ok(url.searchParams.get('nonce'));
      assert.match(url.searchParams.get('scope') ?? '', /\bopenid\b/);
    });

    it('stores the PKCE verifier encrypted and the state and nonce hashed', async () => {
      const connection = await createOidcConnection(tenantId);

      const start = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: connection.id })
        .expect(200);

      const url = new URL((start.body as { authorizationUrl: string }).authorizationUrl);
      const state = url.searchParams.get('state') as string;
      const nonce = url.searchParams.get('nonce') as string;

      const stored = await ctx.admin.unsafeRootClient.ssoAuthRequest.findFirst({
        where: { tenantId },
      });

      assert.ok(stored);
      assert.match(stored?.stateHash ?? '', /^[0-9a-f]{64}$/);
      assert.match(stored?.nonceHash ?? '', /^[0-9a-f]{64}$/);
      assert.notEqual(stored?.stateHash, state, 'the state is hashed, not stored plainly');
      assert.notEqual(stored?.nonceHash, nonce, 'the nonce is hashed, not stored plainly');
      assert.match(stored?.codeVerifierCiphertext ?? '', /^v1\.test\./);
    });

    it('never returns the client secret', async () => {
      const connection = await createOidcConnection(tenantId);
      void connection;

      const list = await asPlatform(
        agent().get(`/tenants/${tenantId}/identity/sso-connections`),
      ).expect(200);

      const serialised = JSON.stringify(list.body);
      assert.ok(!serialised.includes(idp.clientSecret), 'the client secret must never come back');
      assert.ok(!serialised.includes('clientSecretCiphertext'), 'not even the sealed form');
      assert.ok(serialised.includes('"hasClientSecret":true'), 'only whether one is configured');
    });

    it('stores the client secret encrypted', async () => {
      await createOidcConnection(tenantId);

      const stored = await ctx.admin.unsafeRootClient.ssoConnection.findFirst({
        where: { tenantId },
      });

      assert.ok(stored?.clientSecretCiphertext);
      assert.ok(!(stored?.clientSecretCiphertext ?? '').includes(idp.clientSecret));
      assert.match(stored?.clientSecretCiphertext ?? '', /^v1\.test\./);
    });
  });

  // =========================================================================
  describe('SSO session termination', () => {
    const signInViaSso = async (connectionId: string) => {
      const start = await agent().post('/auth/sso/start').send({ connectionId }).expect(200);
      const { code, state } = idp.authorize(
        (start.body as { authorizationUrl: string }).authorizationUrl,
      );
      const callback = await agent()
        .get(`/auth/sso/callback?code=${code}&state=${state}`)
        .expect(302);
      return cookieValue(callback, 'uboss_session') as string;
    };

    it('ends the local session when the provider says its session has ended', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);

      const session = await signInViaSso(connection.id);

      // The session works before the logout.
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(200);

      const logout = await agent()
        .post(`/auth/sso/${connection.id}/backchannel-logout`)
        .send({ logout_token: idp.logoutToken({ sessionId: 'idp-session-1' }) })
        .expect(200);

      assert.equal((logout.body as { revoked: number }).revoked, 1);

      // And is dead immediately afterwards — not at the next expiry.
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(401);
    });

    it('refuses a logout token that does not verify', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      const session = await signInViaSso(connection.id);

      await agent()
        .post(`/auth/sso/${connection.id}/backchannel-logout`)
        .send({ logout_token: `${idp.logoutToken({ sessionId: 'idp-session-1' })}tampered` })
        .expect(401);

      // The session survives: an unauthenticated caller cannot end it by guessing.
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(200);
    });

    it('refuses a logout token with no back-channel logout event', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      await signInViaSso(connection.id);

      await agent()
        .post(`/auth/sso/${connection.id}/backchannel-logout`)
        .send({ logout_token: idp.logoutToken({ sessionId: 'idp-session-1', omitEvents: true }) })
        .expect(401);
    });

    it('refuses an ID token presented as a logout token', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      await signInViaSso(connection.id);

      // An ID token carries a nonce; the spec forbids one on a logout token precisely so this
      // substitution cannot work.
      const idToken = idp.idToken({
        nonce: 'anything',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      });

      await agent()
        .post(`/auth/sso/${connection.id}/backchannel-logout`)
        .send({ logout_token: idToken })
        .expect(401);
    });

    it('ends every session for a connection when the connection is disabled', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      const session = await signInViaSso(connection.id);

      await asPlatform(
        agent().patch(`/tenants/${tenantId}/identity/sso-connections/${connection.id}`),
      )
        .send({ enabled: false })
        .expect(200);

      // A federated session whose federation has been switched off can never be re-validated.
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(401);
    });

    it('ends every session for a connection when the connection is deleted', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      const session = await signInViaSso(connection.id);

      await asPlatform(
        agent().delete(`/tenants/${tenantId}/identity/sso-connections/${connection.id}`),
      ).expect(204);

      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(401);
    });
  });

  // =========================================================================
  describe('SAML', () => {
    it('accepts a connection but refuses to enable it', async () => {
      const created = await asPlatform(
        agent().post(`/tenants/${tenantId}/identity/sso-connections`),
      )
        .send({
          protocol: 'Saml',
          displayName: 'Corporate SAML',
          entityId: 'urn:example:idp',
          ssoUrl: 'https://idp.example.com/sso',
        })
        .expect(201);

      const connection = created.body as { id: string; enabled: boolean };
      assert.equal(connection.enabled, false);

      const refused = await asPlatform(
        agent().patch(`/tenants/${tenantId}/identity/sso-connections/${connection.id}`),
      )
        .send({ enabled: true })
        .expect(400);

      assert.match((refused.body as { message: string }).message, /not implemented/i);
    });

    it('publishes service-provider metadata and says plainly that sign-in is unavailable', async () => {
      const setup = await asPlatform(agent().get(`/tenants/${tenantId}/identity/sso-setup`)).expect(
        200,
      );

      const body = setup.body as {
        samlServiceProviderMetadata: string;
        samlStatus: string;
        unsupportedIdTokenAlgorithms: string[];
      };

      assert.match(body.samlServiceProviderMetadata, /EntityDescriptor/);
      assert.equal(body.samlStatus, 'not-implemented');
      // Stated rather than implied: a company must know HMAC-signed ID tokens are refused
      // before it configures one.
      assert.deepEqual(body.unsupportedIdTokenAlgorithms, ['none', 'HS256', 'HS384', 'HS512']);
    });
  });

  // =========================================================================
  describe('domain verification', () => {
    it('returns the exact DNS record to publish', async () => {
      const claim = await asPlatform(agent().post(`/tenants/${tenantId}/identity/domains`))
        .send({ domain: 'SSO.Example.' })
        .expect(201);

      const view = claim.body as {
        domain: string;
        state: string;
        recordName: string;
        recordType: string;
        recordValue: string;
      };

      assert.equal(view.domain, 'sso.example', 'normalised to lower case, trailing dot removed');
      assert.equal(view.state, 'Pending');
      assert.equal(view.recordName, '_uboss-verification.sso.example');
      assert.equal(view.recordType, 'TXT');
      assert.match(view.recordValue, /^uboss-domain-verification=/);
    });

    it('fails with an actionable reason when the record is absent', async () => {
      const claim = await asPlatform(agent().post(`/tenants/${tenantId}/identity/domains`))
        .send({ domain: 'sso.example' })
        .expect(201);

      const verified = await asPlatform(
        agent().post(
          `/tenants/${tenantId}/identity/domains/${(claim.body as { id: string }).id}/verify`,
        ),
      ).expect(200);

      const view = verified.body as { state: string; failureReason: string };
      assert.equal(view.state, 'Failed');
      assert.match(view.failureReason, /No TXT record was found/);
      assert.match(view.failureReason, /propagate/);
    });

    it('fails when a record exists but the token is wrong', async () => {
      const claim = await asPlatform(agent().post(`/tenants/${tenantId}/identity/domains`))
        .send({ domain: 'sso.example' })
        .expect(201);
      const view = claim.body as { id: string; recordName: string };

      dns.records.set(view.recordName, [['uboss-domain-verification=not-the-right-token']]);

      const verified = await asPlatform(
        agent().post(`/tenants/${tenantId}/identity/domains/${view.id}/verify`),
      ).expect(200);

      assert.equal((verified.body as { state: string }).state, 'Failed');
      assert.match(
        (verified.body as { failureReason: string }).failureReason,
        /none of its values/,
      );
    });

    it('joins the chunks of a long TXT record, as DNS splits them at 255 bytes', async () => {
      const claim = await asPlatform(agent().post(`/tenants/${tenantId}/identity/domains`))
        .send({ domain: 'sso.example' })
        .expect(201);
      const view = claim.body as { id: string; recordName: string; recordValue: string };

      // Split the expected value across two chunks, the way a resolver returns a long record.
      const midpoint = Math.floor(view.recordValue.length / 2);
      dns.records.set(view.recordName, [
        [view.recordValue.slice(0, midpoint), view.recordValue.slice(midpoint)],
      ]);

      const verified = await asPlatform(
        agent().post(`/tenants/${tenantId}/identity/domains/${view.id}/verify`),
      ).expect(200);

      assert.equal((verified.body as { state: string }).state, 'Verified');
    });

    it('lets only one company hold a verified claim on a domain', async () => {
      await verifyDomain(tenantId, 'contested.example');

      // The second company may claim it — blocking a pending claim would let the first company
      // to type a domain lock out its real owner.
      const secondClaim = await asPlatform(
        agent().post(`/tenants/${otherTenantId}/identity/domains`),
      )
        .send({ domain: 'contested.example' })
        .expect(201);

      const view = secondClaim.body as { id: string; recordName: string; recordValue: string };
      dns.records.set(view.recordName, [
        [view.recordValue],
        // The first company's record is still there too.
      ]);

      const attempted = await asPlatform(
        agent().post(`/tenants/${otherTenantId}/identity/domains/${view.id}/verify`),
      ).expect(200);

      assert.equal((attempted.body as { state: string }).state, 'Failed');
      assert.match(
        (attempted.body as { failureReason: string }).failureReason,
        /already verified this domain/i,
      );
    });

    it('rejects anything that is not a bare domain', async () => {
      for (const bad of [
        'https://example.com',
        'example.com/path',
        'example.com:8080',
        '*.example.com',
        'user@example.com',
        'localhost',
        '_underscore.example.com',
      ]) {
        await asPlatform(agent().post(`/tenants/${tenantId}/identity/domains`))
          .send({ domain: bad })
          .expect(400);
      }
    });

    it('does not create a membership, so a verified domain is not signup', async () => {
      await verifyDomain(tenantId, 'sso.example');

      const memberships = await ctx.admin.unsafeRootClient.tenantMembership.count({
        where: { tenantId },
      });
      assert.equal(memberships, 1, 'only the founder, who was provisioned explicitly');
    });

    it('removing a claim is recorded as a security-relevant loosening', async () => {
      const claim = await verifyDomain(tenantId, 'sso.example');

      await asPlatform(agent().delete(`/tenants/${tenantId}/identity/domains/${claim.id}`)).expect(
        204,
      );

      // ADR-045 (Prompt 8): `security.*` events now live in `security_events`, not in
      // `audit_events`. Only the destination changed — the events themselves are the same.
      const events = await ctx.admin.unsafeRootClient.securityEvent.findMany({
        where: { action: 'security.domain_claim_removed' },
      });
      assert.equal(events.length, 1);
      assert.equal((events[0]?.metadata as { wasVerified: boolean }).wasVerified, true);
    });
  });

  // =========================================================================
  describe('SCIM 2.0', () => {
    const createScimToken = async (id: string) => {
      const created = await asPlatform(agent().post(`/tenants/${id}/identity/scim-clients`))
        .send({ displayName: 'Okta' })
        .expect(201);
      return (created.body as { token: string }).token;
    };

    const scim = (token: string) => ({
      get: (path: string) => agent().get(`/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
      post: (path: string) =>
        agent().post(`/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
      put: (path: string) => agent().put(`/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
      patch: (path: string) =>
        agent().patch(`/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
      delete: (path: string) =>
        agent().delete(`/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
    });

    it('publishes discovery documents without a credential', async () => {
      const config = await agent().get('/scim/v2/ServiceProviderConfig').expect(200);
      const body = config.body as {
        schemas: string[];
        patch: { supported: boolean };
        bulk: { supported: boolean };
        sort: { supported: boolean };
      };

      assert.deepEqual(body.schemas, [
        'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
      ]);
      assert.equal(body.patch.supported, true);
      // Declared false rather than omitted, so a connector can plan around it.
      assert.equal(body.bulk.supported, false);
      assert.equal(body.sort.supported, false);

      await agent().get('/scim/v2/ResourceTypes').expect(200);
      await agent().get('/scim/v2/Schemas').expect(200);
    });

    it('refuses every resource endpoint without a valid token', async () => {
      const token = await createScimToken(tenantId);

      for (const path of ['/Users', '/Groups']) {
        await agent().get(`/scim/v2${path}`).expect(401);
        await agent().get(`/scim/v2${path}`).set('Authorization', 'Bearer nonsense').expect(401);
        await agent().get(`/scim/v2${path}`).set('Authorization', token).expect(401);
      }

      await scim(token).get('/Users').expect(200);
    });

    it('answers identically for a missing and an unknown token', async () => {
      const missing = await agent().get('/scim/v2/Users').expect(401);
      const unknown = await agent()
        .get('/scim/v2/Users')
        .set('Authorization', 'Bearer definitely-not-a-token')
        .expect(401);

      assert.deepEqual(missing.body, unknown.body);
    });

    it('refuses to provision an address whose domain the company has not verified', async () => {
      const token = await createScimToken(tenantId);

      const refused = await scim(token)
        .post('/Users')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'newhire@sso.example',
          displayName: 'New Hire',
          active: true,
        })
        .expect(400);

      assert.match((refused.body as { message: string }).message, /has not verified the domain/i);
    });

    it('provisions a member once the domain is verified', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      const created = await scim(token)
        .post('/Users')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'newhire@sso.example',
          externalId: 'okta-1234',
          name: { givenName: 'New', familyName: 'Hire' },
          active: true,
        })
        .expect(201);

      const user = created.body as {
        id: string;
        userName: string;
        active: boolean;
        externalId: string;
        meta: { resourceType: string; location: string };
      };

      assert.equal(user.userName, 'newhire@sso.example');
      assert.equal(user.active, true);
      assert.equal(user.externalId, 'okta-1234');
      assert.equal(user.meta.resourceType, 'User');
      assert.match(user.meta.location, /\/scim\/v2\/Users\//);

      const membership = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId, scimExternalId: 'okta-1234' },
      });
      assert.equal(membership?.accountState, 'Active');
      assert.equal(membership?.provisioningSource, 'Scim');
    });

    it('finds a provisioned user by an equality filter, as connectors do before creating', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      await scim(token)
        .post('/Users')
        .send({ userName: 'newhire@sso.example', active: true })
        .expect(201);

      const byUserName = await scim(token)
        .get('/Users?filter=userName%20eq%20%22newhire%40sso.example%22')
        .expect(200);

      const body = byUserName.body as {
        totalResults: number;
        startIndex: number;
        Resources: unknown[];
      };
      assert.equal(body.totalResults, 1);
      // SCIM pagination is 1-based, unlike almost everything else.
      assert.equal(body.startIndex, 1);
      assert.equal(body.Resources.length, 1);

      const missing = await scim(token)
        .get('/Users?filter=userName%20eq%20%22nobody%40sso.example%22')
        .expect(200);
      assert.equal((missing.body as { totalResults: number }).totalResults, 0);
    });

    it('refuses a filter it cannot evaluate, rather than answering as if unfiltered', async () => {
      const token = await createScimToken(tenantId);

      // Answering this as "no filter" would return every user, and the connector would read that
      // as "the address does not exist" and create a duplicate.
      const refused = await scim(token).get('/Users?filter=userName%20co%20%22sso%22').expect(400);

      assert.match((refused.body as { message: string }).message, /equality filters/i);
    });

    it('deprovisions with active:false and revokes every session immediately', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      const login = await signIn().expect(200);
      const session = cookieValue(login, 'uboss_session') as string;
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(200);

      await scim(token)
        .patch(`/Users/${memberUserId}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
        .expect(200);

      // The whole point: deprovisioning that leaves a live session is the failure this prevents.
      await agent().get('/auth/me').set('Cookie', `uboss_session=${session}`).expect(401);

      const membership = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId, userId: memberUserId },
      });
      assert.equal(membership?.accountState, 'Suspended');
    });

    it('accepts the pathless replace shape some connectors send', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      await scim(token)
        .patch(`/Users/${memberUserId}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', value: { active: false } }],
        })
        .expect(200);

      const membership = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId, userId: memberUserId },
      });
      assert.equal(membership?.accountState, 'Suspended');
    });

    it('refuses a PATCH it does not understand, rather than silently ignoring it', async () => {
      const token = await createScimToken(tenantId);

      // Silently ignoring a deprovisioning PATCH would leave a departed employee with access
      // while the connector reported success.
      await scim(token)
        .patch(`/Users/${memberUserId}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'x@y.z' }],
        })
        .expect(400);
    });

    it('offboards on DELETE and keeps the membership row', async () => {
      const token = await createScimToken(tenantId);

      await scim(token).delete(`/Users/${memberUserId}`).expect(204);

      const membership = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId, userId: memberUserId },
      });
      // Kept, not deleted: an identity provider that briefly loses sight of someone must not be
      // able to destroy the record of their employment.
      assert.ok(membership);
      assert.equal(membership?.accountState, 'Offboarded');
    });

    it('reactivates a suspended member when the identity provider pushes them again', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      await scim(token)
        .patch(`/Users/${memberUserId}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'active', value: false }],
        })
        .expect(200);

      const recreated = await scim(token)
        .post('/Users')
        .send({ userName: 'member@sso.example', active: true })
        .expect(201);

      assert.equal((recreated.body as { active: boolean }).active, true);
    });

    it('conflicts on an address that is already an active member', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const token = await createScimToken(tenantId);

      await scim(token)
        .post('/Users')
        .send({ userName: 'member@sso.example', active: true })
        .expect(409);
    });

    it('cannot see or touch another company, even by guessing an id', async () => {
      const token = await createScimToken(tenantId);
      const otherMember = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId: otherTenantId },
      });

      // The scope comes from the credential, so there is nothing in the request to tamper with.
      await scim(token).get(`/Users/${otherMember?.userId}`).expect(404);
      await scim(token).delete(`/Users/${otherMember?.userId}`).expect(404);

      const list = await scim(token).get('/Users').expect(200);
      const emails = JSON.stringify(list.body);
      assert.ok(!emails.includes('member@other.example'));
    });

    it('manages groups', async () => {
      const token = await createScimToken(tenantId);

      const created = await scim(token)
        .post('/Groups')
        .send({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
          displayName: 'Engineering',
          externalId: 'okta-group-1',
          members: [{ value: memberUserId }],
        })
        .expect(201);

      const group = created.body as {
        id: string;
        displayName: string;
        members: { value: string }[];
      };
      assert.equal(group.displayName, 'Engineering');
      assert.equal(group.members[0]?.value, memberUserId);

      const fetched = await scim(token).get(`/Groups/${group.id}`).expect(200);
      assert.equal((fetched.body as { members: unknown[] }).members.length, 1);

      // PATCH remove with a filtered path — the shape connectors actually send.
      await scim(token)
        .patch(`/Groups/${group.id}`)
        .send({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'remove', path: `members[value eq "${memberUserId}"]` }],
        })
        .expect(200);

      const emptied = await scim(token).get(`/Groups/${group.id}`).expect(200);
      assert.equal((emptied.body as { members: unknown[] }).members.length, 0);

      await scim(token).delete(`/Groups/${group.id}`).expect(204);
      await scim(token).get(`/Groups/${group.id}`).expect(404);
    });

    it('drops a group member who is not a member of this company', async () => {
      const token = await createScimToken(tenantId);
      const outsider = await ctx.admin.unsafeRootClient.tenantMembership.findFirst({
        where: { tenantId: otherTenantId },
      });

      const created = await scim(token)
        .post('/Groups')
        .send({
          displayName: 'Mixed',
          members: [{ value: memberUserId }, { value: outsider?.userId }],
        })
        .expect(201);

      const group = created.body as { id: string };
      const fetched = await scim(token).get(`/Groups/${group.id}`).expect(200);
      const members = (fetched.body as { members: { value: string }[] }).members;

      assert.equal(members.length, 1, 'the outsider was dropped, not added');
      assert.equal(members[0]?.value, memberUserId);
    });

    it('conflicts on a duplicate group name', async () => {
      const token = await createScimToken(tenantId);

      await scim(token).post('/Groups').send({ displayName: 'Sales' }).expect(201);
      await scim(token).post('/Groups').send({ displayName: 'Sales' }).expect(409);
    });

    it('returns the provisioning token exactly once, and stores only its hash', async () => {
      const created = await asPlatform(agent().post(`/tenants/${tenantId}/identity/scim-clients`))
        .send({ displayName: 'Okta' })
        .expect(201);

      const token = (created.body as { token: string }).token;

      const list = await asPlatform(
        agent().get(`/tenants/${tenantId}/identity/scim-clients`),
      ).expect(200);

      const serialised = JSON.stringify(list.body);
      assert.ok(!serialised.includes(token), 'the token is never returned again');
      assert.ok(!serialised.includes('tokenHash'));

      const stored = await ctx.admin.unsafeRootClient.scimClient.findFirst({ where: { tenantId } });
      assert.match(stored?.tokenHash ?? '', /^[0-9a-f]{64}$/);
      assert.ok(!(stored?.tokenHash ?? '').includes(token));
    });

    it('stops working once revoked', async () => {
      const token = await createScimToken(tenantId);
      await scim(token).get('/Users').expect(200);

      const list = await asPlatform(
        agent().get(`/tenants/${tenantId}/identity/scim-clients`),
      ).expect(200);
      const clientId = (list.body as { clients: { id: string }[] }).clients[0]?.id as string;

      await asPlatform(
        agent().delete(`/tenants/${tenantId}/identity/scim-clients/${clientId}`),
      ).expect(204);

      await scim(token).get('/Users').expect(401);
    });
  });

  // =========================================================================
  describe('the security trail', () => {
    it('records the enterprise-identity actions', async () => {
      await verifyDomain(tenantId, 'sso.example');
      idp.setProfile({ email: 'member@sso.example' });
      const connection = await createOidcConnection(tenantId);
      await setPolicy(tenantId, { requireMfa: false, requireSso: true });

      const start = await agent()
        .post('/auth/sso/start')
        .send({ connectionId: connection.id })
        .expect(200);
      const { code, state } = idp.authorize(
        (start.body as { authorizationUrl: string }).authorizationUrl,
      );
      await agent().get(`/auth/sso/callback?code=${code}&state=${state}`).expect(302);

      // ADR-045 (Prompt 8): `security.*` events now live in `security_events`, not in
      // `audit_events`. Only the destination changed — the events themselves are the same.
      const actions = (
        await ctx.admin.unsafeRootClient.securityEvent.findMany({ select: { action: true } })
      ).map((event) => event.action);

      for (const expected of [
        'security.domain_claim_created',
        'security.domain_verified',
        'security.sso_connection_created',
        'security.sso_connection_updated',
        'security.auth_policy_changed',
        'security.sso_login_started',
        'security.sso_login_succeeded',
      ]) {
        assert.ok(actions.includes(expected), `expected a ${expected} event`);
      }
    });

    it('contains no secret of any kind', async () => {
      await verifyDomain(tenantId, 'sso.example');
      const connection = await createOidcConnection(tenantId);
      void connection;
      const { secret } = await enrolForMember();
      const scimToken = await (async () => {
        const created = await asPlatform(agent().post(`/tenants/${tenantId}/identity/scim-clients`))
          .send({ displayName: 'Okta' })
          .expect(201);
        return (created.body as { token: string }).token;
      })();

      // Both trails, since Prompt 8: searching only `audit_events` would have stopped
      // covering the table the identity events actually land in (ADR-045). A "contains no
      // secrets" test that silently stops looking where the secrets would be is worse than none.
      const trail = JSON.stringify([
        await ctx.admin.unsafeRootClient.auditEvent.findMany({
          select: { action: true, summary: true, reason: true, metadata: true },
        }),
        await ctx.admin.unsafeRootClient.securityEvent.findMany({
          select: { action: true, reason: true, metadata: true },
        }),
      ]);

      assert.ok(!trail.includes(secret), 'no TOTP secret');
      assert.ok(!trail.includes(idp.clientSecret), 'no OIDC client secret');
      assert.ok(!trail.includes(scimToken), 'no SCIM token');
      assert.ok(!trail.includes(PASSWORD), 'no password');
      // A rotated secret is recorded as a boolean, never as a value.
      assert.ok(!/"clientSecret":"/.test(trail));
    });
  });
});
