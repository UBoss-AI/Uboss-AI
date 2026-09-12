/**
 * The Approval Engine — Prompt 28.
 *
 * ## One table, across every domain
 *
 * The client's own constraint: approvals must work "without duplicating separate approval tables
 * per module". `APPROVAL_REQUEST_TYPES` was therefore declared in full at Prompt 23, the prompt
 * that first needed a queue, so that this prompt *extends* one table rather than introducing a
 * second. Objective review, workflow publish, agent activation, high-risk actions, output
 * approval, budget override and guest access all live in the same rows with the same lifecycle.
 *
 * ## Separation of duties lives in the authorization engine, not here
 *
 * The temptation was to write a self-approval check in this file. That would have been a second
 * policy engine. `checkSeparationOfDuties` in `scope-evaluation.ts` already does it, the Prompt 7
 * migration already seeds a **mandatory platform-wide `NoSelfApproval` control on `Approve`**, and
 * the authorization service already records a security event when one bites.
 *
 * So the division is:
 *
 *   * **`authorize({ module, action: 'Approve', resource })`** decides whether this person may
 *     decide this thing — role, scope, policy layers, and separation of duties. The approval
 *     service feeds it `createdByUserId` (the requester) and `priorActorUserIds` (everyone in the
 *     decision history), which is what makes both `NoSelfApproval` and `FourEyes` work on an
 *     approval request without either rule being restated here.
 *   * **This file** decides everything about *routing and timing* that the authorization engine
 *     has no opinion on: whether the request is still open, whether it names an approver, whether
 *     a delegation stands in for that approver right now, and whether it has waited long enough
 *     to escalate.
 *
 * Every decision — approve, reject, send back — exercises the same `Approve` action on the same
 * module, so one SoD control covers all three. Rejecting is as much an exercise of the decision
 * right as approving, and a person who may not approve their own work may not dispose of it by
 * rejecting it either.
 */

