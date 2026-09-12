import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LEDGER_ENTRY_KINDS } from './cost.js';
import {
  allowanceAfterPlanChange,
  BILLING_CHOICE_LABELS,
  BILLING_CHOICES,
  carryForwardMinor,
  CARRY_FORWARD_POLICIES,
  CREDIT_REQUEST_STATE_LABELS,
  CREDIT_REQUEST_STATES,
  creditRequestIsOpen,
  DEFAULT_CREDIT_POLICY,
  GRANT_LEDGER_KIND,
  GRANT_SOURCE_LABELS,
  GRANT_SOURCES,
  grantIsLive,
  grantsToExpire,
  liveAllowanceMinor,
  mayMoveCreditRequest,
  mayResumeAfterTopUp,
  negativeBalanceBlocks,
  NEGATIVE_BALANCE_POLICIES,
  PLAN_CHANGE_POLICIES,
  RESET_POLICIES,
  validateCreditDecision,
  validateCreditPolicy,
  validateCreditRequest,
  validateReallocation,
  type CreditPolicy,
} from './credits.js';

const DAY = 86_400_000;

describe('credit requests', () => {
  it('labels every state', () => {
    for (const state of CREDIT_REQUEST_STATES) {
      assert.ok(CREDIT_REQUEST_STATE_LABELS[state].length > 0);
    }
  });

  it('does not model an adjusted approval as its own state', () => {
    // "Approve & Add Credits" and "Adjust Amount" produce the same outcome — an approval for
    // some amount — and the amount approved is already recorded apart from the amount asked for.
    assert.equal(CREDIT_REQUEST_STATES.length, 4);
    assert.ok(!(CREDIT_REQUEST_STATES as readonly string[]).includes('Adjusted'));
  });

  it('is open only while submitted', () => {
    assert.equal(creditRequestIsOpen('Submitted'), true);
    for (const state of CREDIT_REQUEST_STATES.filter((entry) => entry !== 'Submitted')) {
      assert.equal(creditRequestIsOpen(state), false);
    }
  });

  it('moves out of Submitted and never back', () => {
    assert.equal(mayMoveCreditRequest('Submitted', 'Approved'), true);
    assert.equal(mayMoveCreditRequest('Submitted', 'Rejected'), true);
    assert.equal(mayMoveCreditRequest('Submitted', 'Cancelled'), true);
    // A rejected request that could be re-approved would reverse a decision with no record.
    assert.equal(mayMoveCreditRequest('Rejected', 'Approved'), false);
    assert.equal(mayMoveCreditRequest('Approved', 'Rejected'), false);
  });

  it('refuses a request for nothing, or one with no reason', () => {
    assert.equal(validateCreditRequest({ amountMinor: 0, reason: 'x' }).ok, false);
    assert.equal(validateCreditRequest({ amountMinor: -5, reason: 'x' }).ok, false);
    assert.equal(validateCreditRequest({ amountMinor: 1_000, reason: '  ' }).ok, false);
    assert.equal(validateCreditRequest({ amountMinor: 1_000, reason: 'Q4 tenders' }).ok, true);
  });

  it('records a billing choice as an intent, with an unspecified option', () => {
    // The prompt says "billing choice where enabled" — a plan may not offer one, and forcing a
    // choice would make the field a lie on those plans.
    assert.ok((BILLING_CHOICES as readonly string[]).includes('Unspecified'));
    for (const choice of BILLING_CHOICES) {
      assert.ok(BILLING_CHOICE_LABELS[choice].length > 0);
    }
  });
});

describe("Finance's decision", () => {
  const effectiveFrom = new Date('2026-10-01T00:00:00Z');

  it('requires a reason to reject and not to approve', () => {
    assert.equal(validateCreditDecision({ approve: false, reason: '' }).ok, false);
    assert.equal(validateCreditDecision({ approve: false, reason: 'Out of budget.' }).ok, true);
    assert.equal(
      validateCreditDecision({ approve: true, approvedMinor: 1_000, effectiveFrom, reason: '' }).ok,
      true,
    );
  });

  it('requires an amount and an effective date to approve', () => {
    assert.equal(validateCreditDecision({ approve: true, effectiveFrom, reason: '' }).ok, false);
    assert.equal(
      validateCreditDecision({ approve: true, approvedMinor: 1_000, reason: '' }).ok,
      false,
    );
  });

  it('refuses credits that expire before they start', () => {
    const outcome = validateCreditDecision({
      approve: true,
      approvedMinor: 1_000,
      effectiveFrom,
      expiresAt: new Date(effectiveFrom.getTime() - DAY),
      reason: '',
    });
    assert.equal(outcome.ok, false);
  });

  it('allows an approval for less than was asked for', () => {
    // "Adjust Amount" is an approval with a different number, not a separate outcome.
    const outcome = validateCreditDecision({
      approve: true,
      approvedMinor: 500,
      effectiveFrom,
      reason: 'Half approved for this quarter.',
    });
    assert.equal(outcome.ok, true);
  });
});

