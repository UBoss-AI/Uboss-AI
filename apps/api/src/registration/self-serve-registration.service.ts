import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_DOMAIN_CHECKS,
  REGISTRATION_WINDOW_DAYS,
  currencyForCountry,
  likelyCountryFromDomain,
  validateRegistrationAddress,
} from '@uboss/types';

import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { DomainVerificationService, normaliseDomain } from '../auth/domain-verification.service.js';
import { IdentityMailService } from '../auth/identity-mail.service.js';
import { createOneTimeToken, hashToken, clientHintFrom } from '../auth/one-time-token.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { CompanyProvisioningService } from '../provisioning/company-provisioning.service.js';
import { randomBytes } from 'node:crypto';

/**
 * The plan a signup gets, and it is not negotiable here.
 *
 * A constant in this file rather than a parameter anywhere, because the request body must never
 * be able to influence it. A public endpoint that read a plan code from its caller would let
 * anybody post `"plan": "growth"` and provision themselves forty seats and a month's AI
 * allowance — and it would look exactly like a legitimate signup in every log.
 */
const SELF_SERVE_PLAN_CODE = 'pilot';

/**
 * How many signups one domain may have open at once.
 *
 * Two people at the same company starting one on the same afternoon is ordinary, and the third is
 * usually the first person trying again. Beyond that it is either a loop or somebody using a real
 * domain to make this product send mail.
 */
const MAX_OPEN_PER_DOMAIN = 3;

/** One address gets one open signup. A second is the same person pressing the button twice. */
const MAX_OPEN_PER_EMAIL = 1;

/**
 * The backstop: new signups accepted across the whole platform in an hour.
 *
 * The per-domain and per-email limits protect each target, and somebody varying both walks past
 * them — so this is the ceiling that stops a spread flood. Set well above any plausible real
 * day, because the cost of it being hit by genuine traffic is signups refused, and the cost of it
 * not existing is this product's mail domain being used to send a thousand messages.
 */
const MAX_NEW_PER_HOUR = 200;

export interface RegistrationView {
  id: string;
  state: string;
  companyName: string;
  domain: string;
  emailVerified: boolean;
  domainVerified: boolean;
  /** The DNS record to publish. Present once the address is proved and not before. */
  dns: { recordName: string; recordType: 'TXT'; recordValue: string } | null;
  /** Why the last domain check did not pass, in words the reader can act on. */
  failureReason: string | null;
  expiresAt: string;
  /** Set once the company exists. The signal to send the browser to the workspace. */
  tenantId: string | null;
}

/**
 * A company signing itself up.
 *
 * ## The one rule: the company is created last
 *
 * Two proofs come first — the person reads mail at the address, and the company controls the
 * domain — and the tenant row is written only after both. Creating it first and filling it in,
 * which is the obvious order, leaves an empty company for every abandoned form: a half-finished
 * administrator in a database where a company is the unit everything else counts by, and rows
 * nobody dares delete because nobody is certain they are safe to.
 *
 * ## The four things this endpoint must not be talked into
 *
 * It is reachable by anybody on the internet, so each is enforced here rather than trusted:
 *
 * **The plan.** Fixed to Pilot by {@link SELF_SERVE_PLAN_CODE}, never read from the request. A
 * caller posting a plan code would otherwise provision themselves a paid tier.
 *
 * **The seats and the allowance.** Read from the plan row, never from the request. Pilot is one
 * seat and no AI allowance, and that is what the plan says rather than what the caller asks for.
 *
 * **The domain.** Proved by DNS before anything is created, and checked against every company
 * that already proved it. A domain is how this product decides which company a person belongs
 * to; a signup that could claim one without proof could claim an existing customer's staff.
 *
 * **The volume.** Each signup sends mail and makes DNS calls on an anonymous caller's say-so, so
 * it is bounded per domain, per address, and across the platform. The generic rate limiter cannot
 * do this — it keys on identity, and deliberately treats anonymous traffic as the proxy's problem.
 */
@Injectable()
export class SelfServeRegistrationService {
  private readonly logger = new Logger(SelfServeRegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly domains: DomainVerificationService,
    private readonly provisioning: CompanyProvisioningService,
    private readonly mail: IdentityMailService,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly authConfig: AuthConfig,
  ) {}

