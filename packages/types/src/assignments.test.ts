import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOWED_APPROVAL_TRANSITIONS,
  ALLOWED_HUMAN_TASK_TRANSITIONS,
  APPROVAL_REQUEST_STATUS_LABELS,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_TYPE_LABELS,
  APPROVAL_REQUEST_TYPES,
  ASSIGNMENT_CHECK_LABELS,
  ASSIGNMENT_CHECKS,
  CHANGE_REQUEST_KIND_LABELS,
  CHANGE_REQUEST_KINDS,
  changeRequestProblems,
  MAX_CHANGE_REQUEST_REASON,
  dependenciesSatisfied,
  EXECUTOR_EXPECTATION_KINDS,
  EXECUTOR_EXPECTATION_LABELS,
  HUMAN_TASK_STATUS_LABELS,
  HUMAN_TASK_STATUS_TONES,
  HUMAN_TASK_STATUSES,
  humanTaskDisplayStatus,
  isHumanTaskFinished,
  isHumanTaskOverdue,
  mayMoveApproval,
  mayMoveHumanTask,
  mayReleaseHumanTask,
  TASK_NOTE_KINDS,
  TERMINAL_HUMAN_TASK_STATUSES,
  validateTaskSubmission,
  WORK_ITEM_TYPES,
  type HumanTaskStatus,
} from './assignments.js';

const HOUR = 60 * 60 * 1000;

describe('the work item types', () => {
  it('are the approved UI’s own three', () => {
    // The Pending Jobs table's `Type` column: Human, Approval, Agent.
    assert.deepEqual([...WORK_ITEM_TYPES], ['Human', 'Approval', 'Agent']);
  });
});

