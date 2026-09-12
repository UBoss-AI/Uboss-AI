/**
 * Tokens, credits, budgets and the reserve/settle ledger — Prompt 30.
 *
 * ## The flow, and why every step exists
 *
 * §20 of the approved functional document:
 * **Check → Estimate → Reserve → Execute → Provider actual usage → Settle → Release unused
 * reserve → Reconcile.**
 *
 * The step that carries the weight is **Reserve**, and §20 says why in its own words: "Reserve an
 * estimated amount before sending the provider request **so concurrent Agents cannot overspend the
 * same remaining balance**." Without it, two agents each read a remaining balance of ₹100, each
 * spend ₹80, and the company is ₹60 over with both calls having passed their pre-run check. That
 * is not a rare race — it is the normal case for a company running scheduled agents.
 *
 * ## Two records, not one
 *
 * A **reservation** is mutable state: held, then settled or released. A **ledger entry** is
 * immutable and append-only. Both exist because they answer different questions — "how much is
 * currently set aside" and "what has ever happened to this budget" — and collapsing them would
 * make the second unanswerable the moment a reservation was released.
 *
 * The ledger is the source of truth. A running balance is maintained alongside it for the sake of
 * a concurrency-safe check, and `reconcile` is what proves the two still agree. §20 asks for that
 * job by name.
 *
 * ## Money
 *
 * Integer minor units throughout, as everywhere else in this codebase. Never a float, and never a
 * token count standing in for money — tokens are priced by a pricing version (Prompt 29) and the
 * price can change, so a budget denominated in tokens would silently change size.
 */

// ---------------------------------------------------------------------------
// The budget hierarchy
// ---------------------------------------------------------------------------

/**
 * §20's budget model: "Commercial allowance → Company AI Budget → Department/Cost Center →
 * Objective Budget → Agent/Run Limit."
 *
 * The commercial allowance sits *above* this list rather than in it: it is what the customer
 * bought, it lives on the subscription, and a company cannot set it. `Company` is the first level
 * a company controls.
 */
