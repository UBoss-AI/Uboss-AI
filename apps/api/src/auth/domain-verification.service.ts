import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';

import { EnterpriseIdentityRepository } from '../persistence/enterprise-identity.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';

/**
 * DNS TXT lookup, as a seam.
 *
 * Injectable so tests can drive verification without depending on real DNS — a test that needs a
 * live TXT record is a test that fails on a train.
 */
export interface DnsTxtResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export const DNS_TXT_RESOLVER = 'DNS_TXT_RESOLVER';

/** The real one, with a timeout so a slow nameserver cannot hold a request open. */
export class NodeDnsTxtResolver implements DnsTxtResolver {
  private readonly resolver = new Resolver({ timeout: 3_000, tries: 2 });

  async resolveTxt(hostname: string): Promise<string[][]> {
    return this.resolver.resolveTxt(hostname);
  }
}

/** The DNS label a company publishes the proof under. */
export const VERIFICATION_RECORD_PREFIX = '_uboss-verification';
const TOKEN_FIELD = 'uboss-domain-verification';

export interface DomainClaimView {
  id: string;
  domain: string;
  state: string;
  /** The exact DNS name to create. */
  recordName: string;
  recordType: 'TXT';
  /** The exact value to publish. */
  recordValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  failureReason: string | null;
  expiresAt: string;
}

/**
 * Verified control of an email domain.
 *
 * ## What a verified domain does and does not grant
 *
 * It **does**: let a company invite addresses at that domain without confirming each one
 * individually, and let an SSO assertion carrying an address at that domain be believed as
 * belonging to that company.
 *
 * It **does not**: create any membership. That distinction is the whole reason this feature is
 * safe to have — if verifying `example.com` auto-provisioned every `@example.com` address that
 * signed in, domain verification would be public company signup wearing a DNS record. Access
 * still comes from an invitation, or from SCIM pushing it explicitly.
 *
 * ## Why DNS TXT rather than an email challenge
 *
 * An email challenge to `admin@domain` proves control of one mailbox, which a departing employee
 * or a compromised alias can also have. A DNS record proves control of the zone, which is the
 * thing that actually defines the domain. It is also the mechanism every enterprise
 * administrator already recognises.
 *
 * ## Exclusivity
 *
 * Any number of companies may hold a *pending* claim on a domain — otherwise the first company
 * to type it in could block the company that really owns it. Only one may ever hold a
 * **verified** claim, enforced by a partial unique index in the database rather than by a check
 * here, so two simultaneous verifications cannot both win.
 */
@Injectable()
export class DomainVerificationService {
  private readonly logger = new Logger(DomainVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enterprise: EnterpriseIdentityRepository,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(DNS_TXT_RESOLVER) private readonly dns: DnsTxtResolver,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /** Start (or restart) a claim, returning the DNS record the company must publish. */
  async claim(
    scope: TenantScope,
    rawDomain: string,
    actorUserId?: string,
  ): Promise<DomainClaimView> {
    const domain = normaliseDomain(rawDomain);

    const claim = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.upsertDomainClaim(scope, {
        domain,
        // Unguessable, so one company cannot publish another's expected value and pre-empt them.
        verificationToken: randomBytes(24).toString('base64url'),
        expiresAt: new Date(
          Date.now() + this.config.domainVerificationExpiryHours * 60 * 60 * 1000,
        ),
      }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.domainClaimCreated,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'domain_verification',
      resourceId: claim.id,
      summary: `Claimed the domain ${domain}.`,
      metadata: { domain },
    });

    return this.toView(claim);
  }

