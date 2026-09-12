import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_EXCEPTION_TRANSITIONS,
  concludeValidation,
  DEFAULT_ESCALATION_HOURS,
  escalationDue,
  EXCEPTION_DEFAULT_OWNER,
  EXCEPTION_DEFAULT_SEVERITY,
  EXCEPTION_KIND_LABELS,
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITIES,
  EXCEPTION_SEVERITY_TONES,
  EXCEPTION_STATE_LABELS,
  EXCEPTION_STATE_TONES,
  EXCEPTION_STATES,
  exceptionClearsItself,
  EXECUTOR_PERMITTED_ACTIONS,
  executorMayResolve,
  isExceptionClosed,
  mayMoveException,
  RESOLUTION_ACTION_LABELS,
  RESOLUTION_ACTIONS,
  resolutionsFor,
  SELF_CLEARING_EXCEPTIONS,
  TERMINAL_EXCEPTION_STATES,
  EXCEPTION_KINDS_ADDED_SINCE,
  SOURCE_DOCUMENT_EXCEPTION_KINDS,
  VALIDATION_STAGES,
  type ValidationStageResult,
} from './executor.js';

const PASSED: ValidationStageResult = {
  stage: 'Deterministic',
  outcome: 'Passed',
  detail: 'Every rule held.',
  producedByRealModel: null,
};

describe('the ten exception types come from the source document', () => {
  it('still has the client’s ten, first and in the document’s order', () => {
    // Unchanged in intent: the document's ten, in its order, and none of them lost or moved.
    // Asserted as a *prefix* rather than as the whole set, because Prompt 40A adds an eleventh —
    // and the point of this test is that the ten are the ten, not that the set never grows.
    assert.deepEqual(
      [...SOURCE_DOCUMENT_EXCEPTION_KINDS],
      [
        'NeedsHumanInput',
        'CredentialOrConnectionExpired',
        'PermissionDenied',
        'BudgetOrTokenLimit',
        'ProviderOrToolUnavailable',
        'ValidationFailed',
        'ApprovalPending',
        'RepeatedFailure',
        'HumanTaskOverdue',
        'MissingEvidence',
      ],
    );
    assert.deepEqual(EXCEPTION_KINDS.slice(0, SOURCE_DOCUMENT_EXCEPTION_KINDS.length), [
      ...SOURCE_DOCUMENT_EXCEPTION_KINDS,
    ]);
  });

  it('accounts for every kind that is not one of the document’s ten', () => {
    // The guard that replaces the old exact-match. A kind added without a recorded reason fails
    // here, so "where did this come from?" always has an answer — which is what the original
    // test was really protecting.
    const fromDocument = new Set<string>(SOURCE_DOCUMENT_EXCEPTION_KINDS);
    const extras = EXCEPTION_KINDS.filter((kind) => !fromDocument.has(kind));
    assert.deepEqual(
      extras,
      EXCEPTION_KINDS_ADDED_SINCE.map((entry) => entry.kind),
      'every kind beyond the document’s ten must be recorded in EXCEPTION_KINDS_ADDED_SINCE',
    );
    for (const entry of EXCEPTION_KINDS_ADDED_SINCE) {
      assert.ok(entry.prompt.trim() !== '', `${entry.kind} does not say which prompt added it`);
      assert.ok(entry.why.length > 40, `${entry.kind} does not say why it exists`);
    }
  });

  it('carries the document’s default owner for every kind', () => {
    // So a screen can say whose kind of problem this is even when routing named nobody.
    for (const kind of EXCEPTION_KINDS) {
      assert.ok(EXCEPTION_KIND_LABELS[kind]?.trim(), `${kind} has no label`);
      assert.ok(EXCEPTION_DEFAULT_OWNER[kind]?.trim(), `${kind} has no default owner`);
      assert.ok(EXCEPTION_DEFAULT_SEVERITY[kind], `${kind} has no default severity`);
    }
  });

  it('keeps ValidationFailed and MissingEvidence apart', () => {
    // One means the work produced the wrong thing; the other that it produced nothing to check.
    // Different conversations, with different people.
    assert.notEqual(
      EXCEPTION_DEFAULT_OWNER.ValidationFailed,
      EXCEPTION_DEFAULT_OWNER.MissingEvidence,
    );
  });

  it('reserves High severity for the three that mean the company is exposed now', () => {
    const high = EXCEPTION_KINDS.filter((kind) => EXCEPTION_DEFAULT_SEVERITY[kind] === 'High');
    assert.deepEqual([...high], ['PermissionDenied', 'BudgetOrTokenLimit', 'RepeatedFailure']);
  });

  it('treats a provider outage as Medium, however dramatic it sounds', () => {
    // It clears itself, which is exactly why it is not High.
    assert.equal(EXCEPTION_DEFAULT_SEVERITY.ProviderOrToolUnavailable, 'Medium');
    assert.equal(exceptionClearsItself('ProviderOrToolUnavailable'), true);
  });

  it('says only one kind clears itself', () => {
    // Marking any other as self-clearing would be how an exception ages out of a queue without
    // anybody deciding anything.
    assert.deepEqual([...SELF_CLEARING_EXCEPTIONS], ['ProviderOrToolUnavailable']);
    for (const kind of EXCEPTION_KINDS) {
      if (kind === 'ProviderOrToolUnavailable') continue;
      assert.equal(exceptionClearsItself(kind), false, kind);
    }
  });

  it('labels and tones every severity and state', () => {
    for (const severity of EXCEPTION_SEVERITIES) {
      assert.ok(EXCEPTION_SEVERITY_TONES[severity]?.trim(), severity);
    }
    for (const state of EXCEPTION_STATES) {
      assert.ok(EXCEPTION_STATE_LABELS[state]?.trim(), state);
      assert.ok(EXCEPTION_STATE_TONES[state]?.trim(), state);
    }
  });
});

