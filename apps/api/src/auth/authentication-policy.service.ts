import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { EnterpriseIdentityRepository } from '../persistence/enterprise-identity.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { MfaRepository } from '../persistence/mfa.repository.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';

/** The effective policy for one company. */
export interface EffectiveAuthPolicy {
  tenantId: string;
  requireMfa: boolean;
  requireSso: boolean;
  allowPasswordSignIn: boolean;
  mfaGraceUntil: Date | null;
}

/**
 * What a company's policy demands of one particular person's sign-in attempt.
 *
 * `satisfied` means a session may be issued. Everything else names what is missing, so the
 * caller can put the person on the right path rather than just refusing.
 */
export type PolicyDecision =
  | { outcome: 'satisfied' }
  | { outcome: 'sso-required'; tenantId: string; tenantName: string }
  | { outcome: 'mfa-required' }
  | { outcome: 'mfa-enrolment-required'; graceUntil: Date | null };

/**
 * Per-company authentication policy.
 *
 * ## Why the decision is per company and not per person
 *
 * A person can belong to several companies. One may mandate SSO, another may be happy with a
 * password. The policy therefore cannot be a property of the identity — it is a property of the
 * *relationship*, and a sign-in has to be evaluated against every company the person could open.
 *
 * The rule chosen here is deliberately the **strictest of all their companies**, and that needs
 * justifying because the alternative looks reasonable: evaluate policy only for the workspace
 * being entered. That alternative is wrong, because a UBoss session is person-level — it can
 * switch workspaces without re-authenticating. Issuing a password-only session because the
 * person happened to land on a permissive company would hand them a session that then opens the
 * MFA-mandating one. Taking the strictest requirement up front is the only version that cannot
 * be walked around.
 *
 * The visible cost is honest and worth stating: joining one strict company makes a person's
 * sign-in stricter everywhere. That is the correct trade — the strict company's requirement is
 * the one with a real consequence behind it.
 */
