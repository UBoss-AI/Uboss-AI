import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { MAX_DOMAIN_CHECKS, validateRegistrationAddress } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import {
  DNS_TXT_RESOLVER,
  DomainVerificationService,
  type DnsTxtResolver,
} from '../src/auth/domain-verification.service.js';
import { IdentityMailService } from '../src/auth/identity-mail.service.js';
import { InvitationService } from '../src/auth/invitation.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { SessionService } from '../src/auth/session.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { EmailAdapter, LoggingEmailAdapter } from '../src/notifications/email-adapter.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { EnterpriseIdentityRepository } from '../src/persistence/enterprise-identity.repository.js';
import { InvitationRepository } from '../src/persistence/invitation.repository.js';
import { OutboxRepository } from '../src/persistence/outbox.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { SessionRepository } from '../src/persistence/session.repository.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserCredentialRepository } from '../src/persistence/user-credential.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { CompanyProvisioningService } from '../src/provisioning/company-provisioning.service.js';
import { RegistrationController } from '../src/registration/registration.controller.js';
import { SelfServeRegistrationService } from '../src/registration/self-serve-registration.service.js';
import { UnfinishedSweepRunner } from '../src/billing/unfinished-sweep.runner.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard } from '../src/tenancy/tenant.guard.js';
import {
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/** The DNS the product reads, under this test's control. */
class StubDnsResolver implements DnsTxtResolver {
  readonly records = new Map<string, string[][]>();

  async resolveTxt(hostname: string): Promise<string[][]> {
    const found = this.records.get(hostname);
    if (!found) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return found;
  }
}

interface RegistrationBody {
  id: string;
  state: string;
  emailVerified: boolean;
  domainVerified: boolean;
  dns: { recordName: string; recordType: string; recordValue: string } | null;
  failureReason: string | null;
  tenantId: string | null;
}

/**
 * A company signing itself up.
 *
 * ## What these tests are mostly about
 *
 * Not the happy path — that is a handful. The rest are the four things a public, anonymous,
 * internet-facing endpoint must not be talked into: provisioning a plan nobody sold it, taking its
 * seats or allowance from the request, claiming a domain without proving it, and being used as a
 * machine for sending mail or making DNS lookups.
 *
 * Every one of those is a defect that would look exactly like an ordinary signup in the logs.
 *
 * ## Why through HTTP rather than against the service
 *
 * Because half of what is being asserted lives in the request layer: that these routes are
 * reachable with no account at all, that the body is validated, and above all that **there is no
 * field for the plan** — a caller cannot post one, which is a stronger guarantee than a service
 * that happens to ignore it.
 */
describe('a company signs itself up (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;
  let dns: StubDnsResolver;
  let mailbox: LoggingEmailAdapter;

  before(async () => {
    migrateTestDatabase();
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(reachabilityFailureReason());
    }

    dns = new StubDnsResolver();
    mailbox = new LoggingEmailAdapter();

    const moduleRef = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        { provide: DNS_TXT_RESOLVER, useValue: dns },
        // Records rather than sends, which is what a deployment with no SMTP gets — and it is how
        // this test reads the link the way the person does.
        { provide: EmailAdapter, useValue: mailbox },

        UserRepository,
        TenantRepository,
        TenantMembershipRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        EnterpriseIdentityRepository,
        PlatformRepository,
        OutboxRepository,
        InvitationRepository,
        UserCredentialRepository,
        SessionRepository,

        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        PasswordService,
        SessionService,
        InvitationService,
        IdentityMailService,
        DomainVerificationService,
        AuthorizationService,
        CompanyProvisioningService,
        SelfServeRegistrationService,
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
        // The real guards. A registration route reaching a handler with nobody signed in is one
        // of the things being asserted, not something being arranged around.
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
    dns.records.clear();
    mailbox.sent.length = 0;

    /*
     * The plan a signup is allowed to have, and nothing else.
     *
     * Upserted rather than created: `plans` is platform catalogue data and survives the reset
     * between tests, so a bare create collides with the seeded row on the second test. Pinning
     * the three fields that matter — one seat, no allowance, active — means these tests assert
     * what the plan says rather than inheriting whatever the seed happens to hold today.
     */
    await ctx.admin.client.plan.upsert({
      where: { code: 'pilot' },
      create: {
        code: 'pilot',
        tier: 'Pilot',
        name: 'Pilot',
        seatLimit: 1,
        aiAllowanceMinor: 0,
        priceMinor: 0,
        currency: 'USD',
        entitledModules: ['dashboard', 'hierarchy', 'objective', 'todo', 'settings'],
      },
      update: { seatLimit: 1, aiAllowanceMinor: 0, active: true },
    });
  });

  // -------------------------------------------------------------------------
  // Helpers that do what the person does
  // -------------------------------------------------------------------------

  const postForm = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/register').send(body);

  const signUp = async (
    overrides: Partial<Record<'workEmail' | 'fullName' | 'companyName' | 'domain', string>> = {},
  ): Promise<{ id: string; token: string }> => {
    const domain = overrides.domain ?? `aarohan-${Date.now().toString(36)}.co.in`;
    const response = await postForm({
      workEmail: overrides.workEmail ?? `aditi@${domain}`,
      fullName: overrides.fullName ?? 'Aditi Sharma',
      companyName: overrides.companyName ?? 'Aarohan Medicare',
      domain,
    }).expect(201);

    // The link is the only way back in, so the test recovers it from the mail.
    const sent = mailbox.sent.find((email) => email.reference === 'registration-confirmation');
    const raw = /token=([^&\s]+)/.exec(sent?.text ?? '')?.[1] ?? '';
    return { id: response.body.id as string, token: decodeURIComponent(raw) };
  };

  const confirm = (id: string, token: string) =>
    request(app.getHttpServer()).post(`/register/${id}/confirm?token=${encodeURIComponent(token)}`);

  const checkDomain = (id: string, token: string) =>
    request(app.getHttpServer()).post(
      `/register/${id}/domain-check?token=${encodeURIComponent(token)}`,
    );

  const status = (id: string, token: string) =>
    request(app.getHttpServer()).get(`/register/${id}?token=${encodeURIComponent(token)}`);

  const publish = (body: RegistrationBody): void => {
    assert.ok(body.dns, 'the DNS record must be known before it can be published');
    dns.records.set(body.dns.recordName, [[body.dns.recordValue]]);
  };

  // -------------------------------------------------------------------------
  // 1. The way through
  // -------------------------------------------------------------------------

  describe('the way through', () => {
    it('is reachable with no account at all', async () => {
      // No actor header anywhere in this file. A signup has no account by definition, and a guard
      // that refused it would make the whole feature unreachable.
      const { id } = await signUp();
      assert.ok(id);
    });

    it('creates nothing until both proofs are in, then creates the company', async () => {
      const { id, token } = await signUp();

      /*
       * After the form: no company. This is the assertion the design exists for.
       *
       * Creating the tenant first and filling it in would leave one of these for every abandoned
       * form — an empty company with a half-finished administrator, counted as a customer by
       * everything that counts customers.
       */
      assert.equal(await ctx.admin.client.tenant.count(), 0);

      const afterEmail = (await confirm(id, token).expect(201)).body as RegistrationBody;
      assert.equal(afterEmail.state, 'AwaitingDomain');
      assert.equal(afterEmail.emailVerified, true);
      assert.equal(afterEmail.domainVerified, false);
      // Still nothing: one proof is not two.
      assert.equal(await ctx.admin.client.tenant.count(), 0);

      publish(afterEmail);
      const done = (await checkDomain(id, token).expect(201)).body as RegistrationBody;

      assert.equal(done.state, 'Completed');
      assert.equal(done.domainVerified, true);
      assert.notEqual(done.tenantId, null);
      assert.equal(await ctx.admin.client.tenant.count(), 1);
    });

    it('lands the company on Pilot, with the plan’s own seats and allowance', async () => {
      const { id, token } = await signUp();
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);
      const done = (await checkDomain(id, token)).body as RegistrationBody;

      const subscription = await ctx.admin.client.tenantSubscription.findUnique({
        where: { tenantId: done.tenantId ?? '' },
        include: { plan: true },
      });

      assert.equal(subscription?.plan.code, 'pilot');
      // One seat and no AI, read from the plan row rather than from anything a caller sent.
      assert.equal(subscription?.seatsLicensed, 1);
      assert.equal(subscription?.aiAllowanceMinor, 0);
    });

    it('records the proved domain against the new company, so it is not asked twice', async () => {
      const { id, token } = await signUp({
        domain: 'spm-medicare.co.in',
        workEmail: 'aditi@spm-medicare.co.in',
      });
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);
      const done = (await checkDomain(id, token)).body as RegistrationBody;

      const claim = await ctx.admin.client.domainVerification.findFirst({
        where: { tenantId: done.tenantId ?? '' },
      });
      assert.equal(claim?.domain, 'spm-medicare.co.in');
      // Verified, because it was — minutes ago, against this token. Without the row the company
      // would be asked to prove a domain it has just proved, and the platform-wide exclusivity
      // index would not be holding it for them meanwhile.
      assert.equal(claim?.state, 'Verified');
    });

    it('bills an Indian company in rupees, from the domain’s own suffix', async () => {
      // The form asks four questions and none is a country. Defaulting everybody to dollars would
      // price an Indian customer in dollars because nobody asked.
      const { id, token } = await signUp({
        domain: 'aarohan-rupees.co.in',
        workEmail: 'aditi@aarohan-rupees.co.in',
      });
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);
      const done = (await checkDomain(id, token)).body as RegistrationBody;

      const tenant = await ctx.admin.client.tenant.findUnique({
        where: { id: done.tenantId ?? '' },
      });
      assert.equal(tenant?.currency, 'INR');
      assert.equal(tenant?.countryRegion, 'IN');
    });

    it('creates no example data, because a Pilot could not run any of it', async () => {
      const { id, token } = await signUp();
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);
      const done = (await checkDomain(id, token)).body as RegistrationBody;
      const tenantId = done.tenantId ?? '';

      /*
       * Nothing seeded, deliberately.
       *
       * A Pilot has no AI allowance, so example work could not actually run — it would have to be
       * simulated, which is the one thing this product must never show. The setup checklist is
       * what the workspace opens on instead, and that is real work rather than a demonstration.
       */
      assert.equal(await ctx.admin.client.objective.count({ where: { tenantId } }), 0);
      assert.ok(
        (await ctx.admin.client.companySetupTask.count({ where: { tenantId } })) > 0,
        'the setup checklist is what a new workspace has instead',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. The plan cannot come from the caller
  // -------------------------------------------------------------------------

  describe('what the request cannot decide', () => {
    it('has no field for a plan, so a caller cannot ask for one', async () => {
      const domain = `greedy-${Date.now().toString(36)}.co.in`;
      // `forbidNonWhitelisted` is what turns this into a 400 rather than a silently ignored
      // field. A caller must not be able to post `plan: growth` and have it be merely overlooked:
      // the day somebody adds a `plan` field for an unrelated reason, the overlooking stops.
      const response = await postForm({
        workEmail: `aditi@${domain}`,
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain,
        plan: 'growth',
        planCode: 'growth',
        seats: 40,
        aiAllowanceMinor: 5_000_000,
      }).expect(400);

      assert.match(JSON.stringify(response.body), /plan|seats|aiAllowanceMinor/);
      assert.equal(await ctx.admin.client.pendingRegistration.count(), 0);
    });

    it('refuses a form missing any of its four fields', async () => {
      await postForm({ workEmail: 'aditi@aarohan.co.in' }).expect(400);
      await postForm({}).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // 3. The domain cannot be claimed without proof
  // -------------------------------------------------------------------------

  describe('the domain', () => {
    it('creates no company while the DNS record is missing', async () => {
      const { id, token } = await signUp();
      await confirm(id, token);

      const body = (await checkDomain(id, token).expect(201)).body as RegistrationBody;
      assert.equal(body.state, 'AwaitingDomain');
      assert.equal(body.tenantId, null);
      assert.match(body.failureReason ?? '', /No TXT record was found/i);
      assert.equal(await ctx.admin.client.tenant.count(), 0);
    });

    it('creates no company for a record carrying somebody else’s token', async () => {
      const { id, token } = await signUp();
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;

      assert.ok(afterEmail.dns);
      dns.records.set(afterEmail.dns.recordName, [
        ['uboss-domain-verification=a-token-from-another-signup'],
      ]);

      const body = (await checkDomain(id, token)).body as RegistrationBody;
      assert.equal(body.tenantId, null);
      assert.match(body.failureReason ?? '', /none of its values match/i);
      assert.equal(await ctx.admin.client.tenant.count(), 0);
    });

    it('refuses a domain another company has already proved', async () => {
      const first = await signUp({
        domain: 'taken-domain.co.in',
        workEmail: 'aditi@taken-domain.co.in',
      });
      const afterEmail = (await confirm(first.id, first.token)).body as RegistrationBody;
      publish(afterEmail);
      await checkDomain(first.id, first.token);

      /*
       * Refused at the form, not at the DNS step.
       *
       * The DNS step would refuse it too — the unique index on verified domains is platform-wide
       * — but the person would have spent a day on a record they could never win with. The
       * message does not name the company that holds it: that would make this a way of asking who
       * UBoss's customers are.
       */
      const response = await postForm({
        workEmail: 'rohit@taken-domain.co.in',
        fullName: 'Rohit Verma',
        companyName: 'Someone Else',
        domain: 'taken-domain.co.in',
      }).expect(409);

      assert.match(response.body.message, /already set up on UBoss/i);
      assert.doesNotMatch(response.body.message, /Aarohan/i);
    });

    it('will not look for the record before the address is proved', async () => {
      const { id, token } = await signUp();
      // Otherwise this endpoint is a way to make the product run DNS lookups for any domain, from
      // an address nobody has confirmed.
      const response = await checkDomain(id, token).expect(409);
      assert.match(response.body.message, /Confirm your email/i);
    });

    it('does not hand out the DNS token until the address is proved', async () => {
      const { id, token } = await signUp();
      const body = (await status(id, token).expect(200)).body as RegistrationBody;
      // The token is what a lookup is made against, so a signup nobody confirmed never learns it.
      assert.equal(body.dns, null);
    });

    it('stops looking after a bounded number of attempts', async () => {
      const { id, token } = await signUp();
      await confirm(id, token);

      await ctx.admin.client.pendingRegistration.update({
        where: { id },
        data: { domainChecks: MAX_DOMAIN_CHECKS },
      });

      // Each check is a network call this product makes because an anonymous caller asked.
      const response = await checkDomain(id, token).expect(409);
      assert.match(response.body.message, /as many times as it can/i);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The token is the only way in
  // -------------------------------------------------------------------------

  describe('reaching a signup', () => {
    it('refuses the id without the token', async () => {
      const { id } = await signUp();
      // The id appears in a URL and is not a secret. Without this, anybody who saw one could
      // finish somebody else's signup.
      await status(id, '').expect(404);
      await confirm(id, 'guessed').expect(404);
    });

    it('answers the same for an unknown id, a wrong token and an expired one', async () => {
      const { id, token } = await signUp();
      await ctx.admin.client.pendingRegistration.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const messages = [
        (await status('01a00000-0000-7000-8000-000000000000', token).expect(404)).body.message,
        (await status(id, 'the-wrong-token').expect(404)).body.message,
        (await status(id, token).expect(404)).body.message,
      ];

      // One message for all three. They are the same thing to whoever is guessing, and telling
      // them apart tells them which half they got right.
      assert.equal(new Set(messages).size, 1);
    });

    it('is idempotent when the confirmation link is opened twice', async () => {
      const { id, token } = await signUp();
      const first = (await confirm(id, token).expect(201)).body as RegistrationBody;
      const second = (await confirm(id, token).expect(201)).body as RegistrationBody;

      // A mail client pre-fetching the link must not tell somebody their own signup is broken.
      assert.equal(first.state, 'AwaitingDomain');
      assert.equal(second.state, 'AwaitingDomain');
    });

    it('creates one company however many times the domain check is repeated', async () => {
      const { id, token } = await signUp();
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);

      await checkDomain(id, token);
      await checkDomain(id, token);
      await checkDomain(id, token);

      assert.equal(await ctx.admin.client.tenant.count(), 1);
    });
  });

  // -------------------------------------------------------------------------
  // 5. What the form will not accept
  // -------------------------------------------------------------------------

  describe('the form', () => {
    it('refuses a free mail provider, because nobody can prove control of it', async () => {
      const response = await postForm({
        workEmail: 'aditi@gmail.com',
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain: 'gmail.com',
      }).expect(400);

      assert.match(response.body.message, /work address/i);
    });

    it('refuses an address at a different domain from the one being claimed', async () => {
      // Otherwise somebody signs up with their own address and claims a domain they administer but
      // do not work at — or, far more often, mistypes one of the two.
      const response = await postForm({
        workEmail: 'aditi@aarohan.co.in',
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain: 'spm-medicare.co.in',
      }).expect(400);

      assert.match(response.body.message, /have to be the same/i);
    });

    it('refuses a second open signup for the same address', async () => {
      const domain = `repeat-${Date.now().toString(36)}.co.in`;
      const body = {
        workEmail: `aditi@${domain}`,
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain,
      };

      await postForm(body).expect(201);
      const second = await postForm(body).expect(409);
      assert.match(second.body.message, /already a signup open for this address/i);
    });

    it('refuses a fourth open signup for the same domain', async () => {
      const domain = `crowded-${Date.now().toString(36)}.co.in`;

      for (const who of ['aditi', 'rohit', 'priya']) {
        await postForm({
          workEmail: `${who}@${domain}`,
          fullName: 'Somebody',
          companyName: 'Aarohan',
          domain,
        }).expect(201);
      }

      // Each signup sends mail. Three people at one company starting one is ordinary; a fourth is
      // a loop, or somebody using a real domain to make this product send messages.
      const fourth = await postForm({
        workEmail: `vikram@${domain}`,
        fullName: 'Somebody',
        companyName: 'Aarohan',
        domain,
      }).expect(409);
      assert.match(fourth.body.message, /signups open for/i);
    });

    it('says nothing in its answer beyond the id', async () => {
      const domain = `quiet-${Date.now().toString(36)}.co.in`;
      const response = await postForm({
        workEmail: `aditi@${domain}`,
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain,
      }).expect(201);

      // No token, and nothing about whether the address was already known. A different answer for
      // a known address would make this a way of asking who works where.
      assert.deepEqual(Object.keys(response.body), ['id']);
    });
  });

  // -------------------------------------------------------------------------
  // 5b. Closing out what nobody finished
  // -------------------------------------------------------------------------

  describe('a signup nobody finished', () => {
    it('lapses once its window passes, and stops blocking a fresh one', async () => {
      const domain = `lapsed-${Date.now().toString(36)}.co.in`;
      const body = {
        workEmail: `aditi@${domain}`,
        fullName: 'Aditi Sharma',
        companyName: 'Aarohan',
        domain,
      };

      const first = await postForm(body).expect(201);

      // A second is refused while the first is open — which is the point of the limit.
      await postForm(body).expect(409);

      await ctx.admin.client.pendingRegistration.update({
        where: { id: first.body.id as string },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const swept = await new UnfinishedSweepRunner(ctx.prisma).sweep();
      assert.equal(swept.registrations, 1);

      const lapsed = await ctx.admin.client.pendingRegistration.findUnique({
        where: { id: first.body.id as string },
      });
      assert.equal(lapsed?.state, 'Abandoned');
      assert.match(lapsed?.failureReason ?? '', /Not completed in time/i);

      /*
       * And the same person can start again.
       *
       * This is why the sweep matters, and it is not about storage: a stale row is what refuses a
       * second signup, so somebody who gave up in March could not try again in June. The limit was
       * doing its job against a registration that had no chance of being completed.
       */
      await postForm(body).expect(201);
    });

    it('leaves a completed signup alone', async () => {
      const { id, token } = await signUp();
      const afterEmail = (await confirm(id, token)).body as RegistrationBody;
      publish(afterEmail);
      await checkDomain(id, token);

      // Even with the window long past: a completed signup is the record of where a real company
      // came from, and marking it Abandoned would say something false about a live customer.
      await ctx.admin.client.pendingRegistration.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const swept = await new UnfinishedSweepRunner(ctx.prisma).sweep();
      assert.equal(swept.registrations, 0);

      const row = await ctx.admin.client.pendingRegistration.findUnique({ where: { id } });
      assert.equal(row?.state, 'Completed');
    });
  });

  // -------------------------------------------------------------------------
  // 6. The rule in the shared types
  // -------------------------------------------------------------------------

  describe('the address rule', () => {
    it('accepts a work address at the claimed domain', () => {
      assert.equal(validateRegistrationAddress('aditi@aarohan.co.in', 'aarohan.co.in').ok, true);
    });

    it('refuses something that is not an address at all', () => {
      assert.equal(validateRegistrationAddress('aditi', 'aarohan.co.in').ok, false);
      assert.equal(validateRegistrationAddress('aditi@', 'aarohan.co.in').ok, false);
    });
  });
});
