import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyLedgerEntry,
  BUDGET_SCOPE_ORDER,
  BUDGET_SCOPES,
  combineLevels,
  committedPercent,
  COST_THRESHOLDS,
  crossedThreshold,
  decideLevel,
  DEFAULT_COST_THRESHOLD_PERCENTS,
  estimateMinor,
  LEDGER_EFFECT,
  LEDGER_ENTRY_KIND_LABELS,
  LEDGER_ENTRY_KINDS,
  mayMoveReservation,
  projectedExhaustion,
  reconcileBalance,
  remainingMinor,
  replayLedger,
  RESERVATION_STATES,
  reservationHasExpired,
  reservationIsOpen,
  scopesToCheck,
  thresholdsAreOrdered,
  type CostThreshold,
  type SpendCheckLevel,
} from './cost.js';

const level = (overrides: Partial<SpendCheckLevel> = {}): SpendCheckLevel => ({
  scope: 'Company',
  subjectId: null,
  allowanceMinor: 100_000,
  usedMinor: 0,
  reservedMinor: 0,
  remainingMinor: 100_000,
  percentAfter: 0,
  decision: 'Allowed',
  reason: 'fine',
  ...overrides,
});

describe('the budget hierarchy', () => {
  it('is the four levels the functional document names', () => {
    assert.deepEqual([...BUDGET_SCOPES], ['Company', 'Department', 'Objective', 'Agent']);
  });

  it('orders them outermost first', () => {
    assert.ok(BUDGET_SCOPE_ORDER.Company < BUDGET_SCOPE_ORDER.Department);
    assert.ok(BUDGET_SCOPE_ORDER.Department < BUDGET_SCOPE_ORDER.Objective);
    assert.ok(BUDGET_SCOPE_ORDER.Objective < BUDGET_SCOPE_ORDER.Agent);
  });

  it('always checks the company level, even with nothing else attached', () => {
    const levels = scopesToCheck({ departmentId: null, objectiveId: null, engineAgentId: null });
    assert.deepEqual(levels, [{ scope: 'Company', subjectId: null }]);
  });

  it('adds each level that applies, outermost first', () => {
    const levels = scopesToCheck({ departmentId: 'd', objectiveId: 'o', engineAgentId: 'a' });
    assert.deepEqual(
      levels.map((entry) => entry.scope),
      ['Company', 'Department', 'Objective', 'Agent'],
    );
  });

  it('keeps a stable lock order, which is what stops two reservations deadlocking', () => {
    // Two callers with the same levels must produce the same sequence, or they can take the same
    // two rows in opposite orders and wait on each other forever.
    const a = scopesToCheck({ departmentId: 'd', objectiveId: 'o', engineAgentId: null });
    const b = scopesToCheck({ departmentId: 'd', objectiveId: 'o', engineAgentId: null });
    assert.deepEqual(a, b);
  });
});

describe('wallet arithmetic', () => {
  it('subtracts both spend and reservations from the allowance', () => {
    // Omitting reservations here is the overspend bug: two runs would both see room.
    assert.equal(remainingMinor({ allowanceMinor: 100, usedMinor: 30, reservedMinor: 50 }), 20);
  });

  it('lets remaining go negative rather than hiding an overspend', () => {
    // A provider's actual usage can exceed the reserved estimate. Clamping would conceal it.
    assert.equal(remainingMinor({ allowanceMinor: 100, usedMinor: 130, reservedMinor: 0 }), -30);
  });

  it('counts reservations towards the committed percentage', () => {
    assert.equal(
      committedPercent({ allowanceMinor: 200, usedMinor: 100, reservedMinor: 100 }),
      100,
    );
  });

  it('rounds the percentage down, so a threshold is crossed only when it really is', () => {
    assert.equal(committedPercent({ allowanceMinor: 1000, usedMinor: 749, reservedMinor: 0 }), 74);
  });

  it('reports zero for a zero allowance rather than dividing by it', () => {
    assert.equal(committedPercent({ allowanceMinor: 0, usedMinor: 50, reservedMinor: 0 }), 0);
  });
});

