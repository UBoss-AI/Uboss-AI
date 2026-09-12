import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGING_BUCKET_TONES,
  AGING_BUCKETS,
  agingBucketFor,
  APPROVAL_DECISION_LABELS,
  APPROVAL_DECISIONS,
  APPROVAL_TYPE_MODULE,
  approvalEscalationDue,
  DECISION_RESULT,
  decisionNeedsReason,
  decisionSettlesRequest,
  delegationCovers,
  everyApprovalTypeIsDecidable,
  FOUR_EYES_APPROVAL_KIND,
  isAddressedTo,
  MAX_DELEGATION_DAYS,
  requiredSodRule,
  routingFor,
  validateDelegation,
} from './approvals.js';
import { APPROVAL_REQUEST_STATUSES, APPROVAL_REQUEST_TYPES } from './assignments.js';
import { COMPANY_MODULES, ROLE_KINDS } from './authorization.js';
import { ROLE_TEMPLATES } from './role-templates.js';
import { STEP_APPROVAL_KINDS } from './objectives.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('approval decisions', () => {
  it('labels every decision', () => {
    for (const decision of APPROVAL_DECISIONS) {
      assert.equal(typeof APPROVAL_DECISION_LABELS[decision], 'string');
    }
  });

  it('maps every settling decision onto a real request status', () => {
    for (const decision of APPROVAL_DECISIONS) {
      const result = DECISION_RESULT[decision];
      if (result === null) continue;
      assert.ok(
        (APPROVAL_REQUEST_STATUSES as readonly string[]).includes(result),
        `${decision} settles into ${result}, which is not an approval status`,
      );
    }
  });

  it('treats a comment as leaving the request open', () => {
    assert.equal(decisionSettlesRequest('Comment'), false);
    assert.equal(DECISION_RESULT.Comment, null);
  });

  it('settles on approve, reject and send back', () => {
    assert.equal(decisionSettlesRequest('Approve'), true);
    assert.equal(decisionSettlesRequest('Reject'), true);
    assert.equal(decisionSettlesRequest('SendBack'), true);
  });

  it('keeps send back distinct from reject', () => {
    // The client lists both, and they lead to different next steps: sent back is resubmittable,
    // rejected is not.
    assert.notEqual(DECISION_RESULT.SendBack, DECISION_RESULT.Reject);
  });

  it('requires a reason for a refusal but not for an approval', () => {
    assert.equal(decisionNeedsReason('Reject'), true);
    assert.equal(decisionNeedsReason('SendBack'), true);
    assert.equal(decisionNeedsReason('Approve'), false);
  });
});

describe('approval type to module mapping', () => {
  it('governs every approval type by exactly one real company module', () => {
    for (const type of APPROVAL_REQUEST_TYPES) {
      const module = APPROVAL_TYPE_MODULE[type];
      assert.ok(module !== undefined, `${type} has no governing module`);
      assert.ok(
        (COMPANY_MODULES as readonly string[]).includes(module),
        `${type} maps to ${module}, which is not a company module`,
      );
    }
  });

  it('leaves no approval type that nobody can decide', () => {
    // The failure this caught on the first attempt: WorkflowStepApproval pointed at `todo`,
    // OutputApproval at `executor` and GuestAccess at `users` — and no built-in role holds
    // Approve on any of those three. Those requests could be raised and never decided.
    const outcome = everyApprovalTypeIsDecidable(ROLE_TEMPLATES);
    assert.deepEqual(outcome.undecidable, []);
    assert.equal(outcome.ok, true);
  });

  it('reports an undecidable mapping rather than passing quietly', () => {
    // Proves the invariant can actually fail, so a green result means something.
    const noApproveAnywhere = {
      Nobody: { permissions: { objective: ['View'], agents: ['View'], approvals: ['View'] } },
    };
    const outcome = everyApprovalTypeIsDecidable(noApproveAnywhere);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.undecidable.length, 8);
  });
  it('does not govern everything by the approvals module', () => {
    // Otherwise one Approve grant on `approvals` would let an expense approver publish a
    // workflow, which is far broader than the role templates intend.
    const distinct = new Set(Object.values(APPROVAL_TYPE_MODULE));
    assert.ok(distinct.size > 1);
    assert.equal(APPROVAL_TYPE_MODULE.WorkflowPublish, 'objective');
    assert.equal(APPROVAL_TYPE_MODULE.AgentActivation, 'agents');
  });
});

