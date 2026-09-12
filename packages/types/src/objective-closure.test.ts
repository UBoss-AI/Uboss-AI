import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ROLE_TEMPLATES } from './role-templates.js';

import {
  ALLOWED_OBJECTIVE_TRANSITIONS,
  isObjectiveContentFrozen,
  isObjectiveWorkAssignable,
  mayTransitionObjective,
  OBJECTIVE_STATUS_LABELS,
  OBJECTIVE_STATUS_TONES,
  OBJECTIVE_STATUSES,
} from './objectives.js';
import {
  CLOSED_OBJECTIVE_STATUSES,
  CLOSURE_SIGN_OFF_POLICIES,
  DEFAULT_CLOSURE_SIGN_OFF_POLICY,
  decideClosure,
  isObjectiveFinished,
  MIN_OUTCOME_EXPLANATION_LENGTH,
  OUTCOME_VERDICT_DESCRIPTIONS,
  OUTCOME_VERDICT_LABELS,
  OUTCOME_VERDICTS,
  PAUSE_EFFECT,
  PAUSE_REASON_LABELS,
  PAUSE_REASONS,
  readinessForReview,
  SLA_OUTCOMES,
  slaOutcome,
  statusStartsNewWork,
  verdictRequiresExplanation,
  type OutcomeComparison,
} from './objective-closure.js';

const comparison = (overrides: Partial<OutcomeComparison> = {}): OutcomeComparison => ({
  expectedFinalResult: 'Every supplier contract reviewed and signed.',
  targetDate: '2026-09-30T00:00:00.000Z',
  completedAt: '2026-09-28T00:00:00.000Z',
  humanTasksTotal: 4,
  humanTasksCompleted: 4,
  humanElapsedMinutes: 320,
  aiCostMinor: 12_500,
  aiCostCurrency: 'INR',
  agentRunsTotal: 6,
  exceptionsTotal: 2,
  exceptionsUnresolved: 0,
  ...overrides,
});

describe('the extended objective lifecycle', () => {
  it('has the client’s closure chain in it', () => {
    // §27.1: "Completed -> Outcome Review -> Closed -> Archived", plus the controlled pause.
    for (const status of ['Paused', 'Completed', 'OutcomeReview', 'Closed', 'Archived'] as const) {
      assert.ok((OBJECTIVE_STATUSES as readonly string[]).includes(status), status);
    }
  });

  it('labels and tones every status, including the new ones', () => {
    for (const status of OBJECTIVE_STATUSES) {
      assert.ok(OBJECTIVE_STATUS_LABELS[status].length > 0, status);
      assert.ok(OBJECTIVE_STATUS_TONES[status].length > 0, status);
      assert.ok(ALLOWED_OBJECTIVE_TRANSITIONS[status] !== undefined, status);
    }
  });

  it('walks the closure chain in order', () => {
    assert.equal(mayTransitionObjective('Active', 'Completed'), true);
    assert.equal(mayTransitionObjective('Completed', 'OutcomeReview'), true);
    assert.equal(mayTransitionObjective('OutcomeReview', 'Closed'), true);
    assert.equal(mayTransitionObjective('Closed', 'Archived'), true);
  });

  it('refuses skipping the review to reach Closed', () => {
    // Closure is what the review produces. Skipping it would make the chain decorative.
    assert.equal(mayTransitionObjective('Completed', 'Closed'), false);
    assert.equal(mayTransitionObjective('Active', 'Closed'), false);
  });

  it('lets a completed objective be archived without a review', () => {
    // A company that wants no review of a finished objective should not be forced through one.
    assert.equal(mayTransitionObjective('Completed', 'Archived'), true);
  });

  it('pauses and resumes a live objective', () => {
    assert.equal(mayTransitionObjective('Active', 'Paused'), true);
    assert.equal(mayTransitionObjective('Paused', 'Active'), true);
  });

  it('refuses completing a paused objective without resuming it', () => {
    // Otherwise somebody closes an objective whose remaining work was never restarted.
    assert.equal(mayTransitionObjective('Paused', 'Completed'), false);
  });

  it('offers no route from Outcome Review back to Active', () => {
    // Reopening work is a new Draft version under the versioning rule, never a resurrection of
    // the live version that has already been reviewed.
    assert.equal(mayTransitionObjective('OutcomeReview', 'Active'), false);
    assert.equal(mayTransitionObjective('Closed', 'Active'), false);
  });

  it('lets a review be abandoned back to Completed', () => {
    assert.equal(mayTransitionObjective('OutcomeReview', 'Completed'), true);
  });

  it('keeps the archive terminal', () => {
    assert.deepEqual([...ALLOWED_OBJECTIVE_TRANSITIONS.Archived], []);
  });

  it('freezes a paused objective’s content', () => {
    // The one people assume otherwise. Pausing stops the work; it does not reopen the plan, or
    // "pause" would be a way round the versioning rule.
    assert.equal(isObjectiveContentFrozen('Paused'), true);
    assert.equal(isObjectiveContentFrozen('OutcomeReview'), true);
    assert.equal(isObjectiveContentFrozen('Closed'), true);
  });

  it('assigns work only while a objective is live', () => {
    for (const status of OBJECTIVE_STATUSES) {
      assert.equal(isObjectiveWorkAssignable(status), status === 'Active', status);
      assert.equal(statusStartsNewWork(status), status === 'Active', status);
    }
  });

  it('does not count a paused objective as finished', () => {
    // A report that counted it as closed would understate what a company still has open.
    assert.equal(isObjectiveFinished('Paused'), false);
    assert.equal(isObjectiveFinished('Active'), false);
    assert.equal(isObjectiveFinished('Completed'), true);
    assert.equal(isObjectiveFinished('OutcomeReview'), true);
    assert.equal(isObjectiveFinished('Closed'), true);
    assert.equal(isObjectiveFinished('Archived'), true);
    assert.equal(CLOSED_OBJECTIVE_STATUSES.includes('Paused'), false);
  });
});