describe('thresholds', () => {
  it('defaults to the functional document’s own example', () => {
    assert.equal(DEFAULT_COST_THRESHOLD_PERCENTS.Information, 50);
    assert.equal(DEFAULT_COST_THRESHOLD_PERCENTS.Warning, 75);
    assert.equal(DEFAULT_COST_THRESHOLD_PERCENTS.Critical, 90);
    assert.equal(DEFAULT_COST_THRESHOLD_PERCENTS.HardStop, 100);
  });

  it('labels every threshold', () => {
    for (const threshold of COST_THRESHOLDS) {
      assert.ok(threshold.length > 0);
    }
  });

  it('reports only the most severe crossed level', () => {
    // Three notifications for one condition is how an alert becomes noise somebody filters.
    assert.equal(crossedThreshold({ percent: 95 }), 'Critical');
    assert.equal(crossedThreshold({ percent: 80 }), 'Warning');
    assert.equal(crossedThreshold({ percent: 60 }), 'Information');
    assert.equal(crossedThreshold({ percent: 100 }), 'HardStop');
  });

  it('reports nothing below the lowest threshold', () => {
    assert.equal(crossedThreshold({ percent: 10 }), null);
  });

  it('honours configured percentages rather than the defaults', () => {
    // The functional document is explicit that these must be configurable, not hard-coded.
    assert.equal(crossedThreshold({ percent: 30, percents: { Information: 25 } }), 'Information');
    assert.equal(crossedThreshold({ percent: 60, percents: { Warning: 55 } }), 'Warning');
  });

  it('accepts an ordered set', () => {
    assert.equal(thresholdsAreOrdered(DEFAULT_COST_THRESHOLD_PERCENTS).ok, true);
  });

  it('refuses an out-of-order set rather than sorting it', () => {
    // Somebody who typed 90/75/50 meant something; silently reordering hides the mistake until
    // an alert fails to fire.
    const outcome = thresholdsAreOrdered({
      Information: 90,
      Warning: 75,
      Critical: 50,
      HardStop: 100,
    } as Record<CostThreshold, number>);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /must be above/);
  });

  it('refuses equal thresholds too', () => {
    const outcome = thresholdsAreOrdered({
      Information: 50,
      Warning: 50,
      Critical: 90,
      HardStop: 100,
    } as Record<CostThreshold, number>);
    assert.equal(outcome.ok, false);
  });

  it('allows a hard stop above 100%, for a plan with deliberate headroom', () => {
    const outcome = thresholdsAreOrdered({
      Information: 50,
      Warning: 75,
      Critical: 90,
      HardStop: 120,
    } as Record<CostThreshold, number>);
    assert.equal(outcome.ok, true);
  });
});