describe('grants', () => {
  const base = {
    amountMinor: 10_000,
    effectiveFrom: '2026-09-01T00:00:00Z',
    expiresAt: null,
    revokedAt: null,
  };
  const now = new Date('2026-09-15T00:00:00Z');

  it('labels every source', () => {
    for (const source of GRANT_SOURCES) {
      assert.ok(GRANT_SOURCE_LABELS[source].length > 0);
    }
  });

  it('counts a live grant', () => {
    assert.equal(grantIsLive(base, now), true);
  });

  it('does not count a grant that has not started', () => {
    // What makes a future-dated top-up safe to approve: the company sees it and cannot spend it.
    assert.equal(grantIsLive({ ...base, effectiveFrom: '2026-10-01T00:00:00Z' }, now), false);
  });

  it('does not count an expired or revoked grant', () => {
    assert.equal(grantIsLive({ ...base, expiresAt: '2026-09-10T00:00:00Z' }, now), false);
    assert.equal(grantIsLive({ ...base, revokedAt: '2026-09-05T00:00:00Z' }, now), false);
  });

  it('adds the live grants into an allowance', () => {
    const total = liveAllowanceMinor(
      [
        base,
        { ...base, amountMinor: 5_000 },
        // Not yet live.
        { ...base, amountMinor: 99_999, effectiveFrom: '2026-12-01T00:00:00Z' },
        // Expired.
        { ...base, amountMinor: 99_999, expiresAt: '2026-09-02T00:00:00Z' },
      ],
      now,
    );
    assert.equal(total, 15_000);
  });

  it('lists what has expired but has not been written off', () => {
    const due = grantsToExpire(
      [
        {
          id: 'a',
          amountMinor: 1_000,
          expiresAt: '2026-09-10T00:00:00Z',
          revokedAt: null,
          writtenOff: false,
        },
        // Already written off — listing it again would double-charge the expiry.
        {
          id: 'b',
          amountMinor: 2_000,
          expiresAt: '2026-09-10T00:00:00Z',
          revokedAt: null,
          writtenOff: true,
        },
        // Not yet due.
        {
          id: 'c',
          amountMinor: 3_000,
          expiresAt: '2026-12-10T00:00:00Z',
          revokedAt: null,
          writtenOff: false,
        },
        // Never expires.
        { id: 'd', amountMinor: 4_000, expiresAt: null, revokedAt: null, writtenOff: false },
      ],
      now,
    );
    assert.deepEqual(due, [{ id: 'a', amountMinor: 1_000 }]);
  });

  it('maps every source to a real ledger kind', () => {
    for (const source of GRANT_SOURCES) {
      assert.ok((LEDGER_ENTRY_KINDS as readonly string[]).includes(GRANT_LEDGER_KIND[source]));
    }
  });

  it('records promotional credit as an adjustment, not a top-up', () => {
    // It was not purchased, and a revenue report counting it as a sale would overstate revenue.
    assert.equal(GRANT_LEDGER_KIND.Promotional, 'Adjustment');
    assert.equal(GRANT_LEDGER_KIND.TopUp, 'TopUp');
  });
});