describe('the grants closure gates on', () => {
  /**
   * Every action this module uses is held by at least one role template.
   *
   * **The check that catches an unreachable route.** Prompt 33 gated feedback promotion on
   * `skills:EditDraft` and `skills` turned out to be a platform module; Prompt 34 gated pause on
   * `objective:Pause`, which is in the closed `ACTIONS` set and granted on `agents` only. Both
   * were 403 for every user in every company, and both read perfectly well.
   */
  const heldBySomebody = (module: string, action: string): boolean =>
    Object.values(ROLE_TEMPLATES).some((template) => {
      const actions = (template.permissions as Record<string, readonly string[] | undefined>)[
        module
      ];
      return actions !== undefined && actions.includes(action);
    });

  it('gates every closure act on a grant some role actually holds', () => {
    for (const action of ['View', 'Approve', 'Publish'] as const) {
      assert.ok(
        heldBySomebody('objective', action),
        `no role template grants objective:${action}, so a route gated on it is unreachable`,
      );
    }
  });

  it('does not gate anything on objective:Pause', () => {
    // It reads better than `Publish` and it is held by nobody. Pinned so a later prompt does not
    // reach for it again.
    assert.equal(heldBySomebody('objective', 'Pause'), false);
  });
});

describe('the outcome verdict', () => {
  it('has four, including one that is not a failure', () => {
    assert.deepEqual([...OUTCOME_VERDICTS], ['Met', 'PartiallyMet', 'NotMet', 'Superseded']);
  });

  it('labels and explains every verdict', () => {
    for (const verdict of OUTCOME_VERDICTS) {
      assert.ok(OUTCOME_VERDICT_LABELS[verdict].length > 0, verdict);
      assert.ok(OUTCOME_VERDICT_DESCRIPTIONS[verdict].length > 0, verdict);
    }
  });

  it('does not present a superseded objective as a failure', () => {
    // Recording it as one would teach companies to avoid closing objectives honestly.
    assert.match(OUTCOME_VERDICT_DESCRIPTIONS.Superseded, /Not a failure/);
  });

  it('requires an explanation for everything but a clean Met', () => {
    assert.equal(verdictRequiresExplanation('Met'), false);
    assert.equal(verdictRequiresExplanation('PartiallyMet'), true);
    assert.equal(verdictRequiresExplanation('NotMet'), true);
    assert.equal(verdictRequiresExplanation('Superseded'), true);
  });

  it('asks for more than a feedback correction does', () => {
    // Read by a manager at a quarterly review rather than by the person who wrote it.
    assert.ok(MIN_OUTCOME_EXPLANATION_LENGTH > 20);
  });
});

describe('the SLA comparison', () => {
  it('reports on time when the work finished before its target', () => {
    const result = slaOutcome({
      targetDate: new Date('2026-09-30T00:00:00.000Z'),
      completedAt: new Date('2026-09-28T00:00:00.000Z'),
    });
    assert.equal(result.outcome, 'OnTime');
    assert.equal(result.daysLate, 0);
  });

  it('treats finishing exactly on the target as on time', () => {
    const at = new Date('2026-09-30T00:00:00.000Z');
    assert.equal(slaOutcome({ targetDate: at, completedAt: at }).outcome, 'OnTime');
  });

  it('rounds lateness up, so three hours over is a day late', () => {
    // Rounding down would report a missed deadline as met.
    const result = slaOutcome({
      targetDate: new Date('2026-09-30T00:00:00.000Z'),
      completedAt: new Date('2026-09-30T03:00:00.000Z'),
    });
    assert.equal(result.outcome, 'Late');
    assert.equal(result.daysLate, 1);
  });

  it('says no target was set rather than calling it on time', () => {
    // An objective with no target cannot be late, and reporting it as on time would be as false
    // as reporting it as late.
    const result = slaOutcome({
      targetDate: null,
      completedAt: new Date('2026-09-30T00:00:00.000Z'),
    });
    assert.equal(result.outcome, 'Unknown');
    assert.equal(result.daysLate, null);
  });

  it('says unknown when the work never finished', () => {
    assert.equal(
      slaOutcome({ targetDate: new Date('2026-09-30T00:00:00.000Z'), completedAt: null }).outcome,
      'Unknown',
    );
  });

  it('has exactly three outcomes', () => {
    assert.deepEqual([...SLA_OUTCOMES], ['OnTime', 'Late', 'Unknown']);
  });
});