describe('the pre-run check', () => {
  const base = {
    scope: 'Company' as const,
    subjectId: null,
    usedMinor: 0,
    reservedMinor: 0,
    approvalThresholdPercent: 90,
    hardStopPercent: 100,
  };

  it('allows a spend well inside the budget', () => {
    const outcome = decideLevel({ ...base, allowanceMinor: 100_000, estimateMinor: 1_000 });
    assert.equal(outcome.decision, 'Allowed');
  });

  it('treats an unset allowance as deferring to the level above', () => {
    // Only the company level must have one; a department without a budget inherits.
    const outcome = decideLevel({
      ...base,
      scope: 'Department',
      allowanceMinor: null,
      estimateMinor: 999_999,
    });
    assert.equal(outcome.decision, 'Allowed');
    assert.match(outcome.reason, /level above governs/);
  });

  it('needs an approval past the approval threshold', () => {
    const outcome = decideLevel({
      ...base,
      allowanceMinor: 100_000,
      usedMinor: 89_000,
      estimateMinor: 2_000,
    });
    assert.equal(outcome.decision, 'NeedsApproval');
    assert.match(outcome.reason, /A person has to authorise it/);
  });

  it('hard stops at the hard stop', () => {
    const outcome = decideLevel({
      ...base,
      allowanceMinor: 100_000,
      usedMinor: 99_000,
      estimateMinor: 2_000,
    });
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('does not hard stop a spend that lands exactly on the allowance', () => {
    // The company bought ten thousand and should be able to spend ten thousand. Refusing the
    // spend that lands exactly on the limit made the last slice of every allowance unspendable
    // — a real off-by-one the concurrency tests caught.
    //
    // It still needs an approval, because 100% is past the 90% approval threshold. That is the
    // difference between the two controls working: one asks a person, the other refuses.
    const outcome = decideLevel({ ...base, allowanceMinor: 10_000, estimateMinor: 10_000 });
    assert.equal(outcome.decision, 'NeedsApproval');
    assert.equal(outcome.percentAfter, 100);

    // With no approval threshold in the way, it is simply allowed.
    const unthresholded = decideLevel({
      ...base,
      allowanceMinor: 10_000,
      estimateMinor: 10_000,
      approvalThresholdPercent: 200,
    });
    assert.equal(unthresholded.decision, 'Allowed');
  });

  it('refuses the very next unit past it', () => {
    const outcome = decideLevel({
      ...base,
      allowanceMinor: 10_000,
      usedMinor: 10_000,
      estimateMinor: 1,
      approvalThresholdPercent: 200,
    });
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('compares in minor units, so a floored percentage cannot mislead it', () => {
    // 1,004 of 1,000 floors to 100% but is genuinely over, and must be refused.
    const outcome = decideLevel({
      ...base,
      allowanceMinor: 1_000,
      estimateMinor: 1_004,
      approvalThresholdPercent: 200,
    });
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('counts an existing reservation against the estimate', () => {
    // The whole point: a concurrent run already holding budget must reduce what this one sees.
    const outcome = decideLevel({
      ...base,
      allowanceMinor: 100_000,
      usedMinor: 0,
      reservedMinor: 99_000,
      estimateMinor: 2_000,
    });
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('keeps the three decisions distinct', () => {
    // Collapsing approval into blocked would make an expensive authorised run impossible;
    // collapsing it into allowed would make the threshold decorative.
    const allowed = decideLevel({ ...base, allowanceMinor: 100_000, estimateMinor: 1 });
    const approval = decideLevel({
      ...base,
      allowanceMinor: 100_000,
      usedMinor: 91_000,
      estimateMinor: 1,
    });
    const stopped = decideLevel({
      ...base,
      allowanceMinor: 100_000,
      usedMinor: 100_000,
      estimateMinor: 1,
    });
    assert.deepEqual(
      [allowed.decision, approval.decision, stopped.decision],
      ['Allowed', 'NeedsApproval', 'HardStopped'],
    );
  });
});

describe('combining levels', () => {
  it('allows when every level allows', () => {
    const outcome = combineLevels([level(), level({ scope: 'Agent' })]);
    assert.equal(outcome.decision, 'Allowed');
    assert.equal(outcome.bindingLevel, null);
  });

  it('lets the strictest level win', () => {
    const outcome = combineLevels([
      level(),
      level({ scope: 'Agent', decision: 'HardStopped', reason: 'agent limit' }),
    ]);
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('reports the outermost binding level, not the innermost', () => {
    // Telling somebody to raise an agent limit when the company is out of credit sends them to
    // fix the wrong thing.
    const outcome = combineLevels([
      level({ scope: 'Agent', decision: 'HardStopped', reason: 'agent limit' }),
      level({ scope: 'Company', decision: 'HardStopped', reason: 'company budget exhausted' }),
    ]);
    assert.equal(outcome.bindingLevel?.scope, 'Company');
    assert.match(outcome.reason, /company budget exhausted/);
  });

  it('prefers a hard stop over an approval', () => {
    const outcome = combineLevels([
      level({ scope: 'Company', decision: 'NeedsApproval', reason: 'approval' }),
      level({ scope: 'Agent', decision: 'HardStopped', reason: 'stopped' }),
    ]);
    assert.equal(outcome.decision, 'HardStopped');
  });

  it('returns the levels in outermost-first order whatever order they arrive in', () => {
    const outcome = combineLevels([level({ scope: 'Objective' }), level({ scope: 'Company' })]);
    assert.deepEqual(
      outcome.levels.map((entry) => entry.scope),
      ['Company', 'Objective'],
    );
  });
});

describe('reservations', () => {
  it('counts only a held reservation against a balance', () => {
    assert.equal(reservationIsOpen('Held'), true);
    for (const state of RESERVATION_STATES.filter((entry) => entry !== 'Held')) {
      assert.equal(reservationIsOpen(state), false);
    }
  });

  it('moves out of Held and never back', () => {
    assert.equal(mayMoveReservation('Held', 'Settled'), true);
    assert.equal(mayMoveReservation('Held', 'Released'), true);
    assert.equal(mayMoveReservation('Held', 'Expired'), true);
    // A settled reservation that could be re-held would charge a budget twice.
    assert.equal(mayMoveReservation('Settled', 'Held'), false);
    assert.equal(mayMoveReservation('Released', 'Settled'), false);
    assert.equal(mayMoveReservation('Expired', 'Settled'), false);
  });

  it('expires only a held reservation, and only past the window', () => {
    const heldAt = new Date('2026-09-11T00:00:00Z');
    const within = new Date('2026-09-11T00:30:00Z');
    const past = new Date('2026-09-11T02:00:00Z');

    assert.equal(reservationHasExpired({ state: 'Held', heldAt, now: within }), false);
    assert.equal(reservationHasExpired({ state: 'Held', heldAt, now: past }), true);
    // A settled one is not "expired" however old.
    assert.equal(reservationHasExpired({ state: 'Settled', heldAt, now: past }), false);
  });
});

describe('the ledger', () => {
  it('gives every kind a label and an effect', () => {
    for (const kind of LEDGER_ENTRY_KINDS) {
      assert.ok(LEDGER_ENTRY_KIND_LABELS[kind].length > 0);
      assert.ok(LEDGER_EFFECT[kind] !== undefined);
    }
  });

  it('treats a top-up as more allowance and a charge as more used', () => {
    const afterTopUp = applyLedgerEntry(
      { allowanceMinor: 0, usedMinor: 0, reservedMinor: 0 },
      { kind: 'TopUp', amountMinor: 1_000 },
    );
    assert.equal(afterTopUp.allowanceMinor, 1_000);

    const afterSettle = applyLedgerEntry(afterTopUp, { kind: 'Settle', amountMinor: 250 });
    assert.equal(afterSettle.usedMinor, 250);
    assert.equal(afterSettle.allowanceMinor, 1_000);
  });

  it('treats a refund as less used, not more allowance', () => {
    // Money coming back on work already charged is not a larger allowance.
    const after = applyLedgerEntry(
      { allowanceMinor: 1_000, usedMinor: 300, reservedMinor: 0 },
      { kind: 'Refund', amountMinor: 100 },
    );
    assert.equal(after.usedMinor, 200);
    assert.equal(after.allowanceMinor, 1_000);
  });

  it('nets a reserve and its release back to nothing', () => {
    const reserved = applyLedgerEntry(
      { allowanceMinor: 1_000, usedMinor: 0, reservedMinor: 0 },
      { kind: 'Reserve', amountMinor: 400 },
    );
    assert.equal(reserved.reservedMinor, 400);

    const released = applyLedgerEntry(reserved, { kind: 'ReleaseReserve', amountMinor: 400 });
    assert.equal(released.reservedMinor, 0);
  });

  it('replays a whole run: reserve, settle the actual, release the rest', () => {
    const balance = replayLedger([
      { kind: 'TopUp', amountMinor: 10_000 },
      { kind: 'Reserve', amountMinor: 900 },
      { kind: 'Settle', amountMinor: 340 },
      { kind: 'ReleaseReserve', amountMinor: 900 },
    ]);

    assert.equal(balance.allowanceMinor, 10_000);
    assert.equal(balance.usedMinor, 340);
    // Nothing still held, so remaining is the honest figure.
    assert.equal(balance.reservedMinor, 0);
    assert.equal(remainingMinor(balance), 9_660);
  });

  it('expresses a reallocation as two signed entries of the same kind', () => {
    const out = replayLedger([{ kind: 'Reallocation', amountMinor: -5_000 }]);
    const into = replayLedger([{ kind: 'Reallocation', amountMinor: 5_000 }]);
    assert.equal(out.allowanceMinor, -5_000);
    assert.equal(into.allowanceMinor, 5_000);
    // Two kinds that had to stay in step would eventually drift.
    assert.equal(out.allowanceMinor + into.allowanceMinor, 0);
  });
});

describe('reconciliation', () => {
  const entries = [
    { kind: 'TopUp' as const, amountMinor: 10_000 },
    { kind: 'Settle' as const, amountMinor: 2_000 },
  ];

  it('finds nothing when the stored balance matches its ledger', () => {
    const findings = reconcileBalance({
      scope: 'Company',
      subjectId: null,
      stored: { allowanceMinor: 10_000, usedMinor: 2_000, reservedMinor: 0 },
      entries,
    });
    assert.deepEqual(findings, []);
  });

  it('reports drift per field, with both numbers', () => {
    const findings = reconcileBalance({
      scope: 'Company',
      subjectId: null,
      stored: { allowanceMinor: 10_000, usedMinor: 2_500, reservedMinor: 0 },
      entries,
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.field, 'usedMinor');
    assert.equal(findings[0]?.storedMinor, 2_500);
    assert.equal(findings[0]?.replayedMinor, 2_000);
    assert.equal(findings[0]?.driftMinor, 500);
  });

  it('reports rather than corrects', () => {
    // Overwriting the stored balance would destroy the evidence they ever disagreed, and a
    // disagreement means a write outside the engine or a bug in it.
    const stored = { allowanceMinor: 9_000, usedMinor: 2_000, reservedMinor: 0 };
    reconcileBalance({ scope: 'Company', subjectId: null, stored, entries });
    assert.equal(stored.allowanceMinor, 9_000);
  });
});

describe('projection', () => {
  const periodStart = new Date('2026-09-01T00:00:00Z');

  it('projects exhaustion from the rate so far', () => {
    // Ten days in, 50% spent: about ten days left.
    const outcome = projectedExhaustion({
      usedMinor: 50_000,
      reservedMinor: 0,
      allowanceMinor: 100_000,
      periodStart,
      now: new Date('2026-09-11T00:00:00Z'),
    });
    assert.notEqual(outcome, null);
    assert.ok(Math.abs((outcome?.daysAway ?? 0) - 10) < 0.5);
  });

  it('projects nothing when nothing has been spent', () => {
    // A rate of zero projects to never, and "never" shown as a date is worse than an empty cell.
    assert.equal(
      projectedExhaustion({
        usedMinor: 0,
        reservedMinor: 0,
        allowanceMinor: 100_000,
        periodStart,
        now: new Date('2026-09-11T00:00:00Z'),
      }),
      null,
    );
  });

  it('projects nothing from less than an hour of data', () => {
    assert.equal(
      projectedExhaustion({
        usedMinor: 10,
        reservedMinor: 0,
        allowanceMinor: 100_000,
        periodStart: new Date('2026-09-11T00:00:00Z'),
        now: new Date('2026-09-11T00:20:00Z'),
      }),
      null,
    );
  });

  it('projects nothing once the allowance is already gone', () => {
    assert.equal(
      projectedExhaustion({
        usedMinor: 100_000,
        reservedMinor: 0,
        allowanceMinor: 100_000,
        periodStart,
        now: new Date('2026-09-11T00:00:00Z'),
      }),
      null,
    );
  });

  it('counts reservations towards the rate', () => {
    const withReservation = projectedExhaustion({
      usedMinor: 25_000,
      reservedMinor: 25_000,
      allowanceMinor: 100_000,
      periodStart,
      now: new Date('2026-09-11T00:00:00Z'),
    });
    const without = projectedExhaustion({
      usedMinor: 25_000,
      reservedMinor: 0,
      allowanceMinor: 100_000,
      periodStart,
      now: new Date('2026-09-11T00:00:00Z'),
    });
    assert.ok((withReservation?.daysAway ?? 0) < (without?.daysAway ?? 0));
  });
});

describe('estimating', () => {
  it('assumes the whole ceiling at the dearest rate', () => {
    // Pessimistic on purpose: an estimate that came in low would let the reservation be smaller
    // than the eventual charge, which is the overspend the reservation exists to prevent.
    assert.equal(
      estimateMinor({
        maxTokens: 1_000_000,
        inputPerMillionMinorUnits: 300_000,
        outputPerMillionMinorUnits: 1_500_000,
      }),
      1_500_000,
    );
  });

  it('rounds up, so a tiny call still reserves something', () => {
    assert.equal(
      estimateMinor({
        maxTokens: 1,
        inputPerMillionMinorUnits: 300_000,
        outputPerMillionMinorUnits: 1_500_000,
      }),
      2,
    );
  });

  it('estimates nothing for a free model', () => {
    assert.equal(
      estimateMinor({
        maxTokens: 1_000,
        inputPerMillionMinorUnits: 0,
        outputPerMillionMinorUnits: 0,
      }),
      0,
    );
  });
});
