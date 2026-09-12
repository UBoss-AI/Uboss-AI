import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_RUN_TRANSITIONS,
  BLOCK_OWNER,
  BLOCKED_RUN_STATES,
  dateIn,
  DEFAULT_MAX_RUN_ATTEMPTS,
  DEFAULT_MISSED_RUN_POLICY,
  DEFAULT_OVERLAP_POLICY,
  DEFAULT_WORKING_DAYS,
  isRunBlocked,
  isRunFinished,
  isWorkingMoment,
  mayCancelRun,
  mayMoveRun,
  mayRetryRun,
  MISSED_RUN_POLICIES,
  nextWorkingMoment,
  overlapDecision,
  OVERLAP_POLICIES,
  RETRYABILITY,
  retryDelayMs,
  RUN_STATE_LABELS,
  RUN_STATE_TONES,
  RUN_STATES,
  RUN_TRIGGERS,
  runIdempotencyKey,
  TERMINAL_RUN_STATES,
  weekdayIn,
  WEEKDAYS,
  type BusinessCalendar,
} from './runs.js';

const KOLKATA: BusinessCalendar = {
  timezone: 'Asia/Kolkata',
  workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  holidays: ['2026-01-26'],
};

describe('run states come from the architecture', () => {
  it('has the thirteen states the diagram lists', () => {
    assert.deepEqual(
      [...RUN_STATES],
      [
        'Queued',
        'Reserved',
        'Running',
        'WaitingForHumanInput',
        'WaitingForApproval',
        'Retrying',
        'Completed',
        'Failed',
        'Cancelled',
        'BlockedByBudget',
        'BlockedByConnection',
        'BlockedByPermission',
        'BlockedByProvider',
      ],
    );
  });

  it('keeps the four blocked states separate, and says who resolves each', () => {
    // The whole reason they are not one state with a reason code: four different people act.
    assert.equal(BLOCKED_RUN_STATES.length, 4);
    for (const state of BLOCKED_RUN_STATES) {
      assert.ok(BLOCK_OWNER[state]?.trim(), `${state} does not say who resolves it`);
      assert.ok(isRunBlocked(state));
    }
    assert.equal(new Set(Object.values(BLOCK_OWNER)).size, 4, 'two blocks share an owner');
  });

  it('labels and tones every state', () => {
    for (const state of RUN_STATES) {
      assert.ok(RUN_STATE_LABELS[state]?.trim(), `${state} has no label`);
      assert.ok(RUN_STATE_TONES[state]?.trim(), `${state} has no tone`);
    }
  });

  it('treats exactly three states as finished', () => {
    assert.deepEqual([...TERMINAL_RUN_STATES], ['Completed', 'Failed', 'Cancelled']);
    for (const state of RUN_STATES) {
      assert.equal(
        isRunFinished(state),
        (TERMINAL_RUN_STATES as readonly string[]).includes(state),
        state,
      );
    }
  });

  it('has the five triggers, including the engine’s own retry', () => {
    assert.deepEqual([...RUN_TRIGGERS], ['Manual', 'OneTime', 'Scheduled', 'Event', 'Retry']);
  });
});