describe('routing: who a request is addressed to', () => {
  const base = {
    actorUserId: 'approver',
    actorRoleKinds: ['Manager'] as const,
  };

  it('refuses a request that is already decided', () => {
    for (const status of APPROVAL_REQUEST_STATUSES) {
      const outcome = isAddressedTo({
        ...base,
        status,
        namedApproverUserId: 'approver',
        approverRoleKind: null,
      });
      assert.equal(outcome.addressed, status === 'Pending');
    }
  });

  it('says an immutable record cannot be decided twice', () => {
    const outcome = isAddressedTo({
      ...base,
      status: 'Approved',
      namedApproverUserId: 'approver',
      approverRoleKind: null,
    });
    assert.match(outcome.reason, /immutable/i);
  });

  it('addresses a named approver', () => {
    const outcome = isAddressedTo({
      ...base,
      status: 'Pending',
      namedApproverUserId: 'approver',
      approverRoleKind: null,
    });
    assert.equal(outcome.addressed, true);
  });

  it('excludes everybody else when a request names an approver', () => {
    const outcome = isAddressedTo({
      ...base,
      actorUserId: 'somebody-else',
      status: 'Pending',
      namedApproverUserId: 'approver',
      approverRoleKind: null,
    });
    assert.equal(outcome.addressed, false);
    assert.match(outcome.reason, /names a different approver/i);
  });

  it('lets a delegate stand in for the named approver', () => {
    const outcome = isAddressedTo({
      ...base,
      actorUserId: 'stand-in',
      status: 'Pending',
      namedApproverUserId: 'approver',
      approverRoleKind: null,
      delegatedFromUserId: 'approver',
    });
    assert.equal(outcome.addressed, true);
    assert.match(outcome.reason, /delegated/i);
  });

  it('does not let a delegation from a third party open an unrelated request', () => {
    const outcome = isAddressedTo({
      ...base,
      actorUserId: 'stand-in',
      status: 'Pending',
      namedApproverUserId: 'approver',
      approverRoleKind: null,
      // A real delegation, but from a person this request was not addressed to.
      delegatedFromUserId: 'an-unrelated-head',
    });
    assert.equal(outcome.addressed, false);
  });

  it('addresses a role-addressed request to anyone holding the role', () => {
    const outcome = isAddressedTo({
      ...base,
      status: 'Pending',
      namedApproverUserId: null,
      approverRoleKind: 'Manager',
    });
    assert.equal(outcome.addressed, true);
  });

  it('refuses a role-addressed request from somebody without the role', () => {
    const outcome = isAddressedTo({
      ...base,
      actorRoleKinds: ['Employee'],
      status: 'Pending',
      namedApproverUserId: null,
      approverRoleKind: 'Head',
    });
    assert.equal(outcome.addressed, false);
    assert.match(outcome.reason, /Head/);
  });

  it('falls closed on a request addressed to nobody at all', () => {
    // Open season on a misconfigured row would be the worst possible reading of it.
    const outcome = isAddressedTo({
      ...base,
      status: 'Pending',
      namedApproverUserId: null,
      approverRoleKind: null,
    });
    assert.equal(outcome.addressed, false);
    assert.match(outcome.reason, /misconfigured/i);
  });

  it('has no opinion on self-approval, which the authorization engine owns', () => {
    // The requester being the actor is *not* refused here: the mandatory platform NoSelfApproval
    // control in checkSeparationOfDuties is the single place that decides it. If this ever starts
    // refusing too, there are two answers to one question.
    const outcome = isAddressedTo({
      actorUserId: 'author',
      actorRoleKinds: ['Manager'],
      status: 'Pending',
      namedApproverUserId: 'author',
      approverRoleKind: null,
    });
    assert.equal(outcome.addressed, true);
  });
});