  /**
   * Submit the form.
   *
   * ## Why the answer is the same whatever happens
   *
   * It returns the registration's id and nothing else — no token, and no hint about whether the
   * address was already used. A different answer for an address that exists would make this
   * endpoint a way of asking "does this person work at this company", which is a question an
   * anonymous caller should not be able to put to a product that knows.
   *
   * The id alone reaches nothing: every step after this needs the token that went to the inbox.
   */
  async start(input: {
    workEmail: string;
    fullName: string;
    companyName: string;
    domain: string;
    countryRegion?: string | undefined;
    clientAddress?: string | undefined;
  }): Promise<{ id: string }> {
    const workEmail = input.workEmail.trim().toLowerCase();
    const domain = normaliseDomain(input.domain);

    const address = validateRegistrationAddress(workEmail, domain);
    if (!address.ok) throw new BadRequestException(address.reason);

    /*
     * A domain somebody has already proved belongs to them.
     *
     * Refused here rather than at the DNS step, because the DNS step would refuse it too — the
     * unique index on verified domains is platform-wide — and the person would have spent a day
     * on a record they could never win with. The message does not say which company holds it:
     * that would turn this into a way of asking who UBoss's customers are.
     */
    const alreadyVerified = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.domainVerification.findFirst({
        where: { domain, state: 'Verified' },
        select: { id: true },
      }),
    );
    if (alreadyVerified !== null) {
      throw new ConflictException(
        `${domain} is already set up on UBoss. Ask whoever administers it at your company to ` +
          'invite you, rather than starting a second workspace for the same domain.',
      );
    }

    await this.refuseIfTooMany(workEmail, domain);

    const emailToken = createOneTimeToken();
    // Not hashed: the company publishes this in DNS, where the whole world can read it. Hashing a
    // value whose purpose is to be public would only stop this product from checking it.
    const domainToken = randomBytes(24).toString('base64url');
    const hint = clientHintFrom(input.clientAddress);

