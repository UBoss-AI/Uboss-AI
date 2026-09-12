import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ACTIONS, COMPANY_MODULES, type Action, type CompanyModuleKey } from '@uboss/types';
import {
  decideSessionStart,
  DEFAULT_SUPPORT_AUTHORIZATION_MODE,
  initialAuthorizationState,
  SUPPORT_AUTHORIZATION_MODES,
  type CustomerAuthorizationState,
  type SupportAuthorizationMode,
} from '@uboss/types';

import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import type { BreakGlassRequest } from '../generated/prisma/client.js';
import { CompanySettingsService } from '../settings/company-settings.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { AuditEventService } from './audit-event.service.js';

/** The longest window break-glass access may be granted for, in minutes. */
export const MAX_BREAK_GLASS_MINUTES = 8 * 60;
export const DEFAULT_BREAK_GLASS_MINUTES = 60;

/** The minimum length of a reason, so "asdf" cannot satisfy the requirement. */
const MIN_REASON_LENGTH = 20;

export interface RequestBreakGlassInput {
  /** The ticket this access was asked for, when it came from one. */
  supportTicketId?: string | undefined;
  tenantId: string;
  requesterUserId: string;
  /** Why. Mandatory, and checked for substance — see `MIN_REASON_LENGTH`. */
  reason: string;
  /** A ticket or incident reference, so the request can be tied to the thing that caused it. */
  externalReference?: string | undefined;
  /** The modules the access is limited to. Empty is refused: unlimited is not a scope. */
  allowedModules: readonly string[];
  allowedActions: readonly string[];
  /** Optional further narrowing to specific records. */
  allowedResourceIds?: readonly string[] | undefined;
}

export interface BreakGlassGrant {
  requestId: string;
  tenantId: string;
  modules: readonly CompanyModuleKey[];
  actions: readonly Action[];
  resourceIds: readonly string[];
  expiresAt: Date;
}

/**
 * Break-glass: emergency access to a customer's company, with the paper trail that makes it
 * legitimate rather than merely possible.
 *
 * ## The shape of the control
 *
 * Every part of this exists because of a specific failure it prevents:
 *
 *   * **A reason, with substance.** Emergency access with no recorded reason is the thing that
 *     cannot be reviewed afterwards. Checked for length as well as presence, because a
 *     one-character reason satisfies a `NOT NULL` and answers nothing.
 *   * **Identity verification as its own state.** The most effective way into a support system
 *     is to *be* the support engineer over the phone. Verification is therefore a separate,
 *     recorded step with its own actor, not an assumption baked into "the requester is logged
 *     in".
 *   * **A second person approves.** Enforced here, enforced again by a database check
 *     constraint, and it is the same rule as the Prompt 7 four-eyes control: a high-risk action
 *     cannot be self-approved. Break-glass is the highest-risk action in the product.
 *   * **A bounded scope.** Modules and actions must be named, and an empty list is refused.
 *     "Whatever I need" is not a scope, and a grant that cannot be described cannot be reviewed.
 *   * **An expiry.** Access with no end is a permanent back door with an incident number
 *     attached. Capped at {@link MAX_BREAK_GLASS_MINUTES}, because a long-lived grant is
 *     indistinguishable from a standing one.
 *   * **Customer notification as a tracked obligation.** `Pending` is a visible debt, not a
 *     silent default, and withholding notification requires a written reason. A support team
 *     that can quietly enter a customer's data has a different product than one that cannot.
 *   * **A complete audit, written to the customer's own trail.** The audit event carries the
 *     tenant id, so the company can see that somebody broke glass into it. Recording it only on
 *     the platform side would make the transparency obligation depend on the platform choosing
 *     to honour it.
 *
 * ## What this does NOT do at Prompt 8
 *
 * An active grant is not yet *wired into* the authorization engine — nothing consults
 * {@link activeGrantFor} to widen a permission decision yet. That is deliberate: connecting an
 * access-widening path into the engine deserves its own prompt with its own negative tests, and
 * a half-wired one would be the worst of both. What exists now is the record, the state machine,
 * and the query the engine will call. Recorded in `docs/IMPLEMENTATION_STATE.md` as unfinished
 * rather than presented as working.
 */
