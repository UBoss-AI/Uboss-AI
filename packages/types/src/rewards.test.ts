import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REWARD_TYPES, type RewardType } from './objectives.js';
import {
  ALLOWED_AWARD_TRANSITIONS,
  isAwardOpen,
  isAwardTerminal,
  mayTransitionAward,
  OPEN_AWARD_STATUSES,
  REWARD_AWARD_STATUS_LABELS,
  REWARD_AWARD_STATUSES,
  SETTLEMENT_ROUTES,
  settlementRouteFor,
  TERMINAL_AWARD_STATUSES,
  terminalStatusFor,
  validatePayout,
  validateRuleForAssignment,
} from './rewards.js';

describe('reward award lifecycle', () => {
  it('carries the client’s chain, with both slash pairs expanded', () => {
    // `Approved/Rejected` is two states and `Settled/Recorded` is two. Collapsing either would
    // make "was this paid?" unanswerable.
    assert.deepEqual(REWARD_AWARD_STATUSES, [
      'Draft',
      'Assigned',
      'Completed',
      'Eligible',
      'Approved',
      'Rejected',
      'Settled',
      'Recorded',
    ]);
  });

  it('has a transition entry for every status', () => {
    for (const status of REWARD_AWARD_STATUSES) {
      assert.ok(Array.isArray(ALLOWED_AWARD_TRANSITIONS[status]), `${status} has no entry`);
    }
  });

  it('never permits a transition to an unknown status', () => {
    for (const status of REWARD_AWARD_STATUSES) {
      for (const next of ALLOWED_AWARD_TRANSITIONS[status]) {
        assert.ok(REWARD_AWARD_STATUSES.includes(next), `${status} -> ${next} is unknown`);
      }
    }
  });

  it('never permits a status to transition to itself', () => {
    for (const status of REWARD_AWARD_STATUSES) {
      assert.ok(!ALLOWED_AWARD_TRANSITIONS[status].includes(status), `${status} loops`);
    }
  });

  it('walks the client’s happy path in order', () => {
    assert.ok(mayTransitionAward('Draft', 'Assigned'));
    assert.ok(mayTransitionAward('Assigned', 'Completed'));
    assert.ok(mayTransitionAward('Completed', 'Eligible'));
    assert.ok(mayTransitionAward('Eligible', 'Approved'));
    assert.ok(mayTransitionAward('Approved', 'Settled'));
    assert.ok(mayTransitionAward('Approved', 'Recorded'));
  });

  it('lets a claim be rejected from any open state', () => {
    // A claim can fail because the work was not done, because the condition was not met, or
    // because the approver said no. Forcing every rejection through Eligible would mean declaring
    // somebody eligible in order to refuse them.
    for (const status of ['Draft', 'Assigned', 'Completed', 'Eligible'] as const) {
      assert.ok(mayTransitionAward(status, 'Rejected'), `${status} should be rejectable`);
    }
  });

  it('does not let an approved award be rejected', () => {
    // The decision has been made. Reversing it is a new award with a reason, not a second bite.
    assert.ok(!mayTransitionAward('Approved', 'Rejected'));
  });

  it('never skips the decision', () => {
    // The single most important edge to get wrong: reaching a payment without an approval.
    for (const status of REWARD_AWARD_STATUSES) {
      if (status === 'Approved') continue;
      assert.ok(
        !ALLOWED_AWARD_TRANSITIONS[status].includes('Settled'),
        `${status} must not reach Settled directly`,
      );
      assert.ok(
        !ALLOWED_AWARD_TRANSITIONS[status].includes('Recorded'),
        `${status} must not reach Recorded directly`,
      );
    }
  });

  it('reaches Approved only from Eligible', () => {
    const routes = REWARD_AWARD_STATUSES.filter((status) =>
      ALLOWED_AWARD_TRANSITIONS[status].includes('Approved'),
    );
    assert.deepEqual(routes, ['Eligible']);
  });

  it('makes every ending terminal', () => {
    assert.deepEqual(TERMINAL_AWARD_STATUSES, ['Rejected', 'Settled', 'Recorded']);
    for (const status of TERMINAL_AWARD_STATUSES) {
      assert.deepEqual(ALLOWED_AWARD_TRANSITIONS[status], [], `${status} should be an end`);
      assert.ok(isAwardTerminal(status));
      assert.ok(!isAwardOpen(status));
    }
  });

  it('treats every other status as an open claim', () => {
    for (const status of OPEN_AWARD_STATUSES) {
      assert.ok(isAwardOpen(status), `${status} should be open`);
      assert.ok(!isAwardTerminal(status));
    }
    // The two sets partition the vocabulary — no status is both and none is neither.
    assert.equal(
      OPEN_AWARD_STATUSES.length + TERMINAL_AWARD_STATUSES.length,
      REWARD_AWARD_STATUSES.length,
    );
  });

  it('labels Completed and Settled in words that distinguish them', () => {
    assert.equal(REWARD_AWARD_STATUS_LABELS.Completed, 'Work completed');
    assert.equal(REWARD_AWARD_STATUS_LABELS.Settled, 'Settled');
    assert.equal(REWARD_AWARD_STATUS_LABELS.Recorded, 'Recorded');
  });
});

