import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  BUDGET_SCOPE_LABELS,
  combineLevels,
  committedPercent,
  crossedThreshold,
  decideLevel,
  DEFAULT_COST_THRESHOLD_PERCENTS,
  estimateMinor,
  LEDGER_EFFECT,
  projectedExhaustion,
  reconcileBalance,
  nextReset,
  remainingMinor,
  RESERVATION_EXPIRY_MINUTES,
  reservationHasExpired,
  scopesToCheck,
  type BudgetScope,
  type CostThreshold,
  type LedgerEntryKind,
  type LogicalModelProfile,
  type ReconciliationFinding,
  type SpendCheckLevel,
  type SpendCheckOutcome,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { getCorrelationId } from '../request-context/request-context.js';
import { type TenantScope } from '../persistence/tenant-context.js';
import { tokensFrom, ubossTokenMinorUnits } from './uboss-token.js';

/** What a caller wants to spend on. */
export interface SpendContext {
  scope: TenantScope;
  departmentId?: string | null | undefined;
  objectiveId?: string | null | undefined;
  engineAgentId?: string | null | undefined;
  agentRunId?: string | null | undefined;
  /**
   * Whose request this is, so their own allowance is one of the limits it must satisfy.
   *
   * Without it, a company's budget was the only thing standing between one employee and the
   * whole month's AI: every other scope describes *work* — a department, an objective, an agent —
   * and none of them is keyed to a person. One employee running an agent in a loop could exhaust
   * the company in an afternoon, and everybody else would then be refused for something they did
   * not do.
   *
   * Null for work the engine does on its own behalf. A person who has no allowance set is
   * unconstrained by this level, exactly as before.
   */
  actorUserId?: string | null | undefined;
  logicalProfile: LogicalModelProfile;
  purpose: string;
}

/** One held reservation, as the caller needs to see it. */
export interface ReservationView {
  id: string;
  state: string;
  estimateMinor: number;
  settledMinor: number | null;
  currency: string;
  heldAt: string;
  closedAt: string | null;
  closeReason: string | null;
}

/** A wallet as the Tokens & Cost screen shows it. */
export interface WalletView {
  id: string;
  scope: BudgetScope;
  scopeLabel: string;
  subjectId: string | null;
  currency: string;
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
  remainingMinor: number;
  percent: number;
  threshold: CostThreshold | null;
  periodStart: string;
  resetsAt: string | null;
  expiresAt: string | null;
  projectedExhaustion: { at: string; daysAway: number } | null;
}

/** The threshold percentages in force for a company. */
export interface ThresholdPercents {
  Information: number;
  Warning: number;
  Critical: number;
  HardStop: number;
}

/**
 * The Token/Cost Engine — Prompt 30.
 *
 * ## The flow, and where the safety is
 *
 * §20: **Check → Estimate → Reserve → Execute → Provider actual usage → Settle → Release unused
 * reserve → Reconcile.**
 *
 * The concurrency safety lives in exactly one place: `reserve` takes a **row lock on every wallet
 * in the hierarchy, in a fixed outermost-first order**, re-reads the balances inside that lock,
 * decides, and writes. Two agents racing for the last of a budget therefore serialise on the
 * company wallet row, and the second one sees the first one's reservation.
 *
 * That ordering is not incidental. Two transactions locking the same two rows in opposite orders
 * deadlock, and the only reason they cannot here is that `scopesToCheck` returns them in one
 * deterministic order for every caller.
 *
 * ## Redis is not in this path
 *
 * The prompt permits Redis to assist with locking or counters and says **PostgreSQL is the source
 * of truth**. It is not used: a correct `SELECT ... FOR UPDATE` on the row that holds the balance
 * is simpler than a distributed lock, and a Redis counter that drifted from the ledger would be a
 * second source of truth with no reconciliation story. If throughput ever demands it, the seam to
 * add it at is `reserve`, and the ledger stays the arbiter.
 *
 * ## Nothing here spends money without a record
 *
 * Every movement of a balance writes a ledger entry in the same transaction. There is no method
 * that adjusts `usedMinor` directly, which is what makes `reconcile` meaningful — a drift means
 * either a write outside this service or a bug in it, and both need a person.
 */
/**
 * The two kinds whose amount is legitimately signed, matching
 * `ledger_amount_sign_matches_its_kind`: a correction can go either way, and a reallocation is a
 * negative entry on one budget and a positive one on another. Every other kind carries its
 * direction in `LEDGER_EFFECT` and its amount as a magnitude.
 */
const LEDGER_KINDS_WITH_A_SIGNED_AMOUNT: ReadonlySet<LedgerEntryKind> = new Set([
  'Adjustment',
  'Reallocation',
]);

@Injectable()
export class CostEngineService {
  private readonly logger = new Logger(CostEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
    private readonly notifications: NotificationService,
  ) {}

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  /**
   * The company wallet, created on first use.
   *
   * Created lazily rather than at provisioning, because a company's allowance comes from its
   * subscription and that can change before anybody spends anything. The allowance is seeded from
   * `tenant_ai_budget_policies`, which provisioning already writes — reused rather than
   * duplicated, so there is one answer to "what did this company buy".
   */
  async companyWallet(scope: TenantScope): Promise<{ id: string; currency: string }> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.budgetWallet.findFirst({
        where: { tenantId: scope.tenantId, scope: 'Company', subjectId: null },
      });
      if (existing !== null) return { id: existing.id, currency: existing.currency };

      const policy = await this.prisma.client.tenantAiBudgetPolicy.findUnique({
        where: { tenantId: scope.tenantId },
      });

      const created = await this.prisma.client.budgetWallet.create({
        data: {
          tenantId: scope.tenantId,
          scope: 'Company',
          currency: 'INR',
          // The allowance the company was provisioned with. Zero when no policy exists, which
          // the hard stop then treats as "nothing configured" rather than "unlimited".
          allowanceMinor: policy?.monthlyAllowanceMinor ?? 0,
          periodStart: new Date(),
        },
      });

      if ((policy?.monthlyAllowanceMinor ?? 0) > 0) {
        // The opening balance is a ledger entry like any other, so a statement read from the
        // first row explains the whole balance rather than starting mid-story.
        await this.appendEntry(scope.tenantId, {
          walletId: created.id,
          kind: 'TopUp',
          amountMinor: policy?.monthlyAllowanceMinor ?? 0,
          currency: created.currency,
          reason: 'Opening allowance from the provisioned AI budget policy.',
          balanceAfter: {
            allowanceMinor: created.allowanceMinor,
            usedMinor: 0,
            reservedMinor: 0,
          },
        });
      }