describe('the exception lifecycle', () => {
  it('closes on exactly two states', () => {
    assert.deepEqual([...TERMINAL_EXCEPTION_STATES], ['Resolved', 'Dismissed']);
    for (const state of EXCEPTION_STATES) {
      assert.equal(
        isExceptionClosed(state),
        (TERMINAL_EXCEPTION_STATES as readonly string[]).includes(state),
        state,
      );
    }
  });

  it('leads nowhere from a closed exception', () => {
    // Re-opening one would rewrite a resolution somebody recorded. If the condition recurs, the
    // sweep raises a new exception — which the partial unique index specifically allows.
    for (const state of TERMINAL_EXCEPTION_STATES) {
      assert.deepEqual([...ALLOWED_EXCEPTION_TRANSITIONS[state]], [], state);
    }
  });

  it('lets an escalation be handed back', () => {
    // A manager returning something to its owner is a normal outcome, not a reversal to prevent.
    assert.equal(mayMoveException('Escalated', 'Acknowledged'), true);
  });

  it('never lets a state move to itself', () => {
    for (const state of EXCEPTION_STATES) {
      assert.equal(mayMoveException(state, state), false, state);
    }
  });

  it('names only real states in every transition list', () => {
    for (const state of EXCEPTION_STATES) {
      for (const target of ALLOWED_EXCEPTION_TRANSITIONS[state]) {
        assert.ok(EXCEPTION_STATES.includes(target), `${state} → unknown ${target}`);
      }
    }
  });
});

describe('THE LOCKED RULE — the Executor never decides', () => {
  it('has no word for the Executor closing something', () => {
    // The vocabulary itself omits them, so this is not a check that could be forgotten.
    assert.equal(EXECUTOR_PERMITTED_ACTIONS.includes('Resolve'), false);
    assert.equal(EXECUTOR_PERMITTED_ACTIONS.includes('Dismiss'), false);
  });

  it('refuses an Executor Resolve on every kind of exception', () => {
    for (const kind of EXCEPTION_KINDS) {
      const outcome = executorMayResolve({ action: 'Resolve', kind });
      assert.equal(outcome.allowed, false, kind);
      assert.match(outcome.reason, /judgement|oversight/);
    }
  });

  it('refuses an Executor Dismiss on every kind of exception', () => {
    for (const kind of EXCEPTION_KINDS) {
      assert.equal(executorMayResolve({ action: 'Dismiss', kind }).allowed, false, kind);
    }
  });

  it('lets the Executor route and escalate, which is what it is for', () => {
    for (const action of ['Acknowledge', 'Reassign', 'Escalate', 'RequestApproval'] as const) {
      assert.equal(executorMayResolve({ action, kind: 'NeedsHumanInput' }).allowed, true, action);
    }
  });

  it('refuses even a retry when a control refused the work', () => {
    // A permission or budget exception means something said no. Retrying it would be the
    // Executor pressing on past that refusal.
    for (const kind of ['PermissionDenied', 'BudgetOrTokenLimit'] as const) {
      for (const action of ['Retry', 'PauseAgent'] as const) {
        const outcome = executorMayResolve({ action, kind });
        assert.equal(outcome.allowed, false, `${action} on ${kind}`);
        assert.match(outcome.reason, /refused/);
      }
    }
  });

  it('does let the Executor retry a transient fault', () => {
    assert.equal(
      executorMayResolve({ action: 'Retry', kind: 'ProviderOrToolUnavailable' }).allowed,
      true,
    );
  });

  it('always gives a reason, whichever way it answers', () => {
    for (const action of RESOLUTION_ACTIONS) {
      for (const kind of EXCEPTION_KINDS) {
        assert.ok(executorMayResolve({ action, kind }).reason.trim() !== '');
      }
    }
  });

  it('labels every resolution action', () => {
    for (const action of RESOLUTION_ACTIONS) {
      assert.ok(RESOLUTION_ACTION_LABELS[action]?.trim(), action);
    }
  });
});

