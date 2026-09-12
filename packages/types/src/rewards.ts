/**
 * Reward rules and reward awards.
 *
 * ## Rule and award are different things
 *
 * A **reward rule** is the declaration attached to an objective — "a bonus of ₹5,000 applies if
 * this ships with zero critical gaps, and Priya approves it". It lives in `objective_rewards`,
 * created at Prompt 19 as the Performance & Reward panel, one per objective. There is deliberately
 * no second `reward_rules` table: the panel *is* the rule, and a duplicate would immediately
 * disagree with it.
 *
 * A **reward award** is one person's claim under that rule. It carries the lifecycle, because the
 * lifecycle is about an instance: two people can be assigned under one rule and one of them can be
 * rejected.
 *
 * ## Nothing here pays anybody by itself
 *
 * The client's rule is explicit: **do not auto-pay cash.** So `Approved` is not the end of the
 * chain and it is not a payment — it is a decision. Money only moves through
 * `settle`, which needs a configured payroll connector, a separate act by a different person, and
 * which records a reference to what the provider did. With no connector configured the product
 * refuses to settle rather than pretending to.
 *
 * ## Points reach performance only through policy
 *
 * An approved points award does **not** write a performance event on its own. It writes one only
 * when the company's active performance policy says reward points may reach the score, and the
 * default is that they may not. That is the client's "link approved points/achievement to
 * performance only through policy", expressed as a gate rather than a convention.
 */

import type { RewardType } from './objectives.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The client's chain: `Draft -> Assigned -> Completed -> Eligible -> Approved/Rejected ->
 * Settled/Recorded`.
 *
 * The two slash pairs are four separate states, not two, and the distinction carries meaning:
 *
 *   * **`Approved` vs `Rejected`** — the decision, either way, and both are real outcomes that a
 *     person is accountable for.
 *   * **`Settled` vs `Recorded`** — how an approved award *finished*. `Settled` means money moved
 *     through an approved payroll connector and there is a provider reference for it. `Recorded`
 *     means nothing was paid: points or a recognition were written down. Collapsing the two would
 *     make "was this paid?" unanswerable, which is the question an audit asks first.
 */
export const REWARD_AWARD_STATUSES = [
  'Draft',
  'Assigned',
  'Completed',
  'Eligible',
  'Approved',
  'Rejected',
  'Settled',
  'Recorded',
] as const;
export type RewardAwardStatus = (typeof REWARD_AWARD_STATUSES)[number];

export const REWARD_AWARD_STATUS_LABELS: Record<RewardAwardStatus, string> = {
  Draft: 'Draft',
  Assigned: 'Assigned',
  Completed: 'Work completed',
  Eligible: 'Eligible',
  Approved: 'Approved',
  Rejected: 'Rejected',
  Settled: 'Settled',
  Recorded: 'Recorded',
};

export const REWARD_AWARD_STATUS_TONES: Record<RewardAwardStatus, string> = {
  Draft: 'grey',
  Assigned: 'blue',
  Completed: 'cyan',
  Eligible: 'warn',
  Approved: 'success',
  Rejected: 'danger',
  Settled: 'success',
  Recorded: 'purple',
};

/**
 * The closed transition table.
 *
 * ## `Rejected` is reachable from three places, and that is deliberate
 *
 * A claim can fail because the work was not done (`Assigned`), because the condition was not met
 * (`Completed`), or because the approver said no (`Eligible`). Forcing every rejection through
 * `Eligible` would mean declaring somebody eligible in order to refuse them, which is a false
 * record of what happened.
 *
 * ## Nothing returns from a terminal state
 *
 * `Rejected`, `Settled` and `Recorded` are ends. A reward that could be un-settled would be a
 * reward that could be paid twice, and an un-rejected one would let a refused claim quietly
 * reappear. A mistake is corrected by a new award with a reason, not by reopening the old one.
 */
export const ALLOWED_AWARD_TRANSITIONS: Record<RewardAwardStatus, readonly RewardAwardStatus[]> = {
  Draft: ['Assigned', 'Rejected'],
  Assigned: ['Completed', 'Rejected'],
  Completed: ['Eligible', 'Rejected'],
  Eligible: ['Approved', 'Rejected'],
  // Approved is a decision, not a payment. It ends in Settled (money moved) or Recorded (it did
  // not), and never in "paid" as a side effect of approving.
  Approved: ['Settled', 'Recorded'],
  Rejected: [],
  Settled: [],
  Recorded: [],
};

export function mayTransitionAward(from: RewardAwardStatus, to: RewardAwardStatus): boolean {
  return ALLOWED_AWARD_TRANSITIONS[from].includes(to);
}

export const TERMINAL_AWARD_STATUSES = ['Rejected', 'Settled', 'Recorded'] as const;

export function isAwardTerminal(status: RewardAwardStatus): boolean {
  return (TERMINAL_AWARD_STATUSES as readonly RewardAwardStatus[]).includes(status);
}