describe('human task statuses', () => {
  it('label and tone every status, so no screen invents either', () => {
    for (const status of HUMAN_TASK_STATUSES) {
      assert.ok(HUMAN_TASK_STATUS_LABELS[status]?.trim(), status);
      assert.ok(HUMAN_TASK_STATUS_TONES[status]?.trim(), status);
    }
  });

  it('does NOT store Overdue as a status', () => {
    // The point of the design. A task can be waiting on somebody else *and* late; one status
    // column would have to pick, and picking loses the fact somebody needs.
    assert.ok(!(HUMAN_TASK_STATUSES as readonly string[]).includes('Overdue'));
  });

  it('treats only Completed and Cancelled as finished', () => {
    assert.deepEqual([...TERMINAL_HUMAN_TASK_STATUSES], ['Completed', 'Cancelled']);
    for (const status of HUMAN_TASK_STATUSES) {
      assert.equal(
        isHumanTaskFinished(status),
        status === 'Completed' || status === 'Cancelled',
        status,
      );
    }
  });

  it('has a transition list for every status', () => {
    for (const status of HUMAN_TASK_STATUSES) {
      assert.ok(Array.isArray(ALLOWED_HUMAN_TASK_TRANSITIONS[status]), status);
    }
  });

  it('never leaves a terminal status', () => {
    // A completed task that turns out to be wrong is re-assigned, not re-opened: its evidence and
    // timestamps are what a performance record reads.
    assert.deepEqual([...ALLOWED_HUMAN_TASK_TRANSITIONS.Completed], []);
    assert.deepEqual([...ALLOWED_HUMAN_TASK_TRANSITIONS.Cancelled], []);
  });

  it('lets waiting work resume, because the thing it waited for can arrive', () => {
    assert.ok(mayMoveHumanTask('Blocked', 'InProgress'));
    assert.ok(mayMoveHumanTask('NeedsInput', 'InProgress'));
    assert.ok(mayMoveHumanTask('WaitingApproval', 'InProgress'));
  });

  it('offers a waiting step nothing but cancellation', () => {
    /*
     * The whole enforcement in one assertion.
     *
     * If any other move out of Waiting were permitted, the person the step is assigned to could
     * start work the plan says is not startable, and the dependency would be a decoration.
     */
    assert.deepEqual([...ALLOWED_HUMAN_TASK_TRANSITIONS.Waiting], ['Cancelled']);
    assert.ok(!mayMoveHumanTask('Waiting', 'InProgress'));
    assert.ok(!mayMoveHumanTask('Waiting', 'Assigned'));
    assert.ok(!mayMoveHumanTask('Waiting', 'Submitted'));
    assert.ok(!mayMoveHumanTask('Waiting', 'Completed'));
  });

  it('refuses to submit a step that is still waiting on another one', () => {
    const problems = validateTaskSubmission({
      status: 'Waiting',
      evidenceRequirement: '',
      evidenceCount: 0,
      blockedReason: null,
    });
    assert.ok(problems.length > 0);
    assert.match(problems.join(' '), /cannot be submitted/);
  });

  it('never calls a waiting step late', () => {
    /*
     * The product refuses to let this person start the task. Reporting them as overdue for not
     * having started it would be blaming somebody for obeying a rule the product enforced — and
     * this number is read as an individual's record.
     */
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    assert.equal(isHumanTaskOverdue({ status: 'Waiting', dueAt: yesterday }), false);
    // The same task, once it is theirs to do, is late like any other.
    assert.equal(isHumanTaskOverdue({ status: 'Assigned', dueAt: yesterday }), true);
  });

  it('releases only from Waiting', () => {
    assert.ok(mayReleaseHumanTask('Waiting'));
    for (const status of HUMAN_TASK_STATUSES) {
      if (status === 'Waiting') continue;
      assert.ok(!mayReleaseHumanTask(status), status);
    }
  });

  it('lets a submission be sent back for more work', () => {
    assert.ok(mayMoveHumanTask('Submitted', 'InProgress'));
  });

  it('refuses a jump straight from Assigned to Completed', () => {
    // Completing work nobody started is the shape of a mis-click or a script, not of work.
    assert.ok(!mayMoveHumanTask('Assigned', 'Completed'));
  });

  it('waits while any planned dependency is unfinished', () => {
    const planned = new Set(['engine', 'sub-engine', 'executor']);
    assert.ok(!dependenciesSatisfied(['engine'], new Set(), planned));
    assert.ok(dependenciesSatisfied(['engine'], new Set(['engine']), planned));
    // Two dependencies, one done: still waiting. Partial is not satisfied.
    assert.ok(!dependenciesSatisfied(['engine', 'sub-engine'], new Set(['engine']), planned));
    assert.ok(
      dependenciesSatisfied(['engine', 'sub-engine'], new Set(['engine', 'sub-engine']), planned),
    );
  });

  it('starts a step with no dependencies at all', () => {
    assert.ok(dependenciesSatisfied([], new Set(), new Set(['engine'])));
  });

  it('does not wait for a node the plan does not contain', () => {
    /*
     * A dependency naming a step that was deleted, or a Goal or Condition that produces no work,
     * is satisfied rather than pending. The alternative is a task nothing in the world can ever
     * release, which is a worse failure than starting slightly early.
     */
    assert.ok(dependenciesSatisfied(['a-deleted-step'], new Set(), new Set(['engine'])));
  });

  it('names only statuses that exist in every transition list', () => {
    for (const status of HUMAN_TASK_STATUSES) {
      for (const next of ALLOWED_HUMAN_TASK_TRANSITIONS[status]) {
        assert.ok(HUMAN_TASK_STATUSES.includes(next), `${status} -> ${next}`);
      }
    }
  });

  it('never lets a status transition to itself', () => {
    for (const status of HUMAN_TASK_STATUSES) {
      assert.ok(!ALLOWED_HUMAN_TASK_TRANSITIONS[status].includes(status), status);
    }
  });
});

describe('isHumanTaskOverdue', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const past = new Date('2026-09-09T12:00:00Z');
  const future = new Date('2026-09-11T12:00:00Z');

  it('is late when the due time has passed', () => {
    assert.equal(isHumanTaskOverdue({ status: 'InProgress', dueAt: past }, now), true);
  });

  it('is not late before the due time', () => {
    assert.equal(isHumanTaskOverdue({ status: 'InProgress', dueAt: future }, now), false);
  });

  it('is never late with no due time', () => {
    // Plenty of real work is triggered by an event rather than a clock. Reporting "overdue"
    // against a date nobody set would be noise, and noise is what makes people stop reading.
    assert.equal(isHumanTaskOverdue({ status: 'InProgress', dueAt: null }, now), false);
  });

  it('is never late once finished, however late it actually was', () => {
    // That belongs to the completion record, not to a list of things needing attention now.
    assert.equal(isHumanTaskOverdue({ status: 'Completed', dueAt: past }, now), false);
    assert.equal(isHumanTaskOverdue({ status: 'Cancelled', dueAt: past }, now), false);
  });

  it('accepts an ISO string, which is what an API response carries', () => {
    assert.equal(isHumanTaskOverdue({ status: 'Assigned', dueAt: past.toISOString() }, now), true);
  });

  it('is not late exactly at the due moment', () => {
    assert.equal(isHumanTaskOverdue({ status: 'Assigned', dueAt: now }, now), false);
  });
});