describe('what a person may do', () => {
  it('offers nothing on a closed exception', () => {
    for (const state of TERMINAL_EXCEPTION_STATES) {
      assert.deepEqual(resolutionsFor({ kind: 'NeedsHumanInput', state }), []);
    }
  });

  it('offers Acknowledge only while it is Open', () => {
    assert.ok(resolutionsFor({ kind: 'NeedsHumanInput', state: 'Open' }).includes('Acknowledge'));
    assert.ok(
      !resolutionsFor({ kind: 'NeedsHumanInput', state: 'Acknowledged' }).includes('Acknowledge'),
    );
  });

  it('always lets a person resolve or dismiss an open exception', () => {
    // The counterpart to the locked rule: what the Executor cannot do, a person can.
    for (const kind of EXCEPTION_KINDS) {
      const actions = resolutionsFor({ kind, state: 'Open' });
      assert.ok(actions.includes('Resolve'), kind);
      assert.ok(actions.includes('Dismiss'), kind);
    }
  });

  it('offers a retry only where trying again could plausibly work', () => {
    for (const kind of [
      'ProviderOrToolUnavailable',
      'ValidationFailed',
      'RepeatedFailure',
    ] as const) {
      assert.ok(resolutionsFor({ kind, state: 'Open' }).includes('Retry'), kind);
    }
    assert.ok(!resolutionsFor({ kind: 'MissingEvidence', state: 'Open' }).includes('Retry'));
  });

  it('offers requesting an approval where an approval is what is missing', () => {
    for (const kind of ['ApprovalPending', 'BudgetOrTokenLimit'] as const) {
      assert.ok(resolutionsFor({ kind, state: 'Open' }).includes('RequestApproval'), kind);
    }
  });
});

