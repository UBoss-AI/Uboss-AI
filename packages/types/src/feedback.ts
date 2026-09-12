/**
 * AI output feedback and correction — Prompt 33.
 *
 * ## What the approved documents ask for
 *
 * §27.1: *"Permitted users can mark AI output Correct, Needs Correction, Incorrect or Incomplete
 * and provide correction/evidence. Feedback feeds Agent/Skill quality and evaluation workflows; it
 * is not assumed to train external provider models."*
 *
 * The Technical Architecture's `feedback` table: *"run/output, rating, correction/evidence,
 * reviewer, evaluation eligibility."* Both are transcribed here rather than interpreted.
 *
 * ## The sentence that governs the whole module
 *
 * *"It is not assumed to train external provider models."* Prompt 33's own wording is stronger —
 * **"Do NOT assume or automatically enable external provider model training on company data"** —
 * and this module is built so that there is nothing to disable: no field records consent to
 * training, no adapter is passed a training flag, and feedback never leaves UBoss. A company's
 * correction improves *its own* evaluation dataset and nothing else.
 *
 * That is why `evaluationEligible` exists and why it is not called "training data". Eligible
 * feedback becomes a candidate `skill_evaluation_case` — a test UBoss runs against its own Skills
 * — which is a different thing from a sample sent to a provider, and the difference should be
 * visible in the vocabulary.
 */

// ---------------------------------------------------------------------------
// The rating
// ---------------------------------------------------------------------------