describe('humanTaskDisplayStatus', () => {
  const now = new Date('2026-09-10T12:00:00Z');

  it('shows Overdue for a late task, because that is the fact that matters most', () => {
    const shown = humanTaskDisplayStatus(
      { status: 'InProgress', dueAt: new Date(now.getTime() - HOUR) },
      now,
    );
    assert.equal(shown.status, 'Overdue');
    assert.equal(shown.tone, 'danger');
  });

  it('shows the stored status otherwise', () => {
    const shown = humanTaskDisplayStatus({ status: 'NeedsInput', dueAt: null }, now);
    assert.equal(shown.status, 'Needs input');
    assert.equal(shown.tone, HUMAN_TASK_STATUS_TONES.NeedsInput);
  });

  it('shows a completed task as completed even if it finished late', () => {
    const shown = humanTaskDisplayStatus(
      { status: 'Completed', dueAt: new Date(now.getTime() - HOUR) },
      now,
    );
    assert.equal(shown.status, 'Completed');
  });
});

describe('validateTaskSubmission', () => {
  const base = {
    status: 'InProgress' as HumanTaskStatus,
    evidenceRequirement: '',
    evidenceCount: 0,
    blockedReason: null,
  };

  it('accepts a task in progress with nothing required', () => {
    assert.deepEqual(validateTaskSubmission(base), []);
  });

  it('refuses a submission with no evidence when the step required some', () => {
    // Refused here rather than accepted and flagged later: the person is right there and can
    // attach the file. The Executor Agent's "Missing Completion Evidence" exception is what this
    // prevents.
    const problems = validateTaskSubmission({
      ...base,
      evidenceRequirement: 'The signed checklist.',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /signed checklist/);
  });

  it('accepts a submission once evidence is attached', () => {
    assert.deepEqual(
      validateTaskSubmission({
        ...base,
        evidenceRequirement: 'The signed checklist.',
        evidenceCount: 1,
      }),
      [],
    );
  });

  it('ignores a whitespace-only evidence requirement', () => {
    // A requirement of "   " is a field somebody tabbed through, not a rule.
    assert.deepEqual(validateTaskSubmission({ ...base, evidenceRequirement: '   ' }), []);
  });

  it('refuses while a blocker still stands, and quotes it', () => {
    const problems = validateTaskSubmission({
      ...base,
      blockedReason: 'Waiting on the lab report',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /lab report/);
  });

  it('refuses from a status that cannot submit, and says what can be done instead', () => {
    const problems = validateTaskSubmission({ ...base, status: 'Completed' });
    assert.ok(problems.length >= 1);
    assert.match(problems[0] ?? '', /cannot be submitted/);
  });

  it('reports every problem at once', () => {
    // A person fixing one refusal at a time is being told the truth in instalments.
    const problems = validateTaskSubmission({
      status: 'Completed',
      evidenceRequirement: 'The signed checklist.',
      evidenceCount: 0,
      blockedReason: 'Waiting on the lab report',
    });
    assert.equal(problems.length, 3);
  });
});

describe('the approvals vocabulary', () => {
  it('carries the Approval Engine prompt’s full list, so there is never a second table', () => {
    for (const type of [
      'ObjectiveReview',
      'WorkflowPublish',
      'AgentActivation',
      'HighRiskAction',
      'OutputApproval',
      'BudgetOverride',
      'GuestAccess',
    ] as const) {
      assert.ok(APPROVAL_REQUEST_TYPES.includes(type), type);
    }
  });

  it('labels every type and every status', () => {
    for (const type of APPROVAL_REQUEST_TYPES) {
      assert.ok(APPROVAL_REQUEST_TYPE_LABELS[type]?.trim(), type);
    }
    for (const status of APPROVAL_REQUEST_STATUSES) {
      assert.ok(APPROVAL_REQUEST_STATUS_LABELS[status]?.trim(), status);
    }
  });

  it('lets a sent-back request come round again', () => {
    // Sending back asks for changes; it is not a refusal.
    assert.ok(mayMoveApproval('SentBack', 'Pending'));
  });

  it('makes a rejection terminal', () => {
    // A rejection that could be quietly re-decided would make the record meaningless.
    assert.deepEqual([...ALLOWED_APPROVAL_TRANSITIONS.Rejected], []);
    assert.ok(!mayMoveApproval('Rejected', 'Approved'));
  });

  it('makes an approval terminal too', () => {
    assert.deepEqual([...ALLOWED_APPROVAL_TRANSITIONS.Approved], []);
  });

  it('names only statuses that exist', () => {
    for (const status of APPROVAL_REQUEST_STATUSES) {
      for (const next of ALLOWED_APPROVAL_TRANSITIONS[status]) {
        assert.ok(APPROVAL_REQUEST_STATUSES.includes(next), `${status} -> ${next}`);
      }
    }
  });
});

describe('executor expectations', () => {
  it('are named after the Executor Agent prompt’s own exception types', () => {
    // So that prompt reads these rather than deriving a second list from the workflow.
    assert.deepEqual(
      [...EXECUTOR_EXPECTATION_KINDS],
      ['HumanTaskOverdue', 'MissingCompletionEvidence', 'ApprovalPending', 'ConnectionRequired'],
    );
  });

  it('label every kind', () => {
    for (const kind of EXECUTOR_EXPECTATION_KINDS) {
      assert.ok(EXECUTOR_EXPECTATION_LABELS[kind]?.trim(), kind);
    }
  });
});

describe('the publish gate', () => {
  it('covers the client’s seven named checks', () => {
    assert.equal(ASSIGNMENT_CHECKS.length, 7);
    for (const check of ASSIGNMENT_CHECKS) {
      assert.ok(ASSIGNMENT_CHECK_LABELS[check]?.trim(), check);
    }
  });
});

describe('task notes', () => {
  it('keeps a comment and a clarification apart', () => {
    // A clarification is a question somebody is waiting on an answer to, and that is what makes
    // a task visibly stalled rather than merely quiet.
    assert.deepEqual([...TASK_NOTE_KINDS], ['Comment', 'Clarification']);
  });
});

describe('asking for a change', () => {
  it('offers the client’s six kinds and no more', () => {
    assert.deepEqual(
      [...CHANGE_REQUEST_KINDS],
      ['Hierarchy', 'Objective', 'WorkReassignment', 'AgentCorrection', 'Access', 'Other'],
    );
    for (const kind of CHANGE_REQUEST_KINDS) {
      assert.ok(CHANGE_REQUEST_KIND_LABELS[kind].length > 0, kind);
    }
  });

  it('keeps an escape hatch, so the other five stay meaningful', () => {
    /*
     * A closed list with nowhere to put an odd request teaches people to file everything under
     * whichever option is nearest, and then none of the categories describes anything.
     */
    assert.deepEqual(changeRequestProblems({ kind: 'Other', reason: 'The rota is wrong again.' }), []);
  });

  it('refuses a kind nobody asked about', () => {
    const problems = changeRequestProblems({ kind: 'Salary', reason: 'A perfectly good reason.' });
    assert.ok(problems.some((problem) => /not a kind of change/i.test(problem)));
  });

  it('refuses a reason nobody could act on', () => {
    // Somebody has to decide this, and "fix it" is not a thing anybody can decide.
    for (const reason of ['', '   ', 'fix it']) {
      const problems = changeRequestProblems({ kind: 'Access', reason });
      assert.ok(problems.length > 0, JSON.stringify(reason));
    }
  });

  it('accepts a short but real reason', () => {
    assert.deepEqual(
      changeRequestProblems({ kind: 'Access', reason: 'Cannot open the Field Ops workshop.' }),
      [],
    );
  });

  it('refuses a reason longer than the column holds', () => {
    const problems = changeRequestProblems({
      kind: 'Other',
      reason: 'x'.repeat(MAX_CHANGE_REQUEST_REASON + 1),
    });
    assert.ok(problems.length > 0);
  });

  it('is an approval like every other, so deciding it is somebody’s authority', () => {
    /*
     * The client's rule: "Do not give the employee direct configuration power simply because they
     * requested a change." Filing one creates an ApprovalRequest, and an ApprovalRequest changes
     * nothing until it is decided — which is why this is a type here rather than a table of its
     * own with its own idea of who may act on it.
     */
    assert.ok((APPROVAL_REQUEST_TYPES as readonly string[]).includes('ChangeRequest'));
    assert.ok(APPROVAL_REQUEST_TYPE_LABELS.ChangeRequest.length > 0);
  });
});