describe('readiness for review', () => {
  it('is ready when the work is finished', () => {
    const readiness = readinessForReview(comparison());
    assert.equal(readiness.ready, true);
    assert.deepEqual(readiness.outstanding, []);
  });

  it('blocks a review while human tasks are still open', () => {
    // "What was the actual result" has no answer while work is in progress.
    const readiness = readinessForReview(comparison({ humanTasksCompleted: 2 }));
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blocking.some((problem) => /not finished/.test(problem)));
  });

  it('reports unresolved exceptions without blocking on them', () => {
    // §27.1 asks the review to *compare* unresolved items, not to require them gone. Closing with
    // open exceptions is a decision the review records.
    const readiness = readinessForReview(comparison({ exceptionsUnresolved: 3 }));
    assert.equal(readiness.ready, true);
    assert.ok(readiness.outstanding.some((problem) => /unresolved/.test(problem)));
    assert.ok(!readiness.blocking.some((problem) => /unresolved/.test(problem)));
  });

  it('blocks a review with no completion date', () => {
    const readiness = readinessForReview(comparison({ completedAt: null }));
    assert.equal(readiness.ready, false);
  });

  it('lists everything outstanding at once', () => {
    const readiness = readinessForReview(
      comparison({ humanTasksCompleted: 1, exceptionsUnresolved: 2, completedAt: null }),
    );
    assert.equal(readiness.outstanding.length, 3);
    assert.equal(readiness.blocking.length, 2);
  });
});

describe('closure sign-off', () => {
  const attempt = {
    policy: 'OwnerSignOff' as const,
    actorUserId: 'reviewer',
    ownerUserId: 'owner',
    signedOffByUserId: null,
    approvalRequestId: null,
  };

  it('has three policies and defaults to the owner signing', () => {
    assert.deepEqual([...CLOSURE_SIGN_OFF_POLICIES], ['Never', 'OwnerSignOff', 'Approval']);
    assert.equal(DEFAULT_CLOSURE_SIGN_OFF_POLICY, 'OwnerSignOff');
  });

  it('lets anybody close it when the company requires no sign-off', () => {
    assert.deepEqual(decideClosure({ ...attempt, policy: 'Never' }), { mayClose: true });
  });

  it('refuses a reviewer closing the owner’s objective unsigned', () => {
    // The case the default prevents: a review written by somebody else, closing the owner's
    // objective, with the owner never told.
    const decision = decideClosure(attempt);
    assert.equal(decision.mayClose, false);
    if (decision.mayClose) return;
    assert.match(decision.reason, /owner to sign off/);
  });

  it('lets the owner close their own objective without a separate signature', () => {
    // Requiring them to sign their own closure would be ceremony. §27.1 asks for sign-off, not
    // for two signatures.
    assert.deepEqual(decideClosure({ ...attempt, actorUserId: 'owner' }), { mayClose: true });
  });

  it('accepts the owner’s signature from somebody else’s review', () => {
    assert.deepEqual(decideClosure({ ...attempt, signedOffByUserId: 'owner' }), {
      mayClose: true,
    });
  });

  it('does not accept a signature from the wrong person', () => {
    const decision = decideClosure({ ...attempt, signedOffByUserId: 'somebody-else' });
    assert.equal(decision.mayClose, false);
  });

  it('requires a verified approval where the policy says so', () => {
    const decision = decideClosure({ ...attempt, policy: 'Approval' });
    assert.equal(decision.mayClose, false);
    if (decision.mayClose) return;
    assert.match(decision.reason, /Raise one and pass/);

    assert.deepEqual(
      decideClosure({ ...attempt, policy: 'Approval', approvalRequestId: 'approval-1' }),
      { mayClose: true },
    );
  });

  it('does not let an owner’s own signature stand in for an approval', () => {
    // `Approval` is a second person by construction; the approval engine's own separation rules
    // apply to it.
    const decision = decideClosure({
      ...attempt,
      policy: 'Approval',
      actorUserId: 'owner',
      signedOffByUserId: 'owner',
    });
    assert.equal(decision.mayClose, false);
  });
});

describe('pause', () => {
  it('offers five reasons and labels each', () => {
    assert.equal(PAUSE_REASONS.length, 5);
    for (const reason of PAUSE_REASONS) {
      assert.ok(PAUSE_REASON_LABELS[reason].length > 0, reason);
    }
  });

  it('says what a pause does and does not stop', () => {
    // A pause that discarded work in flight would not be reversible, and reversibility is what
    // makes it a pause rather than a cancellation.
    assert.match(PAUSE_EFFECT, /stops new work/);
    assert.match(PAUSE_EFFECT, /never discards what a run has already done/);
    assert.match(PAUSE_EFFECT, /new Draft version/);
  });
});