describe('the commercial policy', () => {
  it('offers every policy the approved documents name', () => {
    assert.ok(RESET_POLICIES.length >= 2);
    assert.ok(CARRY_FORWARD_POLICIES.length >= 3);
    assert.ok(NEGATIVE_BALANCE_POLICIES.length >= 2);
    assert.ok(PLAN_CHANGE_POLICIES.length >= 3);
  });

  it('defaults to never expiring purchased credit', () => {
    // The one default that could not be defended otherwise: expiring money somebody paid for,
    // without being told to.
    assert.equal(DEFAULT_CREDIT_POLICY.defaultTopUpExpiryDays, null);
  });

  it('defaults to forfeiting unused allowance rather than quietly granting more', () => {
    assert.equal(DEFAULT_CREDIT_POLICY.carryForwardPolicy, 'Forfeit');
    assert.equal(DEFAULT_CREDIT_POLICY.resetPolicy, 'MonthlyReset');
  });

  it('defaults to blocking the moment a balance goes negative', () => {
    assert.equal(DEFAULT_CREDIT_POLICY.negativeBalancePolicy, 'BlockImmediately');
    assert.equal(DEFAULT_CREDIT_POLICY.negativeBalanceGraceMinor, 0);
  });

  it('accepts its own defaults', () => {
    assert.equal(validateCreditPolicy(DEFAULT_CREDIT_POLICY).ok, true);
  });

  it('refuses a capped carry-forward with no cap, and a cap with no capped policy', () => {
    assert.equal(
      validateCreditPolicy({ ...DEFAULT_CREDIT_POLICY, carryForwardPolicy: 'CarryForwardCapped' })
        .ok,
      false,
    );
    assert.equal(
      validateCreditPolicy({ ...DEFAULT_CREDIT_POLICY, carryForwardCapMinor: 5_000 }).ok,
      false,
    );
  });

  it('refuses carry-forward on an allowance that never resets', () => {
    const outcome = validateCreditPolicy({
      ...DEFAULT_CREDIT_POLICY,
      resetPolicy: 'NoReset',
      carryForwardPolicy: 'CarryForward',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.reason : '', /only means something if/);
  });

  it('refuses a grace amount that nothing would apply', () => {
    const outcome = validateCreditPolicy({
      ...DEFAULT_CREDIT_POLICY,
      negativeBalanceGraceMinor: 500,
    });
    assert.equal(outcome.ok, false);
  });

  it('accepts a coherent permissive policy', () => {
    const permissive: CreditPolicy = {
      resetPolicy: 'MonthlyReset',
      carryForwardPolicy: 'CarryForwardCapped',
      carryForwardCapMinor: 20_000,
      defaultTopUpExpiryDays: 365,
      negativeBalancePolicy: 'AllowGrace',
      negativeBalanceGraceMinor: 5_000,
      planChangePolicy: 'ProRate',
      billingChoiceEnabled: false,
    };
    assert.equal(validateCreditPolicy(permissive).ok, true);
  });
});

describe('carry-forward', () => {
  it('forfeits by default', () => {
    assert.equal(
      carryForwardMinor({
        policy: { carryForwardPolicy: 'Forfeit', carryForwardCapMinor: null },
        unusedMinor: 8_000,
      }),
      0,
    );
  });

  it('carries everything when told to', () => {
    assert.equal(
      carryForwardMinor({
        policy: { carryForwardPolicy: 'CarryForward', carryForwardCapMinor: null },
        unusedMinor: 8_000,
      }),
      8_000,
    );
  });

  it('carries up to the cap', () => {
    assert.equal(
      carryForwardMinor({
        policy: { carryForwardPolicy: 'CarryForwardCapped', carryForwardCapMinor: 5_000 },
        unusedMinor: 8_000,
      }),
      5_000,
    );
    assert.equal(
      carryForwardMinor({
        policy: { carryForwardPolicy: 'CarryForwardCapped', carryForwardCapMinor: 5_000 },
        unusedMinor: 3_000,
      }),
      3_000,
    );
  });

  it('carries nothing from an overspent period', () => {
    // A negative balance is a debt, not something to carry forward as credit.
    assert.equal(
      carryForwardMinor({
        policy: { carryForwardPolicy: 'CarryForward', carryForwardCapMinor: null },
        unusedMinor: -2_000,
      }),
      0,
    );
  });
});

describe('negative balances', () => {
  it('does not block a healthy balance', () => {
    assert.equal(
      negativeBalanceBlocks({
        policy: { negativeBalancePolicy: 'BlockImmediately', negativeBalanceGraceMinor: 0 },
        remainingMinor: 500,
      }).blocks,
      false,
    );
  });

  it('blocks at zero under the default policy', () => {
    assert.equal(
      negativeBalanceBlocks({
        policy: { negativeBalancePolicy: 'BlockImmediately', negativeBalanceGraceMinor: 0 },
        remainingMinor: -1,
      }).blocks,
      true,
    );
  });

  it('tolerates an overdraft inside the configured grace', () => {
    const policy = {
      negativeBalancePolicy: 'AllowGrace' as const,
      negativeBalanceGraceMinor: 1_000,
    };
    assert.equal(negativeBalanceBlocks({ policy, remainingMinor: -800 }).blocks, false);
    assert.equal(negativeBalanceBlocks({ policy, remainingMinor: -1_000 }).blocks, false);
    assert.equal(negativeBalanceBlocks({ policy, remainingMinor: -1_001 }).blocks, true);
  });
});

describe('plan changes mid-cycle', () => {
  const periodStart = new Date('2026-09-01T00:00:00Z');
  const periodEnd = new Date('2026-10-01T00:00:00Z');
  const halfway = new Date('2026-09-16T00:00:00Z');

  it('leaves this cycle alone by default', () => {
    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: 'NextCycle' },
      currentAllowanceMinor: 100_000,
      newPlanAllowanceMinor: 200_000,
      periodStart,
      periodEnd,
      at: halfway,
    });
    assert.equal(outcome.allowanceMinor, 100_000);
    assert.equal(outcome.appliesNow, false);
  });

  it('applies the new allowance in full when told to', () => {
    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: 'ImmediateFull' },
      currentAllowanceMinor: 100_000,
      newPlanAllowanceMinor: 200_000,
      periodStart,
      periodEnd,
      at: halfway,
    });
    assert.equal(outcome.allowanceMinor, 200_000);
    assert.equal(outcome.appliesNow, true);
  });

  it('pro-rates by the remaining days', () => {
    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: 'ProRate' },
      currentAllowanceMinor: 100_000,
      newPlanAllowanceMinor: 200_000,
      periodStart,
      periodEnd,
      at: halfway,
    });
    // Half the cycle at 100,000 and half at 200,000 is about 150,000.
    assert.ok(Math.abs(outcome.allowanceMinor - 150_000) < 2_000, `got ${outcome.allowanceMinor}`);
    assert.match(outcome.reason, /Pro-rated/);
  });

  it('pro-rates a downgrade downwards', () => {
    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: 'ProRate' },
      currentAllowanceMinor: 200_000,
      newPlanAllowanceMinor: 100_000,
      periodStart,
      periodEnd,
      at: halfway,
    });
    assert.ok(outcome.allowanceMinor < 200_000);
    assert.ok(outcome.allowanceMinor > 100_000);
  });

  it('falls back to the full allowance for a period with no length', () => {
    const outcome = allowanceAfterPlanChange({
      policy: { planChangePolicy: 'ProRate' },
      currentAllowanceMinor: 100_000,
      newPlanAllowanceMinor: 200_000,
      periodStart,
      periodEnd: periodStart,
      at: halfway,
    });
    assert.equal(outcome.allowanceMinor, 200_000);
    assert.match(outcome.reason, /no length/);
  });
});