import { isRoleKind } from './authorization.js';
import type { CompanyModuleKey, RoleKind } from './authorization.js';
import type { ApprovalRequestType } from './assignments.js';

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** What an approver can do with a request. */
export const APPROVAL_DECISIONS = ['Approve', 'Reject', 'SendBack', 'Comment'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_DECISION_LABELS: Record<ApprovalDecision, string> = {
  Approve: 'Approve',
  Reject: 'Reject',
  SendBack: 'Send back',
  Comment: 'Comment',
};

/**
 * The status each decision leaves behind, or `null` for one that leaves the request open.
 *
 * `SendBack` settles the request but is not a rejection: the work returns to its author to be
 * changed and resubmitted, which is a different outcome with a different next step, and the reason
 * the client lists both.
 */
export const DECISION_RESULT: Record<ApprovalDecision, string | null> = {
  Approve: 'Approved',
  Reject: 'Rejected',
  SendBack: 'SentBack',
  Comment: null,
};

export function decisionSettlesRequest(decision: ApprovalDecision): boolean {
  return DECISION_RESULT[decision] !== null;
}

/**
 * Whether a decision must carry a reason.
 *
 * A refusal without a stated reason is unactionable — the author cannot tell what to change — so
 * `Reject` and `SendBack` require one. An approval does not: "approved" is complete on its own.
 */
export function decisionNeedsReason(decision: ApprovalDecision): boolean {
  return decision === 'Reject' || decision === 'SendBack';
}

/**
 * Which module governs each approval type — which is to say, which module's `Approve` permission
 * a person must hold to decide it.
 *
 * Domain-specific where the domain actually has approvers, generic where it does not, and that
 * distinction is not a preference. `ROLE_TEMPLATES` grants `Approve` on only three company
 * modules: `objective`, `agent-builder` and `agents` (the `Approver` role), plus `approvals`
 * itself (`Approver` and `Head`). Nothing anywhere grants `todo:Approve`, `executor:Approve` or
 * `users:Approve`.
 *
 * So mapping a workflow step gate onto `todo`, an output approval onto `executor`, or a guest
 * access request onto `users` would make those three types **undecidable by anybody** — the
 * request would sit in the queue forever and every approver would be told their role does not
 * include Approve. They are governed by `approvals`, where `Head` and `Approver` can actually
 * decide them.
 *
 * The remaining three keep their domain: an objective review or workflow publish needs
 * `objective:Approve`, an agent activation needs `agents:Approve`. That matters — without it, one
 * `approvals:Approve` grant would let whoever signs off expenses also publish a workflow.
 *
 * `everyApprovalTypeIsDecidable` is the invariant that keeps this honest, and it is asserted in
 * the tests rather than trusted.
 */
export const APPROVAL_TYPE_MODULE: Record<ApprovalRequestType, CompanyModuleKey> = {
  ObjectiveReview: 'objective',
  WorkflowPublish: 'objective',
  AgentActivation: 'agents',
  // Generic, because no role holds Approve on todo, executor or users.
  WorkflowStepApproval: 'approvals',
  OutputApproval: 'approvals',
  HighRiskAction: 'approvals',
  BudgetOverride: 'approvals',
  GuestAccess: 'approvals',
};

/**
 * Every approval type must be decidable by at least one built-in role.
 *
 * A guard against the failure this mapping had on its first attempt: three types pointed at
 * modules nobody can approve on, so those requests could be raised and never decided. That is
 * invisible in the type system, invisible in review, and only shows up as a stuck queue in
 * production — so it is asserted as an invariant against the real role templates instead.
 */
export function everyApprovalTypeIsDecidable(
  templates: Record<string, { permissions: Record<string, readonly string[] | undefined> }>,
): { ok: boolean; undecidable: { type: string; module: string }[] } {
  const undecidable: { type: string; module: string }[] = [];

  for (const [type, module] of Object.entries(APPROVAL_TYPE_MODULE)) {
    const someRoleCanApprove = Object.values(templates).some((template) =>
      (template.permissions[module] ?? []).includes('Approve'),
    );
    if (!someRoleCanApprove) {
      undecidable.push({ type, module });
    }
  }

  return { ok: undecidable.length === 0, undecidable };
}

// ---------------------------------------------------------------------------
// Routing: who this request is addressed to
// ---------------------------------------------------------------------------

/**
 * How a request is addressed.
 *
 * `FourEyes` is the one that is not obvious, and it is not an invention here: `STEP_APPROVAL_KINDS`
 * in `objectives.ts` is `['NotRequired', 'Manager', 'Head', 'FourEyes']`, and Prompt 23 writes
 * that value straight into `approver_role_kind` when a workflow step asks for a four-eyes gate.
 * So the column holds a role kind *or* the word `FourEyes`, which is not a role anybody holds.
 *
 * Reading it as a role would deadlock every four-eyes gate in the product — the request would be
 * addressed to a role with no members and could never be decided. It means something different:
 * no particular role, but a second pair of eyes is mandatory. `requiredSodRule` is how that
 * becomes enforceable.
 */
export type ApprovalRouting =
  | { kind: 'Named'; userId: string }
  | { kind: 'Role'; role: RoleKind }
  | { kind: 'FourEyes' }
  | { kind: 'Unaddressed' };

/** The word a workflow step uses for a four-eyes gate, from `STEP_APPROVAL_KINDS`. */
export const FOUR_EYES_APPROVAL_KIND = 'FourEyes';

/**
 * How this request is addressed, from the two columns that carry it.
 *
 * A named approver wins over a role: naming a person is the more specific instruction, and the
 * Prompt 23 assignment path sets both when a step has an owner and an approval kind.
 */
export function routingFor(input: {
  namedApproverUserId: string | null;
  /** A `RoleKind`, or the literal `FourEyes` from `STEP_APPROVAL_KINDS`. */
  approverRoleKind: string | null;
}): ApprovalRouting {
  if (input.namedApproverUserId !== null) {
    return { kind: 'Named', userId: input.namedApproverUserId };
  }

  if (input.approverRoleKind === FOUR_EYES_APPROVAL_KIND) {
    return { kind: 'FourEyes' };
  }

  if (input.approverRoleKind !== null && isRoleKind(input.approverRoleKind)) {
    return { kind: 'Role', role: input.approverRoleKind };
  }

  return { kind: 'Unaddressed' };
}

/**
 * The separation-of-duties control this request carries in its own right, on top of whatever the
 * company has configured.
 *
 * A step that asked for a four-eyes gate gets one whether or not the company also configured a
 * `FourEyes` policy on the module. The approval service passes this to `checkSeparationOfDuties`
 * as an additional policy rather than implementing the check again — the engine already knows how
 * to refuse an actor who created the thing, an actor nobody else has acted alongside, and an
 * automated agent, and none of that is worth a second implementation.
 */
export function requiredSodRule(input: { approverRoleKind: string | null }): 'FourEyes' | null {
  return input.approverRoleKind === FOUR_EYES_APPROVAL_KIND ? 'FourEyes' : null;
}

/**
 * Whether the request is addressed to this actor at all.
 *
 * Deliberately *not* a permission check and deliberately not a separation-of-duties check — the
 * authorization engine owns both, and duplicating either here would create a second answer to the
 * same question. This answers only: is the request open, and is this person one of the people it
 * was sent to?
 *
 * The refusals:
 *
 *   1. **Already settled.** Deciding it again would overwrite a decision somebody recorded, and
 *      the decision record is immutable by design.
 *   2. **A named approver excludes everybody else.** When a request names a person, routing it to
 *      whoever holds the role would defeat the point of naming one — unless that person has
 *      delegated while away, which is `delegatedFromUserId`.
 *   3. **A role-addressed request needs that role.**
 *   4. **Addressed to nobody** falls closed: a request naming neither a person nor a role nor a
 *      four-eyes gate is misconfigured, not open season.
 *
 * A four-eyes request is addressed to anyone the authorization engine will let approve that
 * module — the control is on *how many distinct people* must act, not on *which* one.
 */
export function isAddressedTo(input: {
  status: string;
  namedApproverUserId: string | null;
  approverRoleKind: string | null;
  actorUserId: string;
  /** The role kinds the actor actually holds, for a role-addressed request. */
  actorRoleKinds: readonly RoleKind[];
  /** Set when the named approver has delegated to this actor for this moment. */
  delegatedFromUserId?: string | null | undefined;
}): { addressed: boolean; reason: string } {
  if (input.status !== 'Pending') {
    return {
      addressed: false,
      reason: `This request is already ${input.status}. Its decision record is immutable.`,
    };
  }

  const routing = routingFor(input);

  switch (routing.kind) {
    case 'Named': {
      if (input.actorUserId === routing.userId) {
        return { addressed: true, reason: 'You are the named approver.' };
      }
      if (input.delegatedFromUserId === routing.userId) {
        return { addressed: true, reason: 'The named approver has delegated to you.' };
      }
      return {
        addressed: false,
        reason:
          'This request names a different approver. Routing it to whoever holds the role would ' +
          'defeat the point of naming one; the named approver can delegate while away.',
      };
    }

    case 'Role': {
      return input.actorRoleKinds.includes(routing.role)
        ? { addressed: true, reason: `You hold the ${routing.role} role it is sent to.` }
        : {
            addressed: false,
            reason: `This request is addressed to a ${routing.role}, which you do not hold.`,
          };
    }

    case 'FourEyes': {
      return {
        addressed: true,
        reason:
          'This is a four-eyes gate, so it is addressed to any authorized approver. The control ' +
          'is on how many distinct people must act, not on which one.',
      };
    }

    default: {
      return {
        addressed: false,
        reason:
          'This request names neither an approver nor a role, so there is nobody it is ' +
          'addressed to. That is a misconfigured request rather than one anybody may decide.',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Out-of-office delegation
// ---------------------------------------------------------------------------

/**
 * One person's temporary delegation of their approval authority.
 *
 * Bounded in time on purpose. An open-ended delegation is indistinguishable from a permanent
 * grant, and the client asked for *out-of-office* delegation — a temporary arrangement with a
 * return date, not a quiet way to reassign authority.
 *
 * A delegation moves *routing*, never authority. The delegate still passes the same authorization
 * check on the same module, and still faces the same separation-of-duties controls. Somebody who
 * cannot approve agent activations does not gain that power by being delegated to, and somebody
 * who wrote the request cannot decide it by having it delegated to them. That is why delegation
 * lives here, with routing, rather than anywhere near the permission engine.
 */
export interface ApprovalDelegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  /** Null means every type. A type-scoped delegation is narrower and therefore safer. */
  types: readonly ApprovalRequestType[] | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  revokedAt: string | null;
}

/**
 * Whether a delegation covers a request type at a moment.
 *
 * A revoked delegation stops applying immediately rather than at its end date: somebody who
 * returns early and revokes it means now.
 */
export function delegationCovers(input: {
  delegation: {
    types: readonly ApprovalRequestType[] | null;
    startsAt: string | Date;
    endsAt: string | Date;
    revokedAt: string | Date | null;
  };
  type: ApprovalRequestType;
  at: Date;
}): boolean {
  if (input.delegation.revokedAt !== null) return false;

  const at = input.at.getTime();
  if (at < new Date(input.delegation.startsAt).getTime()) return false;
  if (at > new Date(input.delegation.endsAt).getTime()) return false;

  if (input.delegation.types !== null && !input.delegation.types.includes(input.type)) {
    return false;
  }

  return true;
}

/** How long an out-of-office delegation may run before it stops being one. */
export const MAX_DELEGATION_DAYS = 92;

/**
 * Whether a proposed delegation is sound.
 *
 * Four refusals, each for a concrete failure it prevents:
 *
 *   * **Not to yourself** — a no-op that looks like a control.
 *   * **A real window** — one that ends before it starts covers nothing, and a delegation
 *     covering nothing is worse than none, because the person who set it believes they are
 *     covered and stops watching the queue.
 *   * **Bounded** — beyond a quarter it is not an out-of-office arrangement, it is a reassignment
 *     of authority, and it should be made as one so that it is visible as one.
 *   * **Reasoned** — a delegation nobody can explain afterwards cannot be reviewed.
 */
export function validateDelegation(input: {
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  maxDays?: number | undefined;
}): { ok: true } | { ok: false; reason: string } {
  if (input.fromUserId === input.toUserId) {
    return { ok: false, reason: 'Delegating to yourself changes nothing.' };
  }

  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    return {
      ok: false,
      reason:
        'The delegation must end after it starts. One that covers no time is worse than none, ' +
        'because the person who set it believes they are covered.',
    };
  }

  const days = (input.endsAt.getTime() - input.startsAt.getTime()) / 86_400_000;
  const ceiling = input.maxDays ?? MAX_DELEGATION_DAYS;
  if (days > ceiling) {
    return {
      ok: false,
      reason:
        `A delegation of ${Math.round(days)} days is not an out-of-office arrangement. Beyond ` +
        `${ceiling} days it is a reassignment of authority, and it should be made as one so ` +
        'that it is visible as one.',
    };
  }

  if (input.reason.trim() === '') {
    return {
      ok: false,
      reason: 'Say why. A delegation with no recorded reason cannot be reviewed afterwards.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Aging and escalation
// ---------------------------------------------------------------------------

/** How an approval queue groups by age. The client's "submitted / aging / due". */
export const AGING_BUCKETS = ['Fresh', 'Aging', 'Due', 'Overdue'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  Fresh: 'Submitted',
  Aging: 'Aging',
  Due: 'Due soon',
  Overdue: 'Overdue',
};

export const AGING_BUCKET_TONES: Record<AgingBucket, 'grey' | 'blue' | 'warn' | 'danger'> = {
  Fresh: 'grey',
  Aging: 'blue',
  Due: 'warn',
  Overdue: 'danger',
};

/** Hours a request may sit undecided before the queue calls it aging. */
export const DEFAULT_APPROVAL_AGING_HOURS = 24;

/**
 * Which bucket a pending request falls in.
 *
 * `Due` and `Overdue` come from the request's own due date rather than from a fixed age, because a
 * request with a deadline and one without are different things: the first can be late, the second
 * can only be old. A request with no due date therefore never reports itself `Overdue` — calling
 * it late against a deadline nobody set would be an invention, and it would make the queue's most
 * urgent colour meaningless.
 */
export function agingBucketFor(input: {
  submittedAt: Date;
  dueAt: Date | null;
  now: Date;
  agingAfterHours?: number | undefined;
}): { bucket: AgingBucket; hoursOpen: number; reason: string } {
  const hoursOpen = (input.now.getTime() - input.submittedAt.getTime()) / 3_600_000;
  const agingAfter = input.agingAfterHours ?? DEFAULT_APPROVAL_AGING_HOURS;

  if (input.dueAt !== null) {
    if (input.now.getTime() > input.dueAt.getTime()) {
      return {
        bucket: 'Overdue',
        hoursOpen,
        reason: `Past its due date, open ${hoursOpen.toFixed(1)}h.`,
      };
    }
    const hoursToDue = (input.dueAt.getTime() - input.now.getTime()) / 3_600_000;
    if (hoursToDue <= 24) {
      return { bucket: 'Due', hoursOpen, reason: `Due within ${hoursToDue.toFixed(1)}h.` };
    }
  }

  if (hoursOpen >= agingAfter) {
    return {
      bucket: 'Aging',
      hoursOpen,
      reason: `Open ${hoursOpen.toFixed(1)}h with no decision.`,
    };
  }

  return { bucket: 'Fresh', hoursOpen, reason: `Open ${hoursOpen.toFixed(1)}h.` };
}

/**
 * Whether a pending request should escalate.
 *
 * Only `Overdue` escalates, and only once. An `Aging` request is already visible in the queue in
 * its own colour, and that is the right level of noise for something merely old; escalating on age
 * alone trains people to ignore escalations, which is how a queue with an escalation policy ends
 * up worse than one without.
 *
 * Escalation raises visibility — it never decides. Nothing in this file approves anything when a
 * deadline passes, because an approval that happens because nobody looked is not an approval.
 */
export function approvalEscalationDue(input: {
  status: string;
  bucket: AgingBucket;
  alreadyEscalated: boolean;
}): { due: boolean; reason: string } {
  if (input.status !== 'Pending') {
    return { due: false, reason: 'It is already decided.' };
  }
  if (input.alreadyEscalated) {
    return { due: false, reason: 'It has already escalated.' };
  }
  if (input.bucket !== 'Overdue') {
    return {
      due: false,
      reason:
        `It is ${input.bucket}, not overdue. Escalating on age alone trains people to ignore ` +
        'escalations.',
    };
  }
  return { due: true, reason: 'Past its due date with no decision.' };
}

// ---------------------------------------------------------------------------
// Risk, for the queue's Risk column
// ---------------------------------------------------------------------------

/** The reference UI's three risk levels. */
export const APPROVAL_RISKS = ['Low', 'Medium', 'High'] as const;
export type ApprovalRisk = (typeof APPROVAL_RISKS)[number];

export const APPROVAL_RISK_TONES: Record<ApprovalRisk, 'grey' | 'warn' | 'danger'> = {
  Low: 'grey',
  Medium: 'warn',
  High: 'danger',
};

/**
 * How risky each approval type is, for the queue's Risk column.
 *
 * **Presentation only** — nothing authorizes off this. Every approval decision exercises the same
 * `Approve` action, which `HIGH_RISK_ACTIONS` already treats as high-risk uniformly, so this
 * cannot come from there: the column needs to distinguish *between* approvals, not classify the
 * act of approving.
 *
 * Five of the eight are transcribed from the approved UI reference's own `APPROVALS` rows rather
 * than judged here — "Objective publish" is Medium, "Agent output" Low, "Budget" High, "Agent
 * activation" Medium. The reference has no row for the other three, so each is reasoned from what
 * the request actually does:
 *
 *   * `HighRiskAction` — High by definition; the type exists for decisions that are.
 *   * `GuestAccess` — High, because it admits somebody from outside the company.
 *   * `WorkflowStepApproval` — Medium: a gate inside an already-published plan, so the plan itself
 *     has been reviewed, but the step is still work committing the company.
 */
export const APPROVAL_TYPE_RISK: Record<ApprovalRequestType, ApprovalRisk> = {
  ObjectiveReview: 'Medium',
  WorkflowPublish: 'Medium',
  AgentActivation: 'Medium',
  WorkflowStepApproval: 'Medium',
  OutputApproval: 'Low',
  BudgetOverride: 'High',
  HighRiskAction: 'High',
  GuestAccess: 'High',
};