describe('routing a step approval kind', () => {
  it('reads every step approval kind that reaches the column', () => {
    // Prompt 23 writes the step's approvalKind straight into approver_role_kind for every kind
    // except NotRequired, so each of those has to route to something decidable.
    for (const kind of STEP_APPROVAL_KINDS) {
      if (kind === 'NotRequired') continue;
      const routing = routingFor({ namedApproverUserId: null, approverRoleKind: kind });
      assert.notEqual(
        routing.kind,
        'Unaddressed',
        `a step asking for ${kind} produced an undecidable request`,
      );
    }
  });

  it('does not read FourEyes as a role, which would deadlock the gate', () => {
    assert.ok(!(ROLE_KINDS as readonly string[]).includes(FOUR_EYES_APPROVAL_KIND));
    const routing = routingFor({
      namedApproverUserId: null,
      approverRoleKind: FOUR_EYES_APPROVAL_KIND,
    });
    assert.equal(routing.kind, 'FourEyes');
  });

  it('addresses a four-eyes gate to any authorized approver', () => {
    const outcome = isAddressedTo({
      status: 'Pending',
      namedApproverUserId: null,
      approverRoleKind: FOUR_EYES_APPROVAL_KIND,
      actorUserId: 'anyone',
      actorRoleKinds: ['Manager'],
    });
    assert.equal(outcome.addressed, true);
  });

  it('carries a four-eyes control on the request itself', () => {
    // So a step that asked for one gets one whether or not the company configured a policy.
    assert.equal(requiredSodRule({ approverRoleKind: FOUR_EYES_APPROVAL_KIND }), 'FourEyes');
    assert.equal(requiredSodRule({ approverRoleKind: 'Manager' }), null);
    assert.equal(requiredSodRule({ approverRoleKind: null }), null);
  });

  it('prefers a named approver over a role', () => {
    const routing = routingFor({ namedApproverUserId: 'owner', approverRoleKind: 'Head' });
    assert.deepEqual(routing, { kind: 'Named', userId: 'owner' });
  });

  it('treats an unrecognised role kind as unaddressed rather than as a role', () => {
    const routing = routingFor({ namedApproverUserId: null, approverRoleKind: 'ChiefOfVibes' });
    assert.equal(routing.kind, 'Unaddressed');
  });
});

describe('out-of-office delegation', () => {
  const window = {
    types: null,
    startsAt: new Date('2026-09-01T00:00:00Z').toISOString(),
    endsAt: new Date('2026-09-10T00:00:00Z').toISOString(),
    revokedAt: null,
  };

  it('covers a request inside its window', () => {
    assert.equal(
      delegationCovers({
        delegation: window,
        type: 'WorkflowPublish',
        at: new Date('2026-09-05T00:00:00Z'),
      }),
      true,
    );
  });

  it('does not cover before it starts or after it ends', () => {
    assert.equal(
      delegationCovers({
        delegation: window,
        type: 'WorkflowPublish',
        at: new Date('2026-08-31T23:00:00Z'),
      }),
      false,
    );
    assert.equal(
      delegationCovers({
        delegation: window,
        type: 'WorkflowPublish',
        at: new Date('2026-09-10T00:01:00Z'),
      }),
      false,
    );
  });

  it('stops the moment it is revoked, not at its end date', () => {
    assert.equal(
      delegationCovers({
        delegation: { ...window, revokedAt: new Date('2026-09-03T00:00:00Z').toISOString() },
        type: 'WorkflowPublish',
        at: new Date('2026-09-05T00:00:00Z'),
      }),
      false,
    );
  });

  it('honours a type-scoped delegation', () => {
    const scoped = { ...window, types: ['BudgetOverride'] as const };
    assert.equal(
      delegationCovers({
        delegation: scoped,
        type: 'BudgetOverride',
        at: new Date('2026-09-05T00:00:00Z'),
      }),
      true,
    );
    assert.equal(
      delegationCovers({
        delegation: scoped,
        type: 'AgentActivation',
        at: new Date('2026-09-05T00:00:00Z'),
      }),
      false,
    );
  });

  it('refuses a delegation to yourself', () => {
    const outcome = validateDelegation({
      fromUserId: 'same',
      toUserId: 'same',
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-09-05T00:00:00Z'),
      reason: 'Leave',
    });
    assert.equal(outcome.ok, false);
  });

  it('refuses a window that covers no time', () => {
    const outcome = validateDelegation({
      fromUserId: 'a',
      toUserId: 'b',
      startsAt: new Date('2026-09-05T00:00:00Z'),
      endsAt: new Date('2026-09-01T00:00:00Z'),
      reason: 'Leave',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.reason : '', /end after it starts/i);
  });

  it('refuses an open-ended delegation dressed up as out-of-office', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const outcome = validateDelegation({
      fromUserId: 'a',
      toUserId: 'b',
      startsAt: start,
      endsAt: new Date(start.getTime() + (MAX_DELEGATION_DAYS + 1) * DAY),
      reason: 'Indefinite',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.reason : '', /reassignment of authority/i);
  });

  it('accepts a delegation right up to the ceiling', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const outcome = validateDelegation({
      fromUserId: 'a',
      toUserId: 'b',
      startsAt: start,
      endsAt: new Date(start.getTime() + MAX_DELEGATION_DAYS * DAY),
      reason: 'Sabbatical',
    });
    assert.equal(outcome.ok, true);
  });

  it('requires a reason', () => {
    const outcome = validateDelegation({
      fromUserId: 'a',
      toUserId: 'b',
      startsAt: new Date('2026-09-01T00:00:00Z'),
      endsAt: new Date('2026-09-05T00:00:00Z'),
      reason: '   ',
    });
    assert.equal(outcome.ok, false);
  });
});