describe('the validation order is the substance', () => {
  it('has the client’s three stages in order', () => {
    assert.deepEqual([...VALIDATION_STAGES], ['Deterministic', 'AiEvaluator', 'HumanApproval']);
  });

  it('ends at a failed deterministic check without consulting the AI evaluator', () => {
    // A definite rule has already answered. Asking a model to second-guess it would turn a schema
    // violation into a matter of opinion.
    const outcome = concludeValidation({
      deterministic: {
        stage: 'Deterministic',
        outcome: 'Failed',
        detail: 'The output has no evidence attached.',
        producedByRealModel: null,
      },
      aiEvaluator: {
        stage: 'AiEvaluator',
        outcome: 'Passed',
        detail: 'Looks fine to me.',
        producedByRealModel: false,
      },
      humanApprovalRequired: false,
      humanApprovalGiven: false,
    });

    assert.equal(outcome.verdict, 'Failed');
    assert.equal(outcome.exceptionKind, 'ValidationFailed');
    assert.equal(outcome.stages.length, 1, 'the AI stage was consulted anyway');
    assert.match(outcome.summary, /not consulted/);
  });

  it('fails when the AI evaluator rejects it', () => {
    const outcome = concludeValidation({
      deterministic: PASSED,
      aiEvaluator: {
        stage: 'AiEvaluator',
        outcome: 'Failed',
        detail: 'The checklist misses two requirements.',
        producedByRealModel: false,
      },
      humanApprovalRequired: false,
      humanApprovalGiven: false,
    });
    assert.equal(outcome.verdict, 'Failed');
    assert.equal(outcome.exceptionKind, 'ValidationFailed');
  });

  it('DEFERS a high-risk action rather than passing it', () => {
    // The locked rule inside the pipeline: however confidently the first two stages agreed, work
    // that needs a person is not passed until a person decides.
    const outcome = concludeValidation({
      deterministic: PASSED,
      aiEvaluator: {
        stage: 'AiEvaluator',
        outcome: 'Passed',
        detail: 'No objection.',
        producedByRealModel: false,
      },
      humanApprovalRequired: true,
      humanApprovalGiven: false,
    });

    assert.equal(outcome.verdict, 'Deferred');
    assert.notEqual(outcome.verdict, 'Passed');
    assert.equal(outcome.exceptionKind, 'ApprovalPending');
    assert.match(outcome.summary, /does not make it/);
  });

  it('passes a high-risk action once a person has approved it', () => {
    const outcome = concludeValidation({
      deterministic: PASSED,
      humanApprovalRequired: true,
      humanApprovalGiven: true,
    });
    assert.equal(outcome.verdict, 'Passed');
    assert.equal(outcome.exceptionKind, null);
  });

  it('passes ordinary work with no human stage at all', () => {
    const outcome = concludeValidation({
      deterministic: PASSED,
      humanApprovalRequired: false,
      humanApprovalGiven: false,
    });
    assert.equal(outcome.verdict, 'Passed');
    assert.equal(outcome.stages.length, 1);
  });

  it('records the human stage in the trail whenever it applied', () => {
    const outcome = concludeValidation({
      deterministic: PASSED,
      humanApprovalRequired: true,
      humanApprovalGiven: false,
    });
    const human = outcome.stages.find((stage) => stage.stage === 'HumanApproval');
    assert.ok(human, 'the human stage is missing from the trail');
    assert.equal(human.outcome, 'Deferred');
    // Null, not false: no model touched this stage, and "no model" must not read as "a mock".
    assert.equal(human.producedByRealModel, null);
  });

  it('never reports Deferred as either Passed or Failed', () => {
    // Reporting it either way would be a lie in one direction or the other.
    const outcome = concludeValidation({
      deterministic: PASSED,
      humanApprovalRequired: true,
      humanApprovalGiven: false,
    });
    assert.equal(outcome.verdict === 'Passed', false);
    assert.equal(outcome.verdict === 'Failed', false);
  });
});

describe('escalation', () => {
  const openedAt = new Date('2026-03-02T00:00:00Z');

  it('has a window per severity, tightest for High', () => {
    assert.ok(DEFAULT_ESCALATION_HOURS.High < DEFAULT_ESCALATION_HOURS.Medium);
    assert.ok(DEFAULT_ESCALATION_HOURS.Medium < DEFAULT_ESCALATION_HOURS.Low);
  });

  it('is not due inside the window', () => {
    const outcome = escalationDue({
      state: 'Open',
      severity: 'High',
      openedAt,
      now: new Date('2026-03-02T02:00:00Z'),
    });
    assert.equal(outcome.due, false);
    assert.match(outcome.reason, /2.0h of its 4h window/);
  });

  it('is due once the window has passed', () => {
    const outcome = escalationDue({
      state: 'Open',
      severity: 'High',
      openedAt,
      now: new Date('2026-03-02T05:00:00Z'),
    });
    assert.equal(outcome.due, true);
    assert.match(outcome.reason, /past the 4h window/);
  });

  it('still escalates an ACKNOWLEDGED exception', () => {
    // Acknowledging is not fixing. Letting it stop the clock would make "I have seen it" a way to
    // hold something for ever, which is how an aging queue becomes one nobody reads.
    const outcome = escalationDue({
      state: 'Acknowledged',
      severity: 'High',
      openedAt,
      now: new Date('2026-03-02T05:00:00Z'),
    });
    assert.equal(outcome.due, true);
  });

  it('does not escalate twice', () => {
    const outcome = escalationDue({
      state: 'Escalated',
      severity: 'High',
      openedAt,
      now: new Date('2026-03-03T00:00:00Z'),
    });
    assert.equal(outcome.due, false);
    assert.match(outcome.reason, /already escalated/);
  });

  it('does not escalate a closed exception', () => {
    for (const state of TERMINAL_EXCEPTION_STATES) {
      const outcome = escalationDue({
        state,
        severity: 'High',
        openedAt,
        now: new Date('2026-04-01T00:00:00Z'),
      });
      assert.equal(outcome.due, false, state);
    }
  });

  it('honours a company’s own window over the severity default', () => {
    const outcome = escalationDue({
      state: 'Open',
      severity: 'Low',
      openedAt,
      now: new Date('2026-03-02T02:00:00Z'),
      escalationHours: 1,
    });
    assert.equal(outcome.due, true);
  });
});
