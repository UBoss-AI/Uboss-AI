import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { AuthenticationPolicyService } from '../src/auth/authentication-policy.service.js';
import { MfaLoginService } from '../src/auth/mfa-login.service.js';
import { MfaService } from '../src/auth/mfa.service.js';
import { keyProviderFromEnv, SecretBox } from '../src/auth/secret-box.js';
import { OidcProvider } from '../src/auth/sso/oidc.provider.js';
import { SamlProvider } from '../src/auth/sso/saml.provider.js';
import { SsoService } from '../src/auth/sso/sso.service.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { EnterpriseIdentityRepository } from '../src/persistence/enterprise-identity.repository.js';
import { MfaRepository } from '../src/persistence/mfa.repository.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { InvitationController } from '../src/auth/invitation.controller.js';
import { InvitationService } from '../src/auth/invitation.service.js';
import { LoginService } from '../src/auth/login.service.js';
import { PasswordResetService } from '../src/auth/password-reset.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { SessionActorResolver } from '../src/auth/session-actor.resolver.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { InvitationRepository } from '../src/persistence/invitation.repository.js';
import { PasswordResetRepository } from '../src/persistence/password-reset.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';
import {
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

const GOOD_PASSWORD = 'a sufficiently long password';
const OTHER_PASSWORD = 'another sufficiently long one';

/**
 * Authentication and session integration tests.
 *
 * Run against real PostgreSQL and real Argon2id — not mocks. The properties being asserted here
 * (only hashes stored, single-use tokens, lockout, revocation) are properties of the *stored
 * data*, and a mock would happily agree with an implementation that stored plaintext.
 */
describe('authentication (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let tenantId: string;
  let inviteeUserId: string;
  let platformAdminUboss: string;

  const agent = () => request(app.getHttpServer());

  /** Issue an invitation and return its one-time token. */
  const issueInvitation = async (email = 'invitee@auth.example', displayName = 'Invitee') => {
    const response = await agent()
      .post('/invitations')
      .set('x-uboss-dev-actor', platformAdminUboss)
      .send({ tenantId, email, displayName })
      .expect(201);
    return response.body as { invitationId: string; activationToken: string; resent: boolean };
  };

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

    // The development header resolver is needed to act as the platform admin who issues
    // invitations; everything else in this suite authenticates with real sessions.
    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    // Generated per run, so nothing here could be mistaken for a production value.
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, InvitationController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        {
          // Prompt 6 made `LoginService` consult company policy before issuing a session, so
          // this suite now needs the MFA and policy collaborators too — with a real key, since
          // `SecretBox` refuses to start without one.
          provide: SecretBox,
          useFactory: () => new SecretBox(keyProviderFromEnv(process.env['AUTH_ENCRYPTION_KEYS'])),
        },
        MfaRepository,
        EnterpriseIdentityRepository,
        MfaService,
        MfaLoginService,
        AuthenticationPolicyService,
        // `AuthController` gained the SSO endpoints, so its collaborators have to be present
        // even for a suite that only exercises the password paths.
        OidcProvider,
        SamlProvider,
        SsoService,
        TenantMembershipRepository,
        UserRepository,
        UserCredentialRepository,
        InvitationRepository,
        PasswordResetRepository,
        SessionRepository,
        AuditEventRepository,
        PasswordService,
        AuditTrailRepository,
        SecurityEventService,
        SecurityEventPublisher,
        SessionService,
        SessionActorResolver,
        LoginService,
        InvitationService,
        PasswordResetService,
        TenantContextService,
        Reflector,
        {
          // Session first, development header behind it — the same composition the application
          // uses, so these tests exercise the real resolver ordering.
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
    // The same pipe the application installs, so DTO rejection is genuinely exercised rather
    // than assumed.
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
      slug: 'auth-co',
      name: 'Auth Co',
      firstMember: { email: 'founder@auth.example', displayName: 'Founder' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    // A second person, added but not yet invited — the state an invitation acts on.
    //
    // Since Prompt 13 they also need a **department, a reporting manager and a role** before
    // activation can complete: the client's rule is that a new internal employee has all three
    // before their account goes live, because an account that can sign in and reach nothing
    // looks like it works and does not. The fixture therefore builds the minimum real setup
    // rather than an account in a state no company would actually have.
    const invitee = await ctx.prisma.runAsPlatformOperation(async () => {
      const user = await ctx.users.createForPlatform({
        ubossUniqueId: 'UB-INVT-0001',
        email: 'invitee@auth.example',
        displayName: 'Invitee',
      });
      await ctx.prisma.client.tenantMembership.create({
        data: { tenantId: provisioned.tenant.id, userId: user.id },
      });

      const department = await ctx.prisma.client.department.create({
        data: { tenantId: provisioned.tenant.id, name: 'General', code: 'GEN' },
      });

      // The founder is the root of the reporting tree; the invitee reports to them.
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId: provisioned.tenant.id,
          userId: provisioned.user.id,
          employeeId: 'E-001',
          designation: 'Founder',
          departmentId: department.id,
        },
      });
      await ctx.prisma.client.employmentRecord.create({
        data: {
          tenantId: provisioned.tenant.id,
          userId: user.id,
          employeeId: 'E-002',
          designation: 'Associate',
          departmentId: department.id,
          reportingManagerUserId: provisioned.user.id,
        },
      });

      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: provisioned.tenant.id,
          userId: user.id,
          roleKind: 'Employee',
          scopeKind: 'OwnWork',
          bootstrap: true,
        },
      });

      return user;
    });
    inviteeUserId = invitee.id;

    const admin = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.users.createForPlatform({
        ubossUniqueId: 'UB-PLAT-0002',
        email: 'platform@auth.example',
        displayName: 'Platform Admin',
        isPlatformActor: true,
      }),
    );
    platformAdminUboss = admin.ubossUniqueId;
  });

  describe('invitation issue, resend and cancel', () => {
    it('starts a new membership at NotInvited', async () => {
      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.equal(membership?.accountState, 'NotInvited');
    });

    it('issues an invitation and moves the account to InvitePending', async () => {
      const issued = await issueInvitation();

      assert.ok(issued.activationToken.length > 20);
      assert.equal(issued.resent, false);

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.equal(membership?.accountState, 'InvitePending');
    });

    it('stores only the token hash, never the token', async () => {
      const issued = await issueInvitation();

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.ok(row);
      // sha256 hex, and provably not the token itself.
      assert.equal(row.tokenHash.length, 64);
      assert.notEqual(row.tokenHash, issued.activationToken);
      assert.ok(!JSON.stringify(row).includes(issued.activationToken));
    });

    it('rotates the token on resend, invalidating the previous link', async () => {
      const first = await issueInvitation();
      const second = await issueInvitation();

      assert.equal(second.resent, true);
      assert.notEqual(first.activationToken, second.activationToken);

      // The old link must no longer work — two valid links must never exist at once.
      await agent()
        .post('/auth/invitations/preview')
        .send({ token: first.activationToken })
        .expect(200)
        .expect((response) => assert.equal(response.body.valid, false));

      await agent()
        .post('/auth/invitations/preview')
        .send({ token: second.activationToken })
        .expect(200)
        .expect((response) => assert.equal(response.body.valid, true));
    });

    it('cancels an invitation and returns the account to NotInvited', async () => {
      const issued = await issueInvitation();

      await agent()
        .delete(`/invitations/${issued.invitationId}?tenantId=${tenantId}`)
        .set('x-uboss-dev-actor', platformAdminUboss)
        .expect(204);

      await agent()
        .post('/auth/invitations/preview')
        .send({ token: issued.activationToken })
        .expect(200)
        .expect((response) => assert.equal(response.body.valid, false));

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.equal(membership?.accountState, 'NotInvited');
    });

    it('refuses to invite someone with no membership — an invitation cannot create access', async () => {
      // This is the no-public-signup rule at the domain level.
      await agent()
        .post('/invitations')
        .set('x-uboss-dev-actor', platformAdminUboss)
        .send({ tenantId, email: 'stranger@nowhere.example', displayName: 'Stranger' })
        .expect(400);
    });

    it('refuses invitation management to a non-platform actor', async () => {
      await agent()
        .post('/invitations')
        .set('x-uboss-dev-actor', 'UB-INVT-0001')
        .send({ tenantId, email: 'invitee@auth.example', displayName: 'Invitee' })
        .expect(403);
    });

    it('answers identically for an invalid, expired and unknown token', async () => {
      const issued = await issueInvitation();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.invitation.updateMany({
          where: { userId: inviteeUserId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        }),
      );

      const expired = await agent()
        .post('/auth/invitations/preview')
        .send({ token: issued.activationToken })
        .expect(200);
      const unknown = await agent()
        .post('/auth/invitations/preview')
        .send({ token: 'completely-made-up-token' })
        .expect(200);

      assert.deepEqual(expired.body, unknown.body);
    });
  });

  describe('activation', () => {
    it('activates, sets the password and signs the person in', async () => {
      const issued = await issueInvitation();

      const response = await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      assert.equal(response.body.activated, true);
      assert.equal(response.body.activeWorkspaceId, tenantId);

      const cookies = response.headers['set-cookie'] as unknown as string[];
      assert.ok(cookies.some((cookie) => cookie.startsWith('uboss_session=')));

      const membership = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.equal(membership?.accountState, 'Active');
    });

    it('stores an Argon2id hash, never the password', async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      const credential = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.credentials.findByUserId(inviteeUserId),
      );

      assert.ok(credential);
      assert.match(credential.passwordHash, /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
      assert.ok(!credential.passwordHash.includes(GOOD_PASSWORD));
    });

    it('rejects a password below policy without consuming the invitation', async () => {
      const issued = await issueInvitation();

      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: 'short' })
        .expect(400);

      // The link must still work: a rejected password is the person's mistake, not a reason to
      // strand them.
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
    });

    it('cannot be replayed', async () => {
      const issued = await issueInvitation();

      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: OTHER_PASSWORD })
        .expect(401);
    });

    it('refuses to let a second company reset an existing UBoss password', async () => {
      // One person, one password across companies. A second company's invitation must not be
      // able to overwrite the credential the person uses everywhere.
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      const second = await ctx.provisioning.provision({
        slug: 'second-co',
        name: 'Second Co',
        firstMember: { email: 'other-founder@auth.example', displayName: 'Other Founder' },
      });
      await activateTenant(ctx, second.tenant.id);
      await ctx.prisma.runAsPlatformOperation(async () => {
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: second.tenant.id, userId: inviteeUserId },
        });

        // The second company needs its own department, reporting line and role for this person,
        // for the same Prompt 13 reason as the first: activation requires all three, and they
        // are per-company facts. Being set up in company A says nothing about company B.
        const department = await ctx.prisma.client.department.create({
          data: { tenantId: second.tenant.id, name: 'General', code: 'GEN' },
        });
        await ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId: second.tenant.id,
            userId: second.user.id,
            employeeId: 'S-001',
            designation: 'Other Founder',
            departmentId: department.id,
          },
        });
        await ctx.prisma.client.employmentRecord.create({
          data: {
            tenantId: second.tenant.id,
            userId: inviteeUserId,
            employeeId: 'S-002',
            designation: 'Consultant',
            departmentId: department.id,
            reportingManagerUserId: second.user.id,
          },
        });
        await ctx.prisma.client.roleAssignment.create({
          data: {
            tenantId: second.tenant.id,
            userId: inviteeUserId,
            roleKind: 'Employee',
            scopeKind: 'OwnWork',
            bootstrap: true,
          },
        });
      });

      const secondInvite = await agent()
        .post('/invitations')
        .set('x-uboss-dev-actor', platformAdminUboss)
        .send({
          tenantId: second.tenant.id,
          email: 'invitee@auth.example',
          displayName: 'Invitee',
        })
        .expect(201);

      // Supplying a password is refused...
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: secondInvite.body.activationToken, password: OTHER_PASSWORD })
        .expect(400);

      // ...but activating without one succeeds, joining the second company.
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: secondInvite.body.activationToken })
        .expect(200);

      // The original password still works.
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
    });

    it('signs in and sets an HttpOnly, SameSite cookie', async () => {
      const response = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);

      const cookie = (response.headers['set-cookie'] as unknown as string[]).find((value) =>
        value.startsWith('uboss_session='),
      );
      assert.ok(cookie);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.match(cookie, /Path=\//);
    });

    it('returns the workspaces the person may open', async () => {
      const response = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);

      assert.equal(response.body.workspaces.length, 1);
      assert.equal(response.body.workspaces[0].tenantId, tenantId);
    });

    it('gives the same answer for a wrong password and an unknown address', async () => {
      const wrongPassword = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: 'not the right one at all' })
        .expect(401);

      const unknownAccount = await agent()
        .post('/auth/login')
        .send({ email: 'nobody@auth.example', password: 'not the right one at all' })
        .expect(401);

      // Otherwise the endpoint is an account-existence oracle.
      assert.equal(wrongPassword.body.message, unknownAccount.body.message);
    });

    it('is case-insensitive on the email address', async () => {
      await agent()
        .post('/auth/login')
        .send({ email: 'INVITEE@AUTH.EXAMPLE', password: GOOD_PASSWORD })
        .expect(200);
    });

    it('rejects a body carrying an undeclared field', async () => {
      // forbidNonWhitelisted: a future handler cannot be fed a smuggled field.
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD, isPlatformActor: true })
        .expect(400);
    });
  });

  describe('lockout', () => {
    beforeEach(async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
    });

    it('locks the account after the configured number of failures', async () => {
      const config = loadAuthConfig();

      for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
        await agent()
          .post('/auth/login')
          .send({ email: 'invitee@auth.example', password: 'wrong password value' })
          .expect(401);
      }

      const locked = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: 'wrong password value' })
        .expect(401);

      assert.ok(locked.headers['retry-after'], 'a locked response must say when to retry');
      assert.match(locked.body.message, /temporarily locked/i);
    });

    it('refuses even the correct password while locked', async () => {
      const config = loadAuthConfig();
      for (let attempt = 0; attempt <= config.maxFailedAttempts; attempt += 1) {
        await agent()
          .post('/auth/login')
          .send({ email: 'invitee@auth.example', password: 'wrong password value' })
          .expect(401);
      }

      const response = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(401);

      assert.match(response.body.message, /temporarily locked/i);
    });

    it('clears the failure counter on a successful sign-in', async () => {
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: 'wrong password value' })
        .expect(401);

      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);

      const credential = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.credentials.findByUserId(inviteeUserId),
      );
      assert.equal(credential?.failedAttempts, 0);
      assert.equal(credential?.lockedUntil, null);
    });
  });

  describe('sessions', () => {
    let cookie: string;

    beforeEach(async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      const login = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);
      cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    });

    it('stores only the session token hash', async () => {
      const session = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.ok(session);
      assert.equal(session.tokenHash.length, 64);
      // The cookie value must not appear anywhere in the row.
      const tokenValue = cookie.split(';')[0]!.split('=')[1]!;
      assert.ok(!JSON.stringify(session).includes(tokenValue));
    });

    it('identifies the caller from the cookie', async () => {
      const response = await agent().get('/auth/me').set('Cookie', cookie).expect(200);
      assert.equal(response.body.user.ubossUniqueId, 'UB-INVT-0001');
      assert.equal(response.body.activeWorkspaceId, null);
    });

    it('refuses without a cookie', async () => {
      await agent().get('/auth/me').expect(401);
    });

    it('lists the caller’s sessions and marks the current one', async () => {
      const response = await agent().get('/auth/sessions').set('Cookie', cookie).expect(200);

      assert.equal(response.body.sessions.length, 2, 'activation plus login');
      assert.equal(
        response.body.sessions.filter((s: { isCurrent: boolean }) => s.isCurrent).length,
        1,
      );
    });

    it('never exposes a full client address', async () => {
      const response = await agent().get('/auth/sessions').set('Cookie', cookie).expect(200);
      for (const session of response.body.sessions) {
        if (session.clientHint) {
          assert.match(session.clientHint, /\/(16|48)$/, 'must be a truncated range');
        }
      }
    });

    it('logs out and invalidates the session', async () => {
      await agent().post('/auth/logout').set('Cookie', cookie).expect(204);
      await agent().get('/auth/me').set('Cookie', cookie).expect(401);
    });

    it('clears the cookie on logout even when the session has already gone', async () => {
      await agent().post('/auth/logout').set('Cookie', cookie).expect(204);

      const response = await agent().post('/auth/logout').set('Cookie', cookie).expect(204);
      const cleared = response.headers['set-cookie'] as unknown as string[] | undefined;
      assert.ok(cleared?.some((value) => value.startsWith('uboss_session=')));
    });

    it('logs out all devices while keeping the current session', async () => {
      const response = await agent().post('/auth/logout-all').set('Cookie', cookie).expect(200);

      assert.equal(response.body.keptCurrentSession, true);
      assert.ok(response.body.revoked >= 1);

      // Still signed in here, which is what "sign out my other devices" must mean.
      await agent().get('/auth/me').set('Cookie', cookie).expect(200);

      const remaining = await agent().get('/auth/sessions').set('Cookie', cookie).expect(200);
      assert.equal(remaining.body.sessions.length, 1);
    });

    it('revokes one of the caller’s own sessions', async () => {
      const listed = await agent().get('/auth/sessions').set('Cookie', cookie).expect(200);
      const other = listed.body.sessions.find((s: { isCurrent: boolean }) => !s.isCurrent);
      assert.ok(other);

      await agent().delete(`/auth/sessions/${other.id}`).set('Cookie', cookie).expect(204);

      const after = await agent().get('/auth/sessions').set('Cookie', cookie).expect(200);
      assert.equal(after.body.sessions.length, 1);
    });

    it('cannot revoke someone else’s session', async () => {
      // The founder's session id, obtained out of band — exactly the "guessing an id" case.
      const founder = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByEmailForPlatform('founder@auth.example'),
      );
      assert.ok(founder);
      const foreignSession = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.create({
          data: {
            userId: founder.id,
            tokenHash: 'a'.repeat(64),
            absoluteExpiresAt: new Date(Date.now() + 3_600_000),
          },
        }),
      );

      await agent().delete(`/auth/sessions/${foreignSession.id}`).set('Cookie', cookie).expect(403);

      const survivor = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findUnique({ where: { id: foreignSession.id } }),
      );
      assert.equal(survivor?.revokedAt, null, 'the other person’s session must survive');
    });

    it('rejects a session past its absolute expiry', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.updateMany({
          where: { userId: inviteeUserId },
          data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
        }),
      );

      await agent().get('/auth/me').set('Cookie', cookie).expect(401);
    });

    it('rejects a session that has been idle too long', async () => {
      const config = loadAuthConfig();
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.updateMany({
          where: { userId: inviteeUserId },
          data: {
            lastSeenAt: new Date(Date.now() - (config.idleTimeoutMinutes + 1) * 60 * 1000),
          },
        }),
      );

      await agent().get('/auth/me').set('Cookie', cookie).expect(401);
    });

    it('lets a platform administrator revoke any session', async () => {
      const session = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.ok(session);

      await agent()
        .delete(`/auth/admin/sessions/${session.id}`)
        .set('x-uboss-dev-actor', platformAdminUboss)
        .expect(204);

      const revoked = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findUnique({ where: { id: session.id } }),
      );
      assert.ok(revoked?.revokedAt);
      assert.equal(revoked.revokedReason, 'admin_revoke');
    });

    it('refuses administrative revoke to a company person', async () => {
      const session = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.session.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.ok(session);

      await agent().delete(`/auth/admin/sessions/${session.id}`).set('Cookie', cookie).expect(403);
    });
  });

  describe('password reset', () => {
    beforeEach(async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
    });

    it('answers identically for a known and an unknown address', async () => {
      const known = await agent()
        .post('/auth/password-reset/request')
        .send({ email: 'invitee@auth.example' })
        .expect(202);
      const unknown = await agent()
        .post('/auth/password-reset/request')
        .send({ email: 'nobody@auth.example' })
        .expect(202);

      assert.deepEqual(known.body, unknown.body);
    });

    it('never returns the token in the response', async () => {
      const response = await agent()
        .post('/auth/password-reset/request')
        .send({ email: 'invitee@auth.example' })
        .expect(202);

      assert.ok(!JSON.stringify(response.body).toLowerCase().includes('token'));
    });

    it('stores only the token hash', async () => {
      await agent()
        .post('/auth/password-reset/request')
        .send({ email: 'invitee@auth.example' })
        .expect(202);

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.passwordResetToken.findFirst({ where: { userId: inviteeUserId } }),
      );
      assert.equal(row?.tokenHash.length, 64);
    });

    it('resets the password, revokes every session and is single-use', async () => {
      const login = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;

      // A reset token only ever exists in the recipient's hands, so the test plants a known
      // hash — the same shape the service would have written.
      const { createHash, randomBytes } = await import('node:crypto');
      const plaintext = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(plaintext, 'utf8').digest('hex');

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.passwordResetToken.create({
          data: {
            userId: inviteeUserId,
            tokenHash,
            expiresAt: new Date(Date.now() + 600_000),
          },
        }),
      );

      const confirmed = await agent()
        .post('/auth/password-reset/confirm')
        .send({ token: plaintext, password: OTHER_PASSWORD })
        .expect(200);

      assert.equal(confirmed.body.reset, true);
      assert.ok(confirmed.body.sessionsRevoked >= 1);

      // Every session is gone — the point of a reset.
      await agent().get('/auth/me').set('Cookie', cookie).expect(401);

      // The old password no longer works; the new one does.
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(401);
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: OTHER_PASSWORD })
        .expect(200);

      // The link cannot be replayed.
      await agent()
        .post('/auth/password-reset/confirm')
        .send({ token: plaintext, password: 'yet another long password' })
        .expect(401);
    });

    it('rejects a password below policy without consuming the token', async () => {
      const { createHash, randomBytes } = await import('node:crypto');
      const plaintext = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(plaintext, 'utf8').digest('hex');

      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.passwordResetToken.create({
          data: { userId: inviteeUserId, tokenHash, expiresAt: new Date(Date.now() + 600_000) },
        }),
      );

      await agent()
        .post('/auth/password-reset/confirm')
        .send({ token: plaintext, password: 'tiny' })
        .expect(400);

      // Still usable, so a mistyped password does not strand the person.
      await agent()
        .post('/auth/password-reset/confirm')
        .send({ token: plaintext, password: OTHER_PASSWORD })
        .expect(200);
    });

    it('clears a lockout, so a locked-out person can recover', async () => {
      const config = loadAuthConfig();
      for (let attempt = 0; attempt <= config.maxFailedAttempts; attempt += 1) {
        await agent()
          .post('/auth/login')
          .send({ email: 'invitee@auth.example', password: 'wrong password value' })
          .expect(401);
      }

      const { createHash, randomBytes } = await import('node:crypto');
      const plaintext = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(plaintext, 'utf8').digest('hex');
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.passwordResetToken.create({
          data: { userId: inviteeUserId, tokenHash, expiresAt: new Date(Date.now() + 600_000) },
        }),
      );

      await agent()
        .post('/auth/password-reset/confirm')
        .send({ token: plaintext, password: OTHER_PASSWORD })
        .expect(200);

      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: OTHER_PASSWORD })
        .expect(200);
    });
  });

  describe('account states gate workspace access', () => {
    let cookie: string;

    beforeEach(async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
      const login = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);
      cookie = (login.headers['set-cookie'] as unknown as string[])[0]!;
    });

    const setAccountState = async (
      state: 'NotInvited' | 'InvitePending' | 'Active' | 'Suspended' | 'Offboarded',
    ) => {
      await ctx.admin.unsafeRootClient.tenantMembership.updateMany({
        where: { userId: inviteeUserId, tenantId },
        data: { accountState: state },
      });
    };

    it('lists the workspace while Active', async () => {
      const response = await agent().get('/auth/me').set('Cookie', cookie).expect(200);
      assert.equal(response.body.workspaces.length, 1);
    });

    for (const state of ['NotInvited', 'InvitePending', 'Suspended', 'Offboarded'] as const) {
      it(`hides the workspace while ${state}`, async () => {
        await setAccountState(state);

        const response = await agent().get('/auth/me').set('Cookie', cookie).expect(200);
        assert.equal(
          response.body.workspaces.length,
          0,
          `a ${state} account must not be offered the workspace`,
        );
      });
    }

    it('still authenticates the person even with no usable workspace', async () => {
      // Sign-in is person-level; workspace access is separate. Someone offboarded everywhere can
      // still sign in to manage their own sessions.
      await setAccountState('Offboarded');
      await agent().get('/auth/me').set('Cookie', cookie).expect(200);
    });
  });

  describe('security trail', () => {
    it('records the whole lifecycle with correlation ids and no secrets', async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);
      await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: 'wrong password value' })
        .expect(401);
      const login = await agent()
        .post('/auth/login')
        .send({ email: 'invitee@auth.example', password: GOOD_PASSWORD })
        .expect(200);
      await agent()
        .post('/auth/logout')
        .set('Cookie', (login.headers['set-cookie'] as unknown as string[])[0]!)
        .expect(204);

      // ADR-045 (Prompt 8): `security.*` events now live in `security_events`, not in
      // `audit_events`. Only the destination changed — the events themselves are the same.
      const events = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findMany({
          where: { action: { startsWith: 'security.' } },
        }),
      );

      const actions = new Set(events.map((event) => event.action));
      for (const expected of [
        'security.invitation_issued',
        'security.invitation_accepted',
        'security.login_failed',
        'security.login_succeeded',
        'security.logout',
      ]) {
        assert.ok(actions.has(expected), `expected a ${expected} event`);
      }

      // Every event carries the correlation id of the request that caused it.
      assert.ok(events.every((event) => event.correlationId !== null));

      // No secret material anywhere in the trail.
      const serialised = JSON.stringify(events, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      assert.ok(!serialised.includes(GOOD_PASSWORD));
      assert.ok(!serialised.includes(issued.activationToken));
      // The attempted email is deliberately not recorded on a failed sign-in.
      assert.ok(!serialised.includes('invitee@auth.example'));
    });

    it('records a lockout as suspicious activity', async () => {
      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      const config = loadAuthConfig();
      for (let attempt = 0; attempt <= config.maxFailedAttempts; attempt += 1) {
        await agent()
          .post('/auth/login')
          .send({ email: 'invitee@auth.example', password: 'wrong password value' })
          .expect(401);
      }

      const locked = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.securityEvent.findFirst({
          where: { action: 'security.account_locked' },
        }),
      );
      assert.ok(locked, 'a lockout must be recorded');
    });

    it('notifies a suspicious-activity subscriber', async () => {
      const publisher = app.get(SecurityEventPublisher);
      const seen: string[] = [];
      publisher.onSuspiciousActivity((event) => seen.push(event.action));

      const issued = await issueInvitation();
      await agent()
        .post('/auth/invitations/activate')
        .send({ token: issued.activationToken, password: GOOD_PASSWORD })
        .expect(200);

      // Activation signs in from a previously unseen location, which is the new-device hook.
      assert.ok(seen.includes('security.new_device_sign_in'), `saw ${JSON.stringify(seen)}`);
    });
  });
});