@Injectable()
export class BreakGlassService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly companySettings: CompanySettingsService,
  ) {}

  /**
   * Raise a request. Grants nothing.
   *
   * A requester cannot verify their own identity, cannot approve, and cannot activate. All this
   * call does is create a record that somebody wants access, which is why it is the only step
   * the requester performs alone.
   */
  async request(input: RequestBreakGlassInput): Promise<BreakGlassRequest> {
    const reason = input.reason.trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new BadRequestException(
        `A break-glass reason must be at least ${MIN_REASON_LENGTH} characters and explain what ` +
          'is wrong and why normal access is insufficient. This is the record somebody reviews ' +
          'afterwards.',
      );
    }

    const modules = BreakGlassService.validateModules(input.allowedModules);
    const actions = BreakGlassService.validateActions(input.allowedActions);

    // Read **before** the transaction: the policy lives in the company settings catalogue, and
    // resolving a setting opens its own scope.
    const mode = await this.authorizationModeFor(input.tenantId);

    return this.prisma.runAsPlatformOperation(async () => {
      const request = await this.prisma.client.breakGlassRequest.create({
        data: {
          tenantId: input.tenantId,
          requesterUserId: input.requesterUserId,
          state: 'Requested',
          identityVerificationState: 'Unverified',
          reason,
          externalReference: input.externalReference ?? null,
          allowedModules: [...modules],
          allowedActions: [...actions],
          allowedResourceIds: [...(input.allowedResourceIds ?? [])],
          // Stamped at request time from the policy in force *then*. Reading it again at
          // activation would let a company's setting change mid-request and decide a session
          // under a rule nobody was operating under — the same reasoning as the Prompt 34
          // closure policy being recorded on the review.
          customerAuthorizationState: initialAuthorizationState(mode),
          ...(input.supportTicketId === undefined
            ? {}
            : { supportTicketId: input.supportTicketId }),
        },
      });

      await this.trace(request, SECURITY_ACTIONS.breakGlassRequested, 'break_glass.requested', {
        summary: `Break-glass access requested for ${modules.length} module(s).`,
        reason,
        actorUserId: input.requesterUserId,
        metadata: {
          modules: modules.join(','),
          actions: actions.join(','),
          resourceIds: (input.allowedResourceIds ?? []).length,
          externalReference: input.externalReference ?? null,
        },
      });

      return request;
    });
  }

  /**
   * Record that the requester's identity was verified out of band — or that it was not.
   *
   * A `Failed` verification moves the request to `Denied` immediately rather than leaving it
   * open. Someone who failed identity verification should not be able to try again on the same
   * request record; they raise a new one, and the failed attempt stays visible.
   */
  async verifyIdentity(input: {
    requestId: string;
    verifierUserId: string;
    result: 'VerifiedByHuman' | 'VerifiedBySecondFactor' | 'Failed';
    note?: string | undefined;
  }): Promise<BreakGlassRequest> {
    const outcome = await this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);
      this.assertState(existing, ['Requested']);

      if (existing.requesterUserId === input.verifierUserId) {
        // Recorded AFTER this transaction ends — see `refuse`. Returning rather than throwing
        // is what lets the record outlive the refusal.
        return { refused: existing } as const;
      }

      const failed = input.result === 'Failed';
      const updated = await this.transition(existing, {
        identityVerificationState: input.result,
        identityVerificationNote: input.note ?? null,
        identityVerifiedByUserId: input.verifierUserId,
        identityVerifiedAt: new Date(),
        ...(failed
          ? { state: 'Denied' as const, deniedAt: new Date() }
          : { state: 'IdentityVerified' as const }),
      });

      await this.trace(
        updated,
        failed
          ? SECURITY_ACTIONS.breakGlassIdentityVerificationFailed
          : SECURITY_ACTIONS.breakGlassIdentityVerified,
        failed ? 'break_glass.identity_verification_failed' : 'break_glass.identity_verified',
        {
          summary: failed
            ? 'Identity verification failed; the request was denied.'
            : `Identity verified (${input.result}).`,
          reason: input.note ?? null,
          actorUserId: input.verifierUserId,
        },
      );

      return { updated } as const;
    });

    if ('refused' in outcome) {
      await this.refuse(
        outcome.refused,
        'break_glass.self_verification_blocked',
        input.verifierUserId,
        'Refused: the requester attempted to verify their own identity.',
        'Identity verification must be performed by someone other than the requester.',
      );
      throw new ForbiddenException(
        'The requester cannot verify their own identity. Identity verification exists precisely ' +
          'to establish that the person asking is who they claim to be, which they cannot ' +
          'establish about themselves.',
      );
    }
    return outcome.updated;
  }

  /**
   * Approve, with an expiry.
   *
   * Requires a verified identity, and an approver who is not the requester. Both are checked
   * here **and** by a database check constraint — the double enforcement is deliberate, exactly
   * as with the Prompt 7 privilege-escalation gates. A service can be bypassed by a future code
   * path; a check constraint cannot.
   */
  async approve(input: {
    requestId: string;
    approverUserId: string;
    minutes?: number | undefined;
    note?: string | undefined;
  }): Promise<BreakGlassRequest> {
    const minutes = input.minutes ?? DEFAULT_BREAK_GLASS_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BREAK_GLASS_MINUTES) {
      throw new BadRequestException(
        `A break-glass window must be between 1 and ${MAX_BREAK_GLASS_MINUTES} minutes. ` +
          'A longer grant is indistinguishable from standing access; raise a new request if ' +
          'more time is genuinely needed, so the extension is itself reviewed.',
      );
    }

    const outcome = await this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);
      this.assertState(existing, ['IdentityVerified']);

      if (existing.requesterUserId === input.approverUserId) {
        return { refused: existing } as const;
      }

      const updated = await this.transition(existing, {
        state: 'Approved',
        approverUserId: input.approverUserId,
        approvedAt: new Date(),
        approvalNote: input.note ?? null,
        expiresAt: new Date(Date.now() + minutes * 60_000),
      });

      await this.trace(updated, SECURITY_ACTIONS.breakGlassApproved, 'break_glass.approved', {
        summary: `Approved for ${minutes} minute(s).`,
        reason: input.note ?? null,
        actorUserId: input.approverUserId,
        metadata: { minutes, expiresAt: updated.expiresAt?.toISOString() ?? null },
      });

      return { updated } as const;
    });

    if ('refused' in outcome) {
      await this.refuse(
        outcome.refused,
        'break_glass.self_approval_blocked',
        input.approverUserId,
        'Refused: the requester attempted to approve their own break-glass request.',
        'Break-glass is a four-eyes action and cannot be self-approved.',
      );
      throw new ForbiddenException(
        'Break-glass cannot be self-approved. A second person must approve it — the same ' +
          'four-eyes rule the authorization engine applies to every high-risk action, and ' +
          'break-glass is the highest-risk action in the product.',
      );
    }
    return outcome.updated;
  }

  /** Refuse the request. Terminal. */
  async deny(input: {
    requestId: string;
    approverUserId: string;
    reason: string;
  }): Promise<BreakGlassRequest> {
    if (!input.reason.trim()) {
      throw new BadRequestException('Denying a break-glass request requires a reason.');
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);
      this.assertState(existing, ['Requested', 'IdentityVerified']);

      const updated = await this.transition(existing, {
        state: 'Denied',
        deniedAt: new Date(),
        approvalNote: input.reason.trim(),
        // `approverUserId` is deliberately left unset on a denial: the column means "the person
        // who authorised this access", and nobody did. The denier is in the audit event.
      });

      await this.trace(updated, SECURITY_ACTIONS.breakGlassDenied, 'break_glass.denied', {
        summary: 'Break-glass request denied.',
        reason: input.reason.trim(),
        actorUserId: input.approverUserId,
      });

      return updated;
    });
  }

  /**
   * Activate an approved request, starting the clock.
   *
   * Separate from approval so the window is spent on the actual work rather than on the time
   * between approval and someone sitting down to do it. An approved request whose expiry has
   * already passed cannot be activated.
   */
  async activate(input: { requestId: string; actorUserId: string }): Promise<BreakGlassRequest> {
    // **The customer-authorization gate runs before the transaction, and so does its event.**
    //
    // It used to live inside `runAsPlatformOperation` below, which is a transaction: recording the
    // refusal and then throwing rolled the event back with it, so the control worked invisibly.
    // A control nobody can show a regulator is not a control, and the e2e test found this by
    // asserting the event rather than only the 403.
    const gate = await this.prisma.runAsPlatformOperation(() => this.load(input.requestId));
    const start = decideSessionStart({
      mode: gate.customerAuthorizationState === 'NotRequired' ? 'NotRequired' : 'Required',
      authorization: gate.customerAuthorizationState as CustomerAuthorizationState,
    });

    if (!start.mayStart) {
      await this.prisma.runAsPlatformOperation(() =>
        this.trace(
          gate,
          SECURITY_ACTIONS.breakGlassCustomerAuthorizationBlocked,
          'break_glass.customer_authorization_blocked',
          {
            summary: 'Activation refused: the company has not authorized this session.',
            reason: start.reason,
            actorUserId: input.actorUserId,
            metadata: { customerAuthorization: gate.customerAuthorizationState },
          },
        ),
      );
      throw new ForbiddenException(start.reason);
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);
      this.assertState(existing, ['Approved']);

      if (existing.expiresAt && existing.expiresAt.getTime() <= Date.now()) {
        const expired = await this.transition(existing, { state: 'Expired' });
        await this.trace(expired, SECURITY_ACTIONS.breakGlassExpired, 'break_glass.expired', {
          summary: 'The approved window passed before the access was activated.',
          reason: null,
          actorUserId: input.actorUserId,
        });
        throw new ConflictException(
          'This break-glass approval has already expired. Raise a new request.',
        );
      }

      const updated = await this.transition(existing, {
        state: 'Active',
        activatedAt: new Date(),
      });

      await this.trace(updated, SECURITY_ACTIONS.breakGlassActivated, 'break_glass.activated', {
        summary: 'Break-glass access is now in force.',
        reason: null,
        actorUserId: input.actorUserId,
        metadata: { expiresAt: updated.expiresAt?.toISOString() ?? null },
      });

      return updated;
    });
  }

  /**
   * The company's own authorization of one support session — Prompt 36.
   *
   * §Prompt 36: *"customer authorization where policy requires"*. This is the "where policy
   * requires" half: a company on the `Required` policy must say yes, and **there is no emergency
   * bypass**. An override for a P0 would make the control advisory, and an advisory control is
   * worse than none because the company believes they are protected.
   *
   * Runs as a platform operation because `break_glass_requests` is reached that way everywhere
   * else in this service — but the *caller* is a company administrator, and the route that leads
   * here is tenant-scoped and checks `settings:Administer` before it arrives.
   */
  async recordCustomerAuthorization(input: {
    requestId: string;
    tenantId: string;
    decidedByUserId: string;
    authorized: boolean;
    note?: string;
  }): Promise<BreakGlassRequest> {
    const note = input.note?.trim() ?? '';

    if (!input.authorized && note === '') {
      throw new BadRequestException(
        'Say why you are declining. A refusal nobody explained cannot be answered, and UBoss has ' +
          'to know whether to ask differently or not at all.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);

      // The company deciding about somebody else's session would be a cross-tenant action, so
      // this is checked here as well as by the tenant guard on the route.
      if (existing.tenantId !== input.tenantId) {
        throw new NotFoundException('No such support session.');
      }

      if (existing.customerAuthorizationState === 'NotRequired') {
        throw new ConflictException(
          'This session did not require your authorization — your policy allowed UBoss support ' +
            'to enter under its own approval when it was raised. You can change that in ' +
            'Settings, and it will apply to sessions raised afterwards.',
        );
      }

      if (existing.customerAuthorizationState !== 'Pending') {
        throw new ConflictException(
          `You have already ${
            existing.customerAuthorizationState === 'Authorized' ? 'authorized' : 'declined'
          } this session.`,
        );
      }

      if (existing.state === 'Expired' || existing.state === 'Revoked') {
        throw new ConflictException('That session is already over.');
      }

      const next: CustomerAuthorizationState = input.authorized ? 'Authorized' : 'Declined';

      const updated = await this.prisma.client.breakGlassRequest.update({
        where: { id: existing.id },
        data: {
          customerAuthorizationState: next,
          customerAuthorizedByUserId: input.decidedByUserId,
          customerAuthorizedAt: new Date(),
          ...(note === '' ? {} : { customerAuthorizationNote: note }),
          version: { increment: 1 },
        },
      });

      await this.trace(
        updated,
        input.authorized
          ? SECURITY_ACTIONS.breakGlassCustomerAuthorized
          : SECURITY_ACTIONS.breakGlassCustomerDeclined,
        input.authorized
          ? 'break_glass.customer_authorized'
          : 'break_glass.customer_declined',
        {
          summary: input.authorized
            ? 'The company authorized this support session.'
            : 'The company declined this support session.',
          reason: note === '' ? null : note,
          actorUserId: input.decidedByUserId,
          metadata: { customerAuthorization: next },
        },
      );

      return updated;
    });
  }

  /** The sessions this company is being asked to decide about. */
  async awaitingCustomerAuthorization(tenantId: string): Promise<BreakGlassRequest[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.breakGlassRequest.findMany({
        where: {
          tenantId,
          customerAuthorizationState: 'Pending',
          state: { in: ['Requested', 'Approved'] },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * This company's support-access policy, from the settings catalogue.
   *
   * Read from the one catalogue rather than a second table, so "what is this company's policy" has
   * one answer and the Settings screen that shows it is the screen that changes it. An unreadable
   * or unknown value falls back to the documented default rather than throwing — a settings
   * failure must not make support access *more* permissive by accident, and `NotRequired` is the
   * default the catalogue itself declares.
   */
  async authorizationModeFor(tenantId: string): Promise<SupportAuthorizationMode> {
    try {
      const value = await this.companySettings.effectiveValue(
        tenantScopeForPlatformOperation(tenantId),
        'security.support_session_authorization',
      );
      return SUPPORT_AUTHORIZATION_MODES.includes(value as SupportAuthorizationMode)
        ? (value as SupportAuthorizationMode)
        : DEFAULT_SUPPORT_AUTHORIZATION_MODE;
    } catch {
      return DEFAULT_SUPPORT_AUTHORIZATION_MODE;
    }
  }

  /** End an active grant early. */
  async revoke(input: {
    requestId: string;
    revokedByUserId: string;
    reason: string;
  }): Promise<BreakGlassRequest> {
    if (!input.reason.trim()) {
      throw new BadRequestException('Revoking break-glass access requires a reason.');
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);
      this.assertState(existing, ['Approved', 'Active']);

      const updated = await this.transition(existing, {
        state: 'Revoked',
        revokedAt: new Date(),
        revokedByUserId: input.revokedByUserId,
        revocationReason: input.reason.trim(),
      });

      await this.trace(updated, SECURITY_ACTIONS.breakGlassRevoked, 'break_glass.revoked', {
        summary: 'Break-glass access revoked.',
        reason: input.reason.trim(),
        actorUserId: input.revokedByUserId,
      });

      return updated;
    });
  }

  /**
   * The grant an active request confers, or `null`.
   *
   * Expiry is evaluated **here**, on read, not only by a scheduled sweep: a grant whose window
   * has passed must stop working the moment it passes, and a sweep that runs every minute leaves
   * a minute of access nobody authorised. The sweep exists to tidy the state for reporting, not
   * to enforce the boundary.
   *
   * Records a `breakGlassUsed` event and increments the counter each time the grant is consulted,
   * so "the access was granted but never used" is a distinguishable, provable outcome.
   */
  async activeGrantFor(requestId: string): Promise<BreakGlassGrant | null> {
    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(requestId);

      if (existing.state !== 'Active') {
        return null;
      }
      if (!existing.expiresAt || existing.expiresAt.getTime() <= Date.now()) {
        const expired = await this.transition(existing, { state: 'Expired' });
        await this.trace(expired, SECURITY_ACTIONS.breakGlassExpired, 'break_glass.expired', {
          summary: 'Break-glass window elapsed.',
          reason: null,
        });
        return null;
      }

      const used = await this.transition(existing, {
        usageCount: { increment: 1 },
        lastUsedAt: new Date(),
      });

      await this.trace(used, SECURITY_ACTIONS.breakGlassUsed, 'break_glass.used', {
        summary: `Break-glass grant consulted (use ${used.usageCount}).`,
        reason: null,
        metadata: { usageCount: used.usageCount },
      });

      return {
        requestId: used.id,
        tenantId: used.tenantId,
        modules: used.allowedModules as CompanyModuleKey[],
        actions: used.allowedActions as Action[],
        resourceIds: used.allowedResourceIds,
        expiresAt: used.expiresAt as Date,
      };
    });
  }

  /**
   * Record the customer notification outcome.
   *
   * `Suppressed` demands a reason — checked here and by a database constraint. Suppression is
   * legitimate (an active investigation where the customer is the subject) and is also exactly
   * how a notification obligation would be quietly dropped, so it is recorded at `Critical`
   * severity and the reason is not optional.
   */
  async recordCustomerNotification(input: {
    requestId: string;
    actorUserId: string;
    outcome: 'Sent' | 'Failed' | 'Suppressed';
    suppressionReason?: string | undefined;
  }): Promise<BreakGlassRequest> {
    if (input.outcome === 'Suppressed' && !input.suppressionReason?.trim()) {
      throw new BadRequestException(
        'Suppressing the customer notification requires a written reason. Withholding it is a ' +
          'decision somebody has to be accountable for.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.load(input.requestId);

      const updated = await this.transition(existing, {
        customerNotificationState: input.outcome,
        ...(input.outcome === 'Sent' ? { customerNotifiedAt: new Date() } : {}),
        ...(input.outcome === 'Suppressed'
          ? { notificationSuppressionReason: input.suppressionReason?.trim() ?? null }
          : {}),
      });

      const action =
        input.outcome === 'Sent'
          ? SECURITY_ACTIONS.breakGlassCustomerNotified
          : input.outcome === 'Failed'
            ? SECURITY_ACTIONS.breakGlassNotificationFailed
            : SECURITY_ACTIONS.breakGlassNotificationSuppressed;

      await this.trace(updated, action, `break_glass.notification_${input.outcome.toLowerCase()}`, {
        summary: `Customer notification: ${input.outcome}.`,
        reason: input.suppressionReason?.trim() ?? null,
        actorUserId: input.actorUserId,
      });

      return updated;
    });
  }

  /**
   * Move elapsed grants to `Expired`.
   *
   * Reporting hygiene, not enforcement: {@link activeGrantFor} already refuses an elapsed grant.
   * Intended for a scheduled job; called directly by tests.
   */
  async expireElapsed(): Promise<number> {
    return this.prisma.runAsPlatformOperation(async () => {
      const due = await this.prisma.client.breakGlassRequest.findMany({
        where: { state: { in: ['Approved', 'Active'] }, expiresAt: { lte: new Date() } },
      });

      for (const request of due) {
        const expired = await this.transition(request, { state: 'Expired' });
        await this.trace(expired, SECURITY_ACTIONS.breakGlassExpired, 'break_glass.expired', {
          summary: 'Break-glass window elapsed.',
          reason: null,
        });
      }
      return due.length;
    });
  }

  async findById(requestId: string): Promise<BreakGlassRequest> {
    return this.prisma.runAsPlatformOperation(() => this.load(requestId));
  }

  /** Every break-glass request, newest first. Platform-plane view. */
  async list(filter: {
    tenantId?: string | undefined;
    state?: BreakGlassRequest['state'] | undefined;
    /** Only those whose customer notification is still outstanding. */
    notificationPending?: boolean | undefined;
    take?: number | undefined;
  }): Promise<BreakGlassRequest[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.breakGlassRequest.findMany({
        where: {
          ...(filter.tenantId === undefined ? {} : { tenantId: filter.tenantId }),
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.notificationPending ? { customerNotificationState: 'Pending' } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(filter.take ?? 50, 200),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async load(requestId: string): Promise<BreakGlassRequest> {
    const found = await this.prisma.client.breakGlassRequest.findUnique({
      where: { id: requestId },
    });
    if (!found) {
      throw new NotFoundException(`No break-glass request ${requestId}.`);
    }
    return found;
  }

  /**
   * Refuse a transition from the wrong state.
   *
   * The message names both states, because "conflict" with no detail is the least useful
   * possible response when the caller is a support engineer under time pressure.
   */
  private assertState(
    request: BreakGlassRequest,
    allowed: readonly BreakGlassRequest['state'][],
  ): void {
    if (!allowed.includes(request.state)) {
      throw new ConflictException(
        `This break-glass request is "${request.state}"; that step requires ` +
          `${allowed.map((state) => `"${state}"`).join(' or ')}.`,
      );
    }
  }

  /**
   * Apply a state change with an optimistic-concurrency check.
   *
   * `version` is matched in the `where` clause, so two approvers acting at the same moment
   * cannot both succeed — the second gets a conflict and re-reads. Without this, the second
   * write would silently overwrite the first, and the audit trail would show two approvals of
   * which only one took effect.
   */
  private async transition(
    request: BreakGlassRequest,
    data: Parameters<PrismaService['client']['breakGlassRequest']['update']>[0]['data'],
  ): Promise<BreakGlassRequest> {
    const updated = await this.prisma.client.breakGlassRequest.updateMany({
      where: { id: request.id, version: request.version },
      data: { ...data, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      throw new ConflictException(
        'This break-glass request changed while you were acting on it. Re-read it and try again.',
      );
    }
    return this.load(request.id);
  }

  /**
   * Write both trails for one break-glass step.
   *
   * The audit event uses `…OrThrow`: for break-glass, the record **is** the deliverable. "We
   * granted emergency access to a customer's data and failed to write it down" must fail the
   * step, not proceed with a line in the application log. The security event uses the ordinary
   * best-effort path, because it is the second copy rather than the record of authority.
   *
   * The audit row carries the **tenant id**, so it lands in the customer's own trail. Writing it
   * only platform-side would make the transparency obligation depend on the platform choosing to
   * honour it.
   */
  private async trace(
    request: BreakGlassRequest,
    securityAction: string,
    auditAction: string,
    detail: {
      summary: string;
      reason: string | null;
      actorUserId?: string | undefined;
      metadata?: Record<string, string | number | boolean | null> | undefined;
    },
  ): Promise<void> {
    await this.auditEvents.appendWithinCurrentScope(request.tenantId, {
      action: auditAction,
      resourceType: 'break_glass_request',
      resourceId: request.id,
      summary: detail.summary,
      ...(detail.reason === null ? {} : { reason: detail.reason }),
      resourceVersion: request.version,
      ...(request.externalReference ? { resourceRef: request.externalReference } : {}),
      ...(detail.actorUserId === undefined ? {} : { actorUserId: detail.actorUserId }),
      metadata: {
        state: request.state,
        identityVerification: request.identityVerificationState,
        customerNotification: request.customerNotificationState,
        ...detail.metadata,
      },
    });

    await this.securityEvents.recordWithinCurrentScope({
      action: securityAction as never,
      tenantId: request.tenantId,
      ...(detail.actorUserId === undefined ? {} : { actorUserId: detail.actorUserId }),
      resourceType: 'break_glass_request',
      resourceId: request.id,
      summary: detail.summary,
      metadata: { state: request.state, ...detail.metadata },
    });
  }

  /**
   * Record a refused attempt, in its own transaction.
   *
   * This exists because of a bug worth remembering: the refusal was originally recorded inside
   * the same transaction that then threw, so the `ForbiddenException` rolled back the record of
   * the attempt along with the attempt. A control that blocks something and leaves no trace of
   * having blocked it is half a control — the blocked attempt is often the more interesting
   * event of the two.
   *
   * Errors are swallowed rather than propagated: the caller is about to be refused anyway, and
   * turning a logging failure into a different error message would obscure why they were
   * refused.
   */
  private async refuse(
    request: BreakGlassRequest,
    auditAction: string,
    actorUserId: string,
    summary: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.runAsPlatformOperation(() =>
        this.trace(request, SECURITY_ACTIONS.breakGlassSelfApprovalBlocked, auditAction, {
          summary,
          reason,
          actorUserId,
        }),
      );
    } catch {
      // Deliberately silent — see above.
    }
  }

  /**
   * Reject a module the product does not have, and refuse an empty list.
   *
   * Platform modules are refused too: break-glass is access *into a customer's company*, and a
   * grant naming `platform-settings` would be a support engineer granting themselves platform
   * authority through the customer-access mechanism.
   */
  private static validateModules(modules: readonly string[]): CompanyModuleKey[] {
    if (modules.length === 0) {
      throw new BadRequestException(
        'Break-glass access must name the modules it covers. An empty list would mean ' +
          'unrestricted access, and unrestricted access is not a scope that can be reviewed.',
      );
    }
    const allowed = new Set<string>(COMPANY_MODULES);
    const invalid = modules.filter((module) => !allowed.has(module));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Not company modules: ${invalid.join(', ')}. Break-glass grants access into a customer ` +
          'company, so only company modules can be named.',
      );
    }
    return [...new Set(modules)] as CompanyModuleKey[];
  }

  /**
   * Reject an unknown action, refuse an empty list, and refuse `Administer`.
   *
   * `Administer` is excluded on purpose: it is the action that lets its holder change who else
   * has access. A break-glass grant that includes it can be used to create a *permanent* grant
   * before the window closes, which would make the expiry decorative.
   */
  private static validateActions(actions: readonly string[]): Action[] {
    if (actions.length === 0) {
      throw new BadRequestException(
        'Break-glass access must name the actions it permits. An empty list would mean all of ' +
          'them.',
      );
    }
    const allowed = new Set<string>(ACTIONS);
    const invalid = actions.filter((action) => !allowed.has(action));
    if (invalid.length > 0) {
      throw new BadRequestException(`Not known actions: ${invalid.join(', ')}.`);
    }

    const escalating = actions.filter(
      (action) => action === 'Administer' || action === 'ManageAccess',
    );
    if (escalating.length > 0) {
      throw new BadRequestException(
        `Break-glass cannot grant ${escalating.join(' or ')}. Those actions change who else has ` +
          'access, so a time-limited grant containing them could be used to create a permanent ' +
          'one before it expires — which would make the expiry decorative.',
      );
    }

    return [...new Set(actions)] as Action[];
  }
}
