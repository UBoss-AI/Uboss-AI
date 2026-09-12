/**
 * Credit top-up, reallocation and the commercial edge cases — Prompt 31.
 *
 * ## What the approved documents actually say
 *
 * UBoss_Final_1 line 1048 and Technical Architecture §26 both require these policies to be
 * **defined, configurable and auditable**. Neither states a value: "Define monthly reset,
 * carry-forward policy, top-up expiry, refunds/promotional/manual adjustments, plan change
 * mid-cycle, payment failure after top-up and negative-balance policy. Every commercial
 * adjustment remains auditable."
 *
 * That is a deliberate reading, and it decides the shape of this file. A commercial term is the
 * client's to set, not this codebase's to invent — so every one of them is a configured policy
 * with a stated default and a recorded reason, and nothing here hard-codes a rule a contract
 * would override. The defaults are the conservative choice in each case, and each says why.
 *
 * ## Credits are granted in lots, not as a single number
 *
 * Top-up expiry is what forces this. "This ₹40,000 expires on 31 March" cannot be expressed by a
 * single `allowanceMinor`, because expiring it means knowing which part of the allowance it was.
 * So a top-up creates a **grant** with its own effective date and optional expiry, the allowance
 * is the sum of the live grants, and expiry is one grant reaching its date — which the ledger
 * already has a kind for.
 *
 * Carry-forward and plan changes fall out of the same model: carrying forward is a grant that
 * survives a reset, and a plan change is a grant added or reduced with a reason.
 */

import type { LedgerEntryKind } from './cost.js';

// ---------------------------------------------------------------------------
// Requesting credits
// ---------------------------------------------------------------------------

/**
 * A credit request's life.
 *
 * Four states, and `Adjusted` is deliberately **not** one of them. The prompt lists "Approve &
 * Add Credits" and "Adjust Amount" as two Finance actions, but they produce the same outcome — an
 * approval for some amount — and the amount approved is already recorded separately from the
 * amount asked for. A fifth state would mean two rows could describe the same thing and reports
 * would have to remember to count both.
 */
export const CREDIT_REQUEST_STATES = ['Submitted', 'Approved', 'Rejected', 'Cancelled'] as const;
export type CreditRequestState = (typeof CREDIT_REQUEST_STATES)[number];

export const CREDIT_REQUEST_STATE_LABELS: Record<CreditRequestState, string> = {
  Submitted: 'Submitted',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Cancelled: 'Cancelled',
};

export const CREDIT_REQUEST_STATE_TONES: Record<CreditRequestState, string> = {
  Submitted: 'warn',
  Approved: 'success',
  Rejected: 'danger',
  Cancelled: 'grey',
};

export function creditRequestIsOpen(state: CreditRequestState): boolean {
  return state === 'Submitted';
}

/**
 * Whether a credit request may move.
 *
 * Only out of `Submitted`, and never back. A rejected request that could be re-approved would let
 * a decision be reversed without a record of the reversal; the company raises a new request
 * instead, which is the same discipline the Approval Engine uses (ADR-139).
 */
export function mayMoveCreditRequest(from: CreditRequestState, to: CreditRequestState): boolean {
  if (from === to) return true;
  return from === 'Submitted' && to !== 'Submitted';
}

/**
 * How the customer expects this to be billed — the prompt's "billing choice where enabled".
 *
 * **No payment provider is integrated and none is approved.** These values record an *intent*, so
 * Finance knows what was agreed when they come to add the credits; nothing here takes a payment
 * or authorises a card, and a screen must not imply otherwise. `Unspecified` exists because the
 * prompt says "where enabled" — a plan may not offer the choice at all, and forcing one would
 * make the field a lie on those plans.
 */
export const BILLING_CHOICES = ['AddToInvoice', 'ExistingCommitment', 'Unspecified'] as const;
export type BillingChoice = (typeof BILLING_CHOICES)[number];

export const BILLING_CHOICE_LABELS: Record<BillingChoice, string> = {
  AddToInvoice: 'Add to the next invoice',
  ExistingCommitment: 'Draw on an existing commitment',
  Unspecified: 'Not specified — Finance will decide',
};

export const MIN_CREDIT_REQUEST_MINOR = 1;

/**
 * Whether a credit request is worth submitting.
 *
 * The reason is required and the amount must be positive. A request for nothing, or one nobody
 * can explain, wastes a Finance review — and Finance's own record of *why* credits were added is
 * built from this text.
 */