      return { id: created.id, currency: created.currency };
    });
  }

  /**
   * Every wallet for a company, with its numbers — §20's "Credit / allowance display" and its
   * drill-down.
   */
  async wallets(scope: TenantScope): Promise<WalletView[]> {
    const percents = await this.thresholds(scope);

    return this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.prisma.client.budgetWallet.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
      });

      const now = new Date();
      return rows.map((row) => this.toWalletView(row, percents, now));
    });
  }

  /** Set or change a budget at one level. Writes a ledger entry for the difference. */
  async setAllowance(input: {
    scope: TenantScope;
    actorUserId: string;
    budgetScope: BudgetScope;
    subjectId: string | null;
    allowanceMinor: number;
    reason: string;
    /**
     * How often this allowance comes back. `None` — the default — is a one-off.
     *
     * "Give this person ₹500 a day" is one sentence and should be one call, so the amount being
     * set is also the amount each period grants. The alternative was an administrator setting an
     * allowance and then separately telling it to recur, which is two ways to say one thing and
     * one of them always gets forgotten.
     */
    resetCadence?: 'None' | 'Daily' | 'Weekly' | 'Monthly' | undefined;
  }): Promise<WalletView> {
    if (input.allowanceMinor < 0) {
      throw new BadRequestException('An allowance cannot be negative.');
    }

    const cadence = input.resetCadence ?? 'None';
    if (cadence !== 'None' && input.allowanceMinor === 0) {
      throw new BadRequestException(
        'A recurring allowance of nothing would refuse every call and come back tomorrow to ' +
          'refuse them again. Set an amount, or remove the allowance instead.',
      );
    }
    if (input.budgetScope !== 'Company' && input.subjectId === null) {
      throw new BadRequestException(
        `A ${BUDGET_SCOPE_LABELS[input.budgetScope]} budget must name what it is for.`,
      );
    }

    const percents = await this.thresholds(input.scope);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const company = await this.lockOrCreateWallet(input.scope.tenantId, 'Company', null);
      const wallet =
        input.budgetScope === 'Company'
          ? company
          : await this.lockOrCreateWallet(
              input.scope.tenantId,
              input.budgetScope,
              input.subjectId,
              company.currency,
            );

      const now = new Date();
      /*
       * The cadence travels with the amount.
       *
       * Written on every call, including the one where the amount did not change — an
       * administrator switching a standing allowance to "every day" has changed something, even
       * though the number is the same, and treating that as a no-op would silently discard it.
       */
      const recurrence =
        cadence === 'None'
          ? { resetCadence: 'None', recurringGrantMinor: null, resetsAt: null }
          : {
              resetCadence: cadence,
              recurringGrantMinor: input.allowanceMinor,
              resetsAt: nextReset(now, cadence),
            };

      const delta = input.allowanceMinor - wallet.allowanceMinor;
      if (delta === 0) {
        // Re-read for the full row: the lock helper returns only the columns the decision needs,
        // deliberately, so the view is built from a normal read rather than by widening it.
        const unchanged = await this.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: { ...recurrence, version: { increment: 1 } },
        });
        return this.toWalletView(unchanged, percents, now);
      }

      const updated = await this.prisma.client.budgetWallet.update({
        where: { id: wallet.id },
        data: { allowanceMinor: input.allowanceMinor, ...recurrence, version: { increment: 1 } },
      });

      await this.appendEntry(input.scope.tenantId, {
        walletId: wallet.id,
        // Reallocation rather than TopUp: changing a department's share of an allowance the
        // company already bought does not increase the commercial allowance, and §20 is explicit
        // that the two are different things.
        kind: input.budgetScope === 'Company' ? 'Adjustment' : 'Reallocation',
        amountMinor: delta,
        currency: wallet.currency,
        actorUserId: input.actorUserId,
        reason: input.reason,
        balanceAfter: {
          allowanceMinor: updated.allowanceMinor,
          usedMinor: updated.usedMinor,
          reservedMinor: updated.reservedMinor,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'cost.allowance_set',
        resourceType: 'budget-wallet',
        resourceId: wallet.id,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary:
          `${BUDGET_SCOPE_LABELS[input.budgetScope]} allowance set to ` +
          `${input.allowanceMinor} minor units: ${input.reason}`,
        metadata: {
          budgetScope: input.budgetScope,
          deltaMinor: delta,
          allowanceMinor: input.allowanceMinor,
        },
      });

      return this.toWalletView(updated, percents, new Date());
    });
  }

  /**
   * Move an allowance by a signed delta, writing the ledger entry that explains it.
   *
   * **The one primitive anything outside this service may use to move money**, added at Prompt 31
   * so credit grants, revocations, resets, carry-forward and plan changes all go through the same
   * locked wallet update and the same ledger — rather than each growing its own way to change a
   * balance. There is deliberately no method that moves a balance *without* an entry.
   *
   * The caller supplies the ledger kind, because the kind is the caller's meaning: a purchased
   * top-up and a promotional credit both add allowance and a revenue report must tell them apart
   * (`GRANT_LEDGER_KIND`).
   *
   * Takes the row lock for the same reason `reserve` does — a grant landing while a reservation
   * is being taken must not read a stale balance.
   */
  async adjustAllowance(input: {
    scope: TenantScope;
    budgetScope: BudgetScope;
    subjectId: string | null;
    deltaMinor: number;
    kind: LedgerEntryKind;
    reason: string;
    actorUserId?: string | undefined;
    reference?: string | undefined;
  }): Promise<{ walletId: string; allowanceMinor: number }> {
    if (!Number.isInteger(input.deltaMinor) || input.deltaMinor === 0) {
      throw new BadRequestException('An allowance movement must be a non-zero whole amount.');
    }

    // ---- Direction belongs to the kind, magnitude to the amount ----
    //
    // `LEDGER_EFFECT` is the vocabulary: an `Expiry` of 90,000 *reduces* the allowance by 90,000,
    // and the entry records 90,000 — which is also what the database insists on, because
    // `ledger_amount_sign_matches_its_kind` allows a signed amount for `Adjustment` and
    // `Reallocation` only. Moving the wallet by the raw delta instead would have written an
    // `Expiry` that `replayLedger` reads back as an *increase*, so the maintained balance and the
    // ledger would disagree by twice the amount and `reconcile` would report drift it could not
    // explain. The two arithmetics have to be the same arithmetic.
    const effect = LEDGER_EFFECT[input.kind].allowance;
    if (effect === 0) {
      throw new BadRequestException(
        `A ${input.kind} entry does not move an allowance — it moves what has been used or ` +
          'reserved. Record it through the flow that owns that movement.',
      );
    }
    if (!LEDGER_KINDS_WITH_A_SIGNED_AMOUNT.has(input.kind) && input.deltaMinor < 0) {
      throw new BadRequestException(
        `A ${input.kind} amount is a magnitude, not a signed movement: the kind already says ` +
          'which way the allowance goes.',
      );
    }
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'Say why the allowance moved. An unexplained movement cannot be reviewed.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const wallet = await this.lockOrCreateWallet(
        input.scope.tenantId,
        input.budgetScope,
        input.subjectId,
      );

      const nextAllowance = wallet.allowanceMinor + effect * input.deltaMinor;
      if (nextAllowance < 0) {
        // Refused rather than clamped: an allowance below zero is not a debt, it is an
        // arithmetic mistake, and clamping would silently lose the difference.
        throw new ConflictException(
          `That would take the ${BUDGET_SCOPE_LABELS[input.budgetScope].toLowerCase()} to ` +
            `${nextAllowance}. An allowance cannot be negative — what is already spent stays ` +
            'recorded as spent.',
        );
      }

      const updated = await this.prisma.client.budgetWallet.update({
        where: { id: wallet.id },
        data: { allowanceMinor: nextAllowance, version: { increment: 1 } },
      });

      await this.appendEntry(input.scope.tenantId, {
        walletId: wallet.id,
        kind: input.kind,
        amountMinor: input.deltaMinor,
        currency: wallet.currency,
        reason: input.reason,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        balanceAfter: {
          allowanceMinor: updated.allowanceMinor,
          usedMinor: updated.usedMinor,
          reservedMinor: updated.reservedMinor,
        },
      });

      return { walletId: wallet.id, allowanceMinor: updated.allowanceMinor };
    });
  }

  /** One wallet's current numbers, for a caller that needs to decide against them. */
  async walletSnapshot(
    scope: TenantScope,
    budgetScope: BudgetScope,
    subjectId: string | null,
  ): Promise<{
    id: string;
    allowanceMinor: number;
    usedMinor: number;
    reservedMinor: number;
    remainingMinor: number;
    currency: string;
  } | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const row = await this.prisma.client.budgetWallet.findFirst({
        where: { tenantId: scope.tenantId, scope: budgetScope, subjectId },
      });
      if (row === null) return null;
      return {
        id: row.id,
        allowanceMinor: row.allowanceMinor,
        usedMinor: row.usedMinor,
        reservedMinor: row.reservedMinor,
        remainingMinor: remainingMinor(row),
        currency: row.currency,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Check → Estimate → Reserve
  // -------------------------------------------------------------------------

  /**
   * §20's pre-run check, without taking anything.
   *
   * Read-only and therefore **advisory**: by the time a caller acts on it, another agent may have
   * reserved the room it reported. It exists so a screen can grey out a button and so a run can
   * be refused before the work of preparing it — not as the safety, which is `reserve`.
   */
  async check(
    context: SpendContext,
    estimate: number,
  ): Promise<SpendCheckOutcome & { estimateMinor: number }> {
    const percents = await this.thresholds(context.scope);

    return this.prisma.runInTenantTransaction(context.scope, async () => {
      const levels: SpendCheckLevel[] = [];

      for (const level of scopesToCheck({
        departmentId: context.departmentId ?? null,
        objectiveId: context.objectiveId ?? null,
        engineAgentId: context.engineAgentId ?? null,
        actorUserId: context.actorUserId ?? null,
      })) {
        const wallet = await this.prisma.client.budgetWallet.findFirst({
          where: {
            tenantId: context.scope.tenantId,
            scope: level.scope,
            subjectId: level.subjectId,
          },
        });

        levels.push(
          decideLevel({
            scope: level.scope,
            subjectId: level.subjectId,
            allowanceMinor: wallet?.allowanceMinor ?? null,
            usedMinor: wallet?.usedMinor ?? 0,
            reservedMinor: wallet?.reservedMinor ?? 0,
            estimateMinor: estimate,
            approvalThresholdPercent: percents.Critical,
            hardStopPercent: percents.HardStop,
          }),
        );
      }

      return { ...combineLevels(levels), estimateMinor: estimate };
    });
  }

  /** §20's Estimate step: what a call is likely to cost, pessimistically. */
  async estimate(input: {
    scope: TenantScope;
    logicalProfile: LogicalModelProfile;
    maxTokens: number;
  }): Promise<{ estimateMinor: number; currency: string; pricingVersionId: string | null }> {
    return this.prisma.runAsPlatformOperation(async () => {
      // The model a call would route to, priced at its current version. Reading the route here
      // rather than taking a price from the caller is what keeps the estimate honest when a
      // company's BYOK model is dearer than the platform default.
      const route = await this.prisma.client.logicalModelRoute.findFirst({
        where: {
          OR: [{ tenantId: input.scope.tenantId }, { tenantId: null }],
          profile: input.logicalProfile,
          enabled: true,
        },
        orderBy: [{ tenantId: 'desc' }, { preference: 'asc' }],
        include: { model: { include: { pricing: { where: { supersededAt: null }, take: 1 } } } },
      });

      const pricing = route?.model.pricing[0];
      if (pricing === undefined) {
        // No price means no estimate, and a reservation of zero rather than a guess. The call
        // still records its usage; it simply has nothing to charge against.
        return { estimateMinor: 0, currency: 'INR', pricingVersionId: null };
      }

      /*
       * Estimated at what the company will be **charged**, not at what the call will cost UBoss.
       *
       * The estimate is what the reservation holds and what the budget is checked against, so
       * estimating at cost would let a company through a limit it cannot actually afford: the
       * reservation would pass at a fifth of the real charge and the settle would take the rest
       * out of a balance that had already been declared sufficient.
       */
      const atCost = estimateMinor({
        maxTokens: input.maxTokens,
        inputPerMillionMinorUnits: pricing.inputPerMillionMinorUnits,
        outputPerMillionMinorUnits: pricing.outputPerMillionMinorUnits,
      });

      return {
        estimateMinor: await this.sellPriceFor(atCost),
        currency: pricing.currency,
        pricingVersionId: pricing.id,
      };
    });
  }

  /**
   * §20's Reserve step. **This is the concurrency-safe one.**
   *
   * Inside one transaction:
   *
   *   1. Lock every wallet in the hierarchy with `SELECT ... FOR UPDATE`, **outermost first**.
   *      The order is `scopesToCheck`'s, identical for every caller, which is the only reason two
   *      concurrent reservations cannot deadlock against each other.
   *   2. Re-read the balances *inside* the lock and decide. A decision made before the lock is a
   *      decision made against a balance somebody else may already have spent.
   *   3. Write the reservation, one hold per level, one ledger entry per level, and increment
   *      each wallet's `reservedMinor`.
   *
   * Refuses rather than partially reserving. A reservation that held against the company budget
   * but not the objective's would let the objective be taken past its own limit by runs that each
   * fitted inside the company's.
   */
  async reserve(
    context: SpendContext,
    input: { estimateMinor: number; currency: string },
  ): Promise<
    | { reserved: true; reservation: ReservationView; outcome: SpendCheckOutcome }
    | { reserved: false; outcome: SpendCheckOutcome }
  > {
    const percents = await this.thresholds(context.scope);
    const tenantId = context.scope.tenantId;

    const result = await this.prisma.runInTenantTransaction(context.scope, async () => {
      const wanted = scopesToCheck({
        departmentId: context.departmentId ?? null,
        objectiveId: context.objectiveId ?? null,
        engineAgentId: context.engineAgentId ?? null,
        actorUserId: context.actorUserId ?? null,
      });

      // ---- 1. Lock, outermost first ----
      const locked: {
        level: { scope: BudgetScope; subjectId: string | null };
        wallet: {
          id: string;
          allowanceMinor: number;
          usedMinor: number;
          reservedMinor: number;
          currency: string;
        } | null;
      }[] = [];

      for (const level of wanted) {
        locked.push({
          level,
          wallet: await this.lockWallet(tenantId, level.scope, level.subjectId),
        });
      }

      // ---- 2. Decide inside the lock ----
      const levels = locked.map(({ level, wallet }) =>
        decideLevel({
          scope: level.scope,
          subjectId: level.subjectId,
          allowanceMinor: wallet?.allowanceMinor ?? null,
          usedMinor: wallet?.usedMinor ?? 0,
          reservedMinor: wallet?.reservedMinor ?? 0,
          estimateMinor: input.estimateMinor,
          approvalThresholdPercent: percents.Critical,
          hardStopPercent: percents.HardStop,
        }),
      );

      const outcome = combineLevels(levels);
      if (outcome.decision === 'HardStopped') {
        return { reserved: false as const, outcome, crossed: null };
      }

      const companyWallet = locked.find((entry) => entry.level.scope === 'Company')?.wallet;
      if (companyWallet === null || companyWallet === undefined) {
        // Unreachable in practice — `scopesToCheck` always includes the company level and
        // `lockWallet` creates it. Refused rather than assumed, because a reservation with no
        // company wallet would hold against nothing.
        throw new ConflictException(
          'This company has no AI budget wallet, so nothing can be reserved against it.',
        );
      }

      // ---- 3. Write ----
      const reservation = await this.prisma.client.budgetReservation.create({
        data: {
          tenantId,
          walletId: companyWallet.id,
          state: 'Held',
          estimateMinor: input.estimateMinor,
          currency: input.currency,
          logicalProfile: context.logicalProfile,
          purpose: context.purpose,
          ...(context.agentRunId == null ? {} : { agentRunId: context.agentRunId }),
          ...(context.objectiveId == null ? {} : { objectiveId: context.objectiveId }),
          ...(context.departmentId == null ? {} : { departmentId: context.departmentId }),
          ...(context.engineAgentId == null ? {} : { engineAgentId: context.engineAgentId }),
        },
      });

      let highestCrossed: CostThreshold | null = null;

      for (const { wallet } of locked) {
        if (wallet === null) continue;

        const updated = await this.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: {
            reservedMinor: { increment: input.estimateMinor },
            version: { increment: 1 },
          },
        });

        await this.prisma.client.budgetReservationHold.create({
          data: {
            tenantId,
            reservationId: reservation.id,
            walletId: wallet.id,
            amountMinor: input.estimateMinor,
          },
        });

        await this.appendEntry(tenantId, {
          walletId: wallet.id,
          kind: 'Reserve',
          amountMinor: input.estimateMinor,
          currency: input.currency,
          reason: `Reserved for ${context.purpose}.`,
          reservationId: reservation.id,
          context,
          balanceAfter: {
            allowanceMinor: updated.allowanceMinor,
            usedMinor: updated.usedMinor,
            reservedMinor: updated.reservedMinor,
          },
        });

        const crossed = crossedThreshold({
          percent: committedPercent(updated),
          percents,
        });
        if (crossed !== null && (highestCrossed === null || crossed === 'HardStop')) {
          highestCrossed = crossed;
        }
      }

      return {
        reserved: true as const,
        outcome,
        reservation: this.toReservationView(reservation),
        crossed: highestCrossed,
      };
    });

    // Outside the transaction: a notification is not part of the money movement, and raising one
    // inside would hold the wallet lock for the duration of a write to another table.
    if (result.crossed !== null && result.crossed !== undefined) {
      await this.notifyThreshold(context.scope, result.crossed);
    }

    return result.reserved
      ? { reserved: true, reservation: result.reservation, outcome: result.outcome }
      : { reserved: false, outcome: result.outcome };
  }

  // -------------------------------------------------------------------------
  // Settle → Release
  // -------------------------------------------------------------------------

  /**
   * §20's Settle step: charge the actual amount and release the unused reservation.
   *
   * Both halves in one transaction, because a settle without its release would leave the
   * difference held forever, and a release without its settle would charge nothing for work that
   * happened.
   *
   * The actual charge is what the provider reported, **even when it exceeds the estimate**. An
   * overspend is recorded rather than capped: capping would mean the ledger disagreed with the
   * provider's own invoice, and the next call's hard stop is where the overspend gets caught.
   */
  async settle(input: {
    scope: TenantScope;
    reservationId: string;
    actualMinor: number;
    modelGatewayCallId?: string | undefined;
    pricingVersionId?: string | undefined;
    tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
  }): Promise<ReservationView> {
    if (input.actualMinor < 0) {
      throw new BadRequestException('An actual charge cannot be negative.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const reservation = await this.lockReservation(input.scope.tenantId, input.reservationId);

      if (reservation.state !== 'Held') {
        throw new ConflictException(
          `That reservation is ${reservation.state}. Settling it again would charge the budget ` +
            'twice for one run.',
        );
      }

      const holds = await this.prisma.client.budgetReservationHold.findMany({
        where: { tenantId: input.scope.tenantId, reservationId: reservation.id },
      });

      for (const hold of holds) {
        const wallet = await this.lockWalletById(input.scope.tenantId, hold.walletId);
        if (wallet === null) continue;

        // Release the whole hold and charge the actual. Two entries rather than one net
        // movement, because the ledger has to explain both the release and the charge — a single
        // "charge the difference" entry would make a run that cost more than its estimate look
        // like a refund.
        const released = await this.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: {
            reservedMinor: { decrement: hold.amountMinor },
            usedMinor: { increment: input.actualMinor },
            version: { increment: 1 },
          },
        });

        await this.appendEntry(input.scope.tenantId, {
          walletId: wallet.id,
          kind: 'ReleaseReserve',
          amountMinor: hold.amountMinor,
          currency: reservation.currency,
          reason: 'Reservation released on settlement.',
          reservationId: reservation.id,
          balanceAfter: {
            allowanceMinor: released.allowanceMinor,
            usedMinor: released.usedMinor - input.actualMinor,
            reservedMinor: released.reservedMinor,
          },
        });

        await this.appendEntry(input.scope.tenantId, {
          walletId: wallet.id,
          kind: 'Settle',
          amountMinor: input.actualMinor,
          currency: reservation.currency,
          reason: `Charged for ${reservation.purpose}.`,
          reservationId: reservation.id,
          context: {
            scope: input.scope,
            departmentId: reservation.departmentId,
            objectiveId: reservation.objectiveId,
            engineAgentId: reservation.engineAgentId,
            agentRunId: reservation.agentRunId,
            logicalProfile: reservation.logicalProfile as LogicalModelProfile,
            purpose: reservation.purpose,
          },
          ...(input.pricingVersionId === undefined
            ? {}
            : { pricingVersionId: input.pricingVersionId }),
          ...(input.tokens === undefined ? {} : { tokens: input.tokens }),
          balanceAfter: {
            allowanceMinor: released.allowanceMinor,
            usedMinor: released.usedMinor,
            reservedMinor: released.reservedMinor,
          },
        });
      }

      const updated = await this.prisma.client.budgetReservation.update({
        where: { id: reservation.id },
        data: {
          state: 'Settled',
          settledMinor: input.actualMinor,
          closedAt: new Date(),
          closeReason:
            input.actualMinor > reservation.estimateMinor
              ? `Charged ${input.actualMinor}, above the ${reservation.estimateMinor} reserved.`
              : `Charged ${input.actualMinor} of ${reservation.estimateMinor} reserved.`,
          ...(input.modelGatewayCallId === undefined
            ? {}
            : { modelGatewayCallId: input.modelGatewayCallId }),
          version: { increment: 1 },
        },
      });

      return this.toReservationView(updated);
    });
  }

  /**
   * Release a reservation without charging anything.
   *
   * For a run that never reached the provider — refused by a control, cancelled, or failed before
   * the call. Distinct from settling zero, because "we held budget and spent nothing" and "we
   * held budget and the work was free" are different facts, and the reservation state is what
   * tells them apart.
   */
  async release(input: {
    scope: TenantScope;
    reservationId: string;
    reason: string;
    state?: 'Released' | 'Expired' | undefined;
  }): Promise<ReservationView> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const reservation = await this.lockReservation(input.scope.tenantId, input.reservationId);
      if (reservation.state !== 'Held') {
        throw new ConflictException(`That reservation is already ${reservation.state}.`);
      }

      const holds = await this.prisma.client.budgetReservationHold.findMany({
        where: { tenantId: input.scope.tenantId, reservationId: reservation.id },
      });

      for (const hold of holds) {
        const wallet = await this.lockWalletById(input.scope.tenantId, hold.walletId);
        if (wallet === null) continue;

        const updated = await this.prisma.client.budgetWallet.update({
          where: { id: wallet.id },
          data: {
            reservedMinor: { decrement: hold.amountMinor },
            version: { increment: 1 },
          },
        });

        await this.appendEntry(input.scope.tenantId, {
          walletId: wallet.id,
          kind: 'ReleaseReserve',
          amountMinor: hold.amountMinor,
          currency: reservation.currency,
          reason: input.reason,
          reservationId: reservation.id,
          balanceAfter: {
            allowanceMinor: updated.allowanceMinor,
            usedMinor: updated.usedMinor,
            reservedMinor: updated.reservedMinor,
          },
        });
      }

      const updated = await this.prisma.client.budgetReservation.update({
        where: { id: reservation.id },
        data: {
          state: input.state ?? 'Released',
          closedAt: new Date(),
          closeReason: input.reason,
          version: { increment: 1 },
        },
      });

      return this.toReservationView(updated);
    });
  }

  /**
   * Release reservations nobody closed.
   *
   * A worker that crashes between reserving and settling leaves budget held against a run that
   * will never finish. Without this sweep a company's allowance would leak away one crash at a
   * time, and the symptom — "we are at 90% and nothing is running" — is one nobody can diagnose
   * from a balance.
   *
   * They are marked `Expired`, not `Released`, because the distinction is the whole diagnostic:
   * a released reservation is a run that finished cheaply, an expired one is a run the engine
   * lost.
   */
  async sweepExpiredReservations(input: {
    scope: TenantScope;
    now?: Date | undefined;
    expiryMinutes?: number | undefined;
  }): Promise<{ expired: number }> {
    const now = input.now ?? new Date();

    const held = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.budgetReservation.findMany({
        where: { tenantId: input.scope.tenantId, state: 'Held' },
        take: 500,
      }),
    );

    let expired = 0;
    for (const reservation of held) {
      const isExpired = reservationHasExpired({
        state: 'Held',
        heldAt: reservation.heldAt,
        now,
        ...(input.expiryMinutes === undefined ? {} : { expiryMinutes: input.expiryMinutes }),
      });
      if (!isExpired) continue;

      await this.release({
        scope: input.scope,
        reservationId: reservation.id,
        state: 'Expired',
        reason:
          `Held for more than ${input.expiryMinutes ?? RESERVATION_EXPIRY_MINUTES} minutes with ` +
          'no settlement. The run that took it never reported back.',
      });
      expired += 1;
    }

    if (expired > 0) {
      this.logger.warn(
        `Expired ${expired} abandoned reservation(s) for ${input.scope.tenantId}. Each one was ` +
          'budget held against a run that never finished.',
      );
    }

    return { expired };
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * §20's reconciliation job: does the maintained balance still match its ledger?
   *
   * Reports, never corrects. A drift means either a write that bypassed this service or a bug in
   * it, and silently overwriting the balance would destroy the only evidence that either
   * happened.
   */
  async reconcile(scope: TenantScope): Promise<{
    checked: number;
    findings: ReconciliationFinding[];
  }> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const wallets = await this.prisma.client.budgetWallet.findMany({
        where: { tenantId: scope.tenantId },
      });

      const findings: ReconciliationFinding[] = [];

      for (const wallet of wallets) {
        const entries = await this.prisma.client.costLedgerEntry.findMany({
          where: { tenantId: scope.tenantId, walletId: wallet.id },
          orderBy: { occurredAt: 'asc' },
          select: { kind: true, amountMinor: true },
        });

        findings.push(
          ...reconcileBalance({
            scope: wallet.scope as BudgetScope,
            subjectId: wallet.subjectId,
            stored: {
              allowanceMinor: wallet.allowanceMinor,
              usedMinor: wallet.usedMinor,
              reservedMinor: wallet.reservedMinor,
            },
            entries: entries.map((entry) => ({
              kind: entry.kind as LedgerEntryKind,
              amountMinor: entry.amountMinor,
            })),
          }),
        );
      }

      if (findings.length > 0) {
        this.logger.error(
          `Reconciliation found ${findings.length} drift(s) for ${scope.tenantId}. The ledger is ` +
            'the source of truth; a stored balance that disagrees means a write outside the cost ' +
            'engine or a bug in it.',
        );
      }

      return { checked: wallets.length, findings };
    });
  }

  /** The ledger for one wallet — §20's credit history. */
  async ledger(input: {
    scope: TenantScope;
    walletId?: string | undefined;
    agentRunId?: string | undefined;
    limit?: number | undefined;
  }): Promise<unknown[]> {
    return this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.costLedgerEntry.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.walletId === undefined ? {} : { walletId: input.walletId }),
          ...(input.agentRunId === undefined ? {} : { agentRunId: input.agentRunId }),
        },
        /*
         * Spelled out rather than returning the row.
         *
         * The row carries `inputTokens`, `outputTokens`, `cachedInputTokens` and
         * `pricingVersionId`, and this is the company's own credit history. Token counts are a
         * provider's unit of account: a customer who has them can divide the charge by the
         * tokens, read off a per-million rate and match it against a public price list — which
         * names the provider as surely as printing its name would, and shows the margin besides.
         *
         * The columns stay and the platform plane reads them. What a company is shown is money,
         * what moved it and when.
         */
        select: {
          id: true,
          kind: true,
          amountMinor: true,
          currency: true,
          reason: true,
          reference: true,
          actorUserId: true,
          balanceAfterAllowanceMinor: true,
          balanceAfterUsedMinor: true,
          balanceAfterReservedMinor: true,
          agentRunId: true,
          objectiveId: true,
          departmentId: true,
          engineAgentId: true,
          // The capability class, never a provider or model name — the same rule the gateway keeps.
          logicalProfile: true,
          correlationId: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(input.limit ?? 200, 500),
      }),
    );
  }

  /**
   * Who spent it — by department, objective, agent or person.
   *
   * ## The gap this closes
   *
   * Every charge already carried `department_id`, `objective_id`, `engine_agent_id` and
   * `actor_user_id`; §20 required them and they were written faithfully from the start. Nothing
   * ever grouped by one. An administrator could see a single company total and a list of
   * individual entries, and could not answer "which department is spending this" without reading
   * the ledger by hand — which is the first question anybody asks about an AI bill.
   *
   * ## Charges, not movements
   *
   * Only `Settle` and `Refund`. A `Reserve` is money set aside for a call that has not happened,
   * and `ReleaseReserve` gives it back; counting either would report spend that never occurred.
   * A refund is signed against the charge it reverses, so summing the two gives what was actually
   * kept.
   *
   * ## Uncosted calls are counted, not hidden
   *
   * A charge whose model had no published price settles at zero with `pricingVersionId` null. The
   * tokens are real and the money is not, so `uncostedCalls` is reported beside the spend rather
   * than being averaged into it. A department reading "₹0 across 1,412 calls" is being told
   * something true and actionable; the same row without that count is just wrong.
   */
  async usageBreakdown(input: {
    scope: TenantScope;
    by: 'department' | 'objective' | 'agent' | 'user';
    from?: Date | undefined;
    to?: Date | undefined;
  }): Promise<{
    by: string;
    currency: string | null;
    rows: {
      key: string | null;
      spentMinor: number;
      tokens: number;
      calls: number;
      uncostedCalls: number;
    }[];
    totals: {
      spentMinor: number;
      tokens: number;
      calls: number;
      uncostedCalls: number;
    };
  }> {
    const column = {
      department: 'departmentId',
      objective: 'objectiveId',
      agent: 'engineAgentId',
      user: 'actorUserId',
    }[input.by] as 'departmentId' | 'objectiveId' | 'engineAgentId' | 'actorUserId';

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const entries = await this.prisma.client.costLedgerEntry.findMany({
        where: {
          tenantId: input.scope.tenantId,
          kind: { in: ['Settle', 'Refund'] },
          ...(input.from === undefined && input.to === undefined
            ? {}
            : {
                occurredAt: {
                  ...(input.from === undefined ? {} : { gte: input.from }),
                  ...(input.to === undefined ? {} : { lte: input.to }),
                },
              }),
        },
        /*
         * Both units are summed here; **which of them a company is shown is decided above this
         * layer**, by the controller, and the rule is that it never sees both.
         *
         * A company is quoted a plan price in money and everything it consumes is counted in
         * tokens — the owner's arrangement, and the same one the reader already knows from every
         * other AI product. The shape to refuse is money *and* tokens side by side: divide one by
         * the other and a customer has a per-million rate to match against a public price list,
         * which names the provider as surely as printing its name would and exposes the margin
         * besides.
         *
         * So the engine counts both, because the platform plane needs the money and the company
         * plane needs the tokens, and one query serving two readers is better than two queries
         * that can disagree about the same ledger.
         */
        select: {
          amountMinor: true,
          currency: true,
          inputTokens: true,
          outputTokens: true,
          pricingVersionId: true,
          departmentId: true,
          objectiveId: true,
          engineAgentId: true,
          actorUserId: true,
        },
      });

      const grouped = new Map<
        string | null,
        {
          key: string | null;
          spentMinor: number;
          tokens: number;
          calls: number;
          uncostedCalls: number;
        }
      >();

      let currency: string | null = null;

      for (const entry of entries) {
        currency ??= entry.currency;
        const key = entry[column];
        const row = grouped.get(key) ?? {
          key,
          spentMinor: 0,
          tokens: 0,
          calls: 0,
          uncostedCalls: 0,
        };

        row.spentMinor += entry.amountMinor;
        row.tokens += (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0);
        row.calls += 1;
        if (entry.pricingVersionId === null) row.uncostedCalls += 1;

        grouped.set(key, row);
      }

      /*
       * Ordered by tokens, not by money.
       *
       * A company reads this list to find out which department or agent is consuming the most,
       * and it is shown tokens — a list sorted by a column the reader cannot see appears to be in
       * no order at all. An unpriced model settles at nothing and would sink to the bottom of a
       * money sort while having consumed plenty, which is the same bug the uncosted-calls warning
       * exists to cover.
       */
      const rows = [...grouped.values()].sort((a, b) => b.tokens - a.tokens);

      return {
        by: input.by,
        currency,
        rows,
        totals: {
          spentMinor: rows.reduce((sum, row) => sum + row.spentMinor, 0),
          tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
          calls: rows.reduce((sum, row) => sum + row.calls, 0),
          uncostedCalls: rows.reduce((sum, row) => sum + row.uncostedCalls, 0),
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The company's configured thresholds.
   *
   * §20: "percentages must be configurable rather than hard-coded". They come from the existing
   * `tenant_ai_budget_policies` row — reused rather than given a second home, so there is one
   * answer to "what is this company's warning threshold".
   *
   * The policy's `warningPercent` maps to `Warning`, and its two absolute limits are converted to
   * percentages of the allowance so the whole engine works in one unit. An absolute hard stop
   * below the allowance is a real configuration and converting it keeps that meaning.
   */
  /**
   * What a company pays for AI, as a multiple of what the call costs UBoss.
   *
   * ## Two prices, and why there have to be two
   *
   * `pricing_versions` is the **buy** price: what the provider charges, published by platform
   * staff, never shown to a company. Until this existed it was also the sell price — a company's
   * wallet was debited the exact provider cost — so every call was sold at cost and the product
   * earned nothing on AI. That is not a pricing policy, it is the absence of one.
   *
   * ## Why a multiplier rather than a second price list
   *
   * A per-model sell price would be a second table to keep in step with the first, and the first
   * moves whenever a provider changes a rate or the rupee does. One multiplier over the real cost
   * tracks both automatically: the margin is a percentage, which is what a margin is.
   *
   * ## A missing or unusable setting sells at cost, and says so
   *
   * Not at some assumed markup. Charging a company more than a call cost because a setting could
   * not be read would be inventing a price, and the honest failure is the one that earns nothing
   * rather than the one that overcharges. It is logged, because a platform running at zero margin
   * is something somebody needs to know.
   */
  private async sellMultiplier(): Promise<number> {
    try {
      const row = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.platformSetting.findUnique({
          where: { key: 'commercial.ai_sell_multiplier' },
          select: { value: true },
        }),
      );

      const value = Number(row?.value);
      if (!Number.isFinite(value) || value < 1) {
        this.logger.warn(
          'commercial.ai_sell_multiplier is missing or below 1, so AI is being sold at cost. ' +
            'Set it in the Master Console.',
        );
        return 1;
      }
      return value;
    } catch (error) {
      this.logger.warn(
        `Could not read the AI sell multiplier, so AI is being sold at cost: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  /**
   * What UBoss charges for a call that cost it `costMinor`.
   *
   * Rounded **up**, so a call that costs something is never sold for nothing. Integer arithmetic
   * throughout: money in this product is minor units and never a float.
   */
  async sellPriceFor(costMinor: number): Promise<number> {
    if (costMinor <= 0) return costMinor;
    return Math.ceil(costMinor * (await this.sellMultiplier()));
  }

  /**
   * An amount of sell value, as the number of UBoss Tokens a company sees.
   *
   * The unit, the rate and why a company counts tokens rather than rupees are all in
   * `uboss-token.ts`, which the commercial plane reads from as well. One definition, because a
   * second one that drifted would restate every company's allowance without changing a number
   * anybody could see.
   */
  async tokensFor(minorUnits: number): Promise<number> {
    return tokensFrom(minorUnits, await ubossTokenMinorUnits(this.prisma, this.logger));
  }

  private async thresholds(scope: TenantScope): Promise<ThresholdPercents> {
    const policy = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.tenantAiBudgetPolicy.findUnique({
        where: { tenantId: scope.tenantId },
      }),
    );

    if (policy === null || policy.monthlyAllowanceMinor <= 0) {
      return { ...DEFAULT_COST_THRESHOLD_PERCENTS };
    }

    const asPercent = (minor: number): number =>
      Math.max(1, Math.round((minor / policy.monthlyAllowanceMinor) * 100));

    const warning = policy.warningPercent;
    const critical = asPercent(policy.approvalThresholdMinor);
    const hardStop = asPercent(policy.hardStopMinor);

    return {
      Information: Math.min(DEFAULT_COST_THRESHOLD_PERCENTS.Information, Math.max(1, warning - 25)),
      Warning: warning,
      // Kept strictly increasing. A company whose approval threshold sits below its warning is a
      // misconfiguration the settings screen refuses; the engine still has to behave sanely if
      // one slipped through, and the safe direction is the stricter of the two.
      Critical: Math.max(critical, warning + 1),
      HardStop: Math.max(hardStop, Math.max(critical, warning + 1) + 1),
    };
  }

  /**
   * Lock a wallet row for update, creating it if this level has never been used.
   *
   * `FOR UPDATE` is the whole safety property: it serialises concurrent reservations on the same
   * budget, so the second one reads a balance that already includes the first one's hold.
   *
   * `$queryRawUnsafe` because Prisma has no `FOR UPDATE`. Parameterised, and the only values
   * interpolated are bound parameters — the column and table names are literals.
   */
  private async lockWallet(
    tenantId: string,
    scope: BudgetScope,
    subjectId: string | null,
    currency = 'INR',
  ): Promise<{
    id: string;
    allowanceMinor: number;
    usedMinor: number;
    reservedMinor: number;
    currency: string;
  } | null> {
    const rows = await this.prisma.client.$queryRawUnsafe<
      {
        id: string;
        allowance_minor: number;
        used_minor: number;
        reserved_minor: number;
        currency: string;
      }[]
    >(
      `SELECT "id", "allowance_minor", "used_minor", "reserved_minor", "currency"
         FROM "budget_wallets"
        WHERE "tenant_id" = $1::uuid AND "scope" = $2
          AND "subject_id" IS NOT DISTINCT FROM $3::uuid
        FOR UPDATE`,
      tenantId,
      scope,
      subjectId,
    );

    const row = rows[0];
    if (row !== undefined) {
      return {
        id: row.id,
        allowanceMinor: Number(row.allowance_minor),
        usedMinor: Number(row.used_minor),
        reservedMinor: Number(row.reserved_minor),
        currency: row.currency,
      };
    }

    // Only the company level is created on demand. A department or objective with no wallet has
    // no budget of its own and defers to the level above — creating an empty one here would turn
    // "no budget set" into "a budget of zero", which hard-stops everything.
    if (scope !== 'Company') return null;

    const created = await this.prisma.client.budgetWallet.create({
      data: { tenantId, scope, currency, periodStart: new Date() },
    });

    return {
      id: created.id,
      allowanceMinor: created.allowanceMinor,
      usedMinor: created.usedMinor,
      reservedMinor: created.reservedMinor,
      currency: created.currency,
    };
  }

  private async lockOrCreateWallet(
    tenantId: string,
    scope: BudgetScope,
    subjectId: string | null,
    currency = 'INR',
  ): Promise<{
    id: string;
    allowanceMinor: number;
    usedMinor: number;
    reservedMinor: number;
    currency: string;
  }> {
    const existing = await this.lockWallet(tenantId, scope, subjectId, currency);
    if (existing !== null) return existing;

    const created = await this.prisma.client.budgetWallet.create({
      data: {
        tenantId,
        scope,
        currency,
        periodStart: new Date(),
        ...(subjectId === null ? {} : { subjectId }),
      },
    });

    return {
      id: created.id,
      allowanceMinor: created.allowanceMinor,
      usedMinor: created.usedMinor,
      reservedMinor: created.reservedMinor,
      currency: created.currency,
    };
  }

  private async lockWalletById(tenantId: string, walletId: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.client.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "budget_wallets"
        WHERE "tenant_id" = $1::uuid AND "id" = $2::uuid
        FOR UPDATE`,
      tenantId,
      walletId,
    );
    return rows[0] ?? null;
  }

  private async lockReservation(tenantId: string, reservationId: string) {
    // Locked too: two settles racing on the same reservation would each read `Held` and each
    // charge the budget.
    await this.prisma.client.$queryRawUnsafe(
      `SELECT "id" FROM "budget_reservations"
        WHERE "tenant_id" = $1::uuid AND "id" = $2::uuid
        FOR UPDATE`,
      tenantId,
      reservationId,
    );

    const reservation = await this.prisma.client.budgetReservation.findFirst({
      where: { tenantId, id: reservationId },
    });
    if (reservation === null) {
      throw new NotFoundException('No such reservation.');
    }
    return reservation;
  }

  /** Append one immutable ledger entry. The only way a balance ever moves. */
  /**
   * Move an allowance at a period boundary, and record why.
   *
   * Used by `BudgetResetRunner` and by nothing else. It exists here rather than in the runner
   * because the allowance column and the ledger entry must move in one transaction — a grant that
   * committed without its entry would make `reconcile` report drift for ever, and an entry
   * without its grant would report an allowance the wallet does not have.
   *
   * **No actor.** A period turning over is not something a person did, and naming one would put a
   * name on a decision nobody made.
   *
   * `Expiry` takes allowance away and `Adjustment` adds it, which is the same pairing the monthly
   * company reset already uses. `usedMinor` is untouched: it is derived from this ledger, and the
   * reasoning for never resetting it is in `CreditService`.
   */
  async recordPeriodMovement(
    scope: TenantScope,
    input: {
      walletId: string;
      kind: 'Expiry' | 'Adjustment';
      amountMinor: number;
      reason: string;
      occurredAt: Date;
    },
  ): Promise<void> {
    if (input.amountMinor <= 0) return;

    await this.prisma.runInTenantTransaction(scope, async () => {
      const wallet = await this.prisma.client.budgetWallet.findUniqueOrThrow({
        where: { id: input.walletId },
      });

      const allowanceMinor =
        input.kind === 'Expiry'
          ? Math.max(0, wallet.allowanceMinor - input.amountMinor)
          : wallet.allowanceMinor + input.amountMinor;

      const updated = await this.prisma.client.budgetWallet.update({
        where: { id: wallet.id },
        data: { allowanceMinor, version: { increment: 1 } },
      });

      await this.appendEntry(scope.tenantId, {
        walletId: wallet.id,
        kind: input.kind,
        amountMinor: input.amountMinor,
        currency: wallet.currency,
        reason: input.reason,
        balanceAfter: {
          allowanceMinor: updated.allowanceMinor,
          usedMinor: updated.usedMinor,
          reservedMinor: updated.reservedMinor,
        },
      });
    });
  }

  private async appendEntry(
    tenantId: string,
    input: {
      walletId: string;
      kind: LedgerEntryKind;
      amountMinor: number;
      currency: string;
      reason: string;
      actorUserId?: string | undefined;
      reference?: string | undefined;
      reservationId?: string | undefined;
      pricingVersionId?: string | undefined;
      tokens?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;
      context?: SpendContext | undefined;
      balanceAfter: { allowanceMinor: number; usedMinor: number; reservedMinor: number };
    },
  ): Promise<void> {
    // A sanity check on the caller rather than on the data: every kind must have a declared
    // effect, or a balance would move in a direction nothing describes.
    if (LEDGER_EFFECT[input.kind] === undefined) {
      throw new BadRequestException(`Unknown ledger entry kind: ${input.kind}`);
    }

    await this.prisma.client.costLedgerEntry.create({
      data: {
        tenantId,
        walletId: input.walletId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reason: input.reason,
        balanceAfterAllowanceMinor: input.balanceAfter.allowanceMinor,
        balanceAfterUsedMinor: input.balanceAfter.usedMinor,
        balanceAfterReservedMinor: input.balanceAfter.reservedMinor,
        // Prompt 39: the end of the correlation chain. One identifier now links a click to the
        // money it spent.
        correlationId: getCorrelationId() ?? null,
        ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
        ...(input.pricingVersionId === undefined
          ? {}
          : { pricingVersionId: input.pricingVersionId }),
        ...(input.tokens === undefined
          ? {}
          : {
              inputTokens: input.tokens.inputTokens,
              outputTokens: input.tokens.outputTokens,
              cachedInputTokens: input.tokens.cachedInputTokens,
            }),
        ...(input.context === undefined
          ? {}
          : {
              logicalProfile: input.context.logicalProfile,
              ...(input.context.agentRunId == null ? {} : { agentRunId: input.context.agentRunId }),
              ...(input.context.objectiveId == null
                ? {}
                : { objectiveId: input.context.objectiveId }),
              ...(input.context.departmentId == null
                ? {}
                : { departmentId: input.context.departmentId }),
              ...(input.context.engineAgentId == null
                ? {}
                : { engineAgentId: input.context.engineAgentId }),
            }),
      },
    });
  }

  /** Tell the people who can act about a crossed threshold. */
  private async notifyThreshold(scope: TenantScope, threshold: CostThreshold): Promise<void> {
    const admins = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.roleAssignment.findMany({
        where: { tenantId: scope.tenantId, roleKind: 'CompanyAdmin' },
        select: { userId: true },
        take: 10,
      }),
    );

    for (const admin of admins) {
      try {
        await this.notifications.raise({
          tenantId: scope.tenantId,
          recipientUserId: admin.userId,
          kind: 'BudgetThreshold',
          severity:
            threshold === 'Information' ? 'Info' : threshold === 'Warning' ? 'Warning' : 'Critical',
          title: `AI budget at the ${threshold.toLowerCase()} threshold`,
          body:
            threshold === 'HardStop'
              ? 'The AI allowance is exhausted. New runs are blocked until credits are added.'
              : `The company AI allowance has passed its ${threshold.toLowerCase()} threshold.`,
          deepLink: '/settings?category=tokens',
          resourceType: 'budget-wallet',
          // One notification per threshold per company, not one per run that crosses it.
          dedupeKey: `budget-threshold:${scope.tenantId}:${threshold}`,
        });
      } catch (cause) {
        // **A notification must never fail the money movement that triggered it.**
        //
        // Found by the concurrency tests: twenty simultaneous reservations each cross the same
        // threshold and each race to insert the same deduplicated notification, so all but one
        // hit the unique index — and the error escaped, failing reservations that had already
        // been written correctly. The duplicate *is* the deduplication working.
        //
        // More generally, telling somebody their budget is low is strictly less important than
        // the budget being right. Swallowed and logged rather than retried, because the one
        // notification that did land is the one that was wanted.
        this.logger.debug(
          `Budget threshold notification for ${scope.tenantId} was not delivered to ` +
            `${admin.userId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  private toWalletView(
    row: {
      id: string;
      scope: string;
      subjectId: string | null;
      currency: string;
      allowanceMinor: number;
      usedMinor: number;
      reservedMinor: number;
      periodStart: Date;
      resetsAt: Date | null;
      expiresAt: Date | null;
    },
    percents: ThresholdPercents,
    now: Date,
  ): WalletView {
    const scope = row.scope as BudgetScope;
    const percent = committedPercent(row);

    return {
      id: row.id,
      scope,
      scopeLabel: BUDGET_SCOPE_LABELS[scope] ?? row.scope,
      subjectId: row.subjectId,
      currency: row.currency,
      allowanceMinor: row.allowanceMinor,
      usedMinor: row.usedMinor,
      reservedMinor: row.reservedMinor,
      remainingMinor: remainingMinor(row),
      percent,
      threshold: crossedThreshold({ percent, percents }),
      periodStart: row.periodStart.toISOString(),
      resetsAt: row.resetsAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      projectedExhaustion: projectedExhaustion({
        usedMinor: row.usedMinor,
        reservedMinor: row.reservedMinor,
        allowanceMinor: row.allowanceMinor,
        periodStart: row.periodStart,
        now,
      }),
    };
  }

  private toReservationView(row: {
    id: string;
    state: string;
    estimateMinor: number;
    settledMinor: number | null;
    currency: string;
    heldAt: Date;
    closedAt: Date | null;
    closeReason: string | null;
  }): ReservationView {
    return {
      id: row.id,
      state: row.state,
      estimateMinor: row.estimateMinor,
      settledMinor: row.settledMinor,
      currency: row.currency,
      heldAt: row.heldAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      closeReason: row.closeReason,
    };
  }
}