/** Statuses in which an award is still a live claim on the rule. */
export const OPEN_AWARD_STATUSES = [
  'Draft',
  'Assigned',
  'Completed',
  'Eligible',
  'Approved',
] as const;

export function isAwardOpen(status: RewardAwardStatus): boolean {
  return !isAwardTerminal(status);
}

// ---------------------------------------------------------------------------
// How an approved award finishes
// ---------------------------------------------------------------------------

/**
 * What an approved award of each reward type has to do to finish.
 *
 * This is the whole of "do not auto-pay cash", as a function rather than as a comment: a `Cash`
 * award's only exit is `Payout`, which needs a connector, and no other type can reach that path.
 */
export const SETTLEMENT_ROUTES = ['Payout', 'PerformancePoints', 'RecordOnly'] as const;
export type SettlementRoute = (typeof SETTLEMENT_ROUTES)[number];

export const SETTLEMENT_ROUTE_LABELS: Record<SettlementRoute, string> = {
  Payout: 'Payout through an approved payroll connector',
  PerformancePoints: 'Points recorded against performance, if policy permits',
  RecordOnly: 'Recorded only — nothing is paid and no score changes',
};

export function settlementRouteFor(rewardType: RewardType): SettlementRoute {
  if (rewardType === 'Cash') return 'Payout';
  if (rewardType === 'Points') return 'PerformancePoints';
  // Recognition and Other are not quantified, so there is nothing to pay and nothing to score.
  return 'RecordOnly';
}

/** The status an approved award of this type ends in. */
export function terminalStatusFor(rewardType: RewardType): 'Settled' | 'Recorded' {
  return settlementRouteFor(rewardType) === 'Payout' ? 'Settled' : 'Recorded';
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * What a settlement asks a payroll connector to do.
 *
 * Deliberately small, and deliberately carries the award id: a provider that is asked twice for
 * the same award must be able to recognise it, and a reference that comes back has to be
 * attributable to something.
 */
export interface PayoutRequest {
  awardId: string;
  subjectUserId: string;
  amountMinorUnits: number;
  currency: string;
  /** What the money is for, in words a payroll operator will read. */
  memo: string;
}

export interface PayoutResult {
  /** The provider's own reference. Stored, so "was this paid?" has an answer outside UBoss. */
  reference: string;
  /**
   * Whether real money actually moved. **False for every adapter that ships today.** A screen or
   * a report that claimed a settlement was real when this is false would be the fabrication the
   * client's rules forbid.
   */
  deliveredRealPayment: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Whether a rule is complete enough to assign an award under.
 *
 * Stricter than saving the panel, on purpose: a half-written rule is a fine draft and a terrible
 * promise. Once somebody is assigned under it, "what exactly was promised" has to have an answer.
 */
export function validateRuleForAssignment(rule: {
  applicable: boolean;
  rewardType: RewardType | null;
  amountMinorUnits: number | null;
  eligibilityCondition: string | null;
  approverUserId: string | null;
}): string[] {
  const problems: string[] = [];

  if (!rule.applicable) {
    problems.push(
      'This objective records that no reward applies. Switch the panel on before assigning one.',
    );
    return problems;
  }

  if (rule.rewardType === null) {
    problems.push('The reward rule needs a Reward Type before anybody can be assigned under it.');
  }

  if (rule.eligibilityCondition === null || rule.eligibilityCondition.trim() === '') {
    problems.push('The reward rule needs an Eligibility Condition.');
  }

  if (rule.approverUserId === null) {
    problems.push('The reward rule needs a named Approver.');
  }

  const quantified = rule.rewardType === 'Cash' || rule.rewardType === 'Points';
  if (quantified && rule.amountMinorUnits === null) {
    problems.push(`A ${rule.rewardType} reward needs an Amount / Points.`);
  }

  return problems;
}

/**
 * Whether an approved award may take the payout route.
 *
 * The three conditions are all necessary and none is a formality: the type must be the one that
 * means money, there must be an amount, and there must be a connector that says it can pay. The
 * third is the client's integration boundary, and refusing here is what makes "no auto-pay" true
 * rather than aspirational.
 */
export function validatePayout(input: {
  rewardType: RewardType | null;
  amountMinorUnits: number | null;
  connectorConfigured: boolean;
}): string[] {
  const problems: string[] = [];

  if (input.rewardType !== 'Cash') {
    problems.push(
      `A ${input.rewardType ?? 'reward'} award is not settled through payroll. Record it instead.`,
    );
  }

  if (input.amountMinorUnits === null || input.amountMinorUnits <= 0) {
    problems.push('A payout needs a positive amount.');
  }

  if (!input.connectorConfigured) {
    problems.push(
      'No approved payroll or payment connector is configured, so this cannot be settled. ' +
        'UBoss will not record a payment it did not make.',
    );
  }

  return problems;
}
