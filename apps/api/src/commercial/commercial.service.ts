import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { COMPANY_MODULES, type CompanyModuleKey } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  CommercialChangeKind,
  CommercialChangeRequest,
  ReleaseChannel,
} from '../generated/prisma/client.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SeatService, type SeatPosition } from './seat.service.js';

/**
 * A company's whole commercial position, with the five concepts kept apart.
 *
 * The shape itself is the separation: five named groups, none of which mentions a role. A caller
 * reading this cannot accidentally treat an entitlement as a permission, because there is no
 * field here that looks like one.
 */
export interface CommercialPosition {
  /** (1) Commercial Plan — what was bought. */
  plan: {
    code: string | null;
    name: string | null;
    tier: string | null;
    state: string | null;
    billingState: string | null;
    billingCycle: string | null;
    startedAt: string | null;
    renewsAt: string | null;
    daysToRenewal: number | null;
  };
  /** (2) Module Entitlements — which modules the company *has*. Never who may use them. */
  entitlements: {
    planModules: string[];
    extraModules: string[];
    removedModules: string[];
    effectiveModules: string[];
  };
  /** (3) Feature / Release Channel — which *version* of a module the company sees. */
  release: { channel: ReleaseChannel; fromPlan: ReleaseChannel; overridden: boolean };
  /** (4) Commercial Allowance — how much AI spend was bought. */
  allowance: {
    aiAllowanceMinor: number;
    aiConsumedMinor: number;
    currency: string;
    percentConsumed: number | null;
  };
  /** Seats, which are a commercial unit and not a permission. */
  seats: SeatPosition;
  /** A future-effective plan change, if one is scheduled. */
  pendingChange: {
    planCode: string | null;
    seats: number | null;
    effectiveAt: string;
    reason: string | null;
  } | null;
  /**
   * (5) RBAC is **deliberately absent** from this object.
   *
   * Stated rather than merely omitted, so a reader who expects to find permissions here learns
   * why they are not: authorization is the Prompt 7 engine's answer and never derived from a
   * plan. Buying more seats grants nobody any authority.
   */
  rbacNote: string;
}

/** One row of the platform's decision queue, with the customer named. */
export interface PendingCommercialRequest {
  id: string;
  tenantId: string;
  companyName: string;
  companySlug: string;
  companyCode: string | null;
  kind: CommercialChangeKind;
  requestedSeats: number | null;
  requestedPlanCode: string | null;
  requestedAllowanceMinor: number | null;
  requestedModules: string[];
  justification: string;
  requestedByUserId: string;
  requestedAt: string;
}

/**
 * The commercial plane: plans, entitlements, seats, allowance and change requests.
 *
 * ## The separation this service exists to protect
 *
 * Commercial Plan, Module Entitlements, Feature/Release Channel, Commercial Allowance and RBAC
 * are five different things. This service owns the first four and **never reads or writes the
 * fifth**. `AuthorizationService` is injected for one purpose only — to check whether the caller
 * may *see* this data — and no method here consults a plan to decide a permission or a permission
 * to decide an entitlement.
 *
 * That is worth stating because the bug it prevents is a classic: a plan upgrade that silently
 * widens somebody's authority, or a role change that silently grants a module the company never
 * bought. Keeping them apart means an entitlement question and an authority question always have
 * exactly one answer each.
 *
 * ## Who may do what
 *
 * The client's rule: *Company Admin may view its permitted plan/seat position and may request
 * allowed commercial changes; Platform Admin controls the contracted ceiling and entitlements.*
 * So the company-facing methods here are read-and-request, and every method that changes a
 * contracted number is platform-side.
 *
 * ## Reducing anything destroys nothing
 *
 * There is no delete path in this service. A downgrade sets a grace window that holds the old
 * ceiling; it does not remove users, employment history, tasks, Agent history or audit rows.
 */
