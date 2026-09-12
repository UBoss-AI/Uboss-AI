import { type ObjectiveStatus } from './objectives.js';

/**
 * Objective closure and Outcome Review — Prompt 34.
 *
 * ## What the approved documents ask for
 *
 * §27.1: *"A Live Objective supports controlled Pause/Resume and a formal Completed -> Outcome
 * Review -> Closed -> Archived lifecycle. Closure compares expected vs actual result, SLA/target,
 * Human effort, AI cost and unresolved exceptions. Reopening a closed/live definition follows
 * version rules."*
 *
 * The lifecycle states themselves live in `objectives.ts`, extended rather than duplicated —
 * an objective's closure states are objective states, and a second transition table is how two
 * tables come to disagree.
 *
 * ## The review compares; it does not measure
 *
 * Every figure the review shows is **already recorded by the module that owns it**:
 *
 *   * Expected Final Result and the target/SLA are canonical Form 2 fields (Prompt 19).
 *   * Human effort is on `human_tasks` (Prompt 23) — as task counts and elapsed time, because
 *     nothing in UBoss records effort.
 *   * AI cost is the Prompt 30 ledger.
 *   * Unresolved items are Prompt 27's executor exceptions.
 *
 * So the review record stores the **actual** result — which is a judgement somebody makes, and
 * exists nowhere else — plus a snapshot of the compared figures at the moment of review, and the
 * sign-off. It does not recompute anything, and it does not become a second home for effort or
 * cost.
 *
 * ## Why it snapshots rather than joins
 *
 * A review read live would change after it was signed: a late cost settlement or a reopened
 * exception would silently alter what somebody put their name to. §27.1 asks for a *formal*
 * closure, and a signed document whose contents move is not one. The live figures stay available
 * beside the snapshot, so a reader can see both and a drift between them is visible rather than
 * hidden.
 */

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * How the actual result compared with what was expected.
 *
 * Four outcomes, because three would force a reviewer to lie. §27.1 asks the review to compare
 * expected against actual and states no vocabulary, so this is the smallest set that can describe
 * a real objective honestly:
 *
 *   * `Met` — the expected final result was achieved.
 *   * `PartiallyMet` — some of it was, and the review says which part was not.
 *   * `NotMet` — it was not achieved.
 *   * `Superseded` — the objective stopped being the right thing to do. Not a failure, and
 *     recording it as one would teach companies to avoid closing objectives honestly.
 */
export const OUTCOME_VERDICTS = ['Met', 'PartiallyMet', 'NotMet', 'Superseded'] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export const OUTCOME_VERDICT_LABELS: Record<OutcomeVerdict, string> = {
  Met: 'Met',
  PartiallyMet: 'Partially met',
  NotMet: 'Not met',
  Superseded: 'No longer the right objective',
};

export const OUTCOME_VERDICT_DESCRIPTIONS: Record<OutcomeVerdict, string> = {
  Met: 'The expected final result was achieved.',
  PartiallyMet: 'Some of it was achieved. Say which part was not.',
  NotMet: 'It was not achieved. Say why.',
  Superseded:
    'Circumstances changed and this stopped being the right thing to do. Not a failure — say ' +
    'what replaced it.',
};

/** Verdicts that require the reviewer to explain. Everything but a clean `Met`. */
export function verdictRequiresExplanation(verdict: OutcomeVerdict): boolean {
  return verdict !== 'Met';
}

/**
 * The minimum length of an explanation.
 *
 * Forty characters — longer than the twenty a feedback correction needs, because this one is read
 * by a manager at a quarterly review rather than by the person who wrote it, and "ran out of time"
 * is not an outcome review.
 */
export const MIN_OUTCOME_EXPLANATION_LENGTH = 40;

// ---------------------------------------------------------------------------
// The SLA comparison
// ---------------------------------------------------------------------------

/**
 * Whether the work finished inside its target.
 *
 * `Unknown` is a first-class answer and not a failure: an objective whose Form 2 named no target
 * date cannot be late, and reporting it as on-time would be as false as reporting it as late.
 */
export const SLA_OUTCOMES = ['OnTime', 'Late', 'Unknown'] as const;
export type SlaOutcome = (typeof SLA_OUTCOMES)[number];

export const SLA_OUTCOME_LABELS: Record<SlaOutcome, string> = {
  OnTime: 'On time',
  Late: 'Late',
  Unknown: 'No target was set',
};