describe('the run transition table', () => {
  it('never lets a run reach Running without a reservation', () => {
    // `Reserved` is where budget is set aside. Skipping it would let work start spending before
    // anything checked it could — and a database CHECK refuses the row as well.
    assert.equal(mayMoveRun('Queued', 'Running'), false);
    assert.equal(mayMoveRun('Queued', 'Reserved'), true);
    assert.equal(mayMoveRun('Reserved', 'Running'), true);
  });

  it('lets every unfinished run be cancelled', () => {
    // A run stuck waiting for a person who has left, or a connection nobody will fix, must not be
    // un-cancellable.
    for (const state of RUN_STATES) {
      assert.equal(
        mayCancelRun(state),
        !isRunFinished(state),
        `${state} disagrees about cancellation`,
      );
    }
  });

  it('leads nowhere from a terminal state', () => {
    // A retry of a failed run is a *new* run with its own idempotency key, not a resurrection:
    // one run must describe one attempt sequence, and its provider calls have to be attributable.
    for (const state of TERMINAL_RUN_STATES) {
      assert.deepEqual([...ALLOWED_RUN_TRANSITIONS[state]], [], state);
    }
  });

  it('sends a retry back through Reserved, not straight to Running', () => {
    // The previous reservation was released when the attempt failed, so the next attempt takes
    // one again rather than assuming it still holds.
    assert.equal(mayMoveRun('Retrying', 'Reserved'), true);
    assert.equal(mayMoveRun('Retrying', 'Running'), false);
  });

  it('returns a waiting run to Running, because it still holds its reservation', () => {
    assert.equal(mayMoveRun('WaitingForHumanInput', 'Running'), true);
    assert.equal(mayMoveRun('WaitingForApproval', 'Running'), true);
  });

  it('returns a blocked run to Queued, because what it held was released', () => {
    for (const state of BLOCKED_RUN_STATES) {
      assert.equal(mayMoveRun(state, 'Queued'), true, state);
      assert.equal(mayMoveRun(state, 'Running'), false, `${state} skipped the reservation`);
    }
  });

  it('has a transition list for every state, naming only real states', () => {
    for (const state of RUN_STATES) {
      const next = ALLOWED_RUN_TRANSITIONS[state];
      assert.ok(next !== undefined, `${state} has no transition list`);
      for (const target of next) {
        assert.ok(RUN_STATES.includes(target), `${state} → unknown ${target}`);
      }
    }
  });

  it('never lets a state move to itself', () => {
    for (const state of RUN_STATES) {
      assert.equal(mayMoveRun(state, state), false, state);
    }
  });
});

describe('retries are bounded and classified', () => {
  it('has the three classifications', () => {
    assert.deepEqual([...RETRYABILITY], ['Retryable', 'Terminal', 'NeedsIntervention']);
  });

  it('does not retry a terminal failure', () => {
    // Retrying wastes attempts and delays the report a person actually needs.
    const outcome = mayRetryRun({ retryability: 'Terminal', attempt: 1, maxAttempts: 3 });
    assert.equal(outcome.allowed, false);
    assert.match(outcome.reason, /will not succeed/);
  });

  it('does not retry something that needs a person', () => {
    const outcome = mayRetryRun({ retryability: 'NeedsIntervention', attempt: 1, maxAttempts: 3 });
    assert.equal(outcome.allowed, false);
    assert.match(outcome.reason, /has to act/);
  });

  it('retries a retryable failure while attempts remain', () => {
    assert.equal(
      mayRetryRun({ retryability: 'Retryable', attempt: 1, maxAttempts: 3 }).allowed,
      true,
    );
    assert.equal(
      mayRetryRun({ retryability: 'Retryable', attempt: 2, maxAttempts: 3 }).allowed,
      true,
    );
  });

  it('stops at the ceiling and names the dead-letter path', () => {
    // Unbounded retries are how a queue eats itself.
    const outcome = mayRetryRun({ retryability: 'Retryable', attempt: 3, maxAttempts: 3 });
    assert.equal(outcome.allowed, false);
    assert.match(outcome.reason, /dead-letter/);
  });

  it('backs off exponentially, and caps', () => {
    assert.equal(retryDelayMs(1, 1000), 1000);
    assert.equal(retryDelayMs(2, 1000), 2000);
    assert.equal(retryDelayMs(3, 1000), 4000);
    // Capped, or a fourth retry of a slow job would be scheduled days out.
    assert.equal(retryDelayMs(20, 1000, 10_000), 10_000);
  });

  it('has a bounded default ceiling', () => {
    assert.equal(DEFAULT_MAX_RUN_ATTEMPTS, 3);
  });
});

