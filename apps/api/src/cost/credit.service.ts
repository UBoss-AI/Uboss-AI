import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  allowanceAfterPlanChange,
  BILLING_CHOICES,
  carryForwardMinor,
  DEFAULT_CREDIT_POLICY,
  GRANT_LEDGER_KIND,
  GRANT_SOURCES,
  grantsToExpire,
  mayMoveCreditRequest,
  mayResumeAfterTopUp,
  negativeBalanceBlocks,
  validateCreditDecision,
  validateCreditPolicy,
  validateCreditRequest,
  validateReallocation,
  type BillingChoice,
  type BudgetScope,
  type CreditPolicy,
  type CreditRequestState,
  type GrantSource,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { type TenantScope } from '../persistence/tenant-context.js';
import { CostEngineService } from './cost-engine.service.js';

export interface CreditRequestView {
  id: string;
  state: CreditRequestState;
  requestedMinor: number;
  approvedMinor: number | null;
  currency: string;
  reason: string;
  billingChoice: BillingChoice | null;
  requestedByUserId: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  effectiveFrom: string | null;
  expiresAt: string | null;
  reference: string | null;
  grantId: string | null;
}

export interface CreditGrantView {
  id: string;
  source: GrantSource;
  amountMinor: number;
  currency: string;
  effectiveFrom: string;
  expiresAt: string | null;
  writtenOffAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  reason: string;
  reference: string | null;
  live: boolean;
}