export const BUDGET_SCOPES = ['Company', 'Department', 'Objective', 'Agent'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_SCOPE_LABELS: Record<BudgetScope, string> = {
  Company: 'Company AI budget',
  Department: 'Department / cost centre',
  Objective: 'Objective budget',
  Agent: 'Agent / run limit',
};

/** Outermost first. A spend is checked against every level, and the tightest wins. */
export const BUDGET_SCOPE_ORDER: Record<BudgetScope, number> = {
  Company: 0,
  Department: 1,
  Objective: 2,
  Agent: 3,
};

/**
 * The scopes a spend must satisfy, outermost first.
 *
 * Order matters twice. It is the order the levels are *reported* in, so a refusal names the
 * outermost binding constraint rather than an arbitrary one — "the company budget is exhausted" is
 * a different conversation from "this agent's per-run limit is low". And it is the order rows are
 * **locked** in, which is what stops two concurrent reservations deadlocking against each other by
 * taking the same two rows in opposite orders.
 */
export function scopesToCheck(input: {
  departmentId: string | null;
  objectiveId: string | null;
  engineAgentId: string | null;
}): { scope: BudgetScope; subjectId: string | null }[] {
  const levels: { scope: BudgetScope; subjectId: string | null }[] = [
    { scope: 'Company', subjectId: null },
  ];
  if (input.departmentId !== null) {
    levels.push({ scope: 'Department', subjectId: input.departmentId });
  }
  if (input.objectiveId !== null) {
    levels.push({ scope: 'Objective', subjectId: input.objectiveId });
  }
  if (input.engineAgentId !== null) {
    levels.push({ scope: 'Agent', subjectId: input.engineAgentId });
  }
  return levels;
}

// ---------------------------------------------------------------------------
// A wallet's arithmetic
// ---------------------------------------------------------------------------

/**
 * One budget's numbers, as §20's "Credit / allowance display" lists them.
 *
 * `reservedMinor` is the field a naive implementation omits, and its absence is the overspend bug:
 * remaining has to be allowance minus what is spent **and** what is currently set aside, or two
 * concurrent runs both see room that only one of them has.
 */
export interface WalletSnapshot {
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
  currency: string;
  /** Null when the budget does not reset — a one-off top-up rather than a monthly allowance. */
  resetsAt: string | null;
  expiresAt: string | null;
}

export function remainingMinor(wallet: {
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
}): number {
  // Can go negative: a provider's actual usage can exceed the estimate that was reserved, and
  // clamping that to zero would hide a real overspend. `settle` records it and the ledger shows
  // it; the hard stop then refuses the *next* call.
  return wallet.allowanceMinor - wallet.usedMinor - wallet.reservedMinor;
}

/**
 * How much of the allowance is committed, as a percentage.
 *
 * Includes reservations, because a company at 90% used and 10% reserved is at 100% for every
 * decision that matters. Rounded down, so a threshold is crossed when it is genuinely crossed.
 * Returns 0 for a zero allowance rather than dividing by it — a company with no budget is not
 * "infinitely over", it has nothing configured, and the hard stop handles that separately.
 */
export function committedPercent(wallet: {
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
}): number {
  if (wallet.allowanceMinor <= 0) return 0;
  return Math.floor(((wallet.usedMinor + wallet.reservedMinor) / wallet.allowanceMinor) * 100);
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * §20's threshold levels.
 *
 * "Support configurable information, warning and critical thresholds. Example defaults may be 50%
 * information, 75% warning and 90% critical; **percentages must be configurable rather than
 * hard-coded**." So the defaults live here as defaults and the engine reads company settings.
 *
 * `HardStop` is a fourth level and is not a notification: it refuses execution. Listed with the
 * others because it is configured in the same place and a screen shows all four on one bar.
 */
export const COST_THRESHOLDS = ['Information', 'Warning', 'Critical', 'HardStop'] as const;
export type CostThreshold = (typeof COST_THRESHOLDS)[number];

export const COST_THRESHOLD_LABELS: Record<CostThreshold, string> = {
  Information: 'Information',
  Warning: 'Warning',
  Critical: 'Critical',
  HardStop: 'Hard stop',
};

export const COST_THRESHOLD_TONES: Record<CostThreshold, 'blue' | 'warn' | 'danger' | 'grey'> = {
  Information: 'blue',
  Warning: 'warn',
  Critical: 'danger',
  HardStop: 'danger',
};

/** §20's own example defaults. Configurable, and this is only where they start. */
export const DEFAULT_COST_THRESHOLD_PERCENTS: Record<CostThreshold, number> = {
  Information: 50,
  Warning: 75,
  Critical: 90,
  HardStop: 100,
};

/**
 * The highest threshold a wallet has crossed, or null below all of them.
 *
 * Highest rather than each in turn, because a company at 95% should hear "critical" and not also
 * "information" — three notifications for one condition is how a threshold alert becomes noise
 * somebody filters.
 */
export function crossedThreshold(input: {
  percent: number;
  percents?: Partial<Record<CostThreshold, number>> | undefined;
}): CostThreshold | null {
  const percents = { ...DEFAULT_COST_THRESHOLD_PERCENTS, ...(input.percents ?? {}) };

  // Descending, so the most severe crossed level is the answer.
  for (const threshold of ['HardStop', 'Critical', 'Warning', 'Information'] as const) {
    if (input.percent >= percents[threshold]) return threshold;
  }
  return null;
}

/**
 * Whether the thresholds are configured in a usable order.
 *
 * Refused rather than sorted, because a company that typed 90/75/50 by mistake meant something and
 * silently reordering it would hide the mistake until an alert failed to fire.
 */
export function thresholdsAreOrdered(percents: Record<CostThreshold, number>): {
  ok: boolean;
  reason: string;
} {
  const order: CostThreshold[] = ['Information', 'Warning', 'Critical', 'HardStop'];

  for (let index = 1; index < order.length; index += 1) {
    const previous = order[index - 1] as CostThreshold;
    const current = order[index] as CostThreshold;
    if (percents[current] <= percents[previous]) {
      return {
        ok: false,
        reason:
          `${COST_THRESHOLD_LABELS[current]} (${percents[current]}%) must be above ` +
          `${COST_THRESHOLD_LABELS[previous]} (${percents[previous]}%).`,
      };
    }
  }

  if (percents.Information < 1 || percents.HardStop > 200) {
    return {
      ok: false,
      reason: 'Thresholds must be between 1% and 200% of the allowance.',
    };
  }

  return { ok: true, reason: 'Thresholds are in order.' };
}

// ---------------------------------------------------------------------------
// The pre-run check
// ---------------------------------------------------------------------------

/** What a spend check answers. */
export const SPEND_DECISIONS = ['Allowed', 'NeedsApproval', 'HardStopped'] as const;
export type SpendDecision = (typeof SPEND_DECISIONS)[number];

export interface SpendCheckLevel {
  scope: BudgetScope;
  subjectId: string | null;
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
  remainingMinor: number;
  percentAfter: number;
  decision: SpendDecision;
  reason: string;
}

export type SpendCheckOutcome = {
  decision: SpendDecision;
  /** The level that produced the decision. Null when everything is allowed. */
  bindingLevel: SpendCheckLevel | null;
  levels: SpendCheckLevel[];
  reason: string;
};

/**
 * Decide one level.
 *
 * Three outcomes rather than two, because §20 has three controls: a warning that only notifies, an
 * **approval threshold** where "higher-cost execution" needs a person, and a **hard stop** that
 * blocks. Collapsing approval into blocked would make an expensive-but-authorised run impossible;
 * collapsing it into allowed would make the threshold decorative.
 *
 * A level with **no allowance configured is not a refusal.** Only the company level is required to
 * have one; a department or objective without a budget inherits its parent's, which is what makes
 * the hierarchy usable before every level has been filled in. A zero allowance at the company
 * level is a different thing and the hard stop catches it.
 */
export function decideLevel(input: {
  scope: BudgetScope;
  subjectId: string | null;
  allowanceMinor: number | null;
  usedMinor: number;
  reservedMinor: number;
  estimateMinor: number;
  approvalThresholdPercent: number;
  hardStopPercent: number;
}): SpendCheckLevel {
  if (input.allowanceMinor === null) {
    return {
      scope: input.scope,
      subjectId: input.subjectId,
      allowanceMinor: 0,
      usedMinor: input.usedMinor,
      reservedMinor: input.reservedMinor,
      remainingMinor: 0,
      percentAfter: 0,
      decision: 'Allowed',
      reason: `No ${BUDGET_SCOPE_LABELS[input.scope]} is set, so the level above governs.`,
    };
  }

  const remaining = remainingMinor({
    allowanceMinor: input.allowanceMinor,
    usedMinor: input.usedMinor,
    reservedMinor: input.reservedMinor,
  });

  const percentAfter = committedPercent({
    allowanceMinor: input.allowanceMinor,
    usedMinor: input.usedMinor,
    reservedMinor: input.reservedMinor + input.estimateMinor,
  });

  // Compared in **minor units, not percent**, and the difference is not pedantry. Percent is
  // floored for display, so a spend landing on 100.4% reads as 100 — a `>=` test would then
  // refuse a spend that only just fits, and a `>` test would allow one that does not. The
  // ceiling in minor units is exact.
  const committedAfterMinor = input.usedMinor + input.reservedMinor + input.estimateMinor;
  const hardStopCeilingMinor = Math.floor((input.allowanceMinor * input.hardStopPercent) / 100);

  const base = {
    scope: input.scope,
    subjectId: input.subjectId,
    allowanceMinor: input.allowanceMinor,
    usedMinor: input.usedMinor,
    reservedMinor: input.reservedMinor,
    remainingMinor: remaining,
    percentAfter,
  };

  // **Strictly past the ceiling, not at it.** A company that bought ten thousand should be able
  // to spend ten thousand; refusing the spend that lands exactly on the limit would make the
  // last slice of every allowance unspendable, which is not what "block when the limit is
  // reached" means — once it *is* reached, the next call is refused, and that is this same test.
  if (committedAfterMinor > hardStopCeilingMinor) {
    return {
      ...base,
      decision: 'HardStopped',
      reason:
        `This would take the ${BUDGET_SCOPE_LABELS[input.scope].toLowerCase()} past its ` +
        `${input.hardStopPercent}% hard stop, to ${percentAfter}% of its allowance.`,
    };
  }

  if (percentAfter >= input.approvalThresholdPercent) {
    return {
      ...base,
      decision: 'NeedsApproval',
      reason:
        `This would take the ${BUDGET_SCOPE_LABELS[input.scope].toLowerCase()} to ` +
        `${percentAfter}%, past the ${input.approvalThresholdPercent}% approval threshold. ` +
        'A person has to authorise it.',
    };
  }

  return {
    ...base,
    decision: 'Allowed',
    reason: `Within the ${BUDGET_SCOPE_LABELS[input.scope].toLowerCase()} at ${percentAfter}%.`,
  };
}

/**
 * Combine the levels: the strictest wins, and the outermost strictest is what gets reported.
 *
 * Outermost on purpose. If both the company budget and one agent's limit would hard-stop, the
 * company budget is the real problem and the agent's limit is a detail — telling somebody to raise
 * an agent limit when the company is out of credit sends them to fix the wrong thing.
 */
export function combineLevels(levels: readonly SpendCheckLevel[]): SpendCheckOutcome {
  const ordered = [...levels].sort(
    (a, b) => BUDGET_SCOPE_ORDER[a.scope] - BUDGET_SCOPE_ORDER[b.scope],
  );

  const hardStopped = ordered.find((level) => level.decision === 'HardStopped');
  if (hardStopped !== undefined) {
    return {
      decision: 'HardStopped',
      bindingLevel: hardStopped,
      levels: ordered,
      reason: hardStopped.reason,
    };
  }

  const needsApproval = ordered.find((level) => level.decision === 'NeedsApproval');
  if (needsApproval !== undefined) {
    return {
      decision: 'NeedsApproval',
      bindingLevel: needsApproval,
      levels: ordered,
      reason: needsApproval.reason,
    };
  }

  return {
    decision: 'Allowed',
    bindingLevel: null,
    levels: ordered,
    reason: 'Within every configured budget.',
  };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/**
 * A reservation's life.
 *
 * `Held` is the only state that counts against a balance. The other three are terminal and record
 * *why* it stopped counting, which is what makes an overspend investigation possible: a
 * reservation that expired is a run the engine lost track of, and one that was released is a run
 * that finished cheaply.
 */
export const RESERVATION_STATES = ['Held', 'Settled', 'Released', 'Expired'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export const RESERVATION_STATE_LABELS: Record<ReservationState, string> = {
  Held: 'Held',
  Settled: 'Settled',
  Released: 'Released',
  Expired: 'Expired',
};

export function reservationIsOpen(state: ReservationState): boolean {
  return state === 'Held';
}

/**
 * Whether a reservation may move.
 *
 * Only from `Held`, and never back. A settled reservation that could be re-held would let one run
 * charge a budget twice; an expired one that could settle would charge a budget for work whose
 * outcome nobody recorded.
 */
export function mayMoveReservation(from: ReservationState, to: ReservationState): boolean {
  if (from === to) return true;
  return from === 'Held' && to !== 'Held';
}

/**
 * How long a reservation may be held before a sweep treats it as abandoned.
 *
 * Long enough that a slow provider call is not swept out from under a live run, short enough that
 * a crashed worker does not hold a company's budget hostage until somebody notices. A run that
 * genuinely takes longer than this has a different problem, and the sweep records the expiry rather
 * than deleting it.
 */
export const RESERVATION_EXPIRY_MINUTES = 60;

export function reservationHasExpired(input: {
  state: ReservationState;
  heldAt: Date;
  now: Date;
  expiryMinutes?: number | undefined;
}): boolean {
  if (input.state !== 'Held') return false;
  const minutes = (input.now.getTime() - input.heldAt.getTime()) / 60_000;
  return minutes >= (input.expiryMinutes ?? RESERVATION_EXPIRY_MINUTES);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/**
 * Every kind of movement §20 requires the ledger to preserve: "every credit purchase, addition,
 * adjustment, reallocation, deduction, refund/release and approval with who, amount, reason, time,
 * source/reference and resulting balance".
 *
 * `Reserve` and `ReleaseReserve` are included even though they net to zero across a run, because
 * omitting them would make the balance unexplainable at any moment *during* a run — and "why does
 * this say we have less than the sum of our spends" is the first question anybody asks.
 */
export const LEDGER_ENTRY_KINDS = [
  'TopUp',
  'Adjustment',
  'Reallocation',
  'Reserve',
  'ReleaseReserve',
  'Settle',
  'Refund',
  'Expiry',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const LEDGER_ENTRY_KIND_LABELS: Record<LedgerEntryKind, string> = {
  TopUp: 'Credit added',
  Adjustment: 'Manual adjustment',
  Reallocation: 'Budget reallocated',
  Reserve: 'Reserved',
  ReleaseReserve: 'Reservation released',
  Settle: 'Charged',
  Refund: 'Refunded',
  Expiry: 'Expired',
};

/**
 * Which of the two running totals a kind moves, and in which direction.
 *
 * A table rather than a switch in the engine, so "does a refund reduce used or increase
 * allowance" has one answer that a test can enumerate. It reduces `used`: a refund is money coming
 * back on work already charged, not a larger allowance.
 */
export const LEDGER_EFFECT: Record<
  LedgerEntryKind,
  { allowance: -1 | 0 | 1; used: -1 | 0 | 1; reserved: -1 | 0 | 1 }
> = {
  TopUp: { allowance: 1, used: 0, reserved: 0 },
  Adjustment: { allowance: 1, used: 0, reserved: 0 },
  Reallocation: { allowance: 1, used: 0, reserved: 0 },
  Reserve: { allowance: 0, used: 0, reserved: 1 },
  ReleaseReserve: { allowance: 0, used: 0, reserved: -1 },
  Settle: { allowance: 0, used: 1, reserved: 0 },
  Refund: { allowance: 0, used: -1, reserved: 0 },
  Expiry: { allowance: -1, used: 0, reserved: 0 },
};

/**
 * Apply one entry to a balance.
 *
 * The signed `amountMinor` and the effect table together decide the movement, so a
 * `Reallocation` of −₹5,000 out of one department and +₹5,000 into another is two entries with the
 * same kind and opposite signs rather than two kinds that have to stay in step.
 */
export function applyLedgerEntry(
  balance: { allowanceMinor: number; usedMinor: number; reservedMinor: number },
  entry: { kind: LedgerEntryKind; amountMinor: number },
): { allowanceMinor: number; usedMinor: number; reservedMinor: number } {
  const effect = LEDGER_EFFECT[entry.kind];
  return {
    allowanceMinor: balance.allowanceMinor + effect.allowance * entry.amountMinor,
    usedMinor: balance.usedMinor + effect.used * entry.amountMinor,
    reservedMinor: balance.reservedMinor + effect.reserved * entry.amountMinor,
  };
}

/**
 * Rebuild a balance from its entries.
 *
 * This is what `reconcile` compares the maintained balance against, and it is why the ledger is
 * the source of truth rather than the balance columns. §20 asks for the job; this is the half of
 * it that has no database in the way.
 */
export function replayLedger(entries: readonly { kind: LedgerEntryKind; amountMinor: number }[]): {
  allowanceMinor: number;
  usedMinor: number;
  reservedMinor: number;
} {
  return entries.reduce(applyLedgerEntry, {
    allowanceMinor: 0,
    usedMinor: 0,
    reservedMinor: 0,
  });
}

export interface ReconciliationFinding {
  scope: BudgetScope;
  subjectId: string | null;
  field: 'allowanceMinor' | 'usedMinor' | 'reservedMinor';
  storedMinor: number;
  replayedMinor: number;
  driftMinor: number;
}

/**
 * Compare a maintained balance with its replayed ledger.
 *
 * Reports drift; does not correct it. Silently overwriting the stored balance with the replay
 * would destroy the evidence that they had ever disagreed — and a disagreement means either a
 * write outside the engine or a bug in it, both of which somebody needs to see.
 */
export function reconcileBalance(input: {
  scope: BudgetScope;
  subjectId: string | null;
  stored: { allowanceMinor: number; usedMinor: number; reservedMinor: number };
  entries: readonly { kind: LedgerEntryKind; amountMinor: number }[];
}): ReconciliationFinding[] {
  const replayed = replayLedger(input.entries);
  const findings: ReconciliationFinding[] = [];

  for (const field of ['allowanceMinor', 'usedMinor', 'reservedMinor'] as const) {
    const storedMinor = input.stored[field];
    const replayedMinor = replayed[field];
    if (storedMinor !== replayedMinor) {
      findings.push({
        scope: input.scope,
        subjectId: input.subjectId,
        field,
        storedMinor,
        replayedMinor,
        driftMinor: storedMinor - replayedMinor,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * When the allowance runs out at the current rate — §20's "projected exhaustion".
 *
 * Returns null rather than a date in three cases, and each of them is a case where a date would be
 * a lie:
 *
 *   * **Nothing has been spent yet.** A rate of zero projects to never, and "never" shown as a
 *     date is worse than an empty cell.
 *   * **The window is shorter than an hour.** A rate extrapolated from minutes of data would
 *     swing wildly and be quoted anyway.
 *   * **Already exhausted.** There is nothing to project; the screen shows the hard stop instead.
 */
export function projectedExhaustion(input: {
  usedMinor: number;
  reservedMinor: number;
  allowanceMinor: number;
  /** When the current period began. */
  periodStart: Date;
  now: Date;
}): { at: string; daysAway: number } | null {
  const committed = input.usedMinor + input.reservedMinor;
  const remaining = input.allowanceMinor - committed;
  if (remaining <= 0 || committed <= 0) return null;

  const hoursElapsed = (input.now.getTime() - input.periodStart.getTime()) / 3_600_000;
  if (hoursElapsed < 1) return null;

  const perHour = committed / hoursElapsed;
  if (perHour <= 0) return null;

  const hoursLeft = remaining / perHour;
  const at = new Date(input.now.getTime() + hoursLeft * 3_600_000);

  return { at: at.toISOString(), daysAway: Math.round((hoursLeft / 24) * 10) / 10 };
}

/**
 * A conservative estimate of what a call will cost, in minor units.
 *
 * Deliberately pessimistic: it assumes the whole token ceiling is spent, and prices every token at
 * the *output* rate when output is dearer. An estimate that came in low would let a reservation be
 * smaller than the eventual charge, which is precisely the overspend the reservation exists to
 * prevent — and the unused part is released seconds later, so the cost of being pessimistic is a
 * brief over-reservation and nothing else.
 */
export function estimateMinor(input: {
  maxTokens: number;
  inputPerMillionMinorUnits: number;
  outputPerMillionMinorUnits: number;
}): number {
  const dearest = Math.max(input.inputPerMillionMinorUnits, input.outputPerMillionMinorUnits);
  return Math.ceil((input.maxTokens * dearest) / 1_000_000);
}