@Injectable()
export class AuthenticationPolicyService {
  private readonly logger = new Logger(AuthenticationPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enterprise: EnterpriseIdentityRepository,
    private readonly mfa: MfaRepository,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * The policy for one company, with defaults when no row exists.
   *
   * `runInTenantTransaction` declares the scope to PostgreSQL, so Row-Level Security enforces it
   * as well as the repository's `where` clause. Without it the policy table fails closed and
   * returns nothing — which is the correct behaviour, and is how the missing declaration was
   * found.
   */
  async forTenant(scope: TenantScope): Promise<EffectiveAuthPolicy> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.findPolicy(scope),
    );
    return toEffective(scope.tenantId, row);
  }

  /**
   * Change a company's policy.
   *
   * Two invariants are enforced here rather than left to the caller, because both describe ways
   * a company could lock itself out of its own workspace:
   *
   *   * **Requiring SSO needs an enabled connection.** Otherwise every member is told to use a
   *     provider that does not exist, and no one — including the administrator who set it — can
   *     get back in to undo it.
   *   * **Requiring SSO disables password sign-in.** Not as a side effect but as the meaning of
   *     the setting: leaving passwords enabled alongside it would make the requirement
   *     decorative, since anyone could simply not use SSO.
   */
  async update(
    scope: TenantScope,
    input: {
      requireMfa: boolean;
      requireSso: boolean;
      mfaGraceUntil?: Date | null;
      actorUserId?: string | undefined;
    },
  ): Promise<EffectiveAuthPolicy> {
    if (input.requireSso) {
      const enabled = await this.prisma.runInTenantTransaction(scope, () =>
        this.enterprise.countEnabledConnections(scope),
      );
      if (enabled === 0) {
        throw new BadRequestException(
          'Enable an enterprise identity connection before requiring SSO. Without one, every ' +
            'member would be sent to a provider that is not configured and nobody could sign in ' +
            'to undo this.',
        );
      }
    }

    const updated = await this.prisma.runInTenantTransaction(scope, () =>
      this.enterprise.upsertPolicy(scope, {
        requireMfa: input.requireMfa,
        requireSso: input.requireSso,
        // Requiring SSO *means* passwords are no longer accepted for this company.
        allowPasswordSignIn: !input.requireSso,
        mfaGraceUntil: input.mfaGraceUntil ?? null,
        ...(input.actorUserId === undefined ? {} : { updatedByUserId: input.actorUserId }),
      }),
    );

    // The audit event is written *outside* the tenant transaction on purpose: the publisher runs
    // as a platform operation, and PrismaService refuses to escalate a tenant scope to one —
    // deliberately, so a tenant-scoped request cannot quietly disable the RLS backstop.

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.authPolicyChanged,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'tenant_auth_policy',
      resourceId: updated.id,
      summary: 'Company authentication policy changed.',
      metadata: {
        requireMfa: updated.requireMfa,
        requireSso: updated.requireSso,
        allowPasswordSignIn: updated.allowPasswordSignIn,
        mfaGraceUntil: updated.mfaGraceUntil?.toISOString() ?? null,
      },
    });

    return toEffective(scope.tenantId, updated);
  }

  /**
   * Evaluate policy for a sign-in that has just passed the password check.
   *
   * Runs as a platform operation because there is no session yet, so no tenant scope can exist —
   * and the tenant ids come from the person's own memberships, never from request input.
   */
  async decideForPasswordSignIn(
    userId: string,
    memberships: { tenantId: string; tenantName: string }[],
    now = new Date(),
  ): Promise<PolicyDecision> {
    if (memberships.length === 0) {
      // A person with no company to open has no company policy to satisfy. They can still hold
      // a session — that is how a platform actor and a newly-offboarded person sign in.
      return { outcome: 'satisfied' };
    }

    const policies = await this.prisma.runAsPlatformOperation(async () =>
      Promise.all(
        memberships.map(async (membership) => ({
          membership,
          policy: toEffective(
            membership.tenantId,
            await this.enterprise.findPolicyForPlatform(membership.tenantId),
          ),
        })),
      ),
    );

    // SSO first: it is the stronger requirement, and a company that mandates SSO does not accept
    // this sign-in at all, so there is nothing to ask the person for.
    const ssoRequired = policies.find(({ policy }) => policy.requireSso);
    if (ssoRequired) {
      return {
        outcome: 'sso-required',
        tenantId: ssoRequired.membership.tenantId,
        tenantName: ssoRequired.membership.tenantName,
      };
    }

    if (!policies.some(({ policy }) => policy.requireMfa)) {
      return { outcome: 'satisfied' };
    }

    const activeFactors = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.countActiveFactors(userId),
    );

    if (activeFactors > 0) {
      return { outcome: 'mfa-required' };
    }

    // No enrolled factor. If *every* company demanding MFA is still inside its grace period, the
    // person may sign in and enrol; otherwise they cannot get in without enrolling, which is the
    // point of the grace period ending.
    const demanding = policies.filter(({ policy }) => policy.requireMfa);
    const latestGrace = demanding.reduce<Date | null>((latest, { policy }) => {
      if (policy.mfaGraceUntil === null) {
        return latest;
      }
      return latest === null || policy.mfaGraceUntil > latest ? policy.mfaGraceUntil : latest;
    }, null);

    const everyoneStillInGrace = demanding.every(
      ({ policy }) => policy.mfaGraceUntil !== null && policy.mfaGraceUntil > now,
    );

    if (everyoneStillInGrace) {
      this.logger.log(`User ${userId} signed in without MFA under an active grace period.`);
      return { outcome: 'satisfied' };
    }

    return { outcome: 'mfa-enrolment-required', graceUntil: latestGrace };
  }

  /**
   * Would removing this factor leave the person unable to satisfy a policy that requires MFA?
   *
   * Checked before a factor is revoked, so someone cannot lock themselves out of a company that
   * mandates MFA by deleting their only authenticator. They are told to enrol a replacement
   * first — which is a message they can act on, unlike discovering it at the next sign-in.
   */
  async wouldBreakMfaRequirement(
    userId: string,
    memberships: { tenantId: string }[],
  ): Promise<boolean> {
    const activeFactors = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.countActiveFactors(userId),
    );

    if (activeFactors > 1) {
      return false;
    }

    const requiring = await this.prisma.runAsPlatformOperation(async () => {
      for (const membership of memberships) {
        const policy = await this.enterprise.findPolicyForPlatform(membership.tenantId);
        if (policy?.requireMfa === true) {
          return true;
        }
      }
      return false;
    });

    return requiring;
  }

  /**
   * Which sign-in methods apply to an email address, for the login screen.
   *
   * **Keyed on the email's domain, deliberately not on the address.** The obvious implementation
   * — look the person up, find their companies, return their policy — would make this endpoint an
   * account-enumeration oracle: an address at an SSO-only company would answer differently from
   * one with no account at all, and an unauthenticated caller could sift a list of addresses for
   * which ones exist.
   *
   * Keying on the domain answers a question about *configuration* rather than about a person: it
   * reveals only "a company has verified this domain and requires SSO", which is a property of
   * the domain and is already visible to anyone who tries to sign in. Whether a specific address
   * has an account stays unknowable, and the answer for an unclaimed domain is identical to the
   * answer for an address that does not exist.
   *
   * This is also how the flow behaves in practice — SSO discovery by email domain is what every
   * enterprise identity product does — so the safer design is not the weaker one.
   */
  async signInMethodsForEmail(email: string): Promise<{
    allowPassword: boolean;
    requireMfa: boolean;
    requireSso: boolean;
    ssoConnections: { id: string; displayName: string; protocol: 'Oidc' | 'Saml' }[];
  }> {
    const at = email.lastIndexOf('@');
    const domain =
      at === -1
        ? ''
        : email
            .slice(at + 1)
            .trim()
            .toLowerCase();

    const owner =
      domain === ''
        ? null
        : await this.prisma.runAsPlatformOperation(() =>
            this.enterprise.findVerifiedDomainOwnerForPlatform(domain),
          );

    if (!owner) {
      // No company has verified this domain. Identical to the answer for an unknown address.
      return { allowPassword: true, requireMfa: false, requireSso: false, ssoConnections: [] };
    }

    return this.signInMethodsForTenant(owner.tenantId);
  }

  /**
   * Which sign-in methods a company offers, for the login screen.
   *
   * Answers with what is *allowed*, never with configuration detail: connection display names
   * and ids, but no issuer, no client id and no discovery URL. Someone who can see a login page
   * is by definition unauthenticated.
   */
  async signInMethodsForTenant(tenantId: string): Promise<{
    allowPassword: boolean;
    requireMfa: boolean;
    requireSso: boolean;
    ssoConnections: { id: string; displayName: string; protocol: 'Oidc' | 'Saml' }[];
  }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const policy = toEffective(tenantId, await this.enterprise.findPolicyForPlatform(tenantId));
      const connections = await this.enterprise.listEnabledConnectionsForPlatform(tenantId);

      return {
        // A company that requires SSO but somehow has no enabled connection would otherwise
        // present a login screen with no way to sign in at all. `update` prevents reaching that
        // state, but this read does not assume the write path was the only one.
        allowPassword: policy.allowPasswordSignIn || connections.length === 0,
        requireMfa: policy.requireMfa,
        requireSso: policy.requireSso && connections.length > 0,
        ssoConnections: connections,
      };
    });
  }
}

function toEffective(
  tenantId: string,
  row: {
    requireMfa: boolean;
    requireSso: boolean;
    allowPasswordSignIn: boolean;
    mfaGraceUntil: Date | null;
  } | null,
): EffectiveAuthPolicy {
  // No row means no requirements — the same as a row with everything off. Modelling "unset" as a
  // third state would only create a case every caller has to handle identically.
  return {
    tenantId,
    requireMfa: row?.requireMfa ?? false,
    requireSso: row?.requireSso ?? false,
    allowPasswordSignIn: row?.allowPasswordSignIn ?? true,
    mfaGraceUntil: row?.mfaGraceUntil ?? null,
  };
}