export function validateCreditRequest(input: {
  amountMinor: number;
  reason: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < MIN_CREDIT_REQUEST_MINOR) {
    return {
      ok: false,
      reason: 'Ask for a positive amount, in whole minor units.',
    };
  }
  if (input.reason.trim() === '') {
    return {
      ok: false,
      reason:
        'Say why the credits are needed. Finance records this as the reason the credits were ' +
        'added, so a blank one leaves the trail unexplained.',
    };
  }
  return { ok: true };
}

/**
 * Whether Finance's decision is complete enough to act on.
 *
 * An approval must name an amount and an effective date; a rejection must give a reason. The
 * asymmetry is deliberate — an approval's justification is the request's own reason plus the
 * invoice reference, whereas a refusal tells somebody something they did not already know.
 */
export function validateCreditDecision(input: {
  approve: boolean;
  approvedMinor?: number | undefined;
  effectiveFrom?: Date | undefined;
  expiresAt?: Date | undefined;
  reason: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.approve) {
    return input.reason.trim() === ''
      ? { ok: false, reason: 'A rejection has to say why. The company cannot act on "no".' }
      : { ok: true };
  }

  if (
    input.approvedMinor === undefined ||
    !Number.isInteger(input.approvedMinor) ||
    input.approvedMinor < MIN_CREDIT_REQUEST_MINOR
  ) {
    return { ok: false, reason: 'An approval must name a positive amount to add.' };
  }

  if (input.effectiveFrom === undefined) {
    return {
      ok: false,
      reason:
        'An approval must name the date the balance becomes effective. Without one, "when can ' +
        'we spend it" has no answer.',
    };
  }

  if (input.expiresAt !== undefined && input.expiresAt.getTime() <= input.effectiveFrom.getTime()) {
    return {
      ok: false,
      reason: 'Credits cannot expire before, or at the moment, they become effective.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Grants — credits arrive in lots
// ---------------------------------------------------------------------------

/**
 * Where a lot of credit came from.
 *
 * Enough to answer the question an auditor asks — "why does this company have this money" —
 * without conflating the answers. A `Promotional` grant and a `TopUp` grant spend identically and
 * are reported very differently.
 */
export const GRANT_SOURCES = [
  'PlanAllowance',
  'TopUp',
  'Promotional',
  'ManualAdjustment',
  'CarryForward',
  'PlanChange',
] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

export const GRANT_SOURCE_LABELS: Record<GrantSource, string> = {
  PlanAllowance: 'Plan allowance',
  TopUp: 'Purchased top-up',
  Promotional: 'Promotional credit',
  ManualAdjustment: 'Manual adjustment',
  CarryForward: 'Carried forward',
  PlanChange: 'Plan change',
};

/** One lot of credit, with its own life. */
export interface CreditGrant {
  id: string;
  source: GrantSource;
  amountMinor: number;
  currency: string;
  effectiveFrom: string;
  /** Null when the lot does not expire. */
  expiresAt: string | null;
  /** Set when it was withdrawn before expiry — a payment failure, or a correction. */
  revokedAt: string | null;
  reason: string;
  /** An invoice number or contract reference, when Finance recorded one. */
  reference: string | null;
}

/**
 * Whether a grant counts towards the allowance right now.
 *
 * A grant that has not started yet is **not** counted, which is what makes a future-dated top-up
 * safe to approve: the company sees it coming and cannot spend it early.
 */
export function grantIsLive(
  grant: Pick<CreditGrant, 'effectiveFrom' | 'expiresAt' | 'revokedAt'>,
  at: Date,
): boolean {
  if (grant.revokedAt !== null) return false;
  if (at.getTime() < new Date(grant.effectiveFrom).getTime()) return false;
  if (grant.expiresAt !== null && at.getTime() >= new Date(grant.expiresAt).getTime()) return false;
  return true;
}

/** The allowance a set of grants adds up to at a moment. */
export function liveAllowanceMinor(
  grants: readonly Pick<CreditGrant, 'amountMinor' | 'effectiveFrom' | 'expiresAt' | 'revokedAt'>[],
  at: Date,
): number {
  return grants.reduce(
    (total, grant) => (grantIsLive(grant, at) ? total + grant.amountMinor : total),
    0,
  );
}

/**
 * Which grants have expired but have not yet been written off.
 *
 * Returned rather than acted on, so the caller writes one ledger entry per expiry and the
 * allowance moves for a recorded reason. A balance that dropped with no entry behind it is
 * exactly the drift `reconcile` exists to catch.
 */
export function grantsToExpire(
  grants: readonly (Pick<CreditGrant, 'id' | 'amountMinor' | 'expiresAt' | 'revokedAt'> & {
    writtenOff: boolean;
  })[],
  at: Date,
): { id: string; amountMinor: number }[] {
  return grants
    .filter(
      (grant) =>
        !grant.writtenOff &&
        grant.revokedAt === null &&
        grant.expiresAt !== null &&
        at.getTime() >= new Date(grant.expiresAt).getTime(),
    )
    .map((grant) => ({ id: grant.id, amountMinor: grant.amountMinor }));
}

// ---------------------------------------------------------------------------
// The commercial policies
// ---------------------------------------------------------------------------

/** What happens to the plan allowance at the start of a period. */
export const RESET_POLICIES = ['NoReset', 'MonthlyReset'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

/** What happens to *unused* allowance when a period resets. */
export const CARRY_FORWARD_POLICIES = ['Forfeit', 'CarryForward', 'CarryForwardCapped'] as const;
export type CarryForwardPolicy = (typeof CARRY_FORWARD_POLICIES)[number];

/** What happens when settled spend exceeds the allowance. */
export const NEGATIVE_BALANCE_POLICIES = ['BlockImmediately', 'AllowGrace'] as const;
export type NegativeBalancePolicy = (typeof NEGATIVE_BALANCE_POLICIES)[number];

/** What happens to the allowance when a plan changes mid-cycle. */
export const PLAN_CHANGE_POLICIES = ['ProRate', 'ImmediateFull', 'NextCycle'] as const;
export type PlanChangePolicy = (typeof PLAN_CHANGE_POLICIES)[number];

export const RESET_POLICY_LABELS: Record<ResetPolicy, string> = {
  NoReset: 'No reset — the allowance is a running balance',
  MonthlyReset: 'Reset monthly to the plan allowance',
};

export const CARRY_FORWARD_POLICY_LABELS: Record<CarryForwardPolicy, string> = {
  Forfeit: 'Unused allowance is forfeited at reset',
  CarryForward: 'Unused allowance carries forward in full',
  CarryForwardCapped: 'Unused allowance carries forward up to a cap',
};

export const NEGATIVE_BALANCE_POLICY_LABELS: Record<NegativeBalancePolicy, string> = {
  BlockImmediately: 'Block new AI execution as soon as the balance is negative',
  AllowGrace: 'Allow a configured grace amount below zero before blocking',
};

export const PLAN_CHANGE_POLICY_LABELS: Record<PlanChangePolicy, string> = {
  ProRate: 'Pro-rate the allowance for the remainder of the cycle',
  ImmediateFull: 'Apply the new plan allowance in full immediately',
  NextCycle: 'Keep this cycle unchanged; the new allowance starts next cycle',
};

/**
 * One company's commercial credit policy.
 *
 * Every field is configurable, and that is the requirement rather than a convenience: the
 * approved documents ask for these to be *defined*, and a commercial term compiled into the
 * product would be one the client could not change without a release.
 */
export interface CreditPolicy {
  resetPolicy: ResetPolicy;
  carryForwardPolicy: CarryForwardPolicy;
  /** For `CarryForwardCapped`. Null for the other two. */
  carryForwardCapMinor: number | null;
  /** Default expiry applied to a top-up when Finance names none. Null means it does not expire. */
  defaultTopUpExpiryDays: number | null;
  negativeBalancePolicy: NegativeBalancePolicy;
  /** For `AllowGrace`. How far below zero is tolerated. */
  negativeBalanceGraceMinor: number;
  planChangePolicy: PlanChangePolicy;
  /** Whether a Company Admin may choose how a top-up is billed. */
  billingChoiceEnabled: boolean;
}

/**
 * The defaults, and why each one is the conservative choice.
 *
 * **These are defaults, not the client's terms.** Each is the reading that cannot surprise a
 * customer with a bill or silently destroy something they paid for:
 *
 *   * `MonthlyReset` — the provisioned policy is already a *monthly* allowance
 *     (`monthlyAllowanceMinor`), so not resetting it would contradict the field's own name.
 *   * `Forfeit` — the strict reading of a monthly allowance. Carrying forward by default would
 *     quietly hand a customer more than their contract says, which is harder to undo than the
 *     reverse and is a commercial decision nobody has made.
 *   * A purchased top-up **does not expire by default**. Expiring money somebody paid for,
 *     without being told to, is the one default here that could not be defended.
 *   * `BlockImmediately` — the safe direction the moment a balance goes negative.
 *   * `NextCycle` — a plan change that does not disturb a cycle already in progress. The other
 *     two change what a customer can spend today, which needs saying out loud.
 */
export const DEFAULT_CREDIT_POLICY: CreditPolicy = {
  resetPolicy: 'MonthlyReset',
  carryForwardPolicy: 'Forfeit',
  carryForwardCapMinor: null,
  defaultTopUpExpiryDays: null,
  negativeBalancePolicy: 'BlockImmediately',
  negativeBalanceGraceMinor: 0,
  planChangePolicy: 'NextCycle',
  billingChoiceEnabled: true,
};

/** Whether a policy is internally consistent. */
export function validateCreditPolicy(
  policy: CreditPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (policy.carryForwardPolicy === 'CarryForwardCapped' && policy.carryForwardCapMinor === null) {
    return { ok: false, reason: 'A capped carry-forward needs a cap.' };
  }
  if (policy.carryForwardPolicy !== 'CarryForwardCapped' && policy.carryForwardCapMinor !== null) {
    return {
      ok: false,
      reason:
        'A cap only means something with a capped carry-forward. A number nothing reads is one ' +
        'somebody will eventually believe is being applied.',
    };
  }
  if (policy.carryForwardPolicy !== 'Forfeit' && policy.resetPolicy === 'NoReset') {
    return {
      ok: false,
      reason: 'Carry-forward only means something if the allowance resets.',
    };
  }
  if (
    policy.negativeBalancePolicy === 'BlockImmediately' &&
    policy.negativeBalanceGraceMinor !== 0
  ) {
    return {
      ok: false,
      reason: 'A grace amount only applies when negative balances are tolerated.',
    };
  }
  if (policy.negativeBalanceGraceMinor < 0) {
    return { ok: false, reason: 'A grace amount cannot itself be negative.' };
  }
  if (policy.defaultTopUpExpiryDays !== null && policy.defaultTopUpExpiryDays < 1) {
    return { ok: false, reason: 'A default top-up expiry must be at least a day.' };
  }
  return { ok: true };
}

/**
 * What a period reset does to the unused allowance.
 *
 * Returns the amount to carry, so the caller creates a `CarryForward` grant for it and lets the
 * old plan grant lapse. Nothing is computed in place: a reset that adjusted a balance directly
 * would move money with no entry explaining it.
 */
export function carryForwardMinor(input: {
  policy: Pick<CreditPolicy, 'carryForwardPolicy' | 'carryForwardCapMinor'>;
  unusedMinor: number;
}): number {
  if (input.unusedMinor <= 0) return 0;

  switch (input.policy.carryForwardPolicy) {
    case 'Forfeit':
      return 0;
    case 'CarryForward':
      return input.unusedMinor;
    case 'CarryForwardCapped':
      return Math.min(input.unusedMinor, input.policy.carryForwardCapMinor ?? 0);
    default: {
      // Exhaustiveness: a new policy must be handled, not fall through to carrying everything.
      const unreachable: never = input.policy.carryForwardPolicy;
      throw new Error(`Unhandled carry-forward policy: ${String(unreachable)}`);
    }
  }
}

/**
 * Whether a negative balance should stop new work.
 *
 * Separate from the hard stop, which is about a *percentage* of the allowance. This is about
 * having actually spent more than exists — which can happen because a provider's actual usage can
 * exceed the reserved estimate (ADR-159).
 */
export function negativeBalanceBlocks(input: {
  policy: Pick<CreditPolicy, 'negativeBalancePolicy' | 'negativeBalanceGraceMinor'>;
  remainingMinor: number;
}): { blocks: boolean; reason: string } {
  if (input.remainingMinor >= 0) {
    return { blocks: false, reason: 'The balance is not negative.' };
  }

  if (input.policy.negativeBalancePolicy === 'BlockImmediately') {
    return {
      blocks: true,
      reason: `The balance is ${input.remainingMinor} minor units and this company blocks at zero.`,
    };
  }

  const overdraft = -input.remainingMinor;
  return overdraft > input.policy.negativeBalanceGraceMinor
    ? {
        blocks: true,
        reason:
          `The balance is ${overdraft} minor units past zero, beyond the ` +
          `${input.policy.negativeBalanceGraceMinor} grace this company allows.`,
      }
    : {
        blocks: false,
        reason: `Within the ${input.policy.negativeBalanceGraceMinor} grace this company allows.`,
      };
}

/**
 * The allowance a plan change should produce, under each policy.
 *
 * Pro-rating is by remaining days in the cycle, which is the reading a customer would check with
 * a calendar. Returns the *new total* rather than a delta, so the caller writes one adjustment
 * entry for the difference and the arithmetic is visible in one place.
 */
export function allowanceAfterPlanChange(input: {
  policy: Pick<CreditPolicy, 'planChangePolicy'>;
  currentAllowanceMinor: number;
  newPlanAllowanceMinor: number;
  periodStart: Date;
  periodEnd: Date;
  at: Date;
}): { allowanceMinor: number; appliesNow: boolean; reason: string } {
  if (input.policy.planChangePolicy === 'NextCycle') {
    return {
      allowanceMinor: input.currentAllowanceMinor,
      appliesNow: false,
      reason: 'This cycle is unchanged; the new plan allowance starts at the next reset.',
    };
  }

  if (input.policy.planChangePolicy === 'ImmediateFull') {
    return {
      allowanceMinor: input.newPlanAllowanceMinor,
      appliesNow: true,
      reason: 'The new plan allowance applies in full from today.',
    };
  }

  const totalMs = input.periodEnd.getTime() - input.periodStart.getTime();
  if (totalMs <= 0) {
    // A degenerate period cannot be pro-rated. Falling back to the full allowance is the
    // customer-favourable direction and is stated rather than silent.
    return {
      allowanceMinor: input.newPlanAllowanceMinor,
      appliesNow: true,
      reason: 'The billing period has no length, so the new allowance is applied in full.',
    };
  }

  const remainingMs = Math.max(0, input.periodEnd.getTime() - input.at.getTime());
  const elapsedMs = totalMs - remainingMs;

  // What they have already earned at the old rate, plus what they will earn at the new one.
  const earned = Math.floor((input.currentAllowanceMinor * elapsedMs) / totalMs);
  const remaining = Math.floor((input.newPlanAllowanceMinor * remainingMs) / totalMs);

  return {
    allowanceMinor: earned + remaining,
    appliesNow: true,
    reason:
      `Pro-rated: ${earned} at the old allowance for the elapsed part of the cycle and ` +
      `${remaining} at the new one for the remainder.`,
  };
}

/**
 * The ledger kind a grant of each source produces.
 *
 * A table rather than a conditional, so "is a promotional credit a TopUp or an Adjustment" has
 * one answer somebody can read. Promotional credit is an `Adjustment`: it was not purchased, and
 * a revenue report that counted it as a top-up would overstate sales.
 */
export const GRANT_LEDGER_KIND: Record<GrantSource, LedgerEntryKind> = {
  PlanAllowance: 'TopUp',
  TopUp: 'TopUp',
  Promotional: 'Adjustment',
  ManualAdjustment: 'Adjustment',
  CarryForward: 'Adjustment',
  PlanChange: 'Adjustment',
};

// ---------------------------------------------------------------------------
// Reallocation
// ---------------------------------------------------------------------------

/**
 * Whether budget may be moved from one level to another.
 *
 * The prompt's constraint, and the only one that matters: reallocation "does not increase the
 * total commercial allowance". So a move is always a pair — out of one budget and into another,
 * the same amount — and the source must actually have it **uncommitted**. Moving budget that is
 * already reserved or spent would create money.
 */
export function validateReallocation(input: {
  amountMinor: number;
  fromRemainingMinor: number;
  fromWalletId: string;
  toWalletId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    return { ok: false, reason: 'Move a positive amount, in whole minor units.' };
  }
  if (input.fromWalletId === input.toWalletId) {
    return { ok: false, reason: 'Moving a budget to itself changes nothing.' };
  }
  if (input.amountMinor > input.fromRemainingMinor) {
    return {
      ok: false,
      reason:
        `Only ${input.fromRemainingMinor} minor units are uncommitted in the source budget. ` +
        'Moving more would reallocate money that is already spent or reserved, which would ' +
        'create allowance out of nothing.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resuming after a top-up
// ---------------------------------------------------------------------------

/**
 * Whether a blocked run may resume now that credits have arrived.
 *
 * The approved wording is narrow and this keeps it narrow: "eligible Engine Agent runs may
 * resume", "**blocked only because the credit/allowance was exhausted**", "subject to all other
 * permissions, approvals and limits".
 *
 * So a run blocked for any other reason stays blocked. Resuming a run that was stopped by a
 * permission failure because somebody bought credits would be the credit purchase quietly
 * clearing a governance decision.
 */
export function mayResumeAfterTopUp(input: { runState: string; blockedReason: string | null }): {
  resumable: boolean;
  reason: string;
} {
  if (input.runState !== 'BlockedByBudget') {
    return {
      resumable: false,
      reason:
        `This run is ${input.runState}, not blocked by budget. Credits do not clear any other ` +
        'kind of block.',
    };
  }
  return {
    resumable: true,
    reason:
      'It was blocked only by an exhausted allowance, and is still subject to every other ' +
      'permission, approval and limit when it runs.',
  };
}