/**
 * Credit top-up, reallocation and the commercial edge cases — Prompt 31.
 *
 * ## What this service does not own
 *
 * **It never moves a balance itself.** Every movement goes through
 * `CostEngineService.adjustAllowance`, which takes the wallet row lock and writes the ledger
 * entry in the same transaction. That is the Prompt 30 rule kept intact: there is exactly one way
 * money moves, and `reconcile` is meaningful precisely because nothing bypasses it.
 *
 * ## Credit arrives in lots
 *
 * A top-up creates a **grant** with its own effective date and optional expiry. Top-up expiry is
 * what forces that — expiring "the ₹40,000 from March" means knowing which part of the allowance
 * it was. Carry-forward and plan changes reuse the same shape.
 *
 * ## The commercial terms are configuration
 *
 * UBoss_Final_1 line 1048 asks for these to be *defined*, and states no value for any of them.
 * So every one is a column on `company_credit_policies` with a documented default, and this
 * service reads the policy rather than deciding. The defaults are the conservative reading in
 * each case, and the one that matters most: **a purchased top-up does not expire unless somebody
 * says it does.**
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: CostEngineService,
    private readonly auditEvents: AuditEventService,
    private readonly notifications: NotificationService,
  ) {}

  // -------------------------------------------------------------------------
  // The policy
  // -------------------------------------------------------------------------

  /** The company's commercial policy, created from the defaults on first read. */
  async policy(
    scope: TenantScope,
  ): Promise<CreditPolicy & { periodStart: string; nextResetAt: string | null }> {
    const row = await this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.companyCreditPolicy.findUnique({
        where: { tenantId: scope.tenantId },
      });
      if (existing !== null) return existing;

      // Written from `DEFAULT_CREDIT_POLICY` rather than left to the column defaults: the
      // documented default is a decision (a purchased top-up does not expire unasked), and a
      // policy that reads one thing in the types package and another in the database is a
      // commercial term nobody can quote.
      return this.prisma.client.companyCreditPolicy.create({
        data: {
          tenantId: scope.tenantId,
          resetPolicy: DEFAULT_CREDIT_POLICY.resetPolicy,
          carryForwardPolicy: DEFAULT_CREDIT_POLICY.carryForwardPolicy,
          carryForwardCapMinor: DEFAULT_CREDIT_POLICY.carryForwardCapMinor,
          defaultTopUpExpiryDays: DEFAULT_CREDIT_POLICY.defaultTopUpExpiryDays,
          negativeBalancePolicy: DEFAULT_CREDIT_POLICY.negativeBalancePolicy,
          negativeBalanceGraceMinor: DEFAULT_CREDIT_POLICY.negativeBalanceGraceMinor,
          planChangePolicy: DEFAULT_CREDIT_POLICY.planChangePolicy,
          billingChoiceEnabled: DEFAULT_CREDIT_POLICY.billingChoiceEnabled,
          periodStart: new Date(),
          nextResetAt: this.nextMonthStart(new Date()),
        },
      });
    });

    return {
      resetPolicy: row.resetPolicy as CreditPolicy['resetPolicy'],
      carryForwardPolicy: row.carryForwardPolicy as CreditPolicy['carryForwardPolicy'],
      carryForwardCapMinor: row.carryForwardCapMinor,
      defaultTopUpExpiryDays: row.defaultTopUpExpiryDays,
      negativeBalancePolicy: row.negativeBalancePolicy as CreditPolicy['negativeBalancePolicy'],
      negativeBalanceGraceMinor: row.negativeBalanceGraceMinor,
      planChangePolicy: row.planChangePolicy as CreditPolicy['planChangePolicy'],
      billingChoiceEnabled: row.billingChoiceEnabled,
      periodStart: row.periodStart.toISOString(),
      nextResetAt: row.nextResetAt?.toISOString() ?? null,
    };
  }

  /** Change the commercial policy. Platform-side: these are contract terms, not company settings. */
  async setPolicy(input: {
    scope: TenantScope;
    actorUserId: string;
    policy: CreditPolicy;
    reason: string;
  }): Promise<CreditPolicy> {
    const validation = validateCreditPolicy(input.policy);
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why the commercial policy changed.');
    }

    await this.policy(input.scope);

    const updated = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.companyCreditPolicy.update({
        where: { tenantId: input.scope.tenantId },
        data: {
          resetPolicy: input.policy.resetPolicy,
          carryForwardPolicy: input.policy.carryForwardPolicy,
          carryForwardCapMinor: input.policy.carryForwardCapMinor,
          defaultTopUpExpiryDays: input.policy.defaultTopUpExpiryDays,
          negativeBalancePolicy: input.policy.negativeBalancePolicy,
          negativeBalanceGraceMinor: input.policy.negativeBalanceGraceMinor,
          planChangePolicy: input.policy.planChangePolicy,
          billingChoiceEnabled: input.policy.billingChoiceEnabled,
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.policy_changed',
        resourceType: 'company-credit-policy',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceVersion: row.version,
        summary: `Commercial credit policy changed: ${input.reason}`,
        metadata: {
          resetPolicy: input.policy.resetPolicy,
          carryForwardPolicy: input.policy.carryForwardPolicy,
          negativeBalancePolicy: input.policy.negativeBalancePolicy,
          planChangePolicy: input.policy.planChangePolicy,
          topUpExpiryDays: input.policy.defaultTopUpExpiryDays ?? 0,
        },
      });

      return row;
    });

    return {
      resetPolicy: updated.resetPolicy as CreditPolicy['resetPolicy'],
      carryForwardPolicy: updated.carryForwardPolicy as CreditPolicy['carryForwardPolicy'],
      carryForwardCapMinor: updated.carryForwardCapMinor,
      defaultTopUpExpiryDays: updated.defaultTopUpExpiryDays,
      negativeBalancePolicy: updated.negativeBalancePolicy as CreditPolicy['negativeBalancePolicy'],
      negativeBalanceGraceMinor: updated.negativeBalanceGraceMinor,
      planChangePolicy: updated.planChangePolicy as CreditPolicy['planChangePolicy'],
      billingChoiceEnabled: updated.billingChoiceEnabled,
    };
  }

  // -------------------------------------------------------------------------
  // Requesting credits
  // -------------------------------------------------------------------------

  /**
   * A Company Admin asks for more credit.
   *
   * The prompt is explicit that **employees cannot increase company credits** — the permission
   * check is the controller's, and it is `settings:Administer`, which only a Company Admin holds.
   */
  async requestCredits(input: {
    scope: TenantScope;
    actorUserId: string;
    amountMinor: number;
    reason: string;
    billingChoice?: BillingChoice | undefined;
  }): Promise<CreditRequestView> {
    const validation = validateCreditRequest({
      amountMinor: input.amountMinor,
      reason: input.reason,
    });
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }

    const policy = await this.policy(input.scope);
    if (input.billingChoice !== undefined) {
      if (!policy.billingChoiceEnabled) {
        throw new BadRequestException(
          'This plan does not offer a billing choice. Finance will decide how it is billed.',
        );
      }
      if (!BILLING_CHOICES.includes(input.billingChoice)) {
        throw new BadRequestException(`Unknown billing choice: ${input.billingChoice}`);
      }
    }

    const wallet = await this.cost.companyWallet(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const created = await this.prisma.client.creditRequest.create({
        data: {
          tenantId: input.scope.tenantId,
          requestedMinor: input.amountMinor,
          currency: wallet.currency,
          reason: input.reason,
          requestedByUserId: input.actorUserId,
          ...(input.billingChoice === undefined ? {} : { billingChoice: input.billingChoice }),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.requested',
        resourceType: 'credit-request',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        resourceVersion: created.version,
        summary: `Requested ${input.amountMinor} ${wallet.currency} of AI credit: ${input.reason}`,
        metadata: {
          requestedMinor: input.amountMinor,
          billingChoice: input.billingChoice ?? 'Unspecified',
        },
      });

      return this.toRequestView(created);
    });
  }

  /** The company withdraws its own request. */
  async cancelRequest(input: {
    scope: TenantScope;
    actorUserId: string;
    requestId: string;
    reason: string;
  }): Promise<CreditRequestView> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const request = await this.loadRequest(input.scope, input.requestId);

      if (!mayMoveCreditRequest(request.state as CreditRequestState, 'Cancelled')) {
        throw new ConflictException(
          `That request is already ${request.state}. Raise a new one rather than reversing a ` +
            'decision nobody would see.',
        );
      }

      if (request.requestedByUserId !== input.actorUserId) {
        // Somebody else's request is theirs to withdraw. An admin who needs it gone can reject
        // it through Finance, which leaves a reason.
        throw new ForbiddenException(
          'Only the person who raised a credit request may withdraw it.',
        );
      }

      const updated = await this.prisma.client.creditRequest.update({
        where: { id: request.id },
        data: {
          state: 'Cancelled',
          decidedByUserId: input.actorUserId,
          decidedAt: new Date(),
          decisionNote: input.reason,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.request_cancelled',
        resourceType: 'credit-request',
        resourceId: request.id,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `Credit request withdrawn: ${input.reason}`,
        metadata: { requestedMinor: request.requestedMinor },
      });

      return this.toRequestView(updated);
    });
  }

  async listRequests(input: {
    scope: TenantScope;
    state?: CreditRequestState | undefined;
  }): Promise<CreditRequestView[]> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.creditRequest.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.state === undefined ? {} : { state: input.state }),
        },
        orderBy: { requestedAt: 'desc' },
        take: 200,
      });
      return rows.map((row) => this.toRequestView(row));
    });
  }

  // -------------------------------------------------------------------------
  // Finance decides
  // -------------------------------------------------------------------------

  /**
   * Approve (possibly for a different amount) or reject.
   *
   * The prompt's four Finance actions collapse to two outcomes: "Approve & Add Credits" and
   * "Adjust Amount" both approve, for the amount Finance names.
   *
   * On approval this creates the grant, moves the allowance through the cost engine, notifies the
   * Company Admin and resumes runs blocked *only* by an exhausted allowance — the four things
   * the prompt lists under "After top-up".
   */
  async decideRequest(input: {
    scope: TenantScope;
    operatorUserId: string;
    requestId: string;
    approve: boolean;
    approvedMinor?: number | undefined;
    effectiveFrom?: Date | undefined;
    expiresAt?: Date | undefined;
    reference?: string | undefined;
    note: string;
  }): Promise<{ request: CreditRequestView; resumedRuns: number }> {
    const policy = await this.policy(input.scope);

    // A default expiry is applied only when Finance named none *and* the company's policy sets
    // one. The default policy sets none, so purchased credit does not expire unasked.
    const effectiveFrom = input.effectiveFrom ?? new Date();
    const expiresAt =
      input.expiresAt ??
      (policy.defaultTopUpExpiryDays === null
        ? undefined
        : new Date(effectiveFrom.getTime() + policy.defaultTopUpExpiryDays * 86_400_000));

    const validation = validateCreditDecision({
      approve: input.approve,
      ...(input.approvedMinor === undefined ? {} : { approvedMinor: input.approvedMinor }),
      effectiveFrom,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      reason: input.note,
    });
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }

    const request = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.loadRequest(input.scope, input.requestId),
    );

    if (
      !mayMoveCreditRequest(
        request.state as CreditRequestState,
        input.approve ? 'Approved' : 'Rejected',
      )
    ) {
      throw new ConflictException(
        `That request is already ${request.state}. A decision is final; raise a new request.`,
      );
    }

    if (!input.approve) {
      const rejected = await this.prisma.runInTenantTransaction(input.scope, async () => {
        const updated = await this.prisma.client.creditRequest.update({
          where: { id: request.id },
          data: {
            state: 'Rejected',
            decidedByUserId: input.operatorUserId,
            decidedAt: new Date(),
            decisionNote: input.note,
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'credits.request_rejected',
          resourceType: 'credit-request',
          resourceId: request.id,
          actorUserId: input.operatorUserId,
          resourceVersion: updated.version,
          summary: `Credit request rejected: ${input.note}`,
          metadata: { requestedMinor: request.requestedMinor },
        });

        return updated;
      });

      await this.notifyRequester(input.scope, request.requestedByUserId, {
        title: 'Credit request rejected',
        body: input.note,
        severity: 'Warning',
        dedupeKey: `credit-request:${request.id}`,
      });

      return { request: this.toRequestView(rejected), resumedRuns: 0 };
    }

    const approvedMinor = input.approvedMinor as number;

    // The grant first, then the movement, then the request — so a failure leaves a grant with no
    // balance behind it (visible and harmless) rather than a balance with no grant explaining it.
    const grant = await this.grant({
      scope: input.scope,
      actorUserId: input.operatorUserId,
      source: 'TopUp',
      amountMinor: approvedMinor,
      effectiveFrom,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      reason: `Approved credit request: ${request.reason}`,
      ...(input.reference === undefined ? {} : { reference: input.reference }),
      creditRequestId: request.id,
    });

    const decided = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.creditRequest.update({
        where: { id: request.id },
        data: {
          state: 'Approved',
          approvedMinor,
          decidedByUserId: input.operatorUserId,
          decidedAt: new Date(),
          decisionNote: input.note,
          effectiveFrom,
          grantId: grant.id,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.request_approved',
        resourceType: 'credit-request',
        resourceId: request.id,
        actorUserId: input.operatorUserId,
        resourceVersion: updated.version,
        summary:
          `Approved ${approvedMinor} of the ${request.requestedMinor} requested, effective ` +
          `${effectiveFrom.toISOString()}.` +
          (input.reference === undefined ? '' : ` Reference ${input.reference}.`),
        metadata: {
          requestedMinor: request.requestedMinor,
          approvedMinor,
          // Recorded explicitly so "was this adjusted" is answerable without arithmetic.
          adjusted: approvedMinor !== request.requestedMinor,
          reference: input.reference ?? '',
          expires: expiresAt === undefined ? 'never' : expiresAt.toISOString(),
        },
      });

      return updated;
    });

    await this.notifyRequester(input.scope, request.requestedByUserId, {
      title: 'Credit request approved',
      body:
        `${approvedMinor} ${request.currency} added, effective ${effectiveFrom.toISOString()}.` +
        (approvedMinor === request.requestedMinor
          ? ''
          : ` This is an adjusted amount; you asked for ${request.requestedMinor}.`),
      severity: 'Info',
      dedupeKey: `credit-request:${request.id}`,
    });

    // The prompt's "eligible runs blocked only by exhausted allowance can resume after effective
    // balance". A future-dated grant has not taken effect, so nothing resumes yet.
    const resumedRuns =
      effectiveFrom.getTime() <= Date.now()
        ? await this.resumeRunsBlockedByBudget(input.scope, input.operatorUserId)
        : 0;

    return { request: this.toRequestView(decided), resumedRuns };
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * Add a lot of credit.
   *
   * Used by the approval path above and directly by Finance for promotional or manual credit —
   * the prompt's "refunds/promotional/manual adjustments". The `source` decides the ledger kind
   * (`GRANT_LEDGER_KIND`), which is how a promotional credit stays out of a revenue figure.
   */
  async grant(input: {
    scope: TenantScope;
    actorUserId: string;
    source: GrantSource;
    amountMinor: number;
    effectiveFrom: Date;
    expiresAt?: Date | undefined;
    reason: string;
    reference?: string | undefined;
    creditRequestId?: string | undefined;
    /**
     * The clock this grant is being judged against. Defaults to now.
     *
     * Passed by `applyPeriodReset` and `applyPlanChange`, which are given a period boundary and
     * must not have their own grant read a different time than they did.
     */
    now?: Date | undefined;
  }): Promise<CreditGrantView> {
    if (!GRANT_SOURCES.includes(input.source)) {
      throw new BadRequestException(`Unknown grant source: ${input.source}`);
    }
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new BadRequestException('A grant must be a positive whole amount.');
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why the credit was granted.');
    }

    const wallet = await this.cost.companyWallet(input.scope);
    // The caller's clock, not the wall clock — see the note on `now` in the input.
    const live = input.effectiveFrom.getTime() <= (input.now ?? new Date()).getTime();

    // **One transaction for the row, the movement and the audit.**
    //
    // `runInTenantTransaction` joins an open transaction rather than nesting, so the
    // `adjustAllowance` call inside this block shares it. That matters: three separate
    // transactions could leave a grant row with no balance behind it, and a grant the company
    // can see but cannot spend is worse than a failure — `reconcile` would find nothing wrong,
    // because neither the wallet nor the ledger moved, while the grants list showed live credit.
    const created = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.creditGrant.create({
        data: {
          tenantId: input.scope.tenantId,
          walletId: wallet.id,
          source: input.source,
          amountMinor: input.amountMinor,
          currency: wallet.currency,
          effectiveFrom: input.effectiveFrom,
          reason: input.reason,
          createdByUserId: input.actorUserId,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          ...(input.creditRequestId === undefined
            ? {}
            : { creditRequestId: input.creditRequestId }),
        },
      });

      // **Only a grant that has taken effect moves the allowance.** A future-dated one is
      // recorded and applied when its date arrives, which is what stops a company spending
      // credit before the date Finance agreed.
      if (live) {
        await this.cost.adjustAllowance({
          scope: input.scope,
          budgetScope: 'Company',
          subjectId: null,
          deltaMinor: input.amountMinor,
          kind: GRANT_LEDGER_KIND[input.source],
          reason: input.reason,
          actorUserId: input.actorUserId,
          ...(input.reference === undefined ? {} : { reference: input.reference }),
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.granted',
        resourceType: 'credit-grant',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary:
          `${input.source} grant of ${input.amountMinor} ${wallet.currency}, effective ` +
          `${input.effectiveFrom.toISOString()}: ${input.reason}`,
        metadata: {
          source: input.source,
          amountMinor: input.amountMinor,
          appliedNow: live,
          expires: input.expiresAt === undefined ? 'never' : input.expiresAt.toISOString(),
          reference: input.reference ?? '',
        },
      });

      return row;
    });

    return this.toGrantView(created);
  }

  /**
   * Withdraw a grant — the prompt's "payment failure after top-up".
   *
   * The allowance goes back down by what the grant added. **The balance may end up below what has
   * already been spent**, and that is correct: the company spent credit it turned out not to have
   * paid for, and the negative-balance policy decides what happens next. Refusing to revoke
   * because the money is gone would leave a company holding credit it never bought.
   */
  async revokeGrant(input: {
    scope: TenantScope;
    actorUserId: string;
    grantId: string;
    reason: string;
  }): Promise<CreditGrantView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why the credit is being withdrawn.');
    }

    const grant = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.creditGrant.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.grantId },
      });
      if (row === null) throw new NotFoundException('No such credit grant.');
      if (row.revokedAt !== null) {
        throw new ConflictException('That grant is already withdrawn.');
      }
      return row;
    });

    const wasLive =
      grant.revokedAt === null &&
      grant.writtenOffAt === null &&
      grant.effectiveFrom.getTime() <= Date.now() &&
      (grant.expiresAt === null || grant.expiresAt.getTime() > Date.now());

    // One transaction again, for the reason in `grant`: a balance reduced without the grant
    // being marked revoked would let the same withdrawal happen twice.
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      if (wasLive) {
        await this.cost.adjustAllowance({
          scope: input.scope,
          budgetScope: 'Company',
          subjectId: null,
          deltaMinor: -grant.amountMinor,
          // `Adjustment`, not `Refund`. In this ledger a `Refund` reduces what has been *used* —
          // money coming back after a charge, such as a provider credit. Withdrawing a grant
          // takes back allowance that was never spent, which is a signed correction. Using
          // `Refund` here would have left the allowance untouched and quietly written off real
          // spend instead, and `Expiry` would have claimed the credit lapsed rather than that
          // the payment failed.
          kind: 'Adjustment',
          reason: input.reason,
          actorUserId: input.actorUserId,
          ...(grant.reference === null ? {} : { reference: grant.reference }),
        });
      }

      const updated = await this.prisma.client.creditGrant.update({
        where: { id: grant.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: input.actorUserId,
          revokeReason: input.reason,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.grant_revoked',
        resourceType: 'credit-grant',
        resourceId: grant.id,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `Credit grant of ${grant.amountMinor} withdrawn: ${input.reason}`,
        metadata: {
          amountMinor: grant.amountMinor,
          source: grant.source,
          allowanceReduced: wasLive,
        },
      });

      return this.toGrantView(updated);
    });
  }

  async listGrants(scope: TenantScope): Promise<CreditGrantView[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.prisma.client.creditGrant.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { effectiveFrom: 'desc' },
        take: 200,
      });
      return rows.map((row) => this.toGrantView(row));
    });
  }

  // -------------------------------------------------------------------------
  // Reallocation
  // -------------------------------------------------------------------------

  /**
   * Move budget between levels **without increasing the total**.
   *
   * The prompt's constraint in its own words: "Reallocate existing company budget between
   * departments/objectives within delegated limits **without purchasing new credits; this does
   * not increase the total commercial allowance**."
   *
   * So it is always a pair of movements, the same amount, and the source must have it
   * *uncommitted* — moving budget that is reserved or already spent would create allowance out of
   * nothing. Both movements go through the cost engine, so the ledger shows the two halves.
   */
  async reallocate(input: {
    scope: TenantScope;
    actorUserId: string;
    from: { budgetScope: BudgetScope; subjectId: string | null };
    to: { budgetScope: BudgetScope; subjectId: string | null };
    amountMinor: number;
    reason: string;
  }): Promise<{ fromRemainingMinor: number; toAllowanceMinor: number }> {
    const source = await this.cost.walletSnapshot(
      input.scope,
      input.from.budgetScope,
      input.from.subjectId,
    );
    if (source === null) {
      throw new NotFoundException('That budget does not exist, so it has nothing to move.');
    }

    const destination = await this.cost.walletSnapshot(
      input.scope,
      input.to.budgetScope,
      input.to.subjectId,
    );

    const validation = validateReallocation({
      amountMinor: input.amountMinor,
      fromRemainingMinor: source.remainingMinor,
      fromWalletId: source.id,
      toWalletId: destination?.id ?? 'new',
    });
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }

    if (input.reason.trim() === '') {
      throw new BadRequestException('Say why the budget is being moved.');
    }

    // Out first. If the second movement fails, the company is left with *less* available than it
    // had — visible and correctable — rather than more, which would be allowance from nowhere.
    const out = await this.cost.adjustAllowance({
      scope: input.scope,
      budgetScope: input.from.budgetScope,
      subjectId: input.from.subjectId,
      deltaMinor: -input.amountMinor,
      kind: 'Reallocation',
      reason: `Moved out: ${input.reason}`,
      actorUserId: input.actorUserId,
    });

    const into = await this.cost.adjustAllowance({
      scope: input.scope,
      budgetScope: input.to.budgetScope,
      subjectId: input.to.subjectId,
      deltaMinor: input.amountMinor,
      kind: 'Reallocation',
      reason: `Moved in: ${input.reason}`,
      actorUserId: input.actorUserId,
    });

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.reallocated',
        resourceType: 'budget-wallet',
        resourceId: into.walletId,
        actorUserId: input.actorUserId,
        summary:
          `Moved ${input.amountMinor} from ${input.from.budgetScope} to ${input.to.budgetScope}: ` +
          input.reason,
        metadata: {
          amountMinor: input.amountMinor,
          fromWalletId: out.walletId,
          toWalletId: into.walletId,
          // Stated in the trail: this did not buy anything.
          increasesTotalAllowance: false,
        },
      }),
    );

    return { fromRemainingMinor: out.allowanceMinor, toAllowanceMinor: into.allowanceMinor };
  }

  // -------------------------------------------------------------------------
  // The periodic edge cases
  // -------------------------------------------------------------------------

  /**
   * Apply the monthly reset and carry-forward — the first two commercial edge cases.
   *
   * Expressed as grants rather than as a balance assignment: the unused part becomes a
   * `CarryForward` grant (or does not, under `Forfeit`), and the new period's plan allowance
   * becomes a `PlanAllowance` grant. A reset that assigned a number directly would move money
   * with nothing explaining it, and `reconcile` would find drift it could not attribute.
   */
  async applyPeriodReset(input: {
    scope: TenantScope;
    actorUserId: string;
    now?: Date | undefined;
  }): Promise<{
    reset: boolean;
    carriedForwardMinor: number;
    /** What the company can spend in the new period: the plan allowance plus whatever carried. */
    newAllowanceMinor: number;
    reason: string;
  }> {
    const now = input.now ?? new Date();
    const policy = await this.policy(input.scope);

    if (policy.resetPolicy === 'NoReset') {
      return {
        reset: false,
        carriedForwardMinor: 0,
        newAllowanceMinor: 0,
        reason: 'This company runs a rolling balance rather than a resetting allowance.',
      };
    }

    if (policy.nextResetAt === null || now.getTime() < new Date(policy.nextResetAt).getTime()) {
      return {
        reset: false,
        carriedForwardMinor: 0,
        newAllowanceMinor: 0,
        reason: `Not due until ${policy.nextResetAt ?? 'a date nobody has set'}.`,
      };
    }

    const wallet = await this.cost.walletSnapshot(input.scope, 'Company', null);
    if (wallet === null) {
      return {
        reset: false,
        carriedForwardMinor: 0,
        newAllowanceMinor: 0,
        reason: 'This company has no AI budget to reset.',
      };
    }

    const planAllowance = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.tenantAiBudgetPolicy.findUnique({
        where: { tenantId: input.scope.tenantId },
      }),
    );
    // **No plan allowance on record, no reset.** Provisioning writes this row in the same
    // transaction as the company, so its absence means something is wrong rather than that the
    // company's monthly budget is zero — and resetting against zero would write off the whole
    // allowance and grant nothing back, which is the most expensive possible way to be wrong.
    if (planAllowance === null) {
      return {
        reset: false,
        carriedForwardMinor: 0,
        newAllowanceMinor: wallet.allowanceMinor,
        reason:
          'This company has no monthly plan allowance on record, so there is nothing to reset ' +
          'to. Set the plan allowance first.',
      };
    }
    const planAllowanceMinor = planAllowance.monthlyAllowanceMinor;

    const carried = carryForwardMinor({
      policy: {
        carryForwardPolicy: policy.carryForwardPolicy,
        carryForwardCapMinor: policy.carryForwardCapMinor,
      },
      unusedMinor: wallet.remainingMinor,
    });

    // ---- What actually moves, and why it is not "clear the allowance and start again" ----
    //
    // `usedMinor` is **cumulative**: the ledger is immutable, so a spend that happened stays
    // recorded. That makes the reset subtler than it first looks. Writing off the whole previous
    // allowance and granting a fresh one would leave last period's spend still subtracted from
    // this period's budget — a company that used 10,000 of 100,000 would start the new month
    // with 90,000, losing the amount it had already been charged for.
    //
    // So what lapses is **the unused amount that is not carried forward**, and nothing else:
    //
    //   * `Forfeit`       — write off all 90,000 unused, grant 100,000. Remaining becomes 100,000.
    //   * `CarryForward`  — write off nothing, grant 100,000. Remaining becomes 190,000.
    //   * `...Capped`(20k) — write off 70,000, grant 100,000. Remaining becomes 120,000.
    //
    // Each is the figure a customer would check with a calculator, which is the test.
    const forfeited = Math.max(0, wallet.remainingMinor - carried);

    if (forfeited > 0) {
      await this.cost.adjustAllowance({
        scope: input.scope,
        budgetScope: 'Company',
        subjectId: null,
        // A magnitude: `Expiry` is the kind that takes allowance away.
        deltaMinor: forfeited,
        kind: 'Expiry',
        reason:
          `Period reset: ${forfeited} of ${wallet.remainingMinor} unused lapsed under the ` +
          `${policy.carryForwardPolicy} policy.`,
        actorUserId: input.actorUserId,
      });
    }

    if (planAllowanceMinor > 0) {
      await this.grant({
        scope: input.scope,
        actorUserId: input.actorUserId,
        source: 'PlanAllowance',
        amountMinor: planAllowanceMinor,
        effectiveFrom: now,
        reason: 'Plan allowance for the new period.',
        // The reset's clock, so the allowance it grants is live for the period it opened.
        now,
      });
    }

    // **`usedMinor` deliberately does not reset.** It is derived from an immutable ledger, and
    // `reconcile` replays that ledger to check the maintained balance — so zeroing it here would
    // report drift for as long as the company existed unless a compensating entry were written,
    // and the only kind that reduces `used` is `Refund`, which would claim last period's spend
    // came back. What resets is the *period*, and the allowance arithmetic above accounts for a
    // cumulative `used` instead of fighting it.
    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.companyCreditPolicy.update({
        where: { tenantId: input.scope.tenantId },
        data: {
          periodStart: now,
          nextResetAt: this.nextMonthStart(now),
          version: { increment: 1 },
        },
      });

      await this.prisma.client.budgetWallet.updateMany({
        where: { tenantId: input.scope.tenantId },
        data: { periodStart: now, resetsAt: row.nextResetAt },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'credits.period_reset',
        resourceType: 'company-credit-policy',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceVersion: row.version,
        summary:
          `Period reset. ${carried} carried forward under ${policy.carryForwardPolicy}; ` +
          `plan allowance ${planAllowanceMinor} applied.`,
        metadata: {
          carriedForwardMinor: carried,
          planAllowanceMinor,
          carryForwardPolicy: policy.carryForwardPolicy,
          previousUnusedMinor: wallet.remainingMinor,
        },
      });
    });

    // Reported as **spendable**, not as an allowance total: with a cumulative `usedMinor` the
    // allowance figure alone tells a reader nothing, and "how much can we spend now" is the
    // question a reset is asked.
    return {
      reset: true,
      carriedForwardMinor: carried,
      newAllowanceMinor: planAllowanceMinor + carried,
      reason:
        `Reset applied under ${policy.carryForwardPolicy}: plan allowance ${planAllowanceMinor}, ` +
        `carried ${carried}, lapsed ${forfeited}.`,
    };
  }

  /**
   * Write off grants that have reached their expiry — the top-up expiry edge case.
   *
   * One ledger entry per grant, so a statement says which lot expired and for how much. Marked
   * written-off so a second sweep cannot charge the same expiry twice.
   */
  async expireGrants(input: {
    scope: TenantScope;
    actorUserId: string;
    now?: Date | undefined;
  }): Promise<{ expired: number; totalMinor: number }> {
    const now = input.now ?? new Date();

    const grants = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.creditGrant.findMany({
        where: { tenantId: input.scope.tenantId, writtenOffAt: null, revokedAt: null },
        take: 500,
      }),
    );

    const due = grantsToExpire(
      grants.map((grant) => ({
        id: grant.id,
        amountMinor: grant.amountMinor,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        revokedAt: grant.revokedAt?.toISOString() ?? null,
        writtenOff: grant.writtenOffAt !== null,
      })),
      now,
    );

    let totalMinor = 0;
    for (const grant of due) {
      await this.cost.adjustAllowance({
        scope: input.scope,
        budgetScope: 'Company',
        subjectId: null,
        deltaMinor: grant.amountMinor,
        kind: 'Expiry',
        reason: `Credit grant ${grant.id} reached its expiry.`,
        actorUserId: input.actorUserId,
      });

      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.prisma.client.creditGrant.update({
          where: { id: grant.id },
          data: { writtenOffAt: now, version: { increment: 1 } },
        }),
      );

      totalMinor += grant.amountMinor;
    }

    if (due.length > 0) {
      this.logger.log(
        `Expired ${due.length} credit grant(s) worth ${totalMinor} for ${input.scope.tenantId}.`,
      );
    }

    return { expired: due.length, totalMinor };
  }

  /**
   * Apply a plan change mid-cycle.
   *
   * The policy decides whether it takes effect now, in full or pro-rated, or at the next cycle.
   * The difference is one adjustment entry rather than a new allowance assignment, so the
   * statement shows the change rather than a number appearing.
   */
  async applyPlanChange(input: {
    scope: TenantScope;
    actorUserId: string;
    newPlanAllowanceMinor: number;
    reason: string;
    now?: Date | undefined;
  }): Promise<{ applied: boolean; allowanceMinor: number; reason: string }> {
    const now = input.now ?? new Date();
    const policy = await this.policy(input.scope);
    const wallet = await this.cost.walletSnapshot(input.scope, 'Company', null);

    if (wallet === null) {
      throw new NotFoundException('This company has no AI budget for a plan change to apply to.');
    }

    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: policy.planChangePolicy },
      currentAllowanceMinor: wallet.allowanceMinor,
      newPlanAllowanceMinor: input.newPlanAllowanceMinor,
      periodStart: new Date(policy.periodStart),
      periodEnd: new Date(policy.nextResetAt ?? this.nextMonthStart(new Date(policy.periodStart))),
      at: now,
    });

    if (!outcome.appliesNow) {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'credits.plan_change_deferred',
          resourceType: 'budget-wallet',
          resourceId: wallet.id,
          actorUserId: input.actorUserId,
          summary: `Plan change deferred to the next cycle: ${outcome.reason}`,
          metadata: {
            newPlanAllowanceMinor: input.newPlanAllowanceMinor,
            planChangePolicy: policy.planChangePolicy,
          },
        }),
      );
      return { applied: false, allowanceMinor: wallet.allowanceMinor, reason: outcome.reason };
    }

    const delta = outcome.allowanceMinor - wallet.allowanceMinor;
    if (delta !== 0) {
      await this.cost.adjustAllowance({
        scope: input.scope,
        budgetScope: 'Company',
        subjectId: null,
        deltaMinor: delta,
        kind: 'Adjustment',
        reason: `Plan change: ${input.reason} ${outcome.reason}`,
        actorUserId: input.actorUserId,
      });
    }

    return { applied: true, allowanceMinor: outcome.allowanceMinor, reason: outcome.reason };
  }

  /**
   * Whether a negative balance should stop new work, under this company's policy.
   *
   * Exposed so the run engine and any screen give the same answer. Separate from the hard stop,
   * which is about a percentage of the allowance; this is about having actually spent more than
   * exists, which happens because a provider's usage can exceed the reserved estimate.
   */
  async negativeBalanceStatus(scope: TenantScope): Promise<{ blocks: boolean; reason: string }> {
    const policy = await this.policy(scope);
    const wallet = await this.cost.walletSnapshot(scope, 'Company', null);
    if (wallet === null) {
      return { blocks: false, reason: 'No AI budget is configured.' };
    }
    return negativeBalanceBlocks({
      policy: {
        negativeBalancePolicy: policy.negativeBalancePolicy,
        negativeBalanceGraceMinor: policy.negativeBalanceGraceMinor,
      },
      remainingMinor: wallet.remainingMinor,
    });
  }

  // -------------------------------------------------------------------------
  // Resuming after a top-up
  // -------------------------------------------------------------------------

  /**
   * Re-queue runs blocked **only** by an exhausted allowance.
   *
   * The approved wording is narrow and this keeps it narrow: "eligible Engine Agent runs may
   * resume", "blocked only because the credit/allowance was exhausted", "subject to all other
   * permissions, approvals and limits". A run blocked for any other reason stays blocked —
   * buying credits must not quietly clear a governance decision.
   *
   * Resuming means moving it back to `Queued`, not running it: every other check happens again
   * when it is picked up, which is what "subject to all other permissions" means in practice.
   */
  async resumeRunsBlockedByBudget(scope: TenantScope, actorUserId: string): Promise<number> {
    const blocked = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.agentRun.findMany({
        where: { tenantId: scope.tenantId, state: 'BlockedByBudget' },
        take: 200,
      }),
    );

    let resumed = 0;
    for (const run of blocked) {
      const decision = mayResumeAfterTopUp({ runState: run.state, blockedReason: null });
      if (!decision.resumable) continue;

      await this.prisma.runInTenantTransaction(scope, async () => {
        await this.prisma.client.agentRun.update({
          where: { id: run.id },
          data: {
            state: 'Queued',
            // Cleared: the new attempt takes its own reservation, and a stale one would make
            // `run_started_after_it_was_reserved` fail the way it did at Prompt 26.
            reservedAt: null,
            startedAt: null,
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(scope.tenantId, {
          action: 'credits.run_resumed',
          resourceType: 'agent-run',
          resourceId: run.id,
          actorUserId,
          summary:
            'Re-queued after a credit top-up. It was blocked only by an exhausted allowance, ' +
            'and every other permission, approval and limit applies again when it runs.',
          metadata: { previousState: 'BlockedByBudget' },
        });
      });

      resumed += 1;
    }

    return resumed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The first instant of the month after this one, in UTC. */
  private nextMonthStart(from: Date): Date {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }

  private async loadRequest(scope: TenantScope, requestId: string) {
    const row = await this.prisma.client.creditRequest.findFirst({
      where: { tenantId: scope.tenantId, id: requestId },
    });
    if (row === null) throw new NotFoundException('No such credit request.');
    return row;
  }

  private async notifyRequester(
    scope: TenantScope,
    recipientUserId: string,
    input: { title: string; body: string; severity: 'Info' | 'Warning'; dedupeKey: string },
  ): Promise<void> {
    try {
      await this.notifications.raise({
        tenantId: scope.tenantId,
        recipientUserId,
        kind: 'BudgetThreshold',
        severity: input.severity,
        title: input.title,
        body: input.body,
        deepLink: '/settings?category=tokens',
        resourceType: 'credit-request',
        dedupeKey: input.dedupeKey,
      });
    } catch (cause) {
      // A notification must never fail a credit decision, for the same reason it must never fail
      // a reservation (ADR-162). The money has moved and the audit trail records it.
      this.logger.debug(
        `Credit notification not delivered to ${recipientUserId}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private toRequestView(row: {
    id: string;
    state: string;
    requestedMinor: number;
    approvedMinor: number | null;
    currency: string;
    reason: string;
    billingChoice: string | null;
    requestedByUserId: string;
    requestedAt: Date;
    decidedByUserId: string | null;
    decidedAt: Date | null;
    decisionNote: string | null;
    effectiveFrom: Date | null;
    expiresAt: Date | null;
    reference: string | null;
    grantId: string | null;
  }): CreditRequestView {
    return {
      id: row.id,
      state: row.state as CreditRequestState,
      requestedMinor: row.requestedMinor,
      approvedMinor: row.approvedMinor,
      currency: row.currency,
      reason: row.reason,
      billingChoice: row.billingChoice as BillingChoice | null,
      requestedByUserId: row.requestedByUserId,
      requestedAt: row.requestedAt.toISOString(),
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      reference: row.reference,
      grantId: row.grantId,
    };
  }

  private toGrantView(row: {
    id: string;
    source: string;
    amountMinor: number;
    currency: string;
    effectiveFrom: Date;
    expiresAt: Date | null;
    writtenOffAt: Date | null;
    revokedAt: Date | null;
    revokeReason: string | null;
    reason: string;
    reference: string | null;
  }): CreditGrantView {
    const now = Date.now();
    return {
      id: row.id,
      source: row.source as GrantSource,
      amountMinor: row.amountMinor,
      currency: row.currency,
      effectiveFrom: row.effectiveFrom.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      writtenOffAt: row.writtenOffAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokeReason: row.revokeReason,
      reason: row.reason,
      reference: row.reference,
      live:
        row.revokedAt === null &&
        row.effectiveFrom.getTime() <= now &&
        (row.expiresAt === null || row.expiresAt.getTime() > now),
    };
  }
}