describe('overlap policy', () => {
  it('starts when nothing is in flight, whatever the policy', () => {
    for (const policy of OVERLAP_POLICIES) {
      const outcome = overlapDecision({ policy, unfinishedRuns: 0 });
      assert.equal(outcome.start, true, policy);
    }
  });

  it('skips by default when something is already running', () => {
    // Two concurrent runs can have one agent writing over the other's output. Recoverable by
    // configuring the agent; not a surprise to discover in production.
    assert.equal(DEFAULT_OVERLAP_POLICY, 'Skip');
    const outcome = overlapDecision({ policy: 'Skip', unfinishedRuns: 1 });
    assert.equal(outcome.start, false);
    assert.equal(outcome.queue, false);
  });

  it('queues behind the running one when told to', () => {
    const outcome = overlapDecision({ policy: 'Queue', unfinishedRuns: 2 });
    assert.equal(outcome.start, false);
    assert.equal(outcome.queue, true);
    assert.match(outcome.reason, /2 run/);
  });

  it('allows concurrency only when explicitly configured', () => {
    const outcome = overlapDecision({ policy: 'Allow', unfinishedRuns: 3 });
    assert.equal(outcome.start, true);
    assert.equal(outcome.queue, false);
  });

  it('always says why', () => {
    for (const policy of OVERLAP_POLICIES) {
      for (const unfinishedRuns of [0, 1, 5]) {
        assert.ok(overlapDecision({ policy, unfinishedRuns }).reason.trim() !== '');
      }
    }
  });
});

describe('missed-run policy', () => {
  it('has the three the architecture allows, and skips by default', () => {
    assert.deepEqual([...MISSED_RUN_POLICIES], ['RunOnce', 'RunAll', 'Skip']);
    // Catching up every missed occurrence after an outage can flood a provider and spend a budget
    // in minutes.
    assert.equal(DEFAULT_MISSED_RUN_POLICY, 'Skip');
  });
});

describe('the business calendar', () => {
  it('reads the weekday in the company’s timezone, not the server’s', () => {
    // 2026-01-05T20:00Z is Monday evening in London and already Tuesday in Kolkata. A scheduler
    // that used the server's day would fire this on the wrong one.
    const at = new Date('2026-01-05T20:00:00Z');
    assert.equal(weekdayIn(at, 'Europe/London'), 'Monday');
    assert.equal(weekdayIn(at, 'Asia/Kolkata'), 'Tuesday');
  });

  it('reads the date in the company’s timezone', () => {
    const at = new Date('2026-01-25T20:00:00Z');
    assert.equal(dateIn(at, 'Europe/London'), '2026-01-25');
    assert.equal(dateIn(at, 'Asia/Kolkata'), '2026-01-26');
  });

  it('refuses a non-working day, and says which', () => {
    // 2026-01-03 is a Saturday.
    const outcome = isWorkingMoment(new Date('2026-01-03T06:00:00Z'), KOLKATA);
    assert.equal(outcome.working, false);
    assert.match(outcome.reason, /Saturday/);
  });

  it('refuses a holiday even on a working weekday', () => {
    // 2026-01-26 is a Monday, and a holiday in this calendar.
    const outcome = isWorkingMoment(new Date('2026-01-26T06:00:00Z'), KOLKATA);
    assert.equal(outcome.working, false);
    assert.match(outcome.reason, /holiday/);
  });

  it('judges the holiday by the company’s date, not UTC', () => {
    // 20:00Z on the 25th is already the 26th in Kolkata, so this instant is a holiday there and
    // an ordinary Sunday-evening instant in London.
    const at = new Date('2026-01-25T20:00:00Z');
    assert.equal(isWorkingMoment(at, KOLKATA).working, false);
  });

  it('accepts an ordinary working moment', () => {
    // 2026-01-05 is a Monday.
    const outcome = isWorkingMoment(new Date('2026-01-05T06:00:00Z'), KOLKATA);
    assert.equal(outcome.working, true);
  });

  it('finds the next working moment across a weekend', () => {
    // Friday 2026-01-02 → the next working day is Monday the 5th.
    const next = nextWorkingMoment(new Date('2026-01-03T06:00:00Z'), KOLKATA);
    assert.ok(next);
    assert.equal(weekdayIn(next, KOLKATA.timezone), 'Monday');
  });

  it('returns null rather than looping when no day is a working day', () => {
    // A company with no working days configured would otherwise send a scheduler tick into an
    // unbounded loop. Saying so beats hanging.
    const none: BusinessCalendar = { ...KOLKATA, workingDays: [] };
    assert.equal(nextWorkingMoment(new Date('2026-01-05T06:00:00Z'), none), null);
  });

  it('returns null when every day within the horizon is a holiday', () => {
    const holidays: string[] = [];
    for (let day = 1; day <= 20; day += 1) {
      holidays.push(`2026-01-${String(day).padStart(2, '0')}`);
    }
    const blocked: BusinessCalendar = { ...KOLKATA, holidays };
    assert.equal(nextWorkingMoment(new Date('2026-01-05T06:00:00Z'), blocked, 5), null);
  });

  it('has the seven weekdays with Sunday first, matching cron’s numbering', () => {
    assert.equal(WEEKDAYS.length, 7);
    assert.equal(WEEKDAYS[0], 'Sunday');
    assert.equal(WEEKDAYS[6], 'Saturday');
  });

  it('defaults to Monday through Friday', () => {
    assert.deepEqual(
      [...DEFAULT_WORKING_DAYS],
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    );
  });
});