    const created = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.pendingRegistration.create({
        data: {
          workEmail,
          fullName: input.fullName.trim(),
          companyName: input.companyName.trim(),
          domain,
          emailTokenHash: emailToken.hash,
          domainToken,
          state: 'AwaitingEmail',
          expiresAt: new Date(Date.now() + REGISTRATION_WINDOW_DAYS * 86_400_000),
          ...(hint === undefined ? {} : { createdFromHint: hint }),
        },
      }),
    );

    await this.mail.sendRegistrationConfirmation({
      to: workEmail,
      token: emailToken.plaintext,
      registrationId: created.id,
      fullName: created.fullName,
      companyName: created.companyName,
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.invitationIssued,
      resourceType: 'pending_registration',
      resourceId: created.id,
      summary: `A self-serve signup was started for ${domain}.`,
      metadata: { domain, state: 'AwaitingEmail' },
    });

    this.logger.log(`A self-serve signup was started for ${domain}.`);
    return { id: created.id };
  }

  /**
   * The link from the inbox was opened: the address is proved.
   *
   * Returns the DNS record to publish, which is the first moment it is shown — a signup that
   * never confirmed its address never learns the token, so it cannot be used to make this product
   * run DNS lookups.
   */
  async confirmEmail(id: string, token: string): Promise<RegistrationView> {
    const row = await this.require(id, token);

    if (row.emailVerifiedAt !== null) {
      // Idempotent: somebody clicking the link twice, or a mail client pre-fetching it, must not
      // be told their own signup is broken.
      return this.view(row);
    }

    const updated = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.pendingRegistration.update({
        where: { id: row.id },
        data: { emailVerifiedAt: new Date(), state: 'AwaitingDomain' },
      }),
    );

    this.logger.log(`A self-serve signup proved its address for ${row.domain}.`);
    return this.view(updated);
  }

  /**
   * Look for the DNS record, and create the company when it is there.
   *
   * Bounded by {@link MAX_DOMAIN_CHECKS}: each call is a network request this product makes
   * because an anonymous caller asked. Generous, because the honest case is somebody pressing the
   * button every few minutes while a record propagates, and they should not be locked out of
   * their own signup for being eager.
   */
  async checkDomain(id: string, token: string): Promise<RegistrationView> {
    const row = await this.require(id, token);

    if (row.tenantId !== null) return this.view(row);

    if (row.emailVerifiedAt === null) {
      throw new ConflictException(
        'Confirm your email address first — the link we sent you. The DNS step comes after.',
      );
    }

    if (row.domainChecks >= MAX_DOMAIN_CHECKS) {
      throw new ConflictException(
        'This signup has checked for the DNS record as many times as it can. Start a new one, ' +
          'which gives you a fresh token, once the record is actually published.',
      );
    }

    const proof = await this.domains.proveControlOf(row.domain, row.domainToken);

    if (!proof.proved) {
      const failed = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.pendingRegistration.update({
          where: { id: row.id },
          data: { domainChecks: { increment: 1 }, failureReason: proof.reason },
        }),
      );
      return this.view(failed);
    }

    const ready = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.pendingRegistration.update({
        where: { id: row.id },
        data: {
          domainChecks: { increment: 1 },
          domainVerifiedAt: new Date(),
          state: 'Ready',
          failureReason: null,
        },
      }),
    );

    return this.view(await this.createTheCompany(ready));
  }

  /** Where this signup has got to. Needs the token, like everything else after the form. */
  async status(id: string, token: string): Promise<RegistrationView> {
    return this.view(await this.require(id, token));
  }

  // -------------------------------------------------------------------------
  // Creating the company — the last step, and only after both proofs
  // -------------------------------------------------------------------------

  private async createTheCompany(row: {
    id: string;
    workEmail: string;
    fullName: string;
    companyName: string;
    domain: string;
    domainVerifiedAt: Date | null;
    emailVerifiedAt: Date | null;
    tenantId: string | null;
  }): Promise<Awaited<ReturnType<SelfServeRegistrationService['require']>>> {
    /*
     * Both proofs, asserted again at the point of creation.
     *
     * They were checked by the callers that got here, and they are checked again because this is
     * the method that writes a company. A guard that lives only in the caller is a guard that
     * disappears the day somebody adds a second caller.
     */
    if (row.emailVerifiedAt === null || row.domainVerifiedAt === null) {
      throw new ConflictException(
        'A company is only created once both the address and the domain are proved.',
      );
    }

    const plan = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.findUnique({ where: { code: SELF_SERVE_PLAN_CODE } }),
    );
    if (plan === null || !plan.active) {
      /*
       * Refused rather than defaulted.
       *
       * Without the Pilot plan there is no seat count and no allowance that anybody agreed, and
       * inventing them here would be this code deciding commercial terms. The signup keeps its
       * proofs and can be completed once the plan exists.
       */
      throw new ConflictException(
        'Self-serve signup is not available at the moment. Nothing you have done is lost — your ' +
          'address and your domain are both confirmed, and we will finish this for you.',
      );
    }

    const now = new Date();

    /*
     * The country from the domain's suffix, and the currency from the country.
     *
     * The form asks four questions and none of them is a country — a fifth field on a form whose
     * virtue is being short. But the country decides the currency this company is billed in, and
     * every minor-unit amount ever stored against it is in that currency, fixed from here. A
     * default of dollars for everybody would price an Indian customer in dollars for no reason
     * other than that nobody asked.
     *
     * `aarohan.co.in` is an Indian company far more often than not. A generic suffix says nothing
     * and returns null, which falls back rather than inventing — and the platform can correct it
     * before the first charge.
     */
    const country = likelyCountryFromDomain(row.domain);
    const currency = currencyForCountry(country);

    const result = await this.provisioning.provision({
      legalName: row.companyName,
      displayName: row.companyName,
      code: await this.freeCompanyCode(row.domain),
      countryRegion: country ?? '',
      /*
       * The deployment's own timezone.
       *
       * Not guessed from the domain: a timezone is what every due date and every schedule in the
       * product is computed against, and being wrong about it moves somebody's deadlines. The
       * company sets it on step one of the setup checklist, which is the first thing they see.
       */
      timezone: 'Asia/Kolkata',
      currency,
      admin: { name: row.fullName, workEmail: row.workEmail },

      /*
       * The plan, the seats and the allowance, all from the plan row.
       *
       * Not one of them is read from anything a caller sent. Pilot is one seat and no AI
       * allowance because that is what the plan says — and a free plan carrying an allowance is
       * refused by a check constraint in any case, which is the second lock on the same door.
       */
      planCode: SELF_SERVE_PLAN_CODE,
      seats: plan.seatLimit ?? 1,
      startDate: now,
      renewalDate: new Date(now.getTime() + 365 * 86_400_000),
      billingCycle: 'Monthly',
      commercialAllowanceMinor: plan.aiAllowanceMinor ?? 0,

      aiMode: 'UBossManaged',
      budget: {
        monthlyAllowanceMinor: plan.aiAllowanceMinor ?? 0,
        warningPercent: 80,
        approvalThresholdMinor: 0,
        hardStopMinor: plan.aiAllowanceMinor ?? 0,
      },

      /*
       * No example data, and no industry pack.
       *
       * A Pilot has no AI allowance, so nothing it was given could actually run — example work
       * would have to be simulated, which is the one thing this product must never show. The
       * setup checklist is what a new workspace opens on, and that is real work rather than a
       * demonstration of work.
       */
      universalPackEnabled: false,
      industryPacks: [],

      /*
       * The security posture a self-serve company starts with.
       *
       * The domain is the one thing already proved, so it goes in as the primary domain. Nothing
       * else is turned on: requiring MFA or SSO on a workspace whose only member has not signed in
       * yet would lock out the person who just created it, and support access stays off because
       * nobody has agreed to it. All four are on the setup checklist, which is where a company
       * decides its own posture rather than inheriting one this code chose.
       */
      security: {
        primaryDomain: row.domain,
        requireMfa: false,
        requireSso: false,
        guestExpiryDays: 30,
        supportAccessAllowed: false,
        supportAccessRequiresCustomerApproval: true,
      },

      actorUserId: null,
      idempotencyKey: `self-serve-${row.id}`,
    });

    /*
     * Mark the domain claim Verified, now that there is a company to own it.
     *
     * Provisioning already created the row from `security.primaryDomain`, deliberately as
     * *claimed* and not verified — its rule is that a domain grants nothing until its DNS record
     * is checked, and provisioning cannot check DNS inside a transaction. Here the record **has**
     * been checked, minutes ago, against this signup's own token. So this is the one caller
     * entitled to move it, and it is an update rather than an insert.
     *
     * Without it the company would be asked to prove a domain it has just proved, on the first
     * step of its own setup checklist — and the platform-wide exclusivity index would not be
     * holding the domain for them in the meantime, so somebody else could take it.
     */
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.domainVerification.updateMany({
        where: { tenantId: result.tenant.id, domain: row.domain },
        data: {
          state: 'Verified',
          verifiedAt: row.domainVerifiedAt,
          lastCheckedAt: row.domainVerifiedAt,
          failureReason: null,
        },
      }),
    );

    const completed = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.pendingRegistration.update({
        where: { id: row.id },
        data: { state: 'Completed', tenantId: result.tenant.id },
      }),
    );

    this.logger.log(
      `A self-serve signup created company ${result.tenant.slug} for ${row.domain} on the ` +
        `${SELF_SERVE_PLAN_CODE} plan.`,
    );

    return completed;
  }

  // -------------------------------------------------------------------------
  // The things that keep it from being abused
  // -------------------------------------------------------------------------

  /**
   * Refuse a signup that is one too many.
   *
   * ## Why this is not the generic rate limiter
   *
   * `RateLimitInterceptor` keys on the authenticated actor, and returns "allowed" for anonymous
   * traffic on purpose — its reasoning is that volumetric protection of anonymous requests is the
   * proxy's job, and that an IP limiter in the application would be a control whose strength
   * depended on infrastructure this code cannot see. That reasoning holds, and it leaves this
   * endpoint with no limit at all.
   *
   * So the limits here key on what the request is *about* rather than where it came from: the
   * domain and the address. Both are in the body and an attacker can vary them — but varying them
   * spreads the flood across domains, which is what {@link MAX_NEW_PER_HOUR} is for. Nothing keys
   * on the client address, deliberately, for the reason the interceptor already gives.
   */
  private async refuseIfTooMany(workEmail: string, domain: string): Promise<void> {
    const open = { in: ['AwaitingEmail', 'AwaitingDomain', 'Ready'] };
    const now = new Date();

    const [perEmail, perDomain, lastHour] = await this.prisma.runAsPlatformOperation(async () =>
      Promise.all([
        this.prisma.client.pendingRegistration.count({
          where: { workEmail, state: open, expiresAt: { gt: now } },
        }),
        this.prisma.client.pendingRegistration.count({
          where: { domain, state: open, expiresAt: { gt: now } },
        }),
        this.prisma.client.pendingRegistration.count({
          where: { createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
        }),
      ]),
    );

    if (perEmail >= MAX_OPEN_PER_EMAIL) {
      throw new ConflictException(
        'There is already a signup open for this address. Check your inbox for the confirmation ' +
          'link — including the spam folder — rather than starting another.',
      );
    }

    if (perDomain >= MAX_OPEN_PER_DOMAIN) {
      throw new ConflictException(
        `There are already ${perDomain} signups open for ${domain}. Somebody at your company has ` +
          'started this — ask them to finish it, or wait for theirs to lapse.',
      );
    }

    if (lastHour >= MAX_NEW_PER_HOUR) {
      // Logged loudly: this limit being reached is either an attack or a launch, and both are
      // things somebody at UBoss should find out about from a log rather than from a customer.
      this.logger.error(
        `The platform-wide signup ceiling of ${MAX_NEW_PER_HOUR} an hour was reached. New ` +
          'signups are being refused.',
      );
      throw new ConflictException(
        'We are not able to take new signups this minute. Try again shortly — nothing is wrong ' +
          'with what you entered.',
      );
    }
  }

  /**
   * The row, by id **and** token.
   *
   * Both, always. The id appears in a URL and is not a secret; the token is what makes reaching
   * the row mean something. A lookup by id alone would let anybody who saw one complete somebody
   * else's signup.
   */
  private async require(id: string, token: string) {
    const row = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.pendingRegistration.findUnique({ where: { id } }),
    );

    // One message for "no such signup", "wrong token" and "expired". They are the same thing to
    // whoever is guessing, and distinguishing them tells them which half they got right.
    const refusal = new NotFoundException(
      'That signup link is not valid. It may have expired, or already been used.',
    );

    if (row === null) throw refusal;
    if (row.emailTokenHash !== hashToken(token)) throw refusal;
    if (row.state === 'Abandoned') throw refusal;
    if (row.state !== 'Completed' && row.expiresAt <= new Date()) throw refusal;

    return row;
  }

  /**
   * A company code nothing else is using, from the domain.
   *
   * The domain's first label, uppercased — `aarohan.co.in` becomes `AAROHAN` — because that is
   * what somebody at the company would recognise. Suffixed when taken, rather than failing: two
   * companies at different domains can legitimately share a first label.
   */
  private async freeCompanyCode(domain: string): Promise<string> {
    const base = (domain.split('.')[0] ?? 'company')
      .replace(/[^a-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 12);

    const stem = base === '' ? 'COMPANY' : base;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = attempt === 0 ? stem : `${stem}${attempt + 1}`;
      const taken = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.tenant.findFirst({ where: { code }, select: { id: true } }),
      );
      if (taken === null) return code;
    }

    // Fifty collisions on one stem is not a naming problem any more.
    return `${stem}${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private view(row: {
    id: string;
    state: string;
    companyName: string;
    domain: string;
    domainToken: string;
    emailVerifiedAt: Date | null;
    domainVerifiedAt: Date | null;
    failureReason: string | null;
    expiresAt: Date;
    tenantId: string | null;
  }): RegistrationView {
    return {
      id: row.id,
      state: row.state,
      companyName: row.companyName,
      domain: row.domain,
      emailVerified: row.emailVerifiedAt !== null,
      domainVerified: row.domainVerifiedAt !== null,
      /*
       * The record, only once the address is proved.
       *
       * Before that the token is not shown at all: a signup nobody confirmed cannot be used to
       * learn a token, which is what stops this endpoint being a way to make the product run DNS
       * lookups for somebody else's domain.
       */
      dns:
        row.emailVerifiedAt === null
          ? null
          : {
              recordName: this.domains.recordNameFor(row.domain),
              recordType: 'TXT',
              recordValue: this.domains.recordValueFor(row.domainToken),
            },
      failureReason: row.failureReason,
      expiresAt: row.expiresAt.toISOString(),
      tenantId: row.tenantId,
    };
  }
}