describe('how an approved award finishes', () => {
  it('sends cash through payout and nothing else', () => {
    assert.equal(settlementRouteFor('Cash'), 'Payout');
    for (const type of REWARD_TYPES.filter((candidate) => candidate !== 'Cash')) {
      assert.notEqual(settlementRouteFor(type), 'Payout', `${type} must not be payable`);
    }
  });

  it('sends points to performance and recognition nowhere', () => {
    assert.equal(settlementRouteFor('Points'), 'PerformancePoints');
    assert.equal(settlementRouteFor('Recognition'), 'RecordOnly');
    assert.equal(settlementRouteFor('Other'), 'RecordOnly');
  });

  it('has a route for every reward type, and every route is known', () => {
    for (const type of REWARD_TYPES) {
      assert.ok(SETTLEMENT_ROUTES.includes(settlementRouteFor(type)), `${type} has no route`);
    }
  });

  it('ends a cash award in Settled and everything else in Recorded', () => {
    assert.equal(terminalStatusFor('Cash'), 'Settled');
    assert.equal(terminalStatusFor('Points'), 'Recorded');
    assert.equal(terminalStatusFor('Recognition'), 'Recorded');
    assert.equal(terminalStatusFor('Other'), 'Recorded');
  });
});

describe('validateRuleForAssignment', () => {
  const complete = {
    applicable: true,
    rewardType: 'Cash' as RewardType | null,
    amountMinorUnits: 500_000 as number | null,
    eligibilityCondition: 'Zero critical gaps',
    approverUserId: '11111111-1111-4111-8111-111111111111' as string | null,
  };

  it('accepts a complete rule', () => {
    assert.deepEqual(validateRuleForAssignment(complete), []);
  });

  it('refuses to assign under a rule that says no reward applies', () => {
    const problems = validateRuleForAssignment({ ...complete, applicable: false });
    assert.ok(problems.some((problem) => problem.includes('no reward applies')));
  });

  it('stops at the first finding when the panel is switched off', () => {
    // Listing every missing field on a rule that is deliberately off would be noise.
    assert.equal(validateRuleForAssignment({ ...complete, applicable: false }).length, 1);
  });

  it('demands a type, a condition and an approver', () => {
    const problems = validateRuleForAssignment({
      applicable: true,
      rewardType: null,
      amountMinorUnits: null,
      eligibilityCondition: null,
      approverUserId: null,
    });
    assert.ok(problems.some((problem) => problem.includes('Reward Type')));
    assert.ok(problems.some((problem) => problem.includes('Eligibility Condition')));
    assert.ok(problems.some((problem) => problem.includes('Approver')));
  });

  it('treats a blank condition as missing', () => {
    const problems = validateRuleForAssignment({ ...complete, eligibilityCondition: '   ' });
    assert.ok(problems.some((problem) => problem.includes('Eligibility Condition')));
  });

  it('demands an amount for a quantified type only', () => {
    for (const rewardType of ['Cash', 'Points'] as const) {
      const problems = validateRuleForAssignment({
        ...complete,
        rewardType,
        amountMinorUnits: null,
      });
      assert.ok(problems.some((problem) => problem.includes('Amount / Points')));
    }
    assert.deepEqual(
      validateRuleForAssignment({
        ...complete,
        rewardType: 'Recognition',
        amountMinorUnits: null,
      }),
      [],
    );
  });
});

describe('validatePayout — the whole of "do not auto-pay cash"', () => {
  it('permits a cash payout with an amount and a connector', () => {
    assert.deepEqual(
      validatePayout({ rewardType: 'Cash', amountMinorUnits: 500_000, connectorConfigured: true }),
      [],
    );
  });

  it('refuses every non-cash type', () => {
    for (const rewardType of ['Points', 'Recognition', 'Other'] as const) {
      const problems = validatePayout({
        rewardType,
        amountMinorUnits: 100,
        connectorConfigured: true,
      });
      assert.ok(
        problems.some((problem) => problem.includes('not settled through payroll')),
        `${rewardType} must not be payable`,
      );
    }
  });

  it('refuses a payout with no connector, and says UBoss will not claim a payment it did not make', () => {
    const problems = validatePayout({
      rewardType: 'Cash',
      amountMinorUnits: 500_000,
      connectorConfigured: false,
    });
    assert.ok(problems.some((problem) => problem.includes('No approved payroll')));
    assert.ok(
      problems.some((problem) => problem.includes('will not record a payment it did not make')),
    );
  });

  it('refuses a zero or missing amount', () => {
    for (const amountMinorUnits of [null, 0]) {
      const problems = validatePayout({
        rewardType: 'Cash',
        amountMinorUnits,
        connectorConfigured: true,
      });
      assert.ok(problems.some((problem) => problem.includes('positive amount')));
    }
  });

  it('reports every reason at once rather than the first', () => {
    // Somebody fixing one problem should not have to discover the next two one at a time.
    const problems = validatePayout({
      rewardType: 'Points',
      amountMinorUnits: null,
      connectorConfigured: false,
    });
    assert.equal(problems.length, 3);
  });
});