export function slaOutcome(input: { targetDate: Date | null; completedAt: Date | null }): {
  outcome: SlaOutcome;
  daysLate: number | null;
} {
  if (input.targetDate === null || input.completedAt === null) {
    return { outcome: 'Unknown', daysLate: null };
  }

  const difference = input.completedAt.getTime() - input.targetDate.getTime();
  if (difference <= 0) return { outcome: 'OnTime', daysLate: 0 };

  return {
    // Rounded **up**: finishing three hours after the target is a day late, not zero days late.
    // A figure that rounded down would report a missed deadline as met.
    outcome: 'Late',
    daysLate: Math.ceil(difference / 86_400_000),
  };
}

// ---------------------------------------------------------------------------
// What the review compares
// ---------------------------------------------------------------------------

/** The figures the review is built from, each fetched from the module that owns it. */
export interface OutcomeComparison {
  /** Form 2's Expected Final Result, as the live version recorded it. */
  expectedFinalResult: string;
  /** Form 2's target date, where one was set. */
  targetDate: string | null;
  completedAt: string | null;

  /** Human effort: how many tasks, and how many finished. */
  humanTasksTotal: number;
  humanTasksCompleted: number;
  /**
   * Wall-clock minutes between a task starting and completing, summed — **not effort**.
   *
   * UBoss records no effort anywhere: `human_tasks` has a start and a finish and no time log, so
   * a task somebody picked up on Monday and finished on Friday reads as four days whether they
   * spent four days or twenty minutes on it. Named for what it is, because "human effort: 5,760
   * minutes" beside "AI cost: 12,500" is a comparison a manager would act on, and the two are not
   * measuring the same kind of thing.
   *
   * Null when no task has both a start and a finish.
   */
  humanElapsedMinutes: number | null;

  /** AI cost in minor units, settled from the Prompt 30 ledger. */
  aiCostMinor: number;
  aiCostCurrency: string;
  agentRunsTotal: number;

  /** Prompt 27's exceptions, and how many are still open. */
  exceptionsTotal: number;
  exceptionsUnresolved: number;
}

/**
 * Whether an objective is ready to be reviewed, and what is outstanding if not.
 *
 * §27.1 requires the review to compare "exceptions/unresolved items", which means the review has
 * to be able to *see* them — not that they must be gone. So unresolved work is **reported, not
 * blocking**: a company closing an objective with three open exceptions is making a decision, and
 * the review's job is to make sure it is a decision rather than an oversight.
 *
 * The one thing that does block is an objective whose tasks are still running, because "what was
 * the actual result" has no answer while work is in progress.
 */
export interface ReadinessForReview {
  ready: boolean;
  /** Stated on the screen, whether or not they block. */
  outstanding: string[];
  /** The subset that actually prevents a review. */
  blocking: string[];
}

export function readinessForReview(comparison: OutcomeComparison): ReadinessForReview {
  const outstanding: string[] = [];
  const blocking: string[] = [];

  const openTasks = comparison.humanTasksTotal - comparison.humanTasksCompleted;
  if (openTasks > 0) {
    const problem =
      `${openTasks} of ${comparison.humanTasksTotal} human task(s) are not finished. ` +
      'An objective with work still in progress has no actual result yet.';
    outstanding.push(problem);
    blocking.push(problem);
  }

  if (comparison.exceptionsUnresolved > 0) {
    // Reported and not blocking: closing with open exceptions is a decision the review records.
    outstanding.push(
      `${comparison.exceptionsUnresolved} of ${comparison.exceptionsTotal} exception(s) are ` +
        'unresolved. Closing anyway is a decision the review will record.',
    );
  }

  if (comparison.completedAt === null) {
    const problem = 'The objective has no completion date, so there is nothing to compare against.';
    outstanding.push(problem);
    blocking.push(problem);
  }

  return { ready: blocking.length === 0, outstanding, blocking };
}

// ---------------------------------------------------------------------------
// Sign-off
// ---------------------------------------------------------------------------

/**
 * When closure needs somebody else's signature.
 *
 * §27.1 says "approval/owner sign-off **where policy requires**", which is a company decision and
 * not a fixed rule. So the requirement is configuration, and these are the cases a company can
 * ask for:
 *
 *   * `Never` — the reviewer closes it.
 *   * `OwnerSignOff` — the objective's owner signs, even when somebody else reviewed.
 *   * `Approval` — it goes through the Prompt 28 approval engine.
 *
 * The default is `OwnerSignOff`, and the reason is the case it prevents: a review written by
 * somebody other than the owner, closing the owner's objective, with the owner never told. That is
 * not an approval in the four-eyes sense — it is making sure the person accountable for the work
 * sees how it was judged.
 */