describe('aging', () => {
  const now = new Date('2026-09-10T12:00:00Z');

  it('tones every bucket', () => {
    for (const bucket of AGING_BUCKETS) {
      assert.ok(AGING_BUCKET_TONES[bucket]);
    }
  });

  it('calls a young request fresh', () => {
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 2 * HOUR),
      dueAt: null,
      now,
    });
    assert.equal(outcome.bucket, 'Fresh');
  });

  it('calls an undecided day-old request aging', () => {
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 25 * HOUR),
      dueAt: null,
      now,
    });
    assert.equal(outcome.bucket, 'Aging');
  });

  it('never calls a request with no due date overdue', () => {
    // Reporting it late against a deadline nobody set would be an invention, and it would make
    // the queue's most urgent colour meaningless.
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 400 * HOUR),
      dueAt: null,
      now,
    });
    assert.equal(outcome.bucket, 'Aging');
  });

  it('calls a request due within a day due', () => {
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 1 * HOUR),
      dueAt: new Date(now.getTime() + 6 * HOUR),
      now,
    });
    assert.equal(outcome.bucket, 'Due');
  });

  it('calls a request past its due date overdue', () => {
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 50 * HOUR),
      dueAt: new Date(now.getTime() - 1 * HOUR),
      now,
    });
    assert.equal(outcome.bucket, 'Overdue');
  });

  it('reports how long it has been open', () => {
    const outcome = agingBucketFor({
      submittedAt: new Date(now.getTime() - 10 * HOUR),
      dueAt: null,
      now,
    });
    assert.equal(Math.round(outcome.hoursOpen), 10);
  });

  it('honours a configured aging threshold', () => {
    const submittedAt = new Date(now.getTime() - 5 * HOUR);
    assert.equal(agingBucketFor({ submittedAt, dueAt: null, now }).bucket, 'Fresh');
    assert.equal(
      agingBucketFor({ submittedAt, dueAt: null, now, agingAfterHours: 4 }).bucket,
      'Aging',
    );
  });
});

describe('escalation', () => {
  it('escalates an overdue pending request once', () => {
    const outcome = approvalEscalationDue({
      status: 'Pending',
      bucket: 'Overdue',
      alreadyEscalated: false,
    });
    assert.equal(outcome.due, true);
  });

  it('does not escalate twice', () => {
    const outcome = approvalEscalationDue({
      status: 'Pending',
      bucket: 'Overdue',
      alreadyEscalated: true,
    });
    assert.equal(outcome.due, false);
  });

  it('does not escalate on age alone', () => {
    for (const bucket of ['Fresh', 'Aging', 'Due'] as const) {
      const outcome = approvalEscalationDue({
        status: 'Pending',
        bucket,
        alreadyEscalated: false,
      });
      assert.equal(outcome.due, false, `${bucket} should not escalate`);
    }
  });

  it('does not escalate a decided request', () => {
    const outcome = approvalEscalationDue({
      status: 'Approved',
      bucket: 'Overdue',
      alreadyEscalated: false,
    });
    assert.equal(outcome.due, false);
  });
});