describe('reallocation', () => {
  it('moves budget that is genuinely uncommitted', () => {
    assert.equal(
      validateReallocation({
        amountMinor: 5_000,
        fromRemainingMinor: 8_000,
        fromWalletId: 'a',
        toWalletId: 'b',
      }).ok,
      true,
    );
  });

  it('refuses to move more than is uncommitted', () => {
    // Moving reserved or spent budget would create allowance out of nothing, which is exactly
    // what "does not increase the total commercial allowance" forbids.
    const outcome = validateReallocation({
      amountMinor: 9_000,
      fromRemainingMinor: 8_000,
      fromWalletId: 'a',
      toWalletId: 'b',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.reason : '', /create allowance out of nothing/);
  });

  it('refuses a move to itself and a non-positive amount', () => {
    assert.equal(
      validateReallocation({
        amountMinor: 100,
        fromRemainingMinor: 500,
        fromWalletId: 'a',
        toWalletId: 'a',
      }).ok,
      false,
    );
    assert.equal(
      validateReallocation({
        amountMinor: 0,
        fromRemainingMinor: 500,
        fromWalletId: 'a',
        toWalletId: 'b',
      }).ok,
      false,
    );
  });
});

describe('resuming after a top-up', () => {
  it('resumes a run blocked only by budget', () => {
    const outcome = mayResumeAfterTopUp({ runState: 'BlockedByBudget', blockedReason: null });
    assert.equal(outcome.resumable, true);
  });

  it('leaves every other block alone', () => {
    // Buying credits must not quietly clear a governance decision.
    for (const state of [
      'BlockedByPermission',
      'BlockedByConnection',
      'WaitingForHumanInput',
      'Failed',
      'Running',
    ]) {
      const outcome = mayResumeAfterTopUp({ runState: state, blockedReason: null });
      assert.equal(outcome.resumable, false, `${state} should not resume on a top-up`);
    }
  });

  it('says that every other limit still applies', () => {
    const outcome = mayResumeAfterTopUp({ runState: 'BlockedByBudget', blockedReason: null });
    assert.match(outcome.reason, /permission, approval and limit/);
  });
});