  async list(scope: TenantScope): Promise<DomainClaimView[]> {
    const claims = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.listDomainClaims(scope),
    );
    return claims.map((claim) => this.toView(claim));
  }

  /**
   * Check DNS and settle the claim.
   *
   * Deliberately caller-triggered rather than polled on a schedule: an administrator who has
   * just created the record wants an answer now, and a background poller would mean the screen
   * shows a stale state with no way to refresh it. A scheduled re-check to catch a *removed*
   * record belongs with the job runner at Prompt 21.
   */
  async verify(
    scope: TenantScope,
    claimId: string,
    actorUserId?: string,
  ): Promise<DomainClaimView> {
    // Deliberately three separate scoped steps rather than one: the DNS lookup below is a
    // network call, and holding a database transaction open across it would tie up a connection
    // for the length of a nameserver timeout.
    const claim = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.findDomainClaim(scope, claimId),
    );
    if (!claim) {
      throw new BadRequestException('That domain claim does not exist.');
    }

    const now = new Date();

    if (claim.expiresAt <= now) {
      await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.markDomainFailed(
          scope,
          claim.id,
          now,
          'The claim expired before the DNS record was found. Start a new claim to get a fresh token.',
          true,
        ),
      );
      return this.reload(scope, claim.id);
    }

    const recordName = this.recordNameFor(claim.domain);
    let records: string[][];

    try {
      records = await this.dns.resolveTxt(recordName);
    } catch (cause) {
      // ENOTFOUND / ENODATA is the ordinary "you have not created it yet" case, so the message
      // says what to do rather than reporting a DNS error code at the reader.
      const code = (cause as { code?: string }).code ?? 'unknown';
      const reason =
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? `No TXT record was found at ${recordName}. It can take a few minutes to propagate after you create it.`
          : `The DNS lookup for ${recordName} failed (${code}).`;

      await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.markDomainFailed(scope, claim.id, now, reason),
      );
      await this.recordFailure(scope, claim.id, claim.domain, code, actorUserId);
      return this.reload(scope, claim.id);
    }

    // A TXT record arrives as an array of string chunks that must be concatenated: values over
    // 255 bytes are split, and treating each chunk as a separate value silently fails to match.
    const values = records.map((chunks) => chunks.join(''));
    const expected = this.recordValueFor(claim.verificationToken);

    if (!values.includes(expected)) {
      const reason =
        values.length === 0
          ? `No TXT record was found at ${recordName}.`
          : `A TXT record exists at ${recordName} but none of its values match the expected token.`;

      await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.markDomainFailed(scope, claim.id, now, reason),
      );
      await this.recordFailure(scope, claim.id, claim.domain, 'token_mismatch', actorUserId);
      return this.reload(scope, claim.id);
    }

    try {
      await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.markDomainVerified(scope, claim.id, now),
      );
    } catch (cause) {
      // Only a unique-constraint violation means "another company already proved control".
      // Anything else — a connection drop, a permission problem — must not be reported to the
      // reader as an ownership dispute, so it propagates as the failure it actually is.
      if (!isUniqueViolation(cause)) {
        throw cause;
      }

      // The partial unique index rejected it. Reported plainly, because the reader needs to know
      // this is a dispute and not a DNS problem.
      this.logger.warn(`Domain ${claim.domain} is already verified by another tenant.`);
      await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.markDomainFailed(
          scope,
          claim.id,
          now,
          'Another company has already verified this domain. Contact support if that is wrong.',
        ),
      );
      await this.recordFailure(scope, claim.id, claim.domain, 'already_claimed', actorUserId);
      return this.reload(scope, claim.id);
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.domainVerified,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'domain_verification',
      resourceId: claim.id,
      summary: `Verified control of ${claim.domain}.`,
      metadata: { domain: claim.domain },
    });

    return this.reload(scope, claim.id);
  }

  async remove(scope: TenantScope, claimId: string, actorUserId?: string): Promise<boolean> {
    const claim = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.findDomainClaim(scope, claimId),
    );
    if (!claim) {
      return false;
    }

    const removed = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.deleteDomainClaim(scope, claimId),
    );
    if (removed === 0) {
      return false;
    }

    // Recorded as suspicious because removing a verified domain widens who this company will
    // believe an SSO assertion about — it is a security-relevant loosening, not housekeeping.
    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.domainClaimRemoved,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'domain_verification',
      resourceId: claimId,
      summary: `Removed the domain claim for ${claim.domain}.`,
      metadata: { domain: claim.domain, wasVerified: claim.state === 'Verified' },
    });

    return true;
  }

  /** Is this email's domain verified for this company? Used by invitation and SSO paths. */
  async isDomainVerifiedFor(tenantId: string, email: string): Promise<boolean> {
    if (!email.includes('@')) {
      return false;
    }
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();

    const owner = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.findVerifiedDomainOwnerForPlatform(domain),
    );
    return owner?.tenantId === tenantId;
  }

  recordNameFor(domain: string): string {
    return `${VERIFICATION_RECORD_PREFIX}.${domain}`;
  }

  recordValueFor(token: string): string {
    return `${TOKEN_FIELD}=${token}`;
  }

  private async recordFailure(
    scope: TenantScope,
    claimId: string,
    domain: string,
    reason: string,
    actorUserId?: string,
  ): Promise<void> {
    await this.securityEvents.record({
      action: SECURITY_ACTIONS.domainVerificationFailed,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'domain_verification',
      resourceId: claimId,
      summary: `Verification of ${domain} did not succeed.`,
      metadata: { domain, reason },
    });
  }

  private async reload(scope: TenantScope, claimId: string): Promise<DomainClaimView> {
    const claim = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.findDomainClaim(scope, claimId),
    );
    if (!claim) {
      throw new BadRequestException('That domain claim no longer exists.');
    }
    return this.toView(claim);
  }

  private toView(claim: {
    id: string;
    domain: string;
    state: string;
    verificationToken: string;
    verifiedAt: Date | null;
    lastCheckedAt: Date | null;
    failureReason: string | null;
    expiresAt: Date;
  }): DomainClaimView {
    return {
      id: claim.id,
      domain: claim.domain,
      state: claim.state,
      recordName: this.recordNameFor(claim.domain),
      recordType: 'TXT',
      // Safe to return: the token is proof *because* it gets published. It is not a credential.
      recordValue: this.recordValueFor(claim.verificationToken),
      verifiedAt: claim.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: claim.lastCheckedAt?.toISOString() ?? null,
      failureReason: claim.failureReason,
      expiresAt: claim.expiresAt.toISOString(),
    };
  }
}