/** The client's four ratings, in the order §27.1 names them. */
export const FEEDBACK_RATINGS = ['Correct', 'NeedsCorrection', 'Incorrect', 'Incomplete'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_RATING_LABELS: Record<FeedbackRating, string> = {
  Correct: 'Correct',
  NeedsCorrection: 'Needs correction',
  Incorrect: 'Incorrect',
  Incomplete: 'Incomplete',
};

/**
 * What each rating means, shown beside the control.
 *
 * The distinction between the three negative ratings is the whole value of having three: a
 * reviewer who cannot tell them apart will pick one at random and the dataset will be noise.
 */
export const FEEDBACK_RATING_DESCRIPTIONS: Record<FeedbackRating, string> = {
  Correct: 'Usable as it is.',
  NeedsCorrection: 'Broadly right, with something to fix. Say what.',
  Incorrect: 'Wrong. It states something that is not true, or did the wrong thing.',
  Incomplete: 'Right as far as it goes, and missing something it needed to cover.',
};

/**
 * Ratings that require the reviewer to say what is wrong.
 *
 * All three negative ones. §27.1 pairs the ratings with "and provide correction/evidence", and a
 * bare "Incorrect" is an unactionable rating: it tells an agent's owner that something failed and
 * nothing about what. `Correct` needs no note, because there is nothing to explain.
 */
export function ratingRequiresCorrection(rating: FeedbackRating): boolean {
  return rating !== 'Correct';
}

/** Whether a rating says the output was usable. Drives the quality figures. */
export function ratingIsPositive(rating: FeedbackRating): boolean {
  return rating === 'Correct';
}

/**
 * The minimum length of a correction.
 *
 * Twenty characters. Long enough to rule out "wrong" and "bad" — a one-word correction is a
 * second rating, not an explanation — and short enough that a genuine one-line fix still passes.
 */
export const MIN_CORRECTION_LENGTH = 20;

// ---------------------------------------------------------------------------
// Who may give it
// ---------------------------------------------------------------------------

/**
 * The permission model, and why it is not a single action.
 *
 * §27.1 says "permitted users", and the product already has a precise answer for who is entitled
 * to judge a piece of AI work: the people who could see it. So feedback is gated on the module
 * the output belongs to rather than on a new `feedback` module, and on an action that already
 * exists:
 *
 *   * **Giving feedback** needs `Comment` on the module the run belongs to. `Comment` is the
 *     action for "has something to say about this work without changing it", which is exactly what
 *     a rating is, and an `Employee` holds it — the person who does the work is usually the one who
 *     can tell whether the output was right.
 *   * **Promoting feedback into the evaluation dataset** needs `settings:Administer`, because it
 *     is a change to what UBoss will test its Skills against. An Employee's rating is welcome; an
 *     Employee turning one into a permanent regression case is not.
 *
 * ## Why the promote gate is on `settings` and not on `skills`
 *
 * Because **`skills` is a platform module, not a company one.** `COMPANY_MODULES` does not
 * contain it — the reference UI puts "Skills & AI" inside Settings as a section rather than as a
 * top-level module — so `skills:EditDraft` is a grant no company user can hold, and a route
 * gated on it would be unreachable by everybody. Prompt 17 settled this when it built company
 * Skill authoring: every change to a company Skill is `settings:Administer`, and reads are
 * `settings:View`. Promotion is a change to a company Skill's evaluation cases, so it uses the
 * same gate rather than inventing a second answer.
 *
 * Nothing here invents an action: `Comment` and `Administer` are both in the closed `ACTIONS`
 * set, and `settings` is a company module.
 */
export const FEEDBACK_GIVE_ACTION = 'Comment' as const;
export const FEEDBACK_PROMOTE_ACTION = 'Administer' as const;
export const FEEDBACK_PROMOTE_MODULE = 'settings' as const;

/**
 * Whether the output itself may be shown to this reviewer.
 *
 * "Feedback UI on **permitted** AI outputs" is the prompt's own emphasis. A rating control on an
 * output somebody was not entitled to read would be a disclosure with a button on it, so the
 * question is answered before the control is rendered and again when the rating is submitted.
 *
 * The rule: the reviewer must be able to see the run. That is the run's own visibility — the
 * Objective it belongs to and the assignment it came from — and it is the authorization engine's
 * answer, not this module's. What this module refuses is the two cases the engine cannot see:
 */
export type FeedbackRefusal = { permitted: true } | { permitted: false; reason: string };

export interface FeedbackEligibility {
  /** Whether the run produced anything to judge. */
  hasOutput: boolean;
  /** False for a mock-model result. */
  producedByRealModel: boolean | null;
  /** Whether this reviewer has already rated this run. */
  alreadyRatedByReviewer: boolean;
  /** Whether the run belongs to the company asking. */
  sameTenant: boolean;
}

/**
 * Whether feedback may be given at all, before any question of permission.
 *
 * `producedByRealModel === false` is **not** a refusal, and that is a deliberate decision worth
 * stating. A mock result is still an output a reviewer can judge, and refusing feedback on it
 * would make the feedback loop untestable until a provider credential exists. What matters is that
 * the record says which it was, so a quality figure can never present mock output as a provider's
 * — the flag travels onto the feedback row for exactly that reason.
 */
export function feedbackEligibility(eligibility: FeedbackEligibility): FeedbackRefusal {
  if (!eligibility.sameTenant) {
    // Never reachable through a scoped read; stated because a helper that silently returned
    // `permitted` for a foreign run would be the wrong default if one ever arrived.
    return { permitted: false, reason: 'That output belongs to another company.' };
  }
  if (!eligibility.hasOutput) {
    return {
      permitted: false,
      reason: 'That run produced no output. There is nothing to judge yet.',
    };
  }
  if (eligibility.alreadyRatedByReviewer) {
    return {
      permitted: false,
      reason:
        'You have already rated this output. Amend your existing feedback rather than adding a ' +
        'second rating — two ratings from one reviewer would count twice in the quality figures.',
    };
  }
  return { permitted: true };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FeedbackSubmission {
  rating: FeedbackRating;
  /** What is wrong and what it should have said. Required for every rating but `Correct`. */
  correction: string | null;
  /**
   * Where the reviewer's answer comes from — a document, a record, a rule.
   *
   * Optional, and deliberately not required even for `Incorrect`. §27.1 says
   * "correction/evidence", not "correction and evidence", and a reviewer who knows the output is
   * wrong should not be blocked from saying so because they cannot cite a source.
   */
  evidence: string | null;
}

export function feedbackProblems(submission: FeedbackSubmission): string[] {
  const problems: string[] = [];

  if (!FEEDBACK_RATINGS.includes(submission.rating)) {
    problems.push(`"${submission.rating}" is not a rating.`);
  }

  const correction = submission.correction?.trim() ?? '';

  if (ratingRequiresCorrection(submission.rating)) {
    if (correction === '') {
      problems.push(
        `"${FEEDBACK_RATING_LABELS[submission.rating]}" needs to say what is wrong. A rating with ` +
          'no correction tells an agent’s owner that something failed and nothing about what.',
      );
    } else if (correction.length < MIN_CORRECTION_LENGTH) {
      problems.push(
        `Say a little more — at least ${MIN_CORRECTION_LENGTH} characters. A one-word correction ` +
          'is a second rating rather than an explanation.',
      );
    }
  } else if (correction !== '') {
    // Not a refusal: somebody marking an output correct and adding a note is doing something
    // useful. It is kept, and the emptiness check above simply does not apply.
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Feeding the evaluation dataset
// ---------------------------------------------------------------------------

/**
 * Why a piece of feedback is or is not a candidate evaluation case.
 *
 * §27.1: "Feedback feeds Agent/Skill quality and evaluation workflows". Prompt 18 already built
 * the evaluation machinery — `skill_evaluation_cases`, `skill_evaluation_runs`,
 * `skill_regression_comparisons` — so feedback feeds *that*, and this module decides which
 * feedback is worth feeding it.
 *
 * The rule: a case needs an input, an expected answer and a skill to test. So:
 *
 *   * A negative rating **with a correction** has an expected answer — the correction — and is a
 *     candidate.
 *   * A `Correct` rating has no expected answer distinct from what already happened. It counts
 *     towards quality and makes a poor test case, because a test that asserts the current
 *     behaviour passes by construction.
 *   * A run whose agent version names no Skill has nothing to test.
 *
 * **Candidate, not case.** Promotion is a separate, permissioned act (`skills:EditDraft`), because
 * a regression case is a permanent assertion about how a Skill must behave and an employee's
 * rating is not that.
 */
export interface EvaluationCandidacy {
  rating: FeedbackRating;
  correction: string | null;
  skillVersionIds: readonly string[];
}

export type EvaluationEligibility =
  { eligible: true; skillVersionIds: readonly string[] } | { eligible: false; reason: string };

export function evaluationEligibility(candidacy: EvaluationCandidacy): EvaluationEligibility {
  if (ratingIsPositive(candidacy.rating)) {
    return {
      eligible: false,
      reason:
        'A correct output has no expected answer different from what happened, so it makes a test ' +
        'that passes by construction. It still counts towards the agent’s quality figures.',
    };
  }

  if ((candidacy.correction?.trim() ?? '') === '') {
    return {
      eligible: false,
      reason: 'Without a correction there is no expected answer to assert.',
    };
  }

  if (candidacy.skillVersionIds.length === 0) {
    return {
      eligible: false,
      reason: 'The run cites no Skill version, so there is nothing for a case to test.',
    };
  }

  return { eligible: true, skillVersionIds: candidacy.skillVersionIds };
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export interface QualitySummary {
  total: number;
  correct: number;
  needsCorrection: number;
  incorrect: number;
  incomplete: number;
  /** Whole percent, floored. `null` when nobody has rated anything. */
  correctPercent: number | null;
  /** How many of the ratings were on output a real provider produced. */
  onRealModelOutput: number;
}

/**
 * The quality figure, and the honesty requirement on it.
 *
 * `onRealModelOutput` travels with the summary because a 100% correct rate over mock output says
 * nothing about a provider's quality, and a screen showing the percentage without it would be
 * presenting mock results as real. Prompt 29's rule — a result always carries whether a real model
 * produced it — reaches the quality figures here.
 *
 * Floored, not rounded, for the same reason as MFA coverage: 99.6% must not read as 100% on a
 * screen whose question is "is this agent reliable".
 */
export function summariseQuality(
  feedback: readonly { rating: FeedbackRating; producedByRealModel: boolean | null }[],
): QualitySummary {
  const count = (rating: FeedbackRating) =>
    feedback.filter((entry) => entry.rating === rating).length;

  const total = feedback.length;
  const correct = count('Correct');

  return {
    total,
    correct,
    needsCorrection: count('NeedsCorrection'),
    incorrect: count('Incorrect'),
    incomplete: count('Incomplete'),
    correctPercent: total === 0 ? null : Math.floor((correct / total) * 100),
    onRealModelOutput: feedback.filter((entry) => entry.producedByRealModel === true).length,
  };
}

/**
 * The one thing this module promises never to do.
 *
 * Exported as a constant so it can be asserted by a test and shown in the UI. There is no
 * "enable training" field anywhere in the feedback model, and this states why rather than leaving
 * its absence to be noticed.
 */
export const FEEDBACK_TRAINING_STANCE =
  'Feedback stays inside UBoss. It improves this company’s own evaluation cases and quality ' +
  'figures, and it is never sent to a model provider as training data. No setting enables that, ' +
  'because none exists.';