export const CLOSURE_SIGN_OFF_POLICIES = ['Never', 'OwnerSignOff', 'Approval'] as const;
export type ClosureSignOffPolicy = (typeof CLOSURE_SIGN_OFF_POLICIES)[number];

export const CLOSURE_SIGN_OFF_LABELS: Record<ClosureSignOffPolicy, string> = {
  Never: 'The reviewer closes it',
  OwnerSignOff: 'The objective’s owner signs it off',
  Approval: 'It goes through an approval',
};

export const DEFAULT_CLOSURE_SIGN_OFF_POLICY: ClosureSignOffPolicy = 'OwnerSignOff';

export interface ClosureAttempt {
  policy: ClosureSignOffPolicy;
  /** Who is closing it. */
  actorUserId: string;
  /** Who owns the objective. */
  ownerUserId: string;
  /** Set once the owner has signed. */
  signedOffByUserId: string | null;
  /** A verified, approved request id — not a boolean claim (ADR-160). */
  approvalRequestId: string | null;
}

export type ClosureDecision = { mayClose: true } | { mayClose: false; reason: string };

/**
 * Whether closure may proceed.
 *
 * The owner closing their own objective satisfies `OwnerSignOff` without a separate signature —
 * requiring them to sign their own closure would be ceremony, and §27.1 asks for sign-off rather
 * than for two signatures. `Approval` is different: that one is a second person by construction,
 * and the approval engine's own separation-of-duties rules apply to it.
 */
export function decideClosure(attempt: ClosureAttempt): ClosureDecision {
  switch (attempt.policy) {
    case 'Never':
      return { mayClose: true };

    case 'OwnerSignOff':
      if (attempt.actorUserId === attempt.ownerUserId) return { mayClose: true };
      if (attempt.signedOffByUserId === attempt.ownerUserId) return { mayClose: true };
      return {
        mayClose: false,
        reason:
          'This company requires the objective’s owner to sign off a closure. Ask them to sign ' +
          'the review, or close it yourself if you are the owner.',
      };

    case 'Approval':
      if (attempt.approvalRequestId !== null) return { mayClose: true };
      return {
        mayClose: false,
        reason:
          'This company requires an approval before an objective is closed. Raise one and pass ' +
          'the approved request.',
      };
  }
}

// ---------------------------------------------------------------------------
// Pause and resume
// ---------------------------------------------------------------------------

/**
 * Why an objective was paused.
 *
 * Not a free-text-only field, because "why is this paused" is the first question asked and a
 * category makes a list of paused objectives readable. The reason text is still mandatory.
 */
export const PAUSE_REASONS = [
  'WaitingOnSomebody',
  'WaitingOnBudget',
  'Deprioritised',
  'BeingRethought',
  'Other',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PAUSE_REASON_LABELS: Record<PauseReason, string> = {
  WaitingOnSomebody: 'Waiting on somebody outside this objective',
  WaitingOnBudget: 'Waiting on budget or credits',
  Deprioritised: 'Deprioritised for now',
  BeingRethought: 'Being rethought',
  Other: 'Something else',
};

/**
 * What a pause stops.
 *
 * §27.1 calls it "controlled Pause/Resume" and the control is this: a paused objective starts no
 * new work. It does **not** cancel work already in flight, because killing a run mid-flight would
 * lose whatever it had done and a pause is meant to be reversible.
 *
 * Exported as a constant rather than a comment so the UI states the same thing the service does.
 */
export const PAUSE_EFFECT =
  'Pausing stops new work: no task is assigned and no scheduled agent run starts. Work already ' +
  'in flight finishes — a pause never discards what a run has already done. The objective’s ' +
  'definition stays frozen, so rethinking it means a new Draft version.';

/** A paused objective is not assignable, which is what makes the pause a control. */
export function statusStartsNewWork(status: ObjectiveStatus): boolean {
  return status === 'Active';
}

/**
 * Every closure state, for a report that needs to know which objectives are finished.
 *
 * `Paused` is deliberately absent: a paused objective is live work that has stopped, not finished
 * work. A report counting it as closed would understate what a company still has open.
 */
export const CLOSED_OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = [
  'Completed',
  'OutcomeReview',
  'Closed',
  'Archived',
];

export function isObjectiveFinished(status: ObjectiveStatus): boolean {
  return CLOSED_OBJECTIVE_STATUSES.includes(status);
}