describe('idempotency keys', () => {
  it('gives the same occurrence the same key', () => {
    // What makes a scheduler safe on two instances: both compute this, and the unique index
    // refuses the second row.
    const input = {
      engineAgentId: 'agent-1',
      assignmentId: 'assignment-1',
      trigger: 'Scheduled' as const,
      occurrence: '2026-01-05T10:30:00.000Z',
    };
    assert.equal(runIdempotencyKey(input), runIdempotencyKey(input));
  });

  it('separates different occurrences of the same schedule', () => {
    const base = {
      engineAgentId: 'agent-1',
      assignmentId: 'assignment-1',
      trigger: 'Scheduled' as const,
    };
    assert.notEqual(
      runIdempotencyKey({ ...base, occurrence: '2026-01-05T10:30:00.000Z' }),
      runIdempotencyKey({ ...base, occurrence: '2026-01-06T10:30:00.000Z' }),
    );
  });

  it('separates the same moment on different agents', () => {
    const base = {
      assignmentId: 'assignment-1',
      trigger: 'Scheduled' as const,
      occurrence: '2026-01-05T10:30:00.000Z',
    };
    assert.notEqual(
      runIdempotencyKey({ ...base, engineAgentId: 'agent-1' }),
      runIdempotencyKey({ ...base, engineAgentId: 'agent-2' }),
    );
  });

  it('separates triggers, so a manual start never collides with its schedule', () => {
    const base = {
      engineAgentId: 'agent-1',
      assignmentId: 'assignment-1',
      occurrence: '2026-01-05T10:30:00.000Z',
    };
    assert.notEqual(
      runIdempotencyKey({ ...base, trigger: 'Scheduled' }),
      runIdempotencyKey({ ...base, trigger: 'Manual' }),
    );
  });

  it('handles a run with no assignment without colliding with one that has none either', () => {
    const withNone = runIdempotencyKey({
      engineAgentId: 'agent-1',
      assignmentId: null,
      trigger: 'Manual',
      occurrence: 'nonce-1',
    });
    const alsoNone = runIdempotencyKey({
      engineAgentId: 'agent-1',
      assignmentId: null,
      trigger: 'Manual',
      occurrence: 'nonce-2',
    });
    assert.notEqual(withNone, alsoNone);
    assert.match(withNone, /no-assignment/);
  });
});