@Injectable()
export class CommercialService {
  private readonly logger = new Logger(CommercialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformRepository,
    private readonly seats: SeatService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  // -------------------------------------------------------------------------
  // Company-facing: view and request
  // -------------------------------------------------------------------------

  /**
   * The company's own commercial position.
   *
   * Requires `settings:View`, which every company role holds — a manager who cannot see how many
   * seats are left will invite somebody into a refusal. The *numbers* are visible; changing them
   * is not.
   */
  async positionForCompany(scope: TenantScope, userId: string): Promise<CommercialPosition> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });
    return this.computePosition(scope.tenantId);
  }

  /**
   * Raise a commercial change request.
   *
   * `settings:Administer` — a Company Admin's decision, not any member's. It commits the company
   * to a conversation about money, so it needs the role that speaks for the company.
   */
  async requestChange(input: {
    scope: TenantScope;
    userId: string;
    kind: CommercialChangeKind;
    requestedSeats?: number | undefined;
    requestedPlanCode?: string | undefined;
    requestedAllowanceMinor?: number | undefined;
    requestedModules?: readonly string[] | undefined;
    justification: string;
  }): Promise<CommercialChangeRequest> {
    const context = await this.authorization.contextFor(input.scope, input.userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (!input.justification.trim()) {
      throw new BadRequestException(
        'A commercial request needs a business reason. The platform cannot evaluate a request ' +
          'with no stated need, and this is the record both sides refer back to.',
      );
    }

    CommercialService.assertRequestNamesSomething(input);

    if (input.requestedModules?.length) {
      const allowed = new Set<string>(COMPANY_MODULES);
      const invalid = input.requestedModules.filter((module) => !allowed.has(module));
      if (invalid.length > 0) {
        throw new BadRequestException(
          `Not company modules: ${invalid.join(', ')}. A company can only be entitled to ` +
            'company modules; the platform control plane is not sellable.',
        );
      }
    }

    if (input.requestedPlanCode) {
      const plan = await this.platform.findPlanByCode(input.requestedPlanCode);
      if (!plan || !plan.active) {
        throw new BadRequestException(
          `"${input.requestedPlanCode}" is not a plan a company can move to.`,
        );
      }
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      // One open request per kind, so the platform queue does not fill with duplicates from
      // somebody clicking twice — and so "what has this company asked for" has one answer.
      const open = await this.prisma.client.commercialChangeRequest.findFirst({
        where: { tenantId: input.scope.tenantId, kind: input.kind, state: 'Requested' },
      });
      if (open) {
        throw new ConflictException(
          `This company already has an open ${input.kind} request. Withdraw it before raising ` +
            'another, so there is one answer to "what have we asked for".',
        );
      }

      const request = await this.prisma.client.commercialChangeRequest.create({
        data: {
          tenantId: input.scope.tenantId,
          kind: input.kind,
          requestedSeats: input.requestedSeats ?? null,
          requestedPlanCode: input.requestedPlanCode ?? null,
          requestedAllowanceMinor: input.requestedAllowanceMinor ?? null,
          requestedModules: [...(input.requestedModules ?? [])],
          justification: input.justification.trim(),
          requestedByUserId: input.userId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'commercial.change_requested',
        resourceType: 'commercial_change_request',
        resourceId: request.id,
        actorUserId: input.userId,
        summary: `Requested ${input.kind}.`,
        reason: input.justification.trim(),
        metadata: {
          kind: input.kind,
          seats: input.requestedSeats ?? null,
          planCode: input.requestedPlanCode ?? null,
          modules: (input.requestedModules ?? []).join(','),
        },
      });

      return request;
    });
  }

  /** Withdraw an open request. The company's own, so no platform involvement. */
  async withdrawChange(input: {
    scope: TenantScope;
    userId: string;
    requestId: string;
  }): Promise<CommercialChangeRequest> {
    const context = await this.authorization.contextFor(input.scope, input.userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.commercialChangeRequest.findFirst({
        where: { id: input.requestId, tenantId: input.scope.tenantId },
      });
      if (!existing) {
        throw new NotFoundException('No such commercial request.');
      }
      if (existing.state !== 'Requested') {
        throw new ConflictException(
          `That request is "${existing.state}" and can no longer be withdrawn.`,
        );
      }

      const updated = await this.prisma.client.commercialChangeRequest.update({
        where: { id: existing.id },
        data: { state: 'Withdrawn', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'commercial.change_withdrawn',
        resourceType: 'commercial_change_request',
        resourceId: existing.id,
        actorUserId: input.userId,
        summary: `Withdrew the ${existing.kind} request.`,
      });

      return updated;
    });
  }

  /** The company's own request history. `settings:View`. */
  async requestsForCompany(scope: TenantScope, userId: string): Promise<CommercialChangeRequest[]> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.commercialChangeRequest.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { requestedAt: 'desc' },
        take: 50,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Platform-facing: decide and apply
  // -------------------------------------------------------------------------

  /**
   * The platform's queue of requests awaiting a decision.
   *
   * Carries the company's name and slug alongside each row. A queue of tenant UUIDs is not a
   * queue anybody can work: the first thing a decider needs is *which customer is asking*.
   */
  async pendingRequestsForPlatform(): Promise<PendingCommercialRequest[]> {
    return this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.commercialChangeRequest.findMany({
        where: { state: 'Requested' },
        orderBy: { requestedAt: 'asc' },
        take: 200,
        include: { tenant: { select: { name: true, slug: true, code: true } } },
      });

      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        companyName: row.tenant.name,
        companySlug: row.tenant.slug,
        companyCode: row.tenant.code,
        kind: row.kind,
        requestedSeats: row.requestedSeats,
        requestedPlanCode: row.requestedPlanCode,
        requestedAllowanceMinor: row.requestedAllowanceMinor,
        requestedModules: [...row.requestedModules],
        justification: row.justification,
        requestedByUserId: row.requestedByUserId,
        requestedAt: row.requestedAt.toISOString(),
      }));
    });
  }

  /**
   * Decide a request, and optionally apply it in the same act.
   *
   * The decider may not be the requester — enforced here **and** by a check constraint. A company
   * that could decide its own contracted ceiling would make the ceiling a preference rather than
   * a contract, which is the whole reason this is a request/decide split.
   */
  async decideChange(input: {
    requestId: string;
    actorUserId: string;
    approve: boolean;
    note?: string | undefined;
    /** Apply immediately on approval. Otherwise the platform applies it separately. */
    applyNow?: boolean | undefined;
    /** For a downgrade: when the lower ceiling takes effect. Defaults to the plan's grace. */
    effectiveAt?: Date | undefined;
  }): Promise<CommercialChangeRequest> {
    const outcome = await this.prisma.runAsPlatformOperation(async () => {
      const request = await this.prisma.client.commercialChangeRequest.findUnique({
        where: { id: input.requestId },
      });
      if (!request) {
        throw new NotFoundException('No such commercial request.');
      }
      if (request.state !== 'Requested') {
        throw new ConflictException(`That request is already "${request.state}".`);
      }
      if (request.requestedByUserId === input.actorUserId) {
        // Returned rather than thrown from here, and recorded *outside* this transaction.
        // Throwing would roll back the very record of the refusal — the Prompt 8 break-glass
        // lesson, which cost a suite failure there and would have cost a silent hole here: a
        // blocked self-decision that leaves no trace is indistinguishable from one that never
        // happened.
        return { blockedSelfDecision: { tenantId: request.tenantId, requestId: request.id } };
      }

      const decided = await this.prisma.client.commercialChangeRequest.update({
        where: { id: request.id },
        data: {
          state: input.approve ? 'Approved' : 'Declined',
          decidedByUserId: input.actorUserId,
          decidedAt: new Date(),
          decisionNote: input.note?.trim() ?? null,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(request.tenantId, {
        action: input.approve ? 'commercial.change_approved' : 'commercial.change_declined',
        resourceType: 'commercial_change_request',
        resourceId: request.id,
        actorUserId: input.actorUserId,
        summary: `${input.approve ? 'Approved' : 'Declined'} the ${request.kind} request.`,
        ...(input.note?.trim() ? { reason: input.note.trim() } : {}),
        metadata: { kind: request.kind, approved: input.approve },
      });

      if (input.approve && input.applyNow) {
        return {
          decided: await this.applyApprovedRequest({
            request: decided,
            actorUserId: input.actorUserId,
            effectiveAt: input.effectiveAt,
          }),
        };
      }

      return { decided };
    });

    if ('blockedSelfDecision' in outcome) {
      await this.recordBlockedSelfDecision({
        tenantId: outcome.blockedSelfDecision.tenantId,
        requestId: outcome.blockedSelfDecision.requestId,
        actorUserId: input.actorUserId,
      });
      throw new ForbiddenException(
        'You cannot decide your own commercial request. A contracted ceiling a company could ' +
          'set for itself would not be a contract.',
      );
    }

    return outcome.decided;
  }

  /**
   * Record a blocked self-decision in its own transaction.
   *
   * Its own, because the caller is about to throw, and a refusal recorded inside the transaction
   * the refusal aborts leaves no trace at all. Failures here are swallowed: the refusal itself
   * must stand even if the trail write fails, and the alternative — turning a correct 403 into a
   * 500 — would tell the caller their self-decision hit a bug rather than a control.
   */
  private async recordBlockedSelfDecision(input: {
    tenantId: string;
    requestId: string;
    actorUserId: string;
  }): Promise<void> {
    try {
      await this.prisma.runAsPlatformOperation(() =>
        this.securityEvents.recordWithinCurrentScope({
          action: SECURITY_ACTIONS.commercialSelfDecisionBlocked,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          resourceType: 'commercial_change_request',
          resourceId: input.requestId,
          summary: 'Refused: the requester attempted to decide their own commercial request.',
        }),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record a blocked commercial self-decision on request ${input.requestId}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Apply an approved request to the subscription.
   *
   * Assumes it is already inside a platform operation, because `decideChange` calls it inside
   * one and applying separately opens its own.
   *
   * **A seat reduction never removes anybody.** It sets `seatGraceUntil` / `seatGraceCeiling` to
   * hold the *current* ceiling for the plan's grace period, so a company at 30 people dropping
   * to 25 seats keeps working while it decides who to offboard. Offboarding is a separate,
   * deliberate act that itself preserves employment history.
   */
  private async applyApprovedRequest(input: {
    request: CommercialChangeRequest;
    actorUserId: string;
    effectiveAt?: Date | undefined;
  }): Promise<CommercialChangeRequest> {
    const { request } = input;

    const subscription = await this.prisma.client.tenantSubscription.findUnique({
      where: { tenantId: request.tenantId },
      include: { plan: true },
    });
    if (!subscription) {
      throw new ConflictException(
        'That company has no subscription, so there is nothing to apply the change to.',
      );
    }

    const currentCeiling = subscription.seatsLicensed ?? subscription.plan.seatLimit ?? 0;
    const graceDays = subscription.plan.downgradeGraceDays;

    switch (request.kind) {
      case 'MoreSeats': {
        // An increase applies immediately: there is no reason to make a customer wait for
        // capacity they have agreed to pay for.
        await this.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: { seatsLicensed: request.requestedSeats, version: { increment: 1 } },
        });
        break;
      }

      case 'FewerSeats': {
        const newCeiling = request.requestedSeats ?? currentCeiling;
        // Grace only when the company is actually over the new number — see
        // `graceForNewCeiling`. Nobody is removed either way.
        const grace = await this.graceForNewCeiling({
          tenantId: request.tenantId,
          newCeiling,
          currentCeiling,
          graceDays,
        });

        await this.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: { seatsLicensed: newCeiling, ...grace, version: { increment: 1 } },
        });
        break;
      }

      case 'PlanUpgrade':
      case 'PlanDowngrade': {
        const plan = request.requestedPlanCode
          ? await this.platform.findPlanByCode(request.requestedPlanCode)
          : null;
        if (!plan) {
          throw new ConflictException('That plan no longer exists.');
        }

        const future = input.effectiveAt !== undefined && input.effectiveAt.getTime() > Date.now();

        if (future) {
          // Future-effective, which is what a downgrade normally is: applying it the moment it
          // is agreed would take away capacity the customer has already paid for through the end
          // of the term.
          await this.prisma.client.tenantSubscription.update({
            where: { id: subscription.id },
            data: {
              pendingPlanId: plan.id,
              pendingSeats: plan.seatLimit,
              pendingEffectiveAt: input.effectiveAt as Date,
              pendingReason: request.justification,
              version: { increment: 1 },
            },
          });
        } else {
          const grace = await this.graceForNewCeiling({
            tenantId: request.tenantId,
            newCeiling: plan.seatLimit,
            currentCeiling,
            graceDays,
          });
          await this.prisma.client.tenantSubscription.update({
            where: { id: subscription.id },
            data: {
              planId: plan.id,
              seatsLicensed: plan.seatLimit,
              ...grace,
              version: { increment: 1 },
            },
          });
        }
        break;
      }

      case 'MoreAiAllowance': {
        await this.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: {
            aiAllowanceMinor: request.requestedAllowanceMinor ?? subscription.aiAllowanceMinor,
            version: { increment: 1 },
          },
        });
        break;
      }

      case 'ModuleEntitlement': {
        // Added as an *extra* rather than by changing the plan: the plan is shared across
        // companies, and one company's negotiated module must not appear for everybody on it.
        await this.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: {
            extraModules: [...new Set([...subscription.extraModules, ...request.requestedModules])],
            version: { increment: 1 },
          },
        });
        break;
      }
    }

    const applied = await this.prisma.client.commercialChangeRequest.update({
      where: { id: request.id },
      data: { state: 'Applied', appliedAt: new Date(), version: { increment: 1 } },
    });

    await this.auditEvents.appendWithinCurrentScope(request.tenantId, {
      action: 'commercial.change_applied',
      resourceType: 'commercial_change_request',
      resourceId: request.id,
      actorUserId: input.actorUserId,
      summary: `Applied the ${request.kind} change.`,
      reason: request.justification,
      metadata: {
        kind: request.kind,
        // The client's rule, recorded on every application so it is answerable from the trail.
        nothingDeleted: true,
      },
    });

    return applied;
  }

  /**
   * Apply pending plan changes whose effective date has arrived.
   *
   * Intended for a scheduler; called directly by tests. A downgrade landing here still gets its
   * grace window, so the effective date changes the *plan* while the old ceiling holds for a
   * while longer.
   */
  async applyDuePlanChanges(): Promise<number> {
    return this.prisma.runAsPlatformOperation(async () => {
      const due = await this.prisma.client.tenantSubscription.findMany({
        where: { pendingPlanId: { not: null }, pendingEffectiveAt: { lte: new Date() } },
        include: { plan: true },
      });

      for (const subscription of due) {
        const currentCeiling = subscription.seatsLicensed ?? subscription.plan.seatLimit ?? 0;
        const newCeiling = subscription.pendingSeats ?? currentCeiling;
        const grace = await this.graceForNewCeiling({
          tenantId: subscription.tenantId,
          newCeiling,
          currentCeiling,
          graceDays: subscription.plan.downgradeGraceDays,
        });

        await this.prisma.client.tenantSubscription.update({
          where: { id: subscription.id },
          data: {
            planId: subscription.pendingPlanId as string,
            seatsLicensed: newCeiling,
            ...grace,
            pendingPlanId: null,
            pendingSeats: null,
            pendingEffectiveAt: null,
            pendingReason: null,
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(subscription.tenantId, {
          action: 'commercial.plan_change_applied',
          resourceType: 'tenant_subscription',
          resourceId: subscription.id,
          summary: 'A scheduled plan change took effect.',
          ...(subscription.pendingReason ? { reason: subscription.pendingReason } : {}),
          metadata: {
            byScheduler: true,
            nothingDeleted: true,
            graceApplied: grace.seatGraceUntil !== null,
          },
        });
      }

      return due.length;
    });
  }

  /**
   * Set a company's contracted terms directly. Platform-side.
   *
   * The escape hatch for a negotiated change that never went through a request — most real
   * contract changes are agreed on a call, not in an app. It still requires a reason and still
   * applies grace on a reduction, so the non-destructive rule holds regardless of route.
   */
  async setContractedSeats(input: {
    tenantId: string;
    seats: number;
    reason: string;
    actorUserId: string;
  }): Promise<SeatPosition> {
    if (!input.reason.trim()) {
      throw new BadRequestException('Changing a contracted ceiling requires a reason.');
    }
    if (input.seats < 1) {
      throw new BadRequestException('A company needs at least one seat.');
    }

    await this.prisma.runAsPlatformOperation(async () => {
      const subscription = await this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId: input.tenantId },
        include: { plan: true },
      });
      if (!subscription) {
        throw new NotFoundException('That company has no subscription.');
      }

      const currentCeiling = subscription.seatsLicensed ?? subscription.plan.seatLimit ?? 0;
      const assessment = await this.seats.assessReduction({
        tenantId: input.tenantId,
        newCeiling: input.seats,
      });

      const grace = await this.graceForNewCeiling({
        tenantId: input.tenantId,
        newCeiling: input.seats,
        currentCeiling,
        graceDays: subscription.plan.downgradeGraceDays,
      });

      await this.prisma.client.tenantSubscription.update({
        where: { id: subscription.id },
        data: { seatsLicensed: input.seats, ...grace, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: 'commercial.seats_changed',
        resourceType: 'tenant_subscription',
        resourceId: subscription.id,
        resourceVersion: subscription.version,
        actorUserId: input.actorUserId,
        summary: `Contracted seats ${currentCeiling} → ${input.seats}.`,
        reason: input.reason.trim(),
        metadata: {
          from: currentCeiling,
          to: input.seats,
          used: assessment.used,
          graceApplied: assessment.needsGrace,
          // The client's rule, stated on the record rather than only in a doc.
          nothingDeleted: true,
        },
      });
    });

    return this.prisma.runAsPlatformOperation(() =>
      this.computePosition(input.tenantId).then((position) => position.seats),
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The grace columns for a ceiling that is about to change.
   *
   * One helper because three code paths change a ceiling — an approved `FewerSeats`, an applied
   * plan change, and a direct platform edit — and a company's grace window must not depend on
   * which of them was used.
   *
   * A window is opened **only when the company is actually over the new number**. Holding a
   * higher ceiling nobody is near is not merely pointless: a company at 3 people dropping from
   * 40 seats to 10 would be able to add 37 more during the window and be far over its contract
   * the moment the window shut. So an unnecessary grace window is the opposite of protective.
   */
  private async graceForNewCeiling(input: {
    tenantId: string;
    newCeiling: number | null;
    currentCeiling: number;
    graceDays: number;
  }): Promise<{ seatGraceUntil: Date | null; seatGraceCeiling: number | null }> {
    if (input.newCeiling === null) {
      // Unlimited. Nobody can be over it, so any existing window is cleared.
      return { seatGraceUntil: null, seatGraceCeiling: null };
    }

    const assessment = await this.seats.assessReduction({
      tenantId: input.tenantId,
      newCeiling: input.newCeiling,
    });

    return assessment.needsGrace
      ? {
          seatGraceUntil: new Date(Date.now() + input.graceDays * 86_400_000),
          seatGraceCeiling: input.currentCeiling,
        }
      : { seatGraceUntil: null, seatGraceCeiling: null };
  }

  /**
   * Assemble the whole commercial position.
   *
   * Runs as a platform operation so it works for both the company-facing and platform-facing
   * callers; the *authorization* for the company-facing path happens before this is reached.
   */
  private async computePosition(tenantId: string): Promise<CommercialPosition> {
    return this.prisma.runAsPlatformOperation(async () => {
      const subscription = await this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: true, pendingPlan: true },
      });

      const seats = await this.seats.positionFor(
        // A platform-scope handle: this method is already inside a platform operation, and the
        // seat service re-enters rather than nesting a second transaction.
        { tenantId } as TenantScope,
      );

      const planModules = subscription?.plan.entitledModules ?? [];
      const extraModules = subscription?.extraModules ?? [];
      const removedModules = subscription?.removedModules ?? [];
      // Withheld wins over extra — the same rule the Master Console and the wizard apply, so
      // three surfaces cannot disagree about what a company can see.
      const effectiveModules = [...new Set([...planModules, ...extraModules])].filter(
        (module) => !removedModules.includes(module),
      );

      const allowance = subscription?.aiAllowanceMinor ?? 0;
      const consumed = subscription?.aiConsumedMinor ?? 0;

      const channelFromPlan = subscription?.plan.releaseChannel ?? 'Stable';
      const channel = subscription?.releaseChannelOverride ?? channelFromPlan;

      return {
        plan: {
          code: subscription?.plan.code ?? null,
          name: subscription?.plan.name ?? null,
          tier: subscription?.plan.tier ?? null,
          state: subscription?.state ?? null,
          billingState: subscription?.billingState ?? null,
          billingCycle: subscription?.billingCycle ?? null,
          startedAt: subscription?.startedAt.toISOString() ?? null,
          renewsAt: subscription?.renewsAt?.toISOString() ?? null,
          daysToRenewal:
            subscription?.renewsAt == null
              ? null
              : Math.ceil((subscription.renewsAt.getTime() - Date.now()) / 86_400_000),
        },
        entitlements: {
          planModules: [...planModules],
          extraModules: [...extraModules],
          removedModules: [...removedModules],
          effectiveModules,
        },
        release: {
          channel,
          fromPlan: channelFromPlan,
          overridden: subscription?.releaseChannelOverride != null,
        },
        allowance: {
          aiAllowanceMinor: allowance,
          aiConsumedMinor: consumed,
          currency: subscription?.currency ?? 'USD',
          percentConsumed: allowance > 0 ? Math.round((consumed / allowance) * 100) : null,
        },
        seats,
        pendingChange:
          subscription?.pendingEffectiveAt && subscription.pendingPlan
            ? {
                planCode: subscription.pendingPlan.code,
                seats: subscription.pendingSeats,
                effectiveAt: subscription.pendingEffectiveAt.toISOString(),
                reason: subscription.pendingReason,
              }
            : null,
        rbacNote:
          'Roles and permissions are deliberately absent from this object. What a company has ' +
          'bought and what a person inside it may do are separate questions with separate ' +
          'answers — buying more seats or a bigger plan grants nobody any authority.',
      };
    });
  }

  /**
   * Refuse a request that names nothing actionable.
   *
   * The database enforces this too. Both, because a request sitting in the platform queue that
   * nobody can act on is worse than a rejected one: it looks like work in progress.
   */
  private static assertRequestNamesSomething(input: {
    kind: CommercialChangeKind;
    requestedSeats?: number | undefined;
    requestedPlanCode?: string | undefined;
    requestedAllowanceMinor?: number | undefined;
    requestedModules?: readonly string[] | undefined;
  }): void {
    const named =
      (input.kind === 'MoreSeats' || input.kind === 'FewerSeats') &&
      input.requestedSeats !== undefined &&
      input.requestedSeats > 0
        ? true
        : (input.kind === 'PlanUpgrade' || input.kind === 'PlanDowngrade') &&
            input.requestedPlanCode
          ? true
          : input.kind === 'MoreAiAllowance' &&
              input.requestedAllowanceMinor !== undefined &&
              input.requestedAllowanceMinor > 0
            ? true
            : input.kind === 'ModuleEntitlement' && (input.requestedModules?.length ?? 0) > 0;

    if (!named) {
      throw new BadRequestException(
        `A ${input.kind} request has to say what it wants — a seat count, a plan code, an ` +
          'allowance or a module list. A request nobody can act on sits in the queue looking ' +
          'like work in progress.',
      );
    }
  }

  /**
   * The modules a company is entitled to.
   *
   * Exported for the feature/entitlement gate that later prompts will need. It returns modules
   * and **nothing about roles**, so a caller cannot use it as an authorization check by mistake.
   */
  async entitledModulesFor(tenantId: string): Promise<CompanyModuleKey[]> {
    const position = await this.computePosition(tenantId);
    return position.entitlements.effectiveModules as CompanyModuleKey[];
  }
}
