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

  it('lets a submission be sent back for more work', () => {
    assert.ok(mayMoveHumanTask('Submitted', 'InProgress'));
  });

  it('refuses a jump straight from Assigned to Completed', () => {
    // Completing work nobody started is the shape of a mis-click or a script, not of work.
    assert.ok(!mayMoveHumanTask('Assigned', 'Completed'));
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