/**
 * Normalise and validate a domain.
 *
 * Rejects anything with a scheme, path, port, userinfo or wildcard — all of which are ways to
 * write something that *looks* like a domain and would produce a DNS name we never intended to
 * query. A public-suffix check (refusing a claim on `co.uk`) needs a suffix list and belongs
 * with the job runner that can keep it current; the length and label rules below are what can be
 * enforced correctly today.
 */
export function normaliseDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, '');

  if (trimmed === '') {
    throw new BadRequestException('Enter a domain.');
  }
  if (trimmed.length > 253) {
    throw new BadRequestException('That domain is too long.');
  }
  if (/[:/\\@?#*\s]/.test(trimmed)) {
    throw new BadRequestException(
      'Enter the bare domain only, e.g. "example.com" — no scheme, path, port or wildcard.',
    );
  }

  const labels = trimmed.split('.');
  if (labels.length < 2) {
    throw new BadRequestException('Enter a full domain, e.g. "example.com".');
  }

  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new BadRequestException(`"${trimmed}" is not a valid domain.`);
    }
    // Underscores are valid in some DNS names but never in a registrable domain, and allowing
    // them here would let a claim be made on the verification label itself.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new BadRequestException(`"${trimmed}" is not a valid domain.`);
    }
  }

  return trimmed;
}

/**
 * Is this a unique-constraint violation?
 *
 * Prisma reports one as `P2002`; the raw PostgreSQL code is `23505`. Both are checked because the
 * partial unique index behind this one is created in raw SQL, and a driver-level error can
 * surface before Prisma classifies it.
 */
function isUniqueViolation(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) {
    return false;
  }
  const code = (cause as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}
